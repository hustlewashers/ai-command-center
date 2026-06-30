import { getServiceClient } from '@/lib/supabase/service'
import { executeCallAi } from '@/lib/ai/execute-call-ai'
import type { AiPromptId } from '@/types/ai'
import type {
  WorkflowStepDefinition,
  WorkflowStepResult,
  WorkflowExecutionContext,
} from '@/types/workflows'

// Resolves which UUID to use as execution_log.context_id.
// Falls back to organization_id (always a UUID) if no job_id is available.
function logContextId(ctx: WorkflowExecutionContext): string {
  return (ctx.job_id as string | null | undefined) ?? ctx.organization_id
}

export async function executeStep(
  step: WorkflowStepDefinition,
  ctx: WorkflowExecutionContext,
  accumulated: Record<string, unknown>,
): Promise<WorkflowStepResult> {
  const svc = getServiceClient()

  switch (step.type) {
    // ------------------------------------------------------------------ //
    case 'write_execution_log': {
      const message = (step.params?.['message'] as string | undefined)
        ?? `Workflow step: ${step.id}`

      const { data, error } = await svc
        .from('execution_logs')
        .insert({
          organization_id: ctx.organization_id,
          event_type:      'note',
          actor:           'worker:workflow-step',
          summary:         message,
          context_type:    'workflow',
          context_id:      logContextId(ctx),
          metadata:        { step_id: step.id, workflow_inputs: ctx },
          status:          'recorded',
        })
        .select('id')
        .single()

      if (error) throw new Error(`write_execution_log failed: ${error.message}`)
      return {
        step_id: step.id,
        type:    step.type,
        success: true,
        output:  { execution_log_id: (data as { id: string }).id },
      }
    }

    // ------------------------------------------------------------------ //
    case 'create_task': {
      if (!ctx.project_id)    throw new Error('create_task requires project_id in workflow inputs')
      if (!ctx.department_id) throw new Error('create_task requires department_id in workflow inputs')
      if (!ctx.title)         throw new Error('create_task requires title in workflow inputs')
      if (!ctx.created_by)    throw new Error('create_task requires created_by (user id) in workflow inputs')

      const { data, error } = await svc
        .from('tasks')
        .insert({
          organization_id:     ctx.organization_id,
          project_id:          ctx.project_id,
          department_id:       ctx.department_id,
          title:               ctx.title,
          status:              'backlog',
          priority:            'normal',
          created_by:          ctx.created_by,           // FK → users.id
          request_id:          ctx.request_id ?? null,
          work_packet_id:      null,
          workflow_id:         null,
          tool_profile_id:     null,
          assigned_to_user_id: null,
        })
        .select('id')
        .single()

      if (error) throw new Error(`create_task failed: ${error.message}`)
      return {
        step_id: step.id,
        type:    step.type,
        success: true,
        output:  { task_id: (data as { id: string }).id },
      }
    }

    // ------------------------------------------------------------------ //
    case 'create_work_packet': {
      // task_id comes from the create_task step output accumulated above
      const taskId = accumulated['task_id'] as string | undefined
      if (!taskId)            throw new Error('create_work_packet requires task_id from a prior create_task step')
      if (!ctx.department_id) throw new Error('create_work_packet requires department_id in workflow inputs')
      if (!ctx.title)         throw new Error('create_work_packet requires title in workflow inputs')
      if (!ctx.created_by)    throw new Error('create_work_packet requires created_by (user id) in workflow inputs')

      const { data, error } = await svc
        .from('work_packets')
        .insert({
          organization_id:               ctx.organization_id,
          author_user_id:                ctx.created_by,   // FK → users.id
          department_id:                 ctx.department_id,
          parent_type:                   'task',
          parent_id:                     taskId,
          title:                         `Work packet: ${ctx.title}`,
          objective:                     `Execute task: ${ctx.title}`,
          status:                        'draft',
          priority:                      'normal',
          approval_required_before_start: false,
          scope:                         {},
          acceptance_criteria:           [],
          constraints:                   {},
        })
        .select('id')
        .single()

      if (error) throw new Error(`create_work_packet failed: ${error.message}`)
      return {
        step_id: step.id,
        type:    step.type,
        success: true,
        output:  { work_packet_id: (data as { id: string }).id },
      }
    }

    // ------------------------------------------------------------------ //
    case 'create_output': {
      // Creates a DRAFT output only (Sprint 6.1). Never delivered, never approved.
      // Prefers AI-produced fields from accumulated.ai_result (call_ai step),
      // falling back to workflow inputs. Requires a task + project + department.
      const taskId = (accumulated['task_id'] as string | undefined) ?? (ctx.task_id as string | undefined)
      if (!taskId)            throw new Error('create_output requires task_id (from a prior step or workflow inputs)')
      if (!ctx.project_id)    throw new Error('create_output requires project_id in workflow inputs')
      if (!ctx.department_id) throw new Error('create_output requires department_id in workflow inputs')

      const ai = accumulated['ai_result'] as Record<string, unknown> | undefined
      const title   = (typeof ai?.['title'] === 'string' ? ai['title'] as string : (ctx.title as string | undefined)) ?? 'Draft output'
      const content = typeof ai?.['summary'] === 'string' ? ai['summary'] as string : null

      const { data, error } = await svc
        .from('outputs')
        .insert({
          organization_id:    ctx.organization_id,
          department_id:       ctx.department_id,
          task_id:             taskId,
          project_id:          ctx.project_id,
          title,
          output_type:         (step.params?.['output_type'] as string | undefined) ?? 'report',
          content,
          status:              'draft',        // DRAFT ONLY — no delivery, no approval
          created_by_user_id:  ctx.created_by ?? null,
        })
        .select('id')
        .single()

      if (error) throw new Error(`create_output failed: ${error.message}`)
      return {
        step_id: step.id,
        type:    step.type,
        success: true,
        output:  { output_id: (data as { id: string }).id },
      }
    }

    // ------------------------------------------------------------------ //
    case 'request_approval': {
      // Creates a PENDING approval for a draft output so a HUMAN must review it
      // before any delivery (Sprint 6.1). This NEVER approves anything — it only
      // opens a pending gate. If the subject can't be safely resolved (no output
      // in accumulated) or the insert is denied, fall back to a logged no-op.
      const outputId = accumulated['output_id'] as string | undefined
      if (outputId && ctx.department_id) {
        const { data, error } = await svc
          .from('approvals')
          .insert({
            organization_id:      ctx.organization_id,
            department_id:         ctx.department_id,
            subject_type:         'output',
            subject_id:           outputId,
            category:             'a',
            trigger_reason:       'AI-generated draft output requires human review before delivery',
            requested_by_user_id: ctx.created_by ?? null,
            approver_role:        'department_lead',
            status:               'pending',
          })
          .select('id')
          .single()

        if (!error && data) {
          await svc.from('execution_logs').insert({
            organization_id: ctx.organization_id,
            event_type:      'approval_action',
            actor:           'worker:workflow-step',
            summary:         `Approval requested for output ${outputId} (pending human review)`,
            context_type:    'workflow',
            context_id:      logContextId(ctx),
            metadata:        { step_id: step.id, approval_id: (data as { id: string }).id, subject_type: 'output', subject_id: outputId },
            status:          'recorded',
          })
          return { step_id: step.id, type: step.type, success: true, output: { approval_id: (data as { id: string }).id } }
        }
        console.warn('[step-executor] request_approval insert failed, falling back to no-op log:', error?.message)
      }

      // Fallback: subject unresolved or insert denied → logged no-op (non-fatal).
      const { error: logErr } = await svc.from('execution_logs').insert({
        organization_id: ctx.organization_id,
        event_type:      'note',
        actor:           'worker:workflow-step',
        summary:         `request_approval step '${step.id}' — no approval created (subject unresolved)`,
        context_type:    'workflow',
        context_id:      logContextId(ctx),
        metadata:        { step_id: step.id, has_output_id: !!outputId },
        status:          'recorded',
      })
      if (logErr) console.warn('[step-executor] request_approval log failed:', logErr.message)
      return { step_id: step.id, type: step.type, success: true, output: {} }
    }

    // ------------------------------------------------------------------ //
    case 'call_ai': {
      // Governed AI step: produces validated structured DRAFT output only.
      // Writes NO business records here; subsequent steps materialize drafts.
      const promptId = step.params?.['prompt_id'] as AiPromptId | undefined
      if (!promptId) throw new Error('call_ai requires params.prompt_id')

      // Whitelist which ctx/accumulated keys may enter the prompt (default: intent).
      const inputKeys = (step.params?.['input_keys'] as string[] | undefined) ?? ['intent']
      const variables: Record<string, unknown> = {}
      for (const k of inputKeys) {
        if (ctx[k] !== undefined && ctx[k] !== null) variables[k] = ctx[k]
        else if (accumulated[k] !== undefined && accumulated[k] !== null) variables[k] = accumulated[k]
      }

      const result = await executeCallAi(promptId, variables, ctx, step.id)
      return {
        step_id: step.id,
        type:    step.type,
        success: true,
        output: {
          ai_result:  result.ai_result,
          prompt_id:  result.prompt_id,
          model:      result.model,
          confidence: result.confidence,
        },
      }
    }

    // ------------------------------------------------------------------ //
    case 'complete': {
      return { step_id: step.id, type: step.type, success: true, output: {} }
    }

    // ------------------------------------------------------------------ //
    default: {
      throw new Error(`Unknown step type: ${(step as WorkflowStepDefinition).type}`)
    }
  }
}
