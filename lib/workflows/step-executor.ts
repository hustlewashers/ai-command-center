import { getServiceClient } from '@/lib/supabase/service'
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
      // Deferred: output schema has approval gate complexity beyond MVP scope.
      // Log intent and complete gracefully.
      const { error } = await svc.from('execution_logs').insert({
        organization_id: ctx.organization_id,
        event_type:      'note',
        actor:           'worker:workflow-step',
        summary:         `create_output step '${step.id}' deferred — not yet implemented in MVP executor`,
        context_type:    'workflow',
        context_id:      logContextId(ctx),
        metadata:        { step_id: step.id },
        status:          'recorded',
      })
      if (error) console.warn('[step-executor] create_output log failed:', error.message)
      return { step_id: step.id, type: step.type, success: true, output: {} }
    }

    // ------------------------------------------------------------------ //
    case 'request_approval': {
      // MVP: no approval created — agent context and approval subject must be
      // confirmed by a human-facing path first. Write intent log only.
      const { error } = await svc.from('execution_logs').insert({
        organization_id: ctx.organization_id,
        event_type:      'note',
        actor:           'worker:workflow-step',
        summary:         `request_approval step '${step.id}' deferred — approval gate not yet automated in MVP`,
        context_type:    'workflow',
        context_id:      logContextId(ctx),
        metadata:        { step_id: step.id, accumulated },
        status:          'recorded',
      })
      if (error) console.warn('[step-executor] request_approval log failed:', error.message)
      return { step_id: step.id, type: step.type, success: true, output: {} }
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
