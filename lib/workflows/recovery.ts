import { getServiceClient } from '@/lib/supabase/service'
import { enqueue } from '@/lib/jobs/enqueue'
import { getWorkflow } from './registry'
import { createError } from '@/lib/errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserContext } from '@/types/api'
import type {
  RecoverableRun,
  WorkflowRecoveryEligibility,
  WorkflowRecoveryResult,
} from '@/types/workflow-recovery'

// ─────────────────────────────────────────────────────────────
// Sprint 5.7 — Workflow Recovery Engine
//
// Governance (enforced here, not optional):
//   • Recovery NEVER executes workflow steps. retry/resume/restart only
//     enqueue a `workflow_step` background job; the worker executes it.
//   • Recovery NEVER mutates business records (tasks, work_packets, …).
//     The only writes are: background_jobs (enqueue), workflow_runs.status
//     (cancel / resume-lock), and execution_logs (audit trail).
//   • Approval gates are untouched — the executor's request_approval step
//     behaviour is unchanged, so recovery cannot bypass it.
// ─────────────────────────────────────────────────────────────

const RUN_COLS =
  'id, organization_id, workflow_id, status, current_step_index, inputs, accumulated, retry_count'

// Map each action to its canonical execution_log marker (recorded in metadata).
const RECOVERY_EVENT: Record<'retry' | 'resume' | 'restart' | 'cancel', string> = {
  retry:   'retry_requested',
  resume:  'resume_requested',
  restart: 'restart_requested',
  cancel:  'cancel_requested',
}

// ── Eligibility predicates ───────────────────────────────────
// Pure functions of run state. Safe to import into Server Components.

// Retry re-runs from step 0; only meaningful for a failed run.
export function canRetryRun(run: Pick<RecoverableRun, 'status'>): boolean {
  return run.status === 'failed'
}

// Resume continues from the failed step; requires a recorded step index.
export function canResumeRun(
  run: Pick<RecoverableRun, 'status' | 'current_step_index'>,
): boolean {
  return run.status === 'failed' && run.current_step_index !== null
}

// Restart re-runs from step 0 with lineage; allowed from any terminal state.
export function canRestartRun(run: Pick<RecoverableRun, 'status'>): boolean {
  return run.status === 'failed'
    || run.status === 'cancelled'
    || run.status === 'completed'
}

// Cancel stops an in-flight run; terminal runs cannot be cancelled.
export function canCancelRun(run: Pick<RecoverableRun, 'status'>): boolean {
  return run.status === 'pending'
    || run.status === 'running'
    || run.status === 'resuming'
}

export function getRecoveryEligibility(
  run: Pick<RecoverableRun, 'status' | 'current_step_index'>,
): WorkflowRecoveryEligibility {
  return {
    can_retry:   canRetryRun(run),
    can_resume:  canResumeRun(run),
    can_restart: canRestartRun(run),
    can_cancel:  canCancelRun(run),
  }
}

// ── Internal helpers ─────────────────────────────────────────

// Fetch the full run via service role, scoped to the actor's org as a
// defence-in-depth check (the API route has already confirmed RLS visibility).
async function fetchRun(
  svc: SupabaseClient,
  runId: string,
  organizationId: string,
): Promise<RecoverableRun> {
  const { data, error } = await svc
    .from('workflow_runs')
    .select(RUN_COLS)
    .eq('id', runId)
    .eq('organization_id', organizationId)
    .maybeSingle()

  if (error) throw createError('internal', `recovery: run fetch failed: ${error.message}`)
  if (!data) throw createError('not_found', 'Workflow run not found')
  return data as unknown as RecoverableRun
}

// Strip any resume directives that might have leaked into a stored inputs blob
// so retry/restart always re-enqueue with clean business context.
function cleanInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const {
    resume_from_step_index: _r,
    parent_run_id: _p,
    job_id: _j,
    ...rest
  } = inputs
  void _r; void _p; void _j
  return rest
}

