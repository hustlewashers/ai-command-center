import { getServiceClient } from '@/lib/supabase/service'
import { enqueue } from '@/lib/jobs/enqueue'
import {
  getWorkflow,
  workflowSupportsTrigger,
  findWorkflowsByTrigger,
} from './registry'
import { createError } from '@/lib/errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserContext } from '@/types/api'
import type { WorkflowTriggerEntityType } from '@/types/workflows'

// ─────────────────────────────────────────────────────────────
// Sprint 5.8 — Live Workflow Triggers
//
// A trigger turns a business action into a workflow run *request*. It validates,
// de-duplicates, and enqueues a `workflow_step` background job. It NEVER executes
// a workflow step — the worker does that. Triggers are the bridge from
// "user created a request" to "the engine runs request_to_task".
//
// Governance preserved:
//   • read_only cannot trigger workflows.
//   • Entities are read service-side but scoped to the caller's organization.
//   • No business record is mutated here (only background_jobs + execution_logs).
//   • Duplicate protection prevents a second active workflow for the same entity.
// ─────────────────────────────────────────────────────────────

// Background-job statuses that mean "a workflow is already in flight" for an
// entity but its workflow_run row may not exist yet (job still queued).
const ACTIVE_JOB_STATUSES = ['queued', 'processing', 'retrying'] as const
// workflow_run statuses that mean "already active" (run row exists).
const ACTIVE_RUN_STATUSES = ['pending', 'running', 'resuming'] as const

export interface WorkflowTriggerResult {
  triggered: boolean              // a new job was enqueued
  deduped: boolean                // an active workflow already existed; reused it
  workflow_id: string | null
  background_job_id: string | null
  workflow_run_id: string | null  // known only when an active run already exists
  reason: string
}

function notTriggered(reason: string): WorkflowTriggerResult {
  return { triggered: false, deduped: false, workflow_id: null, background_job_id: null, workflow_run_id: null, reason }
}

// ── Duplicate protection ─────────────────────────────────────
// Returns an existing active workflow for (entity, workflow) if one exists,
// covering both the not-yet-materialized job and the live run.
async function findActiveWorkflow(
  svc: SupabaseClient,
  organizationId: string,
  entityType: WorkflowTriggerEntityType,
  entityId: string,
  workflowId: string,
): Promise<WorkflowTriggerResult | null> {
  // 1. Live run (status pending/running/resuming)
  const { data: runs } = await svc
    .from('workflow_runs')
    .select('id, status, background_job_id')
    .eq('organization_id', organizationId)
    .eq('workflow_id', workflowId)
    .eq('trigger_entity_type', entityType)
    .eq('trigger_entity_id', entityId)
    .in('status', ACTIVE_RUN_STATUSES as unknown as string[])
    .order('created_at', { ascending: false })
    .limit(1)

  if (runs && runs.length > 0) {
    const r = runs[0] as { id: string; background_job_id: string | null }
    return {
      triggered: false, deduped: true, workflow_id: workflowId,
      background_job_id: r.background_job_id, workflow_run_id: r.id,
      reason: 'An active workflow run already exists for this entity',
    }
  }

  // 2. Queued/processing job whose run row may not exist yet
  const { data: jobs } = await svc
    .from('background_jobs')
    .select('id, status, payload')
    .eq('organization_id', organizationId)
    .eq('job_type', 'workflow_step')
    .in('status', ACTIVE_JOB_STATUSES as unknown as string[])
    .filter('payload->>workflow_id', 'eq', workflowId)
    .filter('payload->inputs->>trigger_entity_id', 'eq', entityId)
    .order('created_at', { ascending: false })
    .limit(1)

  if (jobs && jobs.length > 0) {
    const j = jobs[0] as { id: string }
    return {
      triggered: false, deduped: true, workflow_id: workflowId,
      background_job_id: j.id, workflow_run_id: null,
      reason: 'A queued workflow job already exists for this entity',
    }
  }

  return null
}

