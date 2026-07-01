import type {
  AiPlanDefinition,
  AiPlanId,
} from '@/types/ai'

// Sprint 7.6 — AI Plan Registry.
//
// The capstone of the registry stack: a PLAN is a governed, ordered SEQUENCE of
// steps composing agents, skills, capabilities, and workflows, punctuated by
// human-review / approval checkpoints. THIS SPRINT IS READ-MODEL / METADATA ONLY.
// Plans are NON-EXECUTABLE and orchestrate NOTHING:
//   • they run no workflow and sequence nothing at runtime,
//   • they hold NO privilege and CANNOT bypass approvals or auto-deliver outputs,
//   • they register NO prompt and create NO runtime workflow.
//
// Only `request_summary_review_plan` is `active` — meaning its composed chain
// (request_summary_assistant → summarize_request → request_summarization →
// request_ai_summary) is registered and working — but the plan itself still does
// not execute. The rest are `planned`.

const FORBIDDEN_ACTIONS = [
  'execute_plan',
  'execute_workflow',
  'deliver_output',
  'approve_approval',
  'reject_approval',
  'transition_task',
  'transition_work_packet',
  'mutate_governed_state_directly',
  'call_external_tools',
  'act_autonomously',
  'orchestrate_agents_at_runtime',
]

const PROPOSE_ONLY_ACTIONS = [
  'describe_governed_sequence',
  'propose_drafts_via_governed_workflows',
]

// Governance policy shared by all non-executable, draft-oriented plans. The
// execution-bearing flags are hard-false this sprint.
const PLAN_GOVERNANCE = {
  requires_human_approval: true,
  may_create_drafts: true,             // only indirectly, via governed workflows a human triggers
  may_execute_workflows: false as const,
  may_mutate_governed_state: false as const,
  may_deliver_outputs: false as const,
  requires_audit_logging: true,
}

