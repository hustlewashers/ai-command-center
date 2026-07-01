import type {
  AiCapabilityDefinition,
  AiCapabilityId,
} from '@/types/ai'

// Sprint 7.3 — AI Capability Registry.
//
// A reusable layer BETWEEN prompts and workflows. A capability describes WHAT the
// AI does (summarize, assess risk, recommend, classify) independent of any single
// prompt version or runtime workflow, so purpose, governance intent, output
// expectations, and evaluation metadata are declared once and reused.
//
// Registry / read-model only. Capabilities:
//   • NEVER execute anything (runtime workflows own execution),
//   • hold NO privilege and CANNOT bypass approvals or auto-deliver outputs,
//   • register NO prompt and create NO runtime workflow.
//
// Only `request_summarization` is `active` (backed by request_ai_summary). The
// rest are `planned` — declared intent with no prompt or runtime workflow yet.

// Governance boundaries shared by every governed AI capability.
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

// Governance policy shared by all draft-only, human-gated capabilities.
const DRAFT_GOVERNANCE = {
  approval_required: true,
  human_review_required: true,
  draft_only: true,
  may_mutate_governed_state: false as const,
}

const AI_CAPABILITIES: Record<AiCapabilityId, AiCapabilityDefinition> = {
  // 1) Active — realized by request_ai_summary.
  request_summarization: {
    id:          'request_summarization',
    name:        'Request Summarization',
    category:    'summarization',
    purpose:     'Summarize an incoming request into a structured draft for human review.',
    description: 'Reads a request\'s intent and produces a concise, structured draft summary with recommended next steps, a risk level, and a confidence score. Draft-only; a human approval gates any delivery.',
    supported_target_entities: ['request'],
    default_prompt_id:   'REQUEST_SUMMARIZER',
    default_template_id: 'ai_draft_output_from_entity',
    output_contract: {
      type: 'output',
      output_type: 'report',
      status: 'draft',
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'risk_level', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'active',
  },

  // 2) Planned — no prompt, no runtime workflow yet.
  risk_assessment: {
    id:          'risk_assessment',
    name:        'Risk Assessment',
    category:    'risk_assessment',
    purpose:     'Assess the risk of an entity and propose a risk level as a draft for human review.',
    description: 'Planned capability: AI proposes a risk level and rationale as a draft. A human must review before any governed change. No prompt or runtime workflow exists yet.',
    supported_target_entities: ['request', 'task', 'work_packet', 'decision'],
    default_prompt_id:   null,
    default_template_id: 'ai_classification_with_review',
    output_contract: {
      type: 'output',
      output_type: 'risk_assessment',
      status: 'draft',
      expected_fields: ['risk_level', 'rationale', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },

  // 3) Planned — no prompt, no runtime workflow yet.
  action_recommendation: {
    id:          'action_recommendation',
    name:        'Action Recommendation',
    category:    'recommendation',
    purpose:     'Propose next actions or a decision as a draft recommendation for human approval.',
    description: 'Planned capability: AI proposes recommended next actions as a draft. Existing approval gates remain required before anything is acted on. No prompt or runtime workflow exists yet.',
    supported_target_entities: ['request', 'task', 'work_packet', 'decision', 'project'],
    default_prompt_id:   null,
    default_template_id: 'ai_recommendation_with_approval',
    output_contract: {
      type: 'output',
      output_type: 'recommendation',
      status: 'draft',
      expected_fields: ['recommended_actions', 'rationale', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },

  // 4) Planned — no prompt, no runtime workflow yet.
  classification: {
    id:          'classification',
    name:        'Classification',
    category:    'classification',
    purpose:     'Classify an entity into a category or label as a draft for human review.',
    description: 'Planned capability: AI proposes a classification/category/label as a draft. A human must review before any governed change. No prompt or runtime workflow exists yet.',
    supported_target_entities: ['request', 'task', 'work_packet', 'decision'],
    default_prompt_id:   null,
    default_template_id: 'ai_classification_with_review',
    output_contract: {
      type: 'output',
      output_type: 'classification',
      status: 'draft',
      expected_fields: ['label', 'rationale', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },
}

export function listAiCapabilities(): AiCapabilityDefinition[] {
  return Object.values(AI_CAPABILITIES)
}

export function getAiCapability(id: string): AiCapabilityDefinition | undefined {
  return AI_CAPABILITIES[id as AiCapabilityId]
}

export function listActiveAiCapabilities(): AiCapabilityDefinition[] {
  return Object.values(AI_CAPABILITIES).filter(c => c.status === 'active')
}

export function isAiCapabilityActive(id: string): boolean {
  return getAiCapability(id)?.status === 'active'
}
