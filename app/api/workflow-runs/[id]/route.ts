import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import type { WorkflowRunDetail, WorkflowRunRow, WorkflowStepRunRow } from '@/types/workflow-runs'
import type { ExecutionLogRow } from '@/types/execution-logs'

type RouteParams = { params: Promise<{ id: string }> }

// Includes inputs and accumulated — callers need the full context for detail views
// and for resume support (inputs is required to reconstruct the execution context).
const RUN_DETAIL_COLS = [
  'id', 'organization_id', 'workflow_id', 'workflow_version',
  'background_job_id', 'parent_run_id', 'status',
  'trigger_type', 'trigger_entity_type', 'trigger_entity_id',
  'inputs', 'accumulated',
  'started_at', 'completed_at', 'failed_at',
  'current_step_id', 'current_step_index',
  'retry_count', 'error_message',
  'created_at', 'updated_at',
].join(', ')

const STEP_COLS = [
  'id', 'organization_id', 'workflow_run_id',
  'step_id', 'step_index', 'step_type', 'status',
  'started_at', 'completed_at', 'duration_ms',
  'retry_count', 'input_payload', 'output_payload', 'error_message',
  'created_at',
].join(', ')

const LOG_COLS = [
  'id', 'organization_id', 'event_type', 'actor',
  'occurred_at', 'summary', 'context_type', 'context_id',
  'metadata', 'status', 'created_at',
].join(', ')

// GET /api/workflow-runs/:id
// Returns a single workflow run with its step runs and related execution logs.
//
// RLS enforces org/dept visibility — if the run is not visible to the caller,
// maybeSingle() returns null and we surface not_found (no existence leak).
//
// Step runs are ordered by step_index asc, retry_count asc so the timeline
// renders correctly even when step-level retries exist.
//
// Execution logs are fetched via JSONB metadata path filter:
//   metadata->>'workflow_run_id' = :id
// This is non-fatal — if PostgREST rejects the filter, logs is returned empty
// and the run/steps are still returned.
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    // ── Fetch workflow_run ─────────────────────────────────────────────────────
    const { data: runData, error: runError } = await supabase
      .from('workflow_runs')
      .select(RUN_DETAIL_COLS)
      .eq('id', id)
      .maybeSingle()

    if (runError) throw new Error(runError.message)
    if (!runData) throw createError('not_found', 'Workflow run not found')

    // ── Fetch step runs ────────────────────────────────────────────────────────
    const { data: stepsData, error: stepsError } = await supabase
      .from('workflow_step_runs')
      .select(STEP_COLS)
      .eq('workflow_run_id', id)
      .order('step_index',   { ascending: true })
      .order('retry_count',  { ascending: true })

    if (stepsError) throw new Error(stepsError.message)

    // ── Fetch related execution_logs (non-fatal) ───────────────────────────────
    // PostgREST JSONB text-path filter: metadata->>'workflow_run_id' = id
    // If this filter is unsupported (old PostgREST), logsError is set and we
    // return an empty array rather than failing the whole request.
    let logs: ExecutionLogRow[] = []
    const { data: logsData, error: logsError } = await supabase
      .from('execution_logs')
      .select(LOG_COLS)
      .filter('metadata->>workflow_run_id', 'eq', id)
      .order('occurred_at', { ascending: true })
      .limit(50)

    if (logsError) {
      console.warn('[workflow-runs/[id]] execution_logs filter failed, returning empty:', logsError.message)
    } else {
      logs = (logsData ?? []) as unknown as ExecutionLogRow[]
    }

    // ── Compose detail response ────────────────────────────────────────────────
    const detail: WorkflowRunDetail = {
      run:   runData   as unknown as WorkflowRunRow,
      steps: (stepsData ?? []) as unknown as WorkflowStepRunRow[],
      logs,
    }

    return ok(detail)
  } catch (err) {
    return errorResponse(err)
  }
}