// Write a single audit row for a recovery action (event_type/status are
// constrained by migration 007 — state_change + recorded are valid).
async function logRecovery(
  svc: SupabaseClient,
  ctx: UserContext,
  run: RecoverableRun,
  action: 'retry' | 'resume' | 'restart' | 'cancel',
  summary: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const { error } = await svc.from('execution_logs').insert({
    organization_id: run.organization_id,
    event_type:      'state_change',
    actor:           `user:${ctx.userId}`,
    summary,
    context_type:    'workflow',
    context_id:      run.id,
    metadata: {
      recovery_action: action,                 // 'retry' | 'resume' | 'restart' | 'cancel'
      recovery_event:  RECOVERY_EVENT[action], // canonical *_requested marker
      workflow_run_id: run.id,
      workflow_id:     run.workflow_id,
      actor_user_id:   ctx.userId,
      actor_role:      ctx.role,
      // extra supplies parent_run_id / new_run_id / new_job_id when available
      ...extra,
    },
    status: 'recorded',
  })
  // Audit failure is non-fatal: the recovery action itself already succeeded.
  if (error) console.warn(`[workflow-recovery] ${action} audit log failed:`, error.message)
}

function validateWorkflowExists(workflowId: string): void {
  if (!getWorkflow(workflowId)) {
    throw createError('validation', `Unknown workflow '${workflowId}' — cannot recover`)
  }
}

// ── Recovery actions ─────────────────────────────────────────

// retry: new run from step 0, original inputs, NO accumulated reuse.
// Lineage: parent_run_id = the failed run. retry_count = parent + 1
// (tracks "this is the Nth attempt" for transient-failure retries).
export async function retryWorkflowRun(
  runId: string,
  ctx: UserContext,
): Promise<WorkflowRecoveryResult> {
  const svc = getServiceClient()
  const run = await fetchRun(svc, runId, ctx.organizationId)

  if (!canRetryRun(run)) {
    throw createError('conflict', `Run is '${run.status}' — only failed runs can be retried`)
  }
  validateWorkflowExists(run.workflow_id)

  const nextRetryCount = run.retry_count + 1

  const newJobId = await enqueue({
    job_type:        'workflow_step',
    organization_id: run.organization_id,
    payload: {
      workflow_id:         run.workflow_id,
      inputs:              cleanInputs(run.inputs),
      parent_run_id:       run.id,            // lineage to the failed run
      initial_retry_count: nextRetryCount,    // increment (no resume_from_step_index → step 0, fresh accumulated)
    },
    created_by_user_id: ctx.userId,
  })

  await logRecovery(svc, ctx, run, 'retry',
    `Workflow run retry requested (run ${run.id}, attempt ${nextRetryCount})`,
    { new_job_id: newJobId, parent_run_id: run.id, new_run_id: null })

  return {
    action:                 'retry',
    source_run_id:          run.id,
    outcome:                'enqueued',
    new_job_id:             newJobId,
    new_run_id:             null,
    parent_run_id:          run.id,
    resume_from_step_index: null,
    message:                `Retry enqueued — a new run will start from step 0 (attempt ${nextRetryCount}), linked to this run.`,
  }
}

// resume: child run from the failed step, inheriting accumulated. Idempotency-safe.
export async function resumeWorkflowRun(
  runId: string,
  ctx: UserContext,
): Promise<WorkflowRecoveryResult> {
  const svc = getServiceClient()
  const run = await fetchRun(svc, runId, ctx.organizationId)

  if (!canResumeRun(run)) {
    throw createError('conflict',
      `Run is '${run.status}' (step index ${run.current_step_index ?? 'null'}) — cannot resume`)
  }
  validateWorkflowExists(run.workflow_id)

  const workflow = getWorkflow(run.workflow_id)!
  const resumeIndex = run.current_step_index as number
  if (resumeIndex < 0 || resumeIndex >= workflow.steps.length) {
    throw createError('validation',
      `Resume index ${resumeIndex} is out of range for workflow '${run.workflow_id}'`)
  }

  // Race lock: atomically move the parent failed → resuming. If a second
  // operator already triggered resume, 0 rows match and we 409.
  const { data: locked, error: lockErr } = await svc
    .from('workflow_runs')
    .update({ status: 'resuming' })
    .eq('id', run.id)
    .eq('status', 'failed')
    .select('id')

  if (lockErr) throw createError('internal', `resume lock failed: ${lockErr.message}`)
  if (!locked || locked.length === 0) {
    throw createError('conflict', 'Run is already being resumed or is no longer failed')
  }

  const nextRetryCount = run.retry_count + 1

  // Enqueue the resume job. If enqueue throws, revert the lock so the run
  // returns to 'failed' and remains resumable.
  let newJobId: string
  try {
    newJobId = await enqueue({
      job_type:        'workflow_step',
      organization_id: run.organization_id,
      payload: {
        workflow_id:            run.workflow_id,
        inputs:                 cleanInputs(run.inputs),
        parent_run_id:          run.id,
        resume_from_step_index: resumeIndex,    // inherit accumulated, skip steps < this
        initial_retry_count:    nextRetryCount,  // increment
      },
      created_by_user_id: ctx.userId,
    })
  } catch (err) {
    await svc.from('workflow_runs').update({ status: 'failed' }).eq('id', run.id)
    throw err
  }

  await logRecovery(svc, ctx, run, 'resume',
    `Workflow run resume requested from step ${resumeIndex} (run ${run.id}, attempt ${nextRetryCount})`,
    { new_job_id: newJobId, parent_run_id: run.id, new_run_id: null, resume_from_step_index: resumeIndex })

  return {
    action:                 'resume',
    source_run_id:          run.id,
    outcome:                'enqueued',
    new_job_id:             newJobId,
    new_run_id:             null,
    parent_run_id:          run.id,
    resume_from_step_index: resumeIndex,
    message:                `Resume enqueued — a child run will continue from step ${resumeIndex}.`,
  }
}

