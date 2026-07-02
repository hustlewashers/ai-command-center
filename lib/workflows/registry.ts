import type { WorkflowDefinition, WorkflowTriggerEntityType } from '@/types/workflows'

// In-code workflow registry.
// Mirrors the shape of future DB-backed workflow definitions so the executor
// stays generic and the registry can be migrated to a table later.

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  request_to_task: {
    id:          'request_to_task',
    name:        'Request → Task',
    description: 'Turns an incoming request into a task and work packet scaffold.',
    triggers:    ['request'],
    steps: [
      {
        id:   'log_start',
        type: 'write_execution_log',
        params: { message: 'Workflow started: request_to_task' },
      },
      {
        id:   'create_task_1',
        type: 'create_task',
      },
      {
        id:   'create_wp_1',
        type: 'create_work_packet',
      },
      {
        id:   'log_complete',
        type: 'write_execution_log',
        params: { message: 'Workflow completed: request_to_task' },
      },
      {
        id:   'complete',
        type: 'complete',
      },
    ],
  },

  // Sprint 6.1 — first governed AI workflow. Manual trigger only (no `triggers`):
  // AI summarizes a request into a DRAFT output, then a PENDING approval is opened
  // for human review. No delivery, no auto-approval, no irreversible action.
  request_ai_summary: {
    id:          'request_ai_summary',
    name:        'Request → AI Summary (draft)',
    description: 'AI summarizes a request into a draft output and opens a pending approval for human review.',
    steps: [
      {
        id:   'log_start',
        type: 'write_execution_log',
        params: { message: 'Workflow started: request_ai_summary' },
      },
      {
        id:   'ai_summarize',
        type: 'call_ai',
        // Sprint 8.1 — opt in to governed, org-scoped local retrieval (non-fatal).
        params: { prompt_id: 'REQUEST_SUMMARIZER', input_keys: ['intent', 'title'], retrieve: true, retrieval_policy_id: 'entity_local_context_v1', retrieval_entity: 'request' },
      },
      {
        id:   'create_summary_output',
        type: 'create_output',
        params: { output_type: 'report' },
      },
      {
        id:   'request_review',
        type: 'request_approval',
      },
      {
        id:   'complete',
        type: 'complete',
      },
    ],
  },

  // Sprint 7.9 — second governed AI workflow. Same draft-only, human-gated shape
  // as request_ai_summary, but summarizes a WORK PACKET. AI produces a DRAFT
  // output attached to the work packet's parent task, then a PENDING approval is
  // opened for human review. No delivery, no auto-approval.
  work_packet_ai_summary: {
    id:          'work_packet_ai_summary',
    name:        'Work Packet → AI Summary (draft)',
    description: 'AI summarizes a work packet into a draft output and opens a pending approval for human review.',
    steps: [
      {
        id:   'log_start',
        type: 'write_execution_log',
        params: { message: 'Workflow started: work_packet_ai_summary' },
      },
      {
        id:   'ai_summarize',
        type: 'call_ai',
        // Sprint 8.1 — opt in to governed, org-scoped local retrieval (non-fatal).
        params: { prompt_id: 'WORK_PACKET_SUMMARIZER', input_keys: ['title', 'objective'], retrieve: true, retrieval_policy_id: 'entity_local_context_v1', retrieval_entity: 'work_packet' },
      },
      {
        id:   'create_summary_output',
        type: 'create_output',
        params: { output_type: 'report' },
      },
      {
        id:   'request_review',
        type: 'request_approval',
      },
      {
        id:   'complete',
        type: 'complete',
      },
    ],
  },
}

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return WORKFLOWS[id]
}

export function listWorkflows(): WorkflowDefinition[] {
  return Object.values(WORKFLOWS)
}

// Does this workflow declare support for the given trigger entity type?
export function workflowSupportsTrigger(
  workflow: WorkflowDefinition,
  entityType: WorkflowTriggerEntityType,
): boolean {
  return (workflow.triggers ?? []).includes(entityType)
}

// All workflows that may be triggered by the given business entity type.
// Sprint 5.8: only request_to_task (trigger 'request'). Returns [] for task /
// approval until such workflows are declared.
export function findWorkflowsByTrigger(
  entityType: WorkflowTriggerEntityType,
): WorkflowDefinition[] {
  return Object.values(WORKFLOWS).filter(w => workflowSupportsTrigger(w, entityType))
}