// ── Audit (TASK 6) ───────────────────────────────────────────
// One execution_logs row per trigger ATTEMPT — triggered, deduped, or skipped —
// so operators can see why a workflow did or didn't start. Lives under the
// triggering entity (context_type 'request'/'task'/'workflow'); the executor
// still writes the separate workflow start/complete logs.
function triggerOutcome(result: WorkflowTriggerResult): 'triggered' | 'deduped' | 'skipped' {
  if (result.triggered) return 'triggered'
  if (result.deduped)   return 'deduped'
  return 'skipped'
}

async function logTriggerOutcome(
  svc: SupabaseClient,
  ctx: UserContext,
  organizationId: string,
  contextType: 'request' | 'task' | 'workflow',
  contextId: string,
  entityType: WorkflowTriggerEntityType,
  result: WorkflowTriggerResult,
  inputs?: { project_id?: string | null; department_id?: string | null },
): Promise<void> {
  const outcome = triggerOutcome(result)
  const wf = result.workflow_id ?? 'request_to_task'
  const { error } = await svc.from('execution_logs').insert({
    organization_id: organizationId,
    event_type:      'state_change',
    actor:           `user:${ctx.userId}`,
    summary:         `Workflow trigger ${outcome} for ${entityType} ${contextId}: ${result.reason}`,
    context_type:    contextType,
    context_id:      contextId,
    metadata: {
      workflow_trigger:    true,
      trigger_result:      outcome,        // 'triggered' | 'deduped' | 'skipped'
      deduped:             result.deduped,
      reason:              result.reason,
      workflow_id:         wf,
      trigger_entity_type: entityType,
      trigger_entity_id:   contextId,
      background_job_id:   result.background_job_id,
      workflow_run_id:     result.workflow_run_id,
      actor_user_id:       ctx.userId,
      actor_role:          ctx.role,
      // Resolved workflow inputs when known (TASK 6) — null when unresolved.
      ...(inputs?.project_id    !== undefined ? { project_id:    inputs.project_id }    : {}),
      ...(inputs?.department_id !== undefined ? { department_id: inputs.department_id } : {}),
    },
    status: 'recorded',
  })
  if (error) console.warn('[workflow-triggers] audit log failed:', error.message)
}

// Validate that an override department/project id belongs to the actor's org,
// so a manual trigger cannot inject another org's entity into the workflow.
async function assertOrgOwns(
  svc: SupabaseClient,
  table: 'departments' | 'projects',
  id: string,
  organizationId: string,
): Promise<void> {
  const { data, error } = await svc.from(table).select('id')
    .eq('id', id).eq('organization_id', organizationId).maybeSingle()
  if (error) throw createError('internal', `trigger: ${table} validation failed: ${error.message}`)
  if (!data) throw createError('validation', `Provided ${table.slice(0, -1)} is not in your organization`)
}

// Optional inputs an operator may supply when manually starting a workflow.
export interface RequestTriggerOverrides {
  workflowId?: string
  projectId?: string | null
  departmentId?: string | null
}

