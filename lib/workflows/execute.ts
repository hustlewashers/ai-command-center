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

  // ── Recovery directives (Sprint 5.7) ────────────────────────────────────────
  // parent_run_id, resume_from_step_index, and initial_retry_count are passed by
  // the recovery helper via the job payload. They are NOT persisted into
  // run.inputs (stripped below) so a later retry/restart of a child run can't
  // accidentally re-resume or re-use a stale retry counter.
  //
  //   action   parent_run_id  resume_from_step_index  initial_retry_count
  //   ───────  ─────────────  ──────────────────────  ───────────────────
  //   (fresh)  null           null                    (absent → 0)
  //   retry    original       null                    parent + 1
  //   resume   failed run     failed step             parent + 1
  //   restart  original       null                    0
  const parentRunId = (ctx.parent_run_id as string | null | undefined) ?? null
  const resumeFromStepIndex =
    typeof ctx.resume_from_step_index === 'number' ? ctx.resume_from_step_index : null
  const explicitRetryCount =
    typeof ctx.initial_retry_count === 'number' ? ctx.initial_retry_count : null

  if (resumeFromStepIndex !== null) {
    if (!parentRunId) {
      throw new Error('resume_from_step_index requires parent_run_id')
    }
    if (resumeFromStepIndex < 0 || resumeFromStepIndex >= workflow.steps.length) {
      throw new Error(
        `resume_from_step_index ${resumeFromStepIndex} out of range for workflow '${workflowId}'`,
      )
    }
  }

  // Persisted inputs = clean business context only (no reserved directive keys).
  const {
    parent_run_id: _p,
    resume_from_step_index: _r,
    initial_retry_count: _irc,
    ...storedInputs
  } = ctx
  void _p; void _r; void _irc

  // On resume, inherit the parent run's accumulated dict so already-completed
  // side-effecting steps are not re-run. Fresh/retry/restart start empty.
  const accumulated: Record<string, unknown> = {}
  let runRetryCount = explicitRetryCount ?? 0
  if (resumeFromStepIndex !== null && parentRunId) {
    const { data: parent, error: parentErr } = await svc
      .from('workflow_runs')
      .select('accumulated, retry_count')
      .eq('id', parentRunId)
      .single()
    if (parentErr || !parent) {
      throw new Error(`resume: parent run fetch failed: ${parentErr?.message ?? 'not found'}`)
    }
    Object.assign(accumulated, (parent as { accumulated?: Record<string, unknown> }).accumulated ?? {})
    // Prefer the explicit counter from the recovery helper; fall back to parent + 1.
    runRetryCount = explicitRetryCount ?? (((parent as { retry_count?: number }).retry_count ?? 0) + 1)
  }

  const completedSteps: WorkflowExecutionResult['completed_steps'] = []
  // Track the actual index/id of the last executed step so the completed update
  // is correct for resumed runs (which execute only a suffix of the step list).
  let lastStepId: string | null    = null
  let lastStepIndex: number | null = null

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
      parent_run_id:       parentRunId,
      status:              'running',
      trigger_type:        (ctx.trigger_type        as string | null | undefined) ?? null,
      trigger_entity_type: (ctx.trigger_entity_type as string | null | undefined) ?? null,
      trigger_entity_id:   (ctx.trigger_entity_id   as string | null | undefined) ?? null,
      inputs:              storedInputs,
      accumulated:         { ...accumulated },
      started_at:          runStartedAt.toISOString(),
      current_step_index:  resumeFromStepIndex ?? 0,
      retry_count:         runRetryCount,
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

  // ── Existing execution_log: workflow start (unchanged shape; resume context added) ──
  await svc.from('execution_logs').insert({
    organization_id: ctx.organization_id,
    event_type:      'state_change',
    actor:           'worker:workflow-executor',
    summary:         resumeFromStepIndex !== null
      ? `Workflow resumed: ${workflow.name} (${workflowId}) from step ${resumeFromStepIndex}`
      : `Workflow started: ${workflow.name} (${workflowId})`,
    context_type:    'workflow',
    context_id:      contextId,
    metadata:        {
      workflow_id:            workflowId,
      workflow_run_id:        runId,
      step_count:             workflow.steps.length,
      ...(parentRunId          ? { parent_run_id: parentRunId } : {}),
      ...(resumeFromStepIndex !== null ? { resume_from_step_index: resumeFromStepIndex } : {}),
    },
    status:          'recorded',
  })

  // ── Step loop ───────────────────────────────────────────────────────────────
  for (let stepIndex = 0; stepIndex < workflow.steps.length; stepIndex++) {
    const step         = workflow.steps[stepIndex]

    // Resume: steps before the resume point were completed by the parent run.
    // Record a 'skipped' step row for timeline completeness, then move on.
    if (resumeFromStepIndex !== null && stepIndex < resumeFromStepIndex) {
      const { error: skipErr } = await svc.from('workflow_step_runs').insert({
        organization_id: ctx.organization_id,
        workflow_run_id: runId,
        step_id:         step.id,
        step_index:      stepIndex,
        step_type:       step.type,
        status:          'skipped',
        retry_count:     0,
        input_payload:   accumulated,
      })
      if (skipErr) {
        throw new Error(`workflow_step_runs (skipped) INSERT failed for step '${step.id}': ${skipErr.message}`)
      }
      continue
    }

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

      lastStepId    = step.id
      lastStepIndex = stepIndex

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
  const completedAt = new Date()

  await svc.from('workflow_runs').update({
    status:             'completed',
    completed_at:       completedAt.toISOString(),
    accumulated,
    current_step_id:    lastStepId,
    current_step_index: lastStepIndex,
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