const AI_PLANS: Record<AiPlanId, AiPlanDefinition> = {
  // 1) Active — its composed chain is registered and working. The plan itself is
  //    still non-executable metadata.
  request_summary_review_plan: {
    id:          'request_summary_review_plan',
    name:        'Request Summary Review Plan',
    category:    'review',
    purpose:     'Generate and review a governed request summary draft.',
    description: 'A governed two-phase plan: the request_summary_assistant proposes a draft summary via the request_ai_summary workflow, then a human reviews and resolves the pending approval. Non-executable in this sprint — it documents the sequence; the existing workflow + approval do the real work.',
    target_entities: ['request'],
    steps: [
      {
        step_id: 'summarize',
        label: 'AI draft summary',
        kind: 'workflow',
        agent_id: 'request_summary_assistant',
        skill_id: 'summarize_request',
        capability_id: 'request_summarization',
        workflow_id: 'request_ai_summary',
        required: true,
        approval_required: false,
        description: 'Run the governed request_ai_summary workflow to produce a DRAFT summary output (no delivery).',
        output_contract: {
          type: 'output', output_type: 'report', status: 'draft',
          expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
        },
      },
      {
        step_id: 'human_review',
        label: 'Human review + approval',
        kind: 'approval_checkpoint',
        required: true,
        approval_required: true,
        description: 'A human reviews the draft and resolves the pending approval before anything is delivered. No governed transition occurs without this.',
      },
    ],
    allowed_agent_ids:      ['request_summary_assistant'],
    allowed_skill_ids:      ['summarize_request'],
    allowed_capability_ids: ['request_summarization'],
    allowed_workflow_ids:   ['request_ai_summary'],
    governance_policy: PLAN_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: PROPOSE_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'active',
  },

  // 2) Planned — parts of its chain (prompts/workflows) do not exist yet.
  request_risk_triage_plan: {
    id:          'request_risk_triage_plan',
    name:        'Request Risk Triage Plan',
    category:    'triage',
    purpose:     'Future plan for risk assessment + classification + human review.',
    description: 'Planned triage plan: the risk_review_analyst would assess entity risk and classify it as drafts, then a human reviews. No prompt or runtime workflow exists yet; declared as governed metadata only.',
    target_entities: ['request', 'task', 'work_packet', 'decision'],
    steps: [
      { step_id: 'assess_risk', label: 'AI risk assessment', kind: 'skill', agent_id: 'risk_review_analyst', skill_id: 'assess_entity_risk', capability_id: 'risk_assessment', required: true, approval_required: false, description: 'Propose a risk level + rationale as a draft (planned; no workflow yet).' },
      { step_id: 'classify', label: 'AI classification', kind: 'skill', agent_id: 'risk_review_analyst', skill_id: 'classify_entity', capability_id: 'classification', required: false, approval_required: false, description: 'Propose a category/label as a draft (planned; no workflow yet).' },
      { step_id: 'human_review', label: 'Human review + approval', kind: 'approval_checkpoint', required: true, approval_required: true, description: 'A human reviews the risk/classification drafts before any governed change.' },
    ],
    allowed_agent_ids:      ['risk_review_analyst'],
    allowed_skill_ids:      ['assess_entity_risk', 'classify_entity'],
    allowed_capability_ids: ['risk_assessment', 'classification'],
    allowed_workflow_ids:   [],
    governance_policy: PLAN_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: PROPOSE_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },

  // 3) Planned — parts of its chain do not exist yet.
  action_recommendation_plan: {
    id:          'action_recommendation_plan',
    name:        'Action Recommendation Plan',
    category:    'recommendation',
    purpose:     'Future plan for AI-proposed next actions + approval.',
    description: 'Planned recommendation plan: the action_recommendation_advisor would propose next actions as a draft, then a human approves before anything is acted on. No prompt or runtime workflow exists yet; declared as governed metadata only.',
    target_entities: ['request', 'task', 'work_packet', 'decision', 'project'],
    steps: [
      { step_id: 'recommend', label: 'AI recommendation', kind: 'skill', agent_id: 'action_recommendation_advisor', skill_id: 'recommend_next_action', capability_id: 'action_recommendation', required: true, approval_required: false, description: 'Propose recommended next actions as a draft (planned; no workflow yet).' },
      { step_id: 'human_review', label: 'Human review + approval', kind: 'approval_checkpoint', required: true, approval_required: true, description: 'A human reviews and approves before any action is taken.' },
    ],
    allowed_agent_ids:      ['action_recommendation_advisor'],
    allowed_skill_ids:      ['recommend_next_action'],
    allowed_capability_ids: ['action_recommendation'],
    allowed_workflow_ids:   [],
    governance_policy: PLAN_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: PROPOSE_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },

  // 4) Planned — a read-only monitoring plan; composes nothing that mutates.
  operations_monitoring_plan: {
    id:          'operations_monitoring_plan',
    name:        'Operations Monitoring Plan',
    category:    'monitoring',
    purpose:     'Future read-only monitoring plan for AI operations health.',
    description: 'Planned monitoring plan: the operations_monitor would observe AI operations telemetry and surface observations for humans. Read-only by design — proposes nothing and changes nothing. Non-executable metadata only.',
    target_entities: [],
    steps: [
      { step_id: 'observe', label: 'Observe AI operations', kind: 'agent', agent_id: 'operations_monitor', required: true, approval_required: false, description: 'Surface AI operations health observations for humans (read-only; planned).' },
      { step_id: 'human_review', label: 'Human review', kind: 'human_review', required: true, approval_required: false, description: 'A human reviews the observations. No governed change is proposed by this plan.' },
    ],
    allowed_agent_ids:      ['operations_monitor'],
    allowed_skill_ids:      [],
    allowed_capability_ids: [],
    allowed_workflow_ids:   [],
    governance_policy: PLAN_GOVERNANCE,
    evaluation_signals: ['observation_only'],
    allowed_actions: ['observe_for_human_review'],
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
  },
}

export function listAiPlans(): AiPlanDefinition[] {
  return Object.values(AI_PLANS)
}

export function getAiPlan(id: string): AiPlanDefinition | undefined {
  return AI_PLANS[id as AiPlanId]
}

export function listActiveAiPlans(): AiPlanDefinition[] {
  return Object.values(AI_PLANS).filter(p => p.status === 'active')
}

export function isAiPlanActive(id: string): boolean {
  return getAiPlan(id)?.status === 'active'
}