// ── Request trigger (the live path for Sprint 5.8) ───────────
// Fully wired: a created request enqueues request_to_task.
export async function triggerRequestWorkflow(
  requestId: string,
  ctx: UserContext,
  overrides?: RequestTriggerOverrides,
): Promise<WorkflowTriggerResult> {
  if (ctx.role === 'read_only') {
    throw createError('forbidden', 'read_only role cannot trigger workflows')
  }

  const svc = getServiceClient()
  const workflowId = overrides?.workflowId ?? 'request_to_task'

  // Workflow availability (validates an explicitly-supplied workflow_id too)
  const workflow = getWorkflow(workflowId)
  if (!workflow || !workflowSupportsTrigger(workflow, 'request')) {
    return notTriggered(`No workflow available for request triggers ('${workflowId}')`)
  }

  // Entity existence (org-scoped, service-side)
  const { data: req, error: reqErr } = await svc
    .from('requests')
    .select('id, organization_id, routed_department_id, project_id, intent, submitted_by_user_id, deleted_at')
    .eq('id', requestId)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()

  if (reqErr) throw createError('internal', `trigger: request fetch failed: ${reqErr.message}`)
  if (!req || (req as { deleted_at: string | null }).deleted_at) {
    throw createError('not_found', 'Request not found')
  }

  const r = req as {
    id: string; organization_id: string
    routed_department_id: string | null; project_id: string | null
    intent: string; submitted_by_user_id: string | null
  }

  // Resolve workflow inputs: operator overrides win, then request fields, then
  // (for department only) the actor's own department. Overrides are validated
  // to belong to the actor's org so a manual trigger can't inject foreign data.
  if (overrides?.departmentId) await assertOrgOwns(svc, 'departments', overrides.departmentId, ctx.organizationId)
  if (overrides?.projectId)    await assertOrgOwns(svc, 'projects',    overrides.projectId,    ctx.organizationId)

  const departmentId = overrides?.departmentId ?? r.routed_department_id ?? ctx.departmentId
  const projectId    = overrides?.projectId    ?? r.project_id

  // request_to_task → create_task requires a department and project. If neither
  // the request nor the operator supplied them, do not enqueue a doomed run.
  const auditInputs = { project_id: projectId, department_id: departmentId }
  if (!departmentId) {
    const result = notTriggered('Request has no department; request_to_task not triggered')
    await logTriggerOutcome(svc, ctx, r.organization_id, 'request', r.id, 'request', result, auditInputs)
    return result
  }
  if (!projectId) {
    const result = notTriggered('Request has no project; request_to_task not triggered')
    await logTriggerOutcome(svc, ctx, r.organization_id, 'request', r.id, 'request', result, auditInputs)
    return result
  }

  // Duplicate protection
  const existing = await findActiveWorkflow(svc, r.organization_id, 'request', r.id, workflowId)
  if (existing) {
    await logTriggerOutcome(svc, ctx, r.organization_id, 'request', r.id, 'request', existing, auditInputs)
    return existing
  }

  // Enqueue
  const inputs = {
    organization_id:     r.organization_id,
    department_id:       departmentId,
    project_id:          projectId,
    created_by:          r.submitted_by_user_id ?? ctx.userId,
    title:               r.intent,
    request_id:          r.id,
    trigger_type:        'request',
    trigger_entity_type: 'request',
    trigger_entity_id:   r.id,
  }

  const jobId = await enqueue({
    job_type:           'workflow_step',
    organization_id:    r.organization_id,
    payload:            { workflow_id: workflowId, inputs },
    related_request_id: r.id,
    created_by_user_id: ctx.userId,
  })

  const result: WorkflowTriggerResult = {
    triggered: true, deduped: false, workflow_id: workflowId,
    background_job_id: jobId, workflow_run_id: null,
    reason: 'Workflow enqueued',
  }
  await logTriggerOutcome(svc, ctx, r.organization_id, 'request', r.id, 'request', result, auditInputs)
  return result
}

