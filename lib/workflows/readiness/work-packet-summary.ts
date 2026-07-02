import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserContext } from '@/types/api'
import type { AiWorkflowReadinessRequirements } from '@/types/ai'
import { getAiWorkflow } from '@/lib/ai/workflows'

// Sprint 7.9 — Work Packet AI Summary readiness (mirrors readiness/ai-summary.ts).
// Read-only, RLS-bound. Resolves the org/department/project/task a work-packet
// summary needs, and whether one can be triggered, so the UI + API share one
// source of truth and never start a known-doomed run.

export const WORK_PACKET_AI_SUMMARY_WORKFLOW_ID = 'work_packet_ai_summary'

export type WpAiSummaryStatus = 'ready' | 'blocked' | 'active' | 'failed' | 'completed'

export type WpAiSummaryBlockerCode =
  | 'read_only'
  | 'role_not_allowed'
  | 'missing_department'
  | 'missing_project'
  | 'missing_task'
  | 'active_run_exists'
  | 'active_job_exists'
  | 'failed_run_exists'
  | 'completed_exists'

export type WpAiSummaryRecommendedAction =
  | 'link_parent_task'
  | 'fill_missing_inputs'
  | 'summarize_with_ai'
  | 'recover_ai_summary'
  | 'review_ai_draft'
  | 'wait_for_ai_summary'
  | 'none'

export interface WorkPacketAiSummaryReadiness {
  status: WpAiSummaryStatus
  can_trigger: boolean
  reason: string
  blockers: WpAiSummaryBlockerCode[]
  warnings: string[]
  work_packet_id: string
  workflow_id: typeof WORK_PACKET_AI_SUMMARY_WORKFLOW_ID
  // Resolved inputs (shared with the trigger).
  organization_id: string | null
  department_id: string | null
  project_id: string | null
  task_id: string | null
  title: string | null
  objective: string | null
  // Run / draft linkage.
  background_job_id: string | null
  workflow_run_id: string | null
  draft_output_id: string | null
  approval_id: string | null
  recovery_run_id: string | null
  recovery_available: boolean
  recommended_action: WpAiSummaryRecommendedAction
}

type WpShape = {
  id: string
  organization_id: string
  department_id: string | null
  parent_type: string
  parent_id: string
  title: string | null
  objective: string | null
  author_user_id: string | null
}

type AiRunSummary = {
  id: string
  status: string
  background_job_id: string | null
  current_step_id: string | null
  error_message: string | null
  accumulated: Record<string, unknown> | null
}

const ACTIVE_RUN_STATUSES = ['pending', 'running', 'resuming']
const ACTIVE_JOB_STATUSES = ['queued', 'processing', 'retrying']

const DEFAULT_REQS: AiWorkflowReadinessRequirements = {
  require_project: true, require_department: true, require_linked_task: true,
  block_active_run: true, block_active_job: true, block_failed: true, block_completed: true,
}

function reqs(): AiWorkflowReadinessRequirements {
  return getAiWorkflow(WORK_PACKET_AI_SUMMARY_WORKFLOW_ID)?.readiness ?? DEFAULT_REQS
}

function draftOutputId(run: AiRunSummary | null): string | null {
  const id = run?.accumulated?.output_id
  return typeof id === 'string' ? id : null
}
function accApprovalId(run: AiRunSummary | null): string | null {
  const id = run?.accumulated?.approval_id
  return typeof id === 'string' ? id : null
}

function isRoleAllowed(ctx: UserContext, wp: WpShape): boolean {
  if (ctx.role === 'org_admin' || ctx.role === 'department_lead') return true
  return ctx.role === 'department_member' && wp.author_user_id === ctx.userId
}

async function findParentTask(
  supabase: SupabaseClient, wp: WpShape,
): Promise<{ task_id: string | null; project_id: string | null }> {
  if (wp.parent_type !== 'task') return { task_id: null, project_id: null }
  const { data } = await supabase
    .from('tasks')
    .select('id, project_id')
    .eq('id', wp.parent_id)
    .is('deleted_at', null)
    .maybeSingle()
  const t = data as { id: string; project_id: string | null } | null
  return { task_id: t?.id ?? null, project_id: t?.project_id ?? null }
}

async function findLatestAiRun(supabase: SupabaseClient, wpId: string): Promise<AiRunSummary | null> {
  const { data } = await supabase
    .from('workflow_runs')
    .select('id, status, background_job_id, current_step_id, error_message, accumulated')
    .eq('workflow_id', WORK_PACKET_AI_SUMMARY_WORKFLOW_ID)
    .eq('trigger_entity_type', 'work_packet')
    .eq('trigger_entity_id', wpId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data ?? null) as unknown as AiRunSummary | null
}

async function findActiveAiJob(supabase: SupabaseClient, wpId: string): Promise<{ id: string; status: string } | null> {
  const { data } = await supabase
    .from('background_jobs')
    .select('id, status')
    .eq('job_type', 'workflow_step')
    .in('status', ACTIVE_JOB_STATUSES)
    .filter('payload->>workflow_id', 'eq', WORK_PACKET_AI_SUMMARY_WORKFLOW_ID)
    .filter('payload->inputs->>trigger_entity_id', 'eq', wpId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data ?? null) as unknown as { id: string; status: string } | null
}