// restart: fresh run from step 0, fresh accumulated, retry_count RESET to 0.
// Lineage: parent_run_id = the original run. Use when an operator deliberately
// wants a completely new execution (not a transient-failure retry).
export async function restartWorkflowRun(
  runId: string,
  ctx: UserContext,
): Promise<WorkflowRecoveryResult> {
  const svc = getServiceClient()
  const run = await fetchRun(svc, runId, ctx.organizationId)

  if (!canRestartRun(run)) {
    throw createError('conflict',
      `Run is '${run.status}' — only failed, cancelled, or completed runs can be restarted`)
  }
  validateWorkflowExists(run.workflow_id)

  const newJobId = await enqueue({
    job_type:        'workflow_step',
    organization_id: run.organization_id,
    payload: {
      workflow_id:         run.workflow_id,
      inputs:              cleanInputs(run.inputs),
      parent_run_id:       run.id,    // lineage to the original run
      initial_retry_count: 0,         // reset (no resume_from_step_index → step 0, fresh accumulated)
    },
    created_by_user_id: ctx.userId,
  })

  await logRecovery(svc, ctx, run, 'restart',
    `Workflow run restart requested (run ${run.id})`,
    { new_job_id: newJobId, parent_run_id: run.id, new_run_id: null })

  return {
    action:                 'restart',
    source_run_id:          run.id,
    outcome:                'enqueued',
    new_job_id:             newJobId,
    new_run_id:             null,
    parent_run_id:          run.id,
    resume_from_step_index: null,
    message:                'Restart enqueued — a new run will start from step 0, linked to this run.',
  }
}

// cancel: synchronous status change; no job enqueued, nothing executes.
export async function cancelWorkflowRun(
  runId: string,
  ctx: UserContext,
): Promise<WorkflowRecoveryResult> {
  const svc = getServiceClient()
  const run = await fetchRun(svc, runId, ctx.organizationId)

  if (!canCancelRun(run)) {
    throw createError('conflict',
      `Run is '${run.status}' — only pending, running, or resuming runs can be cancelled`)
  }

  // Atomic guard against a race with the worker completing the run.
  const { data: cancelled, error: cancelErr } = await svc
    .from('workflow_runs')
    .update({ status: 'cancelled' })
    .eq('id', run.id)
    .in('status', ['pending', 'running', 'resuming'])
    .select('id')

  if (cancelErr) throw createError('internal', `cancel failed: ${cancelErr.message}`)
  if (!cancelled || cancelled.length === 0) {
    throw createError('conflict', 'Run is no longer cancellable (it may have just completed)')
  }

  await logRecovery(svc, ctx, run, 'cancel',
    `Workflow run cancelled (run ${run.id})`,
    { cancelled: true })

  return {
    action:                 'cancel',
    source_run_id:          run.id,
    outcome:                'cancelled',
    new_job_id:             null,
    new_run_id:             null,
    parent_run_id:          null,
    resume_from_step_index: null,
    message:                'Workflow run cancelled.',
  }
}