// ── AI summary trigger (Sprint 6.4) ──────────────────────────
// Manually starts the existing request_ai_summary workflow for a request.
// Orchestration only: validates, de-duplicates, enqueues — the worker executes
// the governed call_ai step (draft output + pending approval; never delivers).
export async function triggerRequestAiSummary(
  requestId: string,
  ctx: UserContext,
): Promise<WorkflowTriggerResult> {
  if (ctx.role === 'read_only') {
    throw createError('forbidden', 'read_only role cannot trigger AI summaries')
  }

  const svc = getServiceClient()
  const workflowId = 'request_ai_summary'

  const workflow = getWorkflow(workflowId)
  if (!workflow) return notTriggered(`No workflow '${workflowId}' registered`)

  const { data: req, error: reqErr } = await svc
    .from('requests')
    .select('id, organization_id, routed_department_id, project_id, intent, submitted_by_user_id, deleted_at')
    .eq('id', requestId)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()

  if (reqErr) throw createError('internal', `ai summary: request fetch failed: ${reqErr.message}`)
  if (!req || (req as { deleted_at: string | null }).deleted_at) {
    throw createError('not_found', 'Request not found')
  }
  const r = req as {
    id: string; organization_id: string
    routed_department_id: string | null; project_id: string | null
    intent: string; submitted_by_user_id: string | null
  }

  // request_ai_summary → create_output requires a department and project.
  const departmentId = r.routed_department_id ?? ctx.departmentId
  const projectId    = r.project_id
  if (!departmentId) {
    const result = notTriggered('Request has no department; request_ai_summary not triggered')
    await logAiSummaryTrigger(svc, ctx, r.organization_id, r.id, result)
    return result
  }
  if (!projectId) {
    const result = notTriggered('Request has no project; request_ai_summary not triggered')
    await logAiSummaryTrigger(svc, ctx, r.organization_id, r.id, result)
    return result
  }

  // Duplicate protection — one active AI summary per request.
  const existing = await findActiveWorkflow(svc, r.organization_id, 'request', r.id, workflowId)
  if (existing) {
    await logAiSummaryTrigger(svc, ctx, r.organization_id, r.id, existing)
    return existing
  }

  // Best-effort: a task linked to this request lets create_output attach the
  // draft (outputs.task_id is NOT NULL). Without one the run fails at
  // create_output and is recoverable via the existing recovery engine.
  const { data: task } = await svc.from('tasks').select('id')
    .eq('request_id', r.id).is('deleted_at', null)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const taskId = (task as { id: string } | null)?.id ?? null

  const inputs = {
    organization_id:     r.organization_id,
    department_id:       departmentId,
    project_id:          projectId,
    created_by:          r.submitted_by_user_id ?? ctx.userId,
    task_id:             taskId,
    title:               r.intent,
    intent:              r.intent,
    request_id:          r.id,
    trigger_type:        'manual_ai_summary',
    trigger_entity_type: 'request',
    trigger_entity_id:   r.id,
  }

  const jobId = await enqueue({
    job_type:           'workflow_step',
    organization_id:    r.organization_id,
    payload:            { workflow_id: workflowId, inputs },
    related_request_id: r.id,
    created_by_user_id: ctx.userId,
  })

  const result: WorkflowTriggerResult = {
    triggered: true, deduped: false, workflow_id: workflowId,
    background_job_id: jobId, workflow_run_id: null,
    reason: taskId ? 'AI summary workflow enqueued' : 'AI summary enqueued (no linked task — draft creation may need recovery)',
  }
  await logAiSummaryTrigger(svc, ctx, r.organization_id, r.id, result)
  return result
}

// Request-scoped audit for the manual AI summary trigger (TASK 7).
async function logAiSummaryTrigger(
  svc: SupabaseClient, ctx: UserContext, organizationId: string,
  requestId: string, result: WorkflowTriggerResult,
): Promise<void> {
  const outcome = triggerOutcome(result)
  const { error } = await svc.from('execution_logs').insert({
    organization_id: organizationId,
    event_type:      'state_change',
    actor:           'workflow-trigger',
    summary:         `AI summary trigger ${outcome} for request ${requestId}: ${result.reason}`,
    context_type:    'request',
    context_id:      requestId,
    metadata: {
      trigger_type:    'manual_ai_summary',
      workflow_id:     'request_ai_summary',
      request_id:      requestId,
      triggered:       result.triggered,
      deduped:         result.deduped,
      reason:          result.reason,
      actor_user_id:   ctx.userId,
      background_job_id: result.background_job_id,
      workflow_run_id: result.workflow_run_id,
    },
    status: 'recorded',
  })
  if (error) console.warn('[ai-summary-trigger] audit log failed:', error.message)
}

