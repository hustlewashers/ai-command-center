import type {
  AiAgentDefinition,
  AiAgentId,
} from '@/types/ai'

// Sprint 7.5 — AI Agent Registry.
//
// The top of the registry stack: an AGENT is a governed ROLE that may EVENTUALLY
// compose skills, capabilities, and workflows toward a goal. THIS SPRINT IS
// READ-MODEL / METADATA ONLY. Agents are NON-EXECUTABLE and act autonomously
// NOWHERE:
//   • they run no workflow and orchestrate nothing,
//   • they hold NO privilege and CANNOT bypass approvals or auto-deliver outputs,
//   • they register NO prompt and create NO runtime workflow.
//
// Only `request_summary_assistant` is `active` — meaning its composed chain
// (summarize_request → request_summarization → request_ai_summary) is registered
// and working — but the agent itself still does not execute. The rest are
// `planned`.

const FORBIDDEN_ACTIONS = [
  'execute_workflow',
  'deliver_output',
  'approve_approval',
  'reject_approval',
  'transition_task',
  'transition_work_packet',
  'mutate_governed_state_directly',
  'call_external_tools',
  'act_autonomously',
  'orchestrate_other_agents',
]

const PROPOSE_ONLY_ACTIONS = [
  'propose_draft_via_governed_workflow',
  'summarize_for_human_review',
]

// Governance policy shared by all non-executable, draft-oriented agent roles.
// The execution-bearing flags are hard-false this sprint.
const AGENT_GOVERNANCE = {
  requires_human_approval: true,
  may_create_drafts: true,             // only indirectly, via a governed workflow a human triggers
  may_execute_workflows: false as const,
  may_mutate_governed_state: false as const,
  may_deliver_outputs: false as const,
  requires_audit_logging: true,
}

const AI_AGENTS: Record<AiAgentId, AiAgentDefinition> = {
  // 1) Active — its composed chain is registered and working. The agent itself
  //    is still non-executable metadata.
  request_summary_assistant: {
    id:          'request_summary_assistant',
    name:        'Request Summary Assistant',
    category:    'assistant',
    purpose:     'Helps summarize requests into governed draft outputs.',
    description: 'A governed assistant role over the request-summarization chain. Non-executable in this sprint: it describes which skills/capabilities/workflows it would compose. Any real output still flows through the governed request_ai_summary workflow and a human approval.',
    scope: {
      target_entities: ['request'],
      description: 'Requests within the operator\'s own organization/department scope.',
    },
    allowed_skill_ids:      ['summarize_request'],
    allowed_capability_ids: ['request_summarization'],
    allowed_workflow_ids:   ['request_ai_summary'],
    default_prompt_ids:     ['REQUEST_SUMMARIZER'],
    governance_policy: AGENT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: PROPOSE_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'active',
    supported_plan_ids: ['request_summary_review_plan'],
  },

  // 2) Planned — parts of its chain (prompts/workflows) do not exist yet.
  risk_review_analyst: {
    id:          'risk_review_analyst',
    name:        'Risk Review Analyst',
    category:    'analyst',
    purpose:     'Reviews entities for risk and proposes risk levels/classifications as drafts.',
    description: 'Planned analyst role over the risk-assessment and classification chains. No prompt or runtime workflow exists yet; declared as governed metadata only.',
    scope: {
      target_entities: ['request', 'task', 'work_packet', 'decision'],
      description: 'Entities requiring risk review within scope.',
    },
    allowed_skill_ids:      ['assess_entity_risk', 'classify_entity'],
    allowed_capability_ids: ['risk_assessment', 'classification'],
    allowed_workflow_ids:   [],
    default_prompt_ids:     [],
    governance_policy: AGENT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: PROPOSE_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
    supported_plan_ids: ['request_risk_triage_plan'],
  },

  // 3) Planned — 'advisor' is not in the category enum, so categorized as analyst.
  action_recommendation_advisor: {
    id:          'action_recommendation_advisor',
    name:        'Action Recommendation Advisor',
    category:    'analyst',
    purpose:     'Advises on next actions by proposing recommendations as drafts.',
    description: 'Planned advisory role over the action-recommendation chain (categorized as analyst; advisor is not in the category enum). No prompt or runtime workflow exists yet; declared as governed metadata only.',
    scope: {
      target_entities: ['request', 'task', 'work_packet', 'decision', 'project'],
      description: 'Entities needing a next-action recommendation within scope.',
    },
    allowed_skill_ids:      ['recommend_next_action'],
    allowed_capability_ids: ['action_recommendation'],
    allowed_workflow_ids:   [],
    default_prompt_ids:     [],
    governance_policy: AGENT_GOVERNANCE,
    evaluation_signals: ['confidence', 'approval_outcome'],
    allowed_actions: PROPOSE_ONLY_ACTIONS,
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
    supported_plan_ids: ['action_recommendation_plan'],
  },

  // 4) Planned — a read-only monitor role; composes nothing yet.
  operations_monitor: {
    id:          'operations_monitor',
    name:        'Operations Monitor',
    category:    'monitor',
    purpose:     'Observes AI operations health; proposes nothing and changes nothing.',
    description: 'Planned monitor role. Read-only by design — composes no skills or capabilities and would only surface observations for humans. Non-executable metadata only.',
    scope: {
      target_entities: [],
      description: 'Observational scope over AI operations telemetry (no target mutations).',
    },
    allowed_skill_ids:      [],
    allowed_capability_ids: [],
    allowed_workflow_ids:   [],
    default_prompt_ids:     [],
    governance_policy: AGENT_GOVERNANCE,
    evaluation_signals: ['observation_only'],
    allowed_actions: ['observe_for_human_review'],
    forbidden_actions: FORBIDDEN_ACTIONS,
    status: 'planned',
    supported_plan_ids: ['operations_monitoring_plan'],
  },
}

export function listAiAgents(): AiAgentDefinition[] {
  return Object.values(AI_AGENTS)
}

export function getAiAgent(id: string): AiAgentDefinition | undefined {
  return AI_AGENTS[id as AiAgentId]
}

export function listActiveAiAgents(): AiAgentDefinition[] {
  return Object.values(AI_AGENTS).filter(a => a.status === 'active')
}

export function isAiAgentActive(id: string): boolean {
  return getAiAgent(id)?.status === 'active'
}
