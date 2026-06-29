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

  const svc        = getServiceClient()
  const jobId      = (ctx.job_id as string | null | undefined) ?? null
  const contextId  = jobId ?? ctx.organization_id   // UUID for execution_log.context_id
  const accumulated: Record<string, unknown> = {}
  const completedSteps: WorkflowExecutionResult['completed_steps'] = []

  // ── Create workflow_run row ─────────────────────────────────────────────────
  // Fatal: a run ID is required to write step rows. Throw so the job retries.
  const runStartedAt = new Date()

  const { data: runData, error: runError } = await svc
    .from('workflow_runs')
    .insert({
      organization_id:     ctx.organization_id,
      workflow_id:         workflowId,
      workflow_version:    1,
      background_job_id:   jobId,
      status:              'running',
      trigger_type:        (ctx.trigger_type        as string | null | undefined) ?? null,
      trigger_entity_type: (ctx.trigger_entity_type as string | null | undefined) ?? null,
      trigger_entity_id:   (ctx.trigger_entity_id   as string | null | undefined) ?? null,
      inputs:              ctx,
      accumulated:         {},
      started_at:          runStartedAt.toISOString(),
      current_step_index:  0,
      retry_count:         0,
    })
    .select('id')
    .single()

  if (runError || !runData) {
    throw new Error(`workflow_run INSERT failed: ${runError?.message ?? 'no data returned'}`)
  }
  const runId = (runData as { id: string }).id

  // ── Link background_job → workflow_run (non-fatal) ──────────────────────────
  // Don't block execution if this backlink write fails.
  if (jobId) {
    const { error: linkErr } = await svc
      .from('background_jobs')
      .update({ workflow_run_id: runId })
      .eq('id', jobId)
    if (linkErr) {
      console.warn('[workflow-executor] failed to set background_jobs.workflow_run_id:', linkErr.message)
    }
  }

  // ── Existing execution_log: workflow start (unchanged) ─────────────────────
  await svc.from('execution_logs').insert({
    organization_id: ctx.organization_id,
    event_type:      'state_change',
    actor:           'worker:workflow-executor',
    summary:         `Workflow started: ${workflow.name} (${workflowId})`,
    context_type:    'workflow',
    context_id:      contextId,
    metadata:        { workflow_id: workflowId, workflow_run_id: runId, step_count: workflow.steps.length },
    status:          'recorded',
  })

  // ── Step loop ───────────────────────────────────────────────────────────────
  for (let stepIndex = 0; stepIndex < workflow.steps.length; stepIndex++) {
    const step         = workflow.steps[stepIndex]
    const stepStartedAt = new Date()

    // Insert step_run row before execution (fatal: consistent with execution_logs behavior)
    const { data: stepData, error: stepInsertErr } = await svc
      .from('workflow_step_runs')
      .insert({
        organization_id: ctx.organization_id,
        workflow_run_id: runId,
        step_id:         step.id,
        step_index:      stepIndex,
        step_type:       step.type,
        status:          'running',
        retry_count:     0,
        input_payload:   accumulated,
        started_at:      stepStartedAt.toISOString(),
      })
      .select('id')
      .single()

    if (stepInsertErr || !stepData) {
      throw new Error(`workflow_step_runs INSERT failed for step '${step.id}': ${stepInsertErr?.message ?? 'no data returned'}`)
    }
    const stepRunId = (stepData as { id: string }).id

    try {
      const result = await executeStep(step, ctx, accumulated)
      completedSteps.push(result)
      if (result.output) Object.assign(accumulated, result.output)

      const stepCompletedAt = new Date()
      const durationMs      = stepCompletedAt.getTime() - stepStartedAt.getTime()

      // Update step_run: completed
      await svc.from('workflow_step_runs').update({
        status:         'completed',
        completed_at:   stepCompletedAt.toISOString(),
        duration_ms:    durationMs,
        output_payload: result.output ?? {},
      }).eq('id', stepRunId)

      // Update workflow_run position (enables real-time monitoring of long-running workflows)
      await svc.from('workflow_runs').update({
        current_step_id:    step.id,
        current_step_index: stepIndex,
        accumulated,
      }).eq('id', runId)

      if (step.type === 'complete') break
    } catch (err) {
      const message          = err instanceof Error ? err.message : String(err)
      const stepCompletedAt  = new Date()
      const durationMs       = stepCompletedAt.getTime() - stepStartedAt.getTime()

      // Update step_run: failed
      await svc.from('workflow_step_runs').update({
        status:        'failed',
        completed_at:  stepCompletedAt.toISOString(),
        duration_ms:   durationMs,
        error_message: message,
      }).eq('id', stepRunId)

      // Update workflow_run: failed — persist accumulated for future resume
      await svc.from('workflow_runs').update({
        status:             'failed',
        failed_at:          stepCompletedAt.toISOString(),
        current_step_id:    step.id,
        current_step_index: stepIndex,
        error_message:      message,
        accumulated,
      }).eq('id', runId)

      const failedStep = {
        step_id: step.id,
        type:    step.type,
        success: false,
        error:   message,
      }

      // Existing execution_log: step failure (unchanged; workflow_run_id added to metadata)
      await svc.from('execution_logs').insert({
        organization_id: ctx.organization_id,
        event_type:      'error',
        actor:           'worker:workflow-executor',
        summary:         `Workflow step failed: ${step.id} — ${message}`,
        context_type:    'workflow',
        context_id:      contextId,
        metadata:        {
          workflow_id:      workflowId,
          workflow_run_id:  runId,
          failed_step_id:   step.id,
          failed_step_type: step.type,
          error:            message,
          completed_so_far: completedSteps.length,
        },
        status: 'flagged',
      })

      return {
        workflow_id:     workflowId,
        workflow_run_id: runId,
        completed_steps: completedSteps,
        failed_step:     failedStep,
        success:         false,
        accumulated,
      }
    }
  }

  // ── Update workflow_run: completed ──────────────────────────────────────────
  const completedAt    = new Date()
  const lastStep       = completedSteps[completedSteps.length - 1]

  await svc.from('workflow_runs').update({
    status:             'completed',
    completed_at:       completedAt.toISOString(),
    accumulated,
    current_step_id:    lastStep?.step_id ?? null,
    current_step_index: completedSteps.length - 1,
  }).eq('id', runId)

  // ── Existing execution_log: workflow completion (unchanged) ─────────────────
  await svc.from('execution_logs').insert({
    organization_id: ctx.organization_id,
    event_type:      'state_change',
    actor:           'worker:workflow-executor',
    summary:         `Workflow completed: ${workflow.name} (${workflowId})`,
    context_type:    'workflow',
    context_id:      contextId,
    metadata:        {
      workflow_id:     workflowId,
      workflow_run_id: runId,
      steps_completed: completedSteps.length,
      accumulated,
    },
    status: 'recorded',
  })

  return {
    workflow_id:     workflowId,
    workflow_run_id: runId,
    completed_steps: completedSteps,
    success:         true,
    accumulated,
  }
}
