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

// ── Audit (TASK 7) ───────────────────────────────────────────
// Request-scoped narrative log linking the entity to its workflow job.
// The executor still writes the workflow start/complete logs (context_type
// 'workflow'); this one lives under the triggering entity for traceability.
async function logTrigger(
  svc: SupabaseClient,
  ctx: UserContext,
  organizationId: string,
  contextType: 'request' | 'task' | 'workflow',
  contextId: string,
  workflowId: string,
  jobId: string,
): Promise<void> {
  const { error } = await svc.from('execution_logs').insert({
    organization_id: organizationId,
    event_type:      'state_change',
    actor:           `user:${ctx.userId}`,
    summary:         `Workflow '${workflowId}' triggered for ${contextType} ${contextId}`,
    context_type:    contextType,
    context_id:      contextId,
    metadata: {
      workflow_trigger: true,
      workflow_id:      workflowId,
      background_job_id: jobId,
      actor_user_id:    ctx.userId,
      actor_role:       ctx.role,
    },
    status: 'recorded',
  })
  if (error) console.warn('[workflow-triggers] audit log failed:', error.message)
}

// ── Request trigger (the live path for Sprint 5.8) ───────────
// Fully wired: a created request enqueues request_to_task.
export async function triggerRequestWorkflow(
  requestId: string,
  ctx: UserContext,
): Promise<WorkflowTriggerResult> {
  if (ctx.role === 'read_only') {
    throw createError('forbidden', 'read_only role cannot trigger workflows')
  }

  const svc = getServiceClient()
  const workflowId = 'request_to_task'

  // Workflow availability
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

  // request_to_task → create_task requires a department and project. If the
  // request lacks them, do not enqueue a guaranteed-to-fail run; surface why.
  const departmentId = r.routed_department_id ?? ctx.departmentId
  if (!departmentId) {
    return notTriggered('Request has no routed department; request_to_task not triggered')
  }
  if (!r.project_id) {
    return notTriggered('Request has no project; request_to_task not triggered')
  }

  // Duplicate protection (TASK 4)
  const existing = await findActiveWorkflow(svc, r.organization_id, 'request', r.id, workflowId)
  if (existing) return existing

  // Enqueue (TASK 2 / TASK 6 payload shape)
  const inputs = {
    organization_id:     r.organization_id,
    department_id:       departmentId,
    project_id:          r.project_id,
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

  await logTrigger(svc, ctx, r.organization_id, 'request', r.id, workflowId, jobId)

  return {
    triggered: true, deduped: false, workflow_id: workflowId,
    background_job_id: jobId, workflow_run_id: null,
    reason: 'Workflow enqueued',
  }
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

  await logTrigger(svc, ctx, t.organization_id, 'task', t.id, workflow.id, jobId)

  return {
    triggered: true, deduped: false, workflow_id: workflow.id,
    background_job_id: jobId, workflow_run_id: null,
    reason: 'Workflow enqueued',
  }
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

  await logTrigger(svc, ctx, a.organization_id, 'workflow', a.id, workflow.id, jobId)

  return {
    triggered: true, deduped: false, workflow_id: workflow.id,
    background_job_id: jobId, workflow_run_id: null,
    reason: 'Workflow enqueued',
  }
}
