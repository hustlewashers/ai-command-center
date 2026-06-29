import { executeWorkflow } from '@/lib/workflows/execute'
import type { BackgroundJob } from '@/types/jobs'
import type { WorkflowExecutionContext } from '@/types/workflows'

interface WorkflowStepPayload {
  workflow_id: string
  inputs: WorkflowExecutionContext
  // Recovery directives (Sprint 5.7) — present only for retry/resume/restart jobs.
  parent_run_id?: string | null
  resume_from_step_index?: number | null
  initial_retry_count?: number | null
}

export async function handleWorkflowStep(job: BackgroundJob): Promise<void> {
  const payload = job.payload as Partial<WorkflowStepPayload>

  if (!payload.workflow_id) throw new Error('workflow_id is required in job payload')
  if (!payload.inputs)      throw new Error('inputs is required in job payload')
  if (!payload.inputs.organization_id) {
    throw new Error('inputs.organization_id is required in job payload')
  }

  // Stamp the job id into context so execution_logs can use it as context_id.
  // Thread recovery directives (Sprint 5.7) through as reserved context keys;
  // the executor reads them and strips them before persisting run.inputs.
  const ctx: WorkflowExecutionContext = {
    ...payload.inputs,
    job_id: job.id,
  }
  if (payload.parent_run_id != null) {
    ctx.parent_run_id = payload.parent_run_id
  }
  if (payload.resume_from_step_index != null) {
    ctx.resume_from_step_index = payload.resume_from_step_index
  }
  if (payload.initial_retry_count != null) {
    ctx.initial_retry_count = payload.initial_retry_count
  }

  const result = await executeWorkflow(payload.workflow_id, ctx)

  if (!result.success) {
    const step = result.failed_step
    throw new Error(
      `Workflow '${payload.workflow_id}' failed at step '${step?.step_id ?? '?'}': ${step?.error ?? 'unknown error'}`
    )
  }
}
