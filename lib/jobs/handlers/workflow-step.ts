import { executeWorkflow } from '@/lib/workflows/execute'
import type { BackgroundJob } from '@/types/jobs'
import type { WorkflowExecutionContext } from '@/types/workflows'

interface WorkflowStepPayload {
  workflow_id: string
  inputs: WorkflowExecutionContext
}

export async function handleWorkflowStep(job: BackgroundJob): Promise<void> {
  const payload = job.payload as Partial<WorkflowStepPayload>

  if (!payload.workflow_id) throw new Error('workflow_id is required in job payload')
  if (!payload.inputs)      throw new Error('inputs is required in job payload')
  if (!payload.inputs.organization_id) {
    throw new Error('inputs.organization_id is required in job payload')
  }

  // Stamp the job id into context so execution_logs can use it as context_id
  const ctx: WorkflowExecutionContext = {
    ...payload.inputs,
    job_id: job.id,
  }

  const result = await executeWorkflow(payload.workflow_id, ctx)

  if (!result.success) {
    const step = result.failed_step
    throw new Error(
      `Workflow '${payload.workflow_id}' failed at step '${step?.step_id ?? '?'}': ${step?.error ?? 'unknown error'}`
    )
  }
}
