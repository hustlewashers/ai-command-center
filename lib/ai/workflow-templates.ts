import type {
  AiWorkflowTemplateDefinition,
  AiWorkflowTemplateId,
} from '@/types/ai'

// Sprint 7.1 — AI Workflow Template Registry.
//
// Reusable BLUEPRINTS for governed AI workflows. A template captures the
// repeatable shape of a class of AI workflows (output target, approval policy,
// readiness policy, governance boundaries) so a new workflow can be declared
// consistently. Templates are pure serializable metadata — a coordination /
// read-model + documentation layer. They:
//   • NEVER execute anything (the runtime workflow registry owns execution),
//   • hold NO privilege and CANNOT bypass approvals or auto-deliver outputs,
//   • register NO prompt and create NO runtime workflow.
//
// Only `ai_draft_output_from_entity` is `active` and actually backs a registered
// workflow (request_ai_summary). The other two are `experimental` blueprints for
// FUTURE workflows — no prompts, no runtime workflows exist for them yet.

// Governance boundaries shared by every governed AI template. Kept as constants
// so each template restates the same non-negotiable guarantees.
const FORBIDDEN_ACTIONS = [
  'deliver_output',
  'approve_approval',
  'reject_approval',
  'transition_task',
  'transition_work_packet',
  'mutate_governed_state_directly',
  'call_external_tools',
  'auto_trigger_without_human',
]

const DRAFT_ONLY_ACTIONS = [
  'produce_draft_output',
  'open_pending_approval',
  'write_execution_log',
]

const AI_WORKFLOW_TEMPLATES: Record<AiWorkflowTemplateId, AiWorkflowTemplateDefinition> = {
  // 1) The one active template — backs request_ai_summary.
  ai_draft_output_from_entity: {
    id:       'ai_draft_output_from_entity',
    name:     'AI Draft Output from Entity',
    purpose:  'Generic AI draft-output workflow for entity summaries, reports, briefs, and analysis. AI produces a structured draft output; a human approval gates any delivery.',
    category: 'draft',
    supported_target_entities: ['request', 'task', 'work_packet', 'decision', 'project'],
    default_prompt_id: 'REQUEST_SUMMARIZER',
    default_output_target: { type: 'output', output_type: 'report', status: 'draft' },
    default_approval_policy: {
      required: true,
      approver_role: 'department_lead',
      must_precede_governed_change: true,
    },
    default_readiness_policy: {
      require_project:     true,
      require_department:  true,
      require_linked_task: true,
      block_active_run:    true,
      block_active_job:    true,
      block_failed:        true,
      block_completed:     true,
    },
    required_inputs: [
      { key: 'organization_id', description: 'Owning organization (scope).' },
      { key: 'department_id',   description: 'Routed department (scope).' },
      { key: 'project_id',      description: 'Project the draft belongs to.' },
      { key: 'task_id',         description: 'Linked task the output attaches to.' },
      { key: 'intent',          description: 'Source entity intent/body the AI summarizes.' },
      { key: 'title',           description: 'Human-readable title seed for the draft.' },
    ],
    optional_inputs: [],
    governed_actions_allowed: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'active',
  },

  // 2) Blueprint only — no prompt, no runtime workflow yet.
  ai_classification_with_review: {
    id:       'ai_classification_with_review',
    name:     'AI Classification with Human Review',
    purpose:  'AI proposes a classification, risk level, or category as a draft. A human must review before any governed change is applied.',
    category: 'classification',
    supported_target_entities: ['request', 'task', 'work_packet', 'decision'],
    default_prompt_id: null,   // a classification prompt must be registered per instantiation
    default_output_target: { type: 'output', output_type: 'classification', status: 'draft' },
    default_approval_policy: {
      required: true,
      approver_role: 'department_lead',
      must_precede_governed_change: true,
    },
    default_readiness_policy: {
      require_project:     true,
      require_department:  true,
      require_linked_task: false,
      block_active_run:    true,
      block_active_job:    true,
      block_failed:        true,
      block_completed:     true,
    },
    required_inputs: [
      { key: 'organization_id', description: 'Owning organization (scope).' },
      { key: 'department_id',   description: 'Routed department (scope).' },
      { key: 'subject_text',    description: 'Text/attributes the AI classifies.' },
    ],
    optional_inputs: [
      { key: 'candidate_labels', description: 'Allowed labels to choose from, if constrained.' },
    ],
    governed_actions_allowed: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'experimental',
  },

  // 3) Blueprint only — no prompt, no runtime workflow yet.
  ai_recommendation_with_approval: {
    id:       'ai_recommendation_with_approval',
    name:     'AI Recommendation with Approval',
    purpose:  'AI proposes next actions or a decision as a draft recommendation. Existing approval gates remain required before anything is acted on.',
    category: 'recommendation',
    supported_target_entities: ['request', 'task', 'work_packet', 'decision', 'project'],
    default_prompt_id: null,   // a recommendation prompt must be registered per instantiation
    default_output_target: { type: 'output', output_type: 'recommendation', status: 'draft' },
    default_approval_policy: {
      required: true,
      approver_role: 'department_lead',
      must_precede_governed_change: true,
    },
    default_readiness_policy: {
      require_project:     true,
      require_department:  true,
      require_linked_task: false,
      block_active_run:    true,
      block_active_job:    true,
      block_failed:        true,
      block_completed:     true,
    },
    required_inputs: [
      { key: 'organization_id', description: 'Owning organization (scope).' },
      { key: 'department_id',   description: 'Routed department (scope).' },
      { key: 'context_text',    description: 'Context the AI reasons over to recommend next steps.' },
    ],
    optional_inputs: [
      { key: 'goal', description: 'Objective the recommendation should optimize for.' },
    ],
    governed_actions_allowed: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'experimental',
  },
}

export function listAiWorkflowTemplates(): AiWorkflowTemplateDefinition[] {
  return Object.values(AI_WORKFLOW_TEMPLATES)
}

export function getAiWorkflowTemplate(id: string): AiWorkflowTemplateDefinition | undefined {
  return AI_WORKFLOW_TEMPLATES[id as AiWorkflowTemplateId]
}

export function isAiWorkflowTemplateActive(id: string): boolean {
  return getAiWorkflowTemplate(id)?.status === 'active'
}