async function findPendingApprovalId(supabase: SupabaseClient, run: AiRunSummary | null): Promise<string | null> {
  const existing = accApprovalId(run)
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

function unique<T>(a: T[]): T[] { return [...new Set(a)] }

export async function getWorkPacketAiSummaryReadiness(
  supabase: SupabaseClient,
  workPacketId: string,
  ctx: UserContext,
): Promise<WorkPacketAiSummaryReadiness | null> {
  const { data: wpData } = await supabase
    .from('work_packets')
    .select('id, organization_id, department_id, parent_type, parent_id, title, objective, author_user_id')
    .eq('id', workPacketId)
    .maybeSingle()
  if (!wpData) return null
  const wp = wpData as WpShape

  const r = reqs()
  const { task_id, project_id } = await findParentTask(supabase, wp)
  const [latestRun, activeJob] = await Promise.all([
    findLatestAiRun(supabase, wp.id),
    findActiveAiJob(supabase, wp.id),
  ])
  const pendingApprovalId = await findPendingApprovalId(supabase, latestRun)

  const blockers: WpAiSummaryBlockerCode[] = []
  const warnings: string[] = []
  const outputId = draftOutputId(latestRun)
  const resolvedApprovalId = pendingApprovalId ?? accApprovalId(latestRun)

  const base = {
    work_packet_id: wp.id,
    workflow_id: WORK_PACKET_AI_SUMMARY_WORKFLOW_ID,
    organization_id: wp.organization_id,
    department_id: wp.department_id,
    project_id,
    task_id,
    title: wp.title,
    objective: wp.objective,
  } as const

  const done = (fields: Partial<WorkPacketAiSummaryReadiness> & { status: WpAiSummaryStatus; reason: string; recommended_action: WpAiSummaryRecommendedAction }): WorkPacketAiSummaryReadiness => ({
    ...base,
    can_trigger: (fields.blockers ?? blockers).length === 0 && fields.status === 'ready',
    blockers: unique(fields.blockers ?? blockers),
    warnings: fields.warnings ?? warnings,
    background_job_id: fields.background_job_id ?? null,
    workflow_run_id: fields.workflow_run_id ?? null,
    draft_output_id: fields.draft_output_id ?? null,
    approval_id: fields.approval_id ?? null,
    recovery_run_id: fields.recovery_run_id ?? null,
    recovery_available: fields.recovery_available ?? false,
    status: fields.status,
    reason: fields.reason,
    recommended_action: fields.recommended_action,
  })

  if (ctx.role === 'read_only') blockers.push('read_only')
  else if (!isRoleAllowed(ctx, wp)) blockers.push('role_not_allowed')

  if (r.require_department && !wp.department_id) blockers.push('missing_department')
  if (r.require_project && !project_id) blockers.push('missing_project')
  if (r.require_linked_task && !task_id) blockers.push('missing_task')

  if (r.block_active_run && latestRun && ACTIVE_RUN_STATUSES.includes(latestRun.status)) {
    return done({ status: 'active', blockers: [...blockers, 'active_run_exists'], reason: 'AI summary is already running for this work packet.', background_job_id: latestRun.background_job_id, workflow_run_id: latestRun.id, draft_output_id: outputId, approval_id: resolvedApprovalId, recommended_action: 'wait_for_ai_summary' })
  }
  if (r.block_active_job && activeJob) {
    return done({ status: 'active', blockers: [...blockers, 'active_job_exists'], reason: 'AI summary job is already queued for this work packet.', background_job_id: activeJob.id, draft_output_id: outputId, approval_id: resolvedApprovalId, recommended_action: 'wait_for_ai_summary' })
  }
  if (r.block_failed && latestRun?.status === 'failed') {
    return done({ status: 'failed', blockers: [...blockers, 'failed_run_exists'], reason: latestRun.error_message ? `AI summary failed at ${latestRun.current_step_id ?? 'unknown step'}: ${latestRun.error_message}` : 'AI summary failed and should be recovered before starting another one.', workflow_run_id: latestRun.id, background_job_id: latestRun.background_job_id, draft_output_id: outputId, approval_id: resolvedApprovalId, recovery_run_id: latestRun.id, recovery_available: true, recommended_action: 'recover_ai_summary' })
  }
  if (r.block_completed && latestRun?.status === 'completed') {
    if (outputId && !resolvedApprovalId) warnings.push('AI draft output exists, but no pending approval link was found.')
    return done({ status: 'completed', blockers: [...blockers, 'completed_exists'], reason: 'AI summary already exists for this work packet.', warnings, workflow_run_id: latestRun.id, background_job_id: latestRun.background_job_id, draft_output_id: outputId, approval_id: resolvedApprovalId, recommended_action: 'review_ai_draft' })
  }

  const uniq = unique(blockers)
  if (uniq.includes('read_only') || uniq.includes('role_not_allowed')) {
    return done({ status: 'blocked', blockers: uniq, reason: 'Your role cannot start an AI summary for this work packet.', recommended_action: 'none' })
  }
  if (uniq.includes('missing_department') || uniq.includes('missing_project')) {
    return done({ status: 'blocked', blockers: uniq, reason: 'AI summary needs a department and a project (via the parent task) before it can run.', recommended_action: 'fill_missing_inputs' })
  }
  if (uniq.includes('missing_task')) {
    return done({ status: 'blocked', blockers: uniq, reason: 'AI summary needs a parent task. Link this work packet to a task first.', recommended_action: 'link_parent_task' })
  }

  return done({ status: 'ready', blockers: [], reason: 'AI summary is ready to run.', recommended_action: 'summarize_with_ai' })
}
