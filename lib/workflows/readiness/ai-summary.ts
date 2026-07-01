import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserContext } from '@/types/api'

export const REQUEST_AI_SUMMARY_WORKFLOW_ID = 'request_ai_summary'

export type AiSummaryReadinessStatus =
  | 'ready'
  | 'blocked'
  | 'active'
  | 'failed'
  | 'completed'

export type AiSummaryBlockerCode =
  | 'read_only'
  | 'role_not_allowed'
  | 'missing_department'
  | 'missing_project'
  | 'missing_task'
  | 'active_run_exists'
  | 'active_job_exists'
  | 'failed_run_exists'
  | 'completed_exists'

export type AiSummaryRecommendedAction =
  | 'run_request_to_task_first'
  | 'fill_missing_inputs'
  | 'summarize_with_ai'
  | 'recover_ai_summary'
  | 'review_ai_draft'
  | 'wait_for_ai_summary'
  | 'none'

export interface RequestAiSummaryReadiness {
  status: AiSummaryReadinessStatus
  can_trigger: boolean
  reason: string
  blockers: AiSummaryBlockerCode[]
  warnings: string[]
  request_id: string
  workflow_id: typeof REQUEST_AI_SUMMARY_WORKFLOW_ID
  background_job_id: string | null
  workflow_run_id: string | null
  draft_output_id: string | null
  approval_id: string | null
  recovery_run_id: string | null
  recommended_action: AiSummaryRecommendedAction
}

type RequestShape = {
  id: string
  organization_id: string
  submitted_by_user_id: string | null
  routed_department_id: string | null
  project_id: string | null
}

type AiRunSummary = {
  id: string
  status: string
  background_job_id: string | null
  current_step_id: string | null
  error_message: string | null
  accumulated: Record<string, unknown> | null
}

type ActiveJobSummary = {
  id: string
  status: string
}

const ACTIVE_RUN_STATUSES = ['pending', 'running', 'resuming']
const ACTIVE_JOB_STATUSES = ['queued', 'processing', 'retrying']

