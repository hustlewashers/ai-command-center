import { getServiceClient } from '@/lib/supabase/service'
import { getWorkflow } from './registry'
import { executeStep } from './step-executor'
import type { WorkflowExecutionContext, WorkflowExecutionResult } from '@/types/workflows'

export async function executeWorkflow(
  workflowId: string,
  ctx: WorkflowExecutionContext,
): Promise<WorkflowExecutionResult> {
  const workflow = getWorkflow(workflowId)
  if (!workflow) throw new Error(`Unknown workflow id: '${workflowId}'`)

  const svc = getServiceClient()
  const contextId = (ctx.job_id as string | null | undefined) ?? ctx.organization_id
  const accumulated: Record<string, unknown> = {}
  const completedSteps: WorkflowExecutionResult['completed_steps'] = []

  // Workflow start log
  await svc.from('execution_logs').insert({
    organization_id: ctx.organization_id,
    event_type:      'state_change',
    actor:           'worker:workflow-executor',
    summary:         `Workflow started: ${workflow.name} (${workflowId})`,
    context_type:    'workflow',
    context_id:      contextId,
    metadata:        { workflow_id: workflowId, step_count: workflow.steps.length },
    status:          'recorded',
  })

  for (const step of workflow.steps) {
    try {
      const result = await executeStep(step, ctx, accumulated)
      completedSteps.push(result)
      if (result.output) Object.assign(accumulated, result.output)
      if (step.type === 'complete') break
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failedStep = {
        step_id: step.id,
        type:    step.type,
        success: false,
        error:   message,
      }

      // Failure log — status='flagged' so it surfaces in dashboards
      await svc.from('execution_logs').insert({
        organization_id: ctx.organization_id,
        event_type:      'error',
        actor:           'worker:workflow-executor',
        summary:         `Workflow step failed: ${step.id} — ${message}`,
        context_type:    'workflow',
        context_id:      contextId,
        metadata:        {
          workflow_id:       workflowId,
          failed_step_id:    step.id,
          failed_step_type:  step.type,
          error:             message,
          completed_so_far:  completedSteps.length,
        },
        status: 'flagged',
      })

      return {
        workflow_id:      workflowId,
        completed_steps:  completedSteps,
        failed_step:      failedStep,
        success:          false,
        accumulated,
      }
    }
  }

  // Workflow completion log
  await svc.from('execution_logs').insert({
    organization_id: ctx.organization_id,
    event_type:      'state_change',
    actor:           'worker:workflow-executor',
    summary:         `Workflow completed: ${workflow.name} (${workflowId})`,
    context_type:    'workflow',
    context_id:      contextId,
    metadata:        {
      workflow_id:      workflowId,
      steps_completed:  completedSteps.length,
      accumulated,
    },
    status: 'recorded',
  })

  return {
    workflow_id:     workflowId,
    completed_steps: completedSteps,
    success:         true,
    accumulated,
  }
}
