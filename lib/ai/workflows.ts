import type { AiWorkflowDefinition, AiWorkflowId } from '@/types/ai'

// Sprint 7.0 — AI Workflow Definition Layer.
//
// A reusable, in-code registry of governed AI workflows. It mirrors the shape of
// lib/workflows/registry.ts (the runtime registry) but is a COORDINATION /
// READ-MODEL layer only: it does NOT execute anything. The runtime registry still
// owns step execution; this registry centralizes the metadata that the UI,
// readiness evaluation, and draft-review read model share so a new AI workflow can
// be added declaratively instead of re-implementing each surface by hand.
//
// To add a new AI workflow (see docs/sprint-7-0-ai-workflow-framework.md):
//   1. Register its prompt in lib/ai/prompts.ts (+ types/ai.ts AiPromptId).
//   2. Add its runtime workflow (steps) to lib/workflows/registry.ts.
//   3. Register its metadata here (prompt_id, runtime_workflow_id, readiness, …).
// Nothing here may bypass approvals or auto-deliver outputs — approval_required
// and the output_target.status='draft' contract are declarative reminders of the
// governance the runtime enforces.

const AI_WORKFLOWS: Record<AiWorkflowId, AiWorkflowDefinition> = {
  request_ai_summary: {
    id:                  'request_ai_summary',
    name:                'Request → AI Summary (draft)',
    purpose:             'AI summarizes a request into a draft output and opens a pending approval for human review.',
    prompt_id:           'REQUEST_SUMMARIZER',
    runtime_workflow_id: 'request_ai_summary',
    trigger_entity_type: 'request',
    required_inputs:     ['organization_id', 'department_id', 'project_id', 'task_id', 'intent', 'title'],
    output_target:       { type: 'output', output_type: 'report', status: 'draft' },
    approval_required:   true,
    readiness: {
      require_project:     true,
      require_department:  true,
      require_linked_task: true,
      block_active_run:    true,
      block_active_job:    true,
      block_failed:        true,
      block_completed:     true,
    },
    status: 'active',
    template_id: 'ai_draft_output_from_entity',
    capability_id: 'request_summarization',
    agent_id: 'request_summary_assistant',
    supported_plan_ids: ['request_summary_review_plan'],
  },
}

export function getAiWorkflow(id: string): AiWorkflowDefinition | undefined {
  return AI_WORKFLOWS[id as AiWorkflowId]
}

export function listAiWorkflows(): AiWorkflowDefinition[] {
  return Object.values(AI_WORKFLOWS)
}

// The runtime workflow_id → AI workflow mapping, used to detect whether a given
// workflow_run belongs to a governed AI workflow (e.g. in draft-review).
export function getAiWorkflowByRuntimeId(runtimeWorkflowId: string): AiWorkflowDefinition | undefined {
  return Object.values(AI_WORKFLOWS).find(w => w.runtime_workflow_id === runtimeWorkflowId)
}

// All runtime workflow ids that are governed AI workflows. Used to scope run
// lookups so any registered AI workflow is recognized, not just one hardcoded id.
export function aiRuntimeWorkflowIds(): string[] {
  return [...new Set(Object.values(AI_WORKFLOWS).map(w => w.runtime_workflow_id))]
}