function emptyReadiness(
  requestId: string,
  fields: Partial<RequestAiSummaryReadiness>,
): RequestAiSummaryReadiness {
  const blockers = fields.blockers ?? []
  const status = fields.status ?? (blockers.length > 0 ? 'blocked' : 'ready')
  return {
    status,
    can_trigger: blockers.length === 0 && status === 'ready',
    reason: fields.reason ?? 'AI summary readiness is unknown.',
    blockers,
    warnings: fields.warnings ?? [],
    request_id: requestId,
    workflow_id: REQUEST_AI_SUMMARY_WORKFLOW_ID,
    background_job_id: fields.background_job_id ?? null,
    workflow_run_id: fields.workflow_run_id ?? null,
    draft_output_id: fields.draft_output_id ?? null,
    approval_id: fields.approval_id ?? null,
    recovery_run_id: fields.recovery_run_id ?? null,
    recommended_action: fields.recommended_action ?? 'none',
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function isRoleAllowed(ctx: UserContext, request: RequestShape): boolean {
  if (ctx.role === 'org_admin' || ctx.role === 'department_lead') return true
  return ctx.role === 'department_member' && request.submitted_by_user_id === ctx.userId
}

function draftOutputId(run: AiRunSummary | null): string | null {
  const id = run?.accumulated?.output_id
  return typeof id === 'string' ? id : null
}

function approvalId(run: AiRunSummary | null): string | null {
  const id = run?.accumulated?.approval_id
  return typeof id === 'string' ? id : null
}

export function evaluateRequestAiSummaryReadiness(input: {
  request: RequestShape
  ctx: UserContext
  linked_task_id: string | null
  latest_run: AiRunSummary | null
  active_job: ActiveJobSummary | null
  approval_id: string | null
}): RequestAiSummaryReadiness {
  const { request, ctx, linked_task_id, latest_run, active_job } = input
  const blockers: AiSummaryBlockerCode[] = []
  const warnings: string[] = []
  const departmentId = request.routed_department_id ?? ctx.departmentId
  const outputId = draftOutputId(latest_run)
  const resolvedApprovalId = input.approval_id ?? approvalId(latest_run)

  if (ctx.role === 'read_only') blockers.push('read_only')
  else if (!isRoleAllowed(ctx, request)) blockers.push('role_not_allowed')

  if (!departmentId) blockers.push('missing_department')
  if (!request.project_id) blockers.push('missing_project')
  if (!linked_task_id) blockers.push('missing_task')

  if (latest_run && ACTIVE_RUN_STATUSES.includes(latest_run.status)) {
    blockers.push('active_run_exists')
    return emptyReadiness(request.id, {
      status: 'active',
      blockers: unique(blockers),
      reason: 'AI summary is already running for this request.',
      background_job_id: latest_run.background_job_id,
      workflow_run_id: latest_run.id,
      draft_output_id: outputId,
      approval_id: resolvedApprovalId,
      recommended_action: 'wait_for_ai_summary',
    })
  }

  if (active_job) {
    blockers.push('active_job_exists')
    return emptyReadiness(request.id, {
      status: 'active',
      blockers: unique(blockers),
      reason: 'AI summary job is already queued for this request.',
      background_job_id: active_job.id,
      workflow_run_id: null,
      draft_output_id: outputId,
      approval_id: resolvedApprovalId,
      recommended_action: 'wait_for_ai_summary',
    })
  }

  if (latest_run?.status === 'failed') {
    blockers.push('failed_run_exists')
    return emptyReadiness(request.id, {
      status: 'failed',
      blockers: unique(blockers),
      reason: latest_run.error_message
        ? `AI summary failed at ${latest_run.current_step_id ?? 'unknown step'}: ${latest_run.error_message}`
        : 'AI summary failed and should be recovered before starting another one.',
      workflow_run_id: latest_run.id,
      background_job_id: latest_run.background_job_id,
      draft_output_id: outputId,
      approval_id: resolvedApprovalId,
      recovery_run_id: latest_run.id,
      recommended_action: 'recover_ai_summary',
    })
  }

  if (latest_run?.status === 'completed') {
    blockers.push('completed_exists')
    if (outputId && !resolvedApprovalId) {
      warnings.push('AI draft output exists, but no pending approval link was found.')
    }
    return emptyReadiness(request.id, {
      status: 'completed',
      blockers: unique(blockers),
      warnings,
      reason: 'AI summary already exists for this request.',
      workflow_run_id: latest_run.id,
      background_job_id: latest_run.background_job_id,
      draft_output_id: outputId,
      approval_id: resolvedApprovalId,
      recommended_action: 'review_ai_draft',
    })
  }

  if (latest_run?.status === 'cancelled') {
    warnings.push('Previous AI summary run was cancelled.')
  }

  const uniqueBlockers = unique(blockers)
  if (uniqueBlockers.includes('read_only') || uniqueBlockers.includes('role_not_allowed')) {
    return emptyReadiness(request.id, {
      status: 'blocked',
      blockers: uniqueBlockers,
      warnings,
      reason: 'Your role cannot start an AI summary for this request.',
      recommended_action: 'none',
    })
  }
  if (uniqueBlockers.includes('missing_project') || uniqueBlockers.includes('missing_department')) {
    return emptyReadiness(request.id, {
      status: 'blocked',
      blockers: uniqueBlockers,
      warnings,
      reason: 'AI summary needs a routed department and project before it can run.',
      recommended_action: 'fill_missing_inputs',
    })
  }
  if (uniqueBlockers.includes('missing_task')) {
    return emptyReadiness(request.id, {
      status: 'blocked',
      blockers: uniqueBlockers,
      warnings,
      reason: 'AI summary needs a linked task. Run request_to_task first.',
      recommended_action: 'run_request_to_task_first',
    })
  }

  return emptyReadiness(request.id, {
    status: 'ready',
    blockers: [],
    warnings,
    reason: 'AI summary is ready to run.',
    recommended_action: 'summarize_with_ai',
  })
}

async function findLinkedTaskId(supabase: SupabaseClient, requestId: string): Promise<string | null> {
  const { data } = await supabase
    .from('tasks')
    .select('id')
    .eq('request_id', requestId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

async function findLatestAiRun(supabase: SupabaseClient, requestId: string): Promise<AiRunSummary | null> {
  const { data } = await supabase
    .from('workflow_runs')
    .select('id, status, background_job_id, current_step_id, error_message, accumulated')
    .eq('workflow_id', REQUEST_AI_SUMMARY_WORKFLOW_ID)
    .eq('trigger_entity_type', 'request')
    .eq('trigger_entity_id', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data ?? null) as unknown as AiRunSummary | null
}

async function findActiveAiJob(supabase: SupabaseClient, requestId: string): Promise<ActiveJobSummary | null> {
  const { data } = await supabase
    .from('background_jobs')
    .select('id, status')
    .eq('job_type', 'workflow_step')
    .in('status', ACTIVE_JOB_STATUSES)
    .filter('payload->>workflow_id', 'eq', REQUEST_AI_SUMMARY_WORKFLOW_ID)
    .filter('payload->inputs->>trigger_entity_id', 'eq', requestId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data ?? null) as unknown as ActiveJobSummary | null
}

async function findPendingApprovalId(
  supabase: SupabaseClient,
  run: AiRunSummary | null,
): Promise<string | null> {
  const existing = approvalId(run)
  if (existing) return existing
  const outputId = draftOutputId(run)
  if (!outputId) return null

  const { data } = await supabase
    .from('approvals')
    .select('id')
    .eq('subject_type', 'output')
    .eq('subject_id', outputId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}

export async function getRequestAiSummaryReadiness(
  supabase: SupabaseClient,
  requestId: string,
  ctx: UserContext,
): Promise<RequestAiSummaryReadiness | null> {
  const { data: req } = await supabase
    .from('requests')
    .select('id, organization_id, submitted_by_user_id, routed_department_id, project_id')
    .eq('id', requestId)
    .maybeSingle()

  if (!req) return null

  const request = req as RequestShape
  const [linkedTaskId, latestRun, activeJob] = await Promise.all([
    findLinkedTaskId(supabase, request.id),
    findLatestAiRun(supabase, request.id),
    findActiveAiJob(supabase, request.id),
  ])
  const pendingApprovalId = await findPendingApprovalId(supabase, latestRun)

  return evaluateRequestAiSummaryReadiness({
    request,
    ctx,
    linked_task_id: linkedTaskId,
    latest_run: latestRun,
    active_job: activeJob,
    approval_id: pendingApprovalId,
  })
}
