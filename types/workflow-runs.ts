import type { ExecutionLogRow } from '@/types/execution-logs'

// Status enums mirror migration 023 check constraints exactly.
export type WorkflowRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'resuming'

export type WorkflowStepRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'

// Full row shape for workflow_runs (migration 023).
// inputs and accumulated are large JSONB; omit from list queries, include in detail.
export interface WorkflowRunRow {
  id: string
  organization_id: string
  workflow_id: string
  workflow_version: number
  background_job_id: string | null
  parent_run_id: string | null
  status: WorkflowRunStatus
  trigger_type: string | null
  trigger_entity_type: string | null
  trigger_entity_id: string | null
  inputs: Record<string, unknown>
  accumulated: Record<string, unknown>
  started_at: string | null
  completed_at: string | null
  failed_at: string | null
  current_step_id: string | null
  current_step_index: number | null
  retry_count: number
  error_message: string | null
  created_at: string
  updated_at: string
}

// List-safe subset: excludes inputs and accumulated to keep payloads small.
export type WorkflowRunSummary = Omit<WorkflowRunRow, 'inputs' | 'accumulated'>

// Full row shape for workflow_step_runs (migration 023).
export interface WorkflowStepRunRow {
  id: string
  organization_id: string
  workflow_run_id: string
  step_id: string
  step_index: number
  step_type: string
  status: WorkflowStepRunStatus
  started_at: string | null
  completed_at: string | null
  duration_ms: number | null
  retry_count: number
  input_payload: Record<string, unknown>
  output_payload: Record<string, unknown> | null
  error_message: string | null
  created_at: string
}

// Shape returned by GET /api/workflow-runs/:id
export interface WorkflowRunDetail {
  run: WorkflowRunRow
  steps: WorkflowStepRunRow[]
  logs: ExecutionLogRow[]
}
