import type { WorkflowRunRow } from '@/types/workflow-runs'

// ─────────────────────────────────────────────────────────────
// Sprint 5.7 — Workflow Recovery Decision Model
//
// Four operator-driven recovery actions for workflow runs. All four are
// *requests* — the API route enqueues work (or marks status) and the worker
// performs any execution. No business records are mutated by recovery itself.
//
//   retry    Re-run the workflow from step 0 using the original inputs.
//            A fresh workflow_run is created (no parent link). Use for
//            transient failures. ⚠ Re-runs side-effecting steps → may
//            duplicate business records created by the original run.
//
//   resume   Continue a failed run from its failed/current step. A child
//            workflow_run is created with parent_run_id = failed run id and
//            resume_from_step_index = the failed step index. The child inherits
//            the parent's accumulated dict, so already-completed side-effecting
//            steps are NOT re-run. This is the idempotency-safe path.
//
//   restart  Re-run from step 0 but record lineage: a new workflow_run is
//            created with parent_run_id = original run id. Like retry, it
//            re-runs side-effecting steps → same duplication caveat.
//
//   cancel   Mark an in-flight run (pending/running/resuming) as cancelled.
//            No job is enqueued; nothing executes. Terminal runs cannot be
//            cancelled.
// ─────────────────────────────────────────────────────────────

export type WorkflowRecoveryAction = 'retry' | 'resume' | 'restart' | 'cancel'

export const WORKFLOW_RECOVERY_ACTIONS: readonly WorkflowRecoveryAction[] = [
  'retry',
  'resume',
  'restart',
  'cancel',
] as const

export function isWorkflowRecoveryAction(v: unknown): v is WorkflowRecoveryAction {
  return typeof v === 'string'
    && (WORKFLOW_RECOVERY_ACTIONS as readonly string[]).includes(v)
}

// POST body for /api/workflow-runs/[id]/recovery
export interface WorkflowRecoveryRequest {
  action: WorkflowRecoveryAction
}

// Outcome of a recovery action.
//
// retry/resume/restart enqueue a background job; the worker creates the new
// workflow_run, so new_run_id is unknown at request time and is returned null.
// new_job_id links to the enqueued job (visible at /background-jobs).
//
// cancel performs the state change synchronously: status='cancelled',
// new_job_id and new_run_id are null.
export interface WorkflowRecoveryResult {
  action: WorkflowRecoveryAction
  source_run_id: string
  outcome: 'enqueued' | 'cancelled'
  new_job_id: string | null
  new_run_id: string | null
  parent_run_id: string | null
  resume_from_step_index: number | null
  message: string
}

// Per-run eligibility flags — drives which buttons render in the detail UI.
// Computed purely from run.status (and current_step_index for resume).
export interface WorkflowRecoveryEligibility {
  can_retry: boolean
  can_resume: boolean
  can_restart: boolean
  can_cancel: boolean
}

// Convenience alias for helper signatures.
export type RecoverableRun = Pick<WorkflowRunRow,
  | 'id'
  | 'organization_id'
  | 'workflow_id'
  | 'status'
  | 'current_step_index'
  | 'inputs'
  | 'accumulated'
  | 'retry_count'
>
