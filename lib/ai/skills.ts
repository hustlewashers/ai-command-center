import type {
  AiSkillDefinition,
  AiSkillId,
} from '@/types/ai'

// Sprint 7.4 — AI Skill Registry.
//
// The most granular reusable layer. A SKILL is a single reusable AI operation
// (summarize, classify, extract, recommend, …) that capabilities compose and
// future agents will orchestrate. Where a capability names WHAT the AI does for a
// business purpose, a skill names the underlying OPERATION.
//
// Registry / read-model only. Skills:
//   • NEVER execute anything (runtime workflows own execution),
//   • hold NO privilege and CANNOT bypass approvals or auto-deliver outputs,
//   • register NO prompt and create NO runtime workflow.
//
// Only `summarize_request` is `active` (composed by the request_summarization
// capability). The rest are `planned` — declared operations with no prompt or
// runtime workflow yet.

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

const DRAFT_GOVERNANCE = {
  approval_required: true,
  human_review_required: true,
  draft_only: true,
  may_mutate_governed_state: false as const,
}

const AI_SKILLS: Record<AiSkillId, AiSkillDefinition> = {
  // 1) Active — composed by the request_summarization capability.
  summarize_request: {
    id:          'summarize_request',
    name:        'Summarize Request',
    category:    'summarize',
    purpose:     'Produce a concise structured draft summary of a request.',
    description: 'The summarization operation behind request_summarization: reads a request\'s intent and returns a structured draft (title, summary, next steps, risk, confidence). Draft-only; a human approval gates any delivery.',
    supported_input_entities: ['request'],
    supported_output_types: ['report'],
    default_capability_id: 'request_summarization',
    default_prompt_id:     'REQUEST_SUMMARIZER',
    required_inputs: [
      { key: 'intent', description: 'The request intent/body to summarize.' },
      { key: 'title',  description: 'Human-readable title seed for the draft.' },
    ],
    optional_inputs: [],
    output_contract: {
      type: 'output', output_type: 'report', status: 'draft',
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'risk_level', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'active',
  },

  // 2) Planned — no prompt, no runtime workflow yet.
  classify_entity: {
    id:          'classify_entity',
    name:        'Classify Entity',
    category:    'classify',
    purpose:     'Propose a category or label for an entity as a draft.',
    description: 'Planned operation behind the classification capability: AI proposes a label/category with rationale as a draft. A human must review before any governed change. No prompt or runtime workflow exists yet.',
    supported_input_entities: ['request', 'task', 'work_packet', 'decision'],
    supported_output_types: ['classification'],
    default_capability_id: 'classification',
    default_prompt_id:     null,
    required_inputs: [
      { key: 'subject_text', description: 'Text/attributes to classify.' },
    ],
    optional_inputs: [
      { key: 'candidate_labels', description: 'Allowed labels, if constrained.' },
    ],
    output_contract: {
      type: 'output', output_type: 'classification', status: 'draft',
      expected_fields: ['label', 'rationale', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },

  // 3) Planned — no prompt, no runtime workflow yet.
  assess_entity_risk: {
    id:          'assess_entity_risk',
    name:        'Assess Entity Risk',
    category:    'assess_risk',
    purpose:     'Propose a risk level and rationale for an entity as a draft.',
    description: 'Planned operation behind the risk_assessment capability: AI proposes a risk level with rationale as a draft. A human must review before any governed change. No prompt or runtime workflow exists yet.',
    supported_input_entities: ['request', 'task', 'work_packet', 'decision'],
    supported_output_types: ['risk_assessment'],
    default_capability_id: 'risk_assessment',
    default_prompt_id:     null,
    required_inputs: [
      { key: 'subject_text', description: 'Text/attributes to assess for risk.' },
    ],
    optional_inputs: [],
    output_contract: {
      type: 'output', output_type: 'risk_assessment', status: 'draft',
      expected_fields: ['risk_level', 'rationale', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },

  // 4) Planned — no prompt, no runtime workflow yet.
  recommend_next_action: {
    id:          'recommend_next_action',
    name:        'Recommend Next Action',
    category:    'recommend',
    purpose:     'Propose next actions for an entity as a draft recommendation.',
    description: 'Planned operation behind the action_recommendation capability: AI proposes recommended next actions as a draft. Existing approval gates remain required before anything is acted on. No prompt or runtime workflow exists yet.',
    supported_input_entities: ['request', 'task', 'work_packet', 'decision', 'project'],
    supported_output_types: ['recommendation'],
    default_capability_id: 'action_recommendation',
    default_prompt_id:     null,
    required_inputs: [
      { key: 'context_text', description: 'Context to reason over for a recommendation.' },
    ],
    optional_inputs: [
      { key: 'goal', description: 'Objective the recommendation should optimize for.' },
    ],
    output_contract: {
      type: 'output', output_type: 'recommendation', status: 'draft',
      expected_fields: ['recommended_actions', 'rationale', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },

  // 5) Planned — generic extraction; no capability, prompt, or workflow yet.
  extract_entity_facts: {
    id:          'extract_entity_facts',
    name:        'Extract Entity Facts',
    category:    'extract',
    purpose:     'Extract structured facts from an entity as a draft.',
    description: 'Planned operation: AI extracts structured facts/fields from an entity as a draft. A human must review before any governed use. No capability, prompt, or runtime workflow exists yet.',
    supported_input_entities: ['request', 'task', 'work_packet', 'decision', 'output'],
    supported_output_types: ['extraction'],
    default_capability_id: null,
    default_prompt_id:     null,
    required_inputs: [
      { key: 'source_text', description: 'Text to extract structured facts from.' },
    ],
    optional_inputs: [
      { key: 'fields', description: 'Specific fields to extract, if constrained.' },
    ],
    output_contract: {
      type: 'output', output_type: 'extraction', status: 'draft',
      expected_fields: ['facts', 'confidence'],
    },
    governance_policy: DRAFT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: DRAFT_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },
}

export function listAiSkills(): AiSkillDefinition[] {
  return Object.values(AI_SKILLS)
}

export function getAiSkill(id: string): AiSkillDefinition | undefined {
  return AI_SKILLS[id as AiSkillId]
}

export function listActiveAiSkills(): AiSkillDefinition[] {
  return Object.values(AI_SKILLS).filter(sk => sk.status === 'active')
}

export function isAiSkillActive(id: string): boolean {
  return getAiSkill(id)?.status === 'active'
}