// ── Task trigger (forward-looking) ───────────────────────────
// No task-triggered workflow is registered yet (Sprint 5.8). Validates and
// returns a not-triggered result until such a definition is declared.
export async function triggerTaskWorkflow(
  taskId: string,
  ctx: UserContext,
): Promise<WorkflowTriggerResult> {
  if (ctx.role === 'read_only') {
    throw createError('forbidden', 'read_only role cannot trigger workflows')
  }

  const candidates = findWorkflowsByTrigger('task')
  if (candidates.length === 0) {
    return notTriggered('No workflow registered for task triggers')
  }

  const svc = getServiceClient()
  const { data: task, error } = await svc
    .from('tasks')
    .select('id, organization_id, department_id, project_id, title, created_by, request_id, deleted_at')
    .eq('id', taskId)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()

  if (error) throw createError('internal', `trigger: task fetch failed: ${error.message}`)
  if (!task || (task as { deleted_at: string | null }).deleted_at) {
    throw createError('not_found', 'Task not found')
  }

  const t = task as {
    id: string; organization_id: string; department_id: string
    project_id: string; title: string; created_by: string; request_id: string | null
  }
  const workflow = candidates[0]

  const existing = await findActiveWorkflow(svc, t.organization_id, 'task', t.id, workflow.id)
  if (existing) return existing

  const inputs = {
    organization_id:     t.organization_id,
    department_id:       t.department_id,
    project_id:          t.project_id,
    created_by:          t.created_by,
    title:               t.title,
    request_id:          t.request_id,
    trigger_type:        'task',
    trigger_entity_type: 'task',
    trigger_entity_id:   t.id,
  }

  const jobId = await enqueue({
    job_type:           'workflow_step',
    organization_id:    t.organization_id,
    payload:            { workflow_id: workflow.id, inputs },
    related_task_id:    t.id,
    created_by_user_id: ctx.userId,
  })

  const result: WorkflowTriggerResult = {
    triggered: true, deduped: false, workflow_id: workflow.id,
    background_job_id: jobId, workflow_run_id: null,
    reason: 'Workflow enqueued',
  }
  await logTriggerOutcome(svc, ctx, t.organization_id, 'task', t.id, 'task', result)
  return result
}

// ── Approval trigger (forward-looking) ───────────────────────
// No approval-triggered workflow is registered yet (Sprint 5.8). Approval
// workflows must never bypass the approval gate itself — they react to an
// approval decision, they do not grant it.
export async function triggerApprovalWorkflow(
  approvalId: string,
  ctx: UserContext,
): Promise<WorkflowTriggerResult> {
  if (ctx.role === 'read_only') {
    throw createError('forbidden', 'read_only role cannot trigger workflows')
  }

  const candidates = findWorkflowsByTrigger('approval')
  if (candidates.length === 0) {
    return notTriggered('No workflow registered for approval triggers')
  }

  const svc = getServiceClient()
  const { data: approval, error } = await svc
    .from('approvals')
    .select('id, organization_id, status, deleted_at')
    .eq('id', approvalId)
    .eq('organization_id', ctx.organizationId)
    .maybeSingle()

  if (error) throw createError('internal', `trigger: approval fetch failed: ${error.message}`)
  if (!approval || (approval as { deleted_at: string | null }).deleted_at) {
    throw createError('not_found', 'Approval not found')
  }

  const a = approval as { id: string; organization_id: string }
  const workflow = candidates[0]

  const existing = await findActiveWorkflow(svc, a.organization_id, 'approval', a.id, workflow.id)
  if (existing) return existing

  const inputs = {
    organization_id:     a.organization_id,
    department_id:       ctx.departmentId,
    trigger_type:        'approval',
    trigger_entity_type: 'approval',
    trigger_entity_id:   a.id,
  }

  const jobId = await enqueue({
    job_type:           'workflow_step',
    organization_id:    a.organization_id,
    payload:            { workflow_id: workflow.id, inputs },
    created_by_user_id: ctx.userId,
  })

  const result: WorkflowTriggerResult = {
    triggered: true, deduped: false, workflow_id: workflow.id,
    background_job_id: jobId, workflow_run_id: null,
    reason: 'Workflow enqueued',
  }
  await logTriggerOutcome(svc, ctx, a.organization_id, 'workflow', a.id, 'approval', result)
  return result
}
