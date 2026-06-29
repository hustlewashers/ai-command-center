import type { SupabaseClient } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────
// Sprint 5.9 — Request trigger status (read model)
//
// Centralizes "what is the workflow situation for this request?" so the
// request detail page, the manual-trigger API, and dashboard alerts all reason
// about triggers the same way. Focused on request_to_task for now.
//
// Pure reads — no enqueue, no mutation. Works with any SupabaseClient: pass the
// RLS-bound SSR client from a Server Component, or the service client server-side.
// ─────────────────────────────────────────────────────────────

export const REQUEST_WORKFLOW_ID = 'request_to_task'

// run statuses that count as "a workflow is in flight"
const ACTIVE_RUN_STATUSES = ['pending', 'running', 'resuming']
// job statuses that count as "queued/processing but no run row yet"
const ACTIVE_JOB_STATUSES = ['queued', 'processing', 'retrying']

export interface TriggerRunSummary {
  id: string
  workflow_id: string
  status: string
  background_job_id: string | null
  started_at: string | null
  completed_at: string | null
  failed_at: string | null
  current_step_id: string | null
  created_at: string
}

export interface TriggerJobSummary {
  id: string
  status: string
  created_at: string
}

export interface RequestTriggerStatus {
  workflow_id: string
  recent_runs: TriggerRunSummary[]
  latest_run: TriggerRunSummary | null
  active_run: TriggerRunSummary | null
  latest_failure: TriggerRunSummary | null
  latest_job: TriggerJobSummary | null
  has_active_workflow: boolean
  missing_inputs: string[]          // 'project_id' / 'department_id' the request lacks
  can_trigger: boolean              // no active workflow → an operator may (re)start
}

const RUN_COLS =
  'id, workflow_id, status, background_job_id, started_at, completed_at, failed_at, current_step_id, created_at'

type RequestShape = {
  id: string
  project_id: string | null
  routed_department_id: string | null
}

// Compute the full trigger status for one request.
export async function getRequestTriggerStatus(
  supabase: SupabaseClient,
  request: RequestShape,
): Promise<RequestTriggerStatus> {
  const [runsRes, jobRes] = await Promise.all([
    supabase
      .from('workflow_runs')
      .select(RUN_COLS)
      .eq('trigger_entity_type', 'request')
      .eq('trigger_entity_id', request.id)
      .order('created_at', { ascending: false })
      .limit(5),
    supabase
      .from('background_jobs')
      .select('id, status, created_at')
      .eq('related_request_id', request.id)
      .eq('job_type', 'workflow_step')
      .in('status', ACTIVE_JOB_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const recentRuns = (runsRes.data ?? []) as unknown as TriggerRunSummary[]
  const latestRun  = recentRuns[0] ?? null
  const activeRun  = recentRuns.find(r => ACTIVE_RUN_STATUSES.includes(r.status)) ?? null
  const latestFail = recentRuns.find(r => r.status === 'failed') ?? null
  const latestJob  = (jobRes.data ?? null) as unknown as TriggerJobSummary | null

  const missingInputs: string[] = []
  if (!request.project_id)          missingInputs.push('project_id')
  if (!request.routed_department_id) missingInputs.push('department_id')

  const hasActiveWorkflow = activeRun !== null || latestJob !== null

  return {
    workflow_id:         REQUEST_WORKFLOW_ID,
    recent_runs:         recentRuns,
    latest_run:          latestRun,
    active_run:          activeRun,
    latest_failure:      latestFail,
    latest_job:          latestJob,
    has_active_workflow: hasActiveWorkflow,
    missing_inputs:      missingInputs,
    can_trigger:         !hasActiveWorkflow,
  }
}
