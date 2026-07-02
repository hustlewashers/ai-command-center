import type { AiPromptEvalSuite } from '@/types/ai'

// Sprint 7.8 — Evaluation suite for REQUEST_SUMMARIZER@v1.
//
// Static, mock-safe cases. Each pairs a representative request input with a
// representative model output (candidate_output) to score against the version's
// schema + rubric. No live provider call, no DB — deterministic. These are the
// "golden" cases a future version (v2) must also pass before it can be activated,
// and the same cases a future CI step can replay against the live provider.

export const REQUEST_SUMMARIZER_V1_SUITE: AiPromptEvalSuite = {
  id: 'request_summarizer_v1',
  prompt_id: 'REQUEST_SUMMARIZER',
  prompt_version_id: 'REQUEST_SUMMARIZER@v1',
  description: 'Golden cases for the request summarizer: valid structured drafts across low/medium/high risk.',
  pass_threshold: 0.8,
  cases: [
    {
      id: 'onboarding_low_risk',
      description: 'Routine onboarding request → low risk, complete draft.',
      input_payload: {
        intent: 'Onboard a new marketing hire: set up accounts, tools, and first-week plan.',
        title: 'New marketing hire onboarding',
      },
      candidate_output: {
        title: 'Onboarding plan for new marketing hire',
        summary: 'Request to onboard a new marketing team member, including account provisioning, tool access, and a structured first-week plan.',
        recommended_next_steps: [
          'Provision email and SSO accounts',
          'Grant access to marketing tools',
          'Schedule first-week orientation',
        ],
        risk_level: 'low',
        confidence: 0.82,
      },
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
    {
      id: 'budget_change_medium_risk',
      description: 'Mid-quarter budget reallocation → medium risk.',
      input_payload: {
        intent: 'Reallocate $40k from events to paid ads for Q3.',
        title: 'Q3 budget reallocation',
      },
      candidate_output: {
        title: 'Q3 budget reallocation: events → paid ads',
        summary: 'Request to move $40k of the Q3 budget from events to paid advertising, requiring finance and department-lead review.',
        recommended_next_steps: [
          'Confirm current events budget commitments',
          'Model expected paid-ads ROI',
          'Route to finance for approval',
        ],
        risk_level: 'medium',
        confidence: 0.7,
      },
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
    {
      id: 'security_incident_high_risk',
      description: 'Suspected data exposure → high risk.',
      input_payload: {
        intent: 'Investigate a suspected exposure of customer records in an exported report.',
        title: 'Possible customer data exposure',
      },
      candidate_output: {
        title: 'Investigate suspected customer data exposure',
        summary: 'Request to investigate potential exposure of customer records via an exported report; requires immediate security review and containment.',
        recommended_next_steps: [
          'Identify the scope of exposed records',
          'Revoke access to the affected export',
          'Escalate to security and compliance leads',
        ],
        risk_level: 'high',
        confidence: 0.6,
      },
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
    {
      id: 'minimal_intent_low_risk',
      description: 'Sparse intent still yields a valid, conservative draft.',
      input_payload: {
        intent: 'Update the team wiki.',
        title: 'Wiki update',
      },
      candidate_output: {
        title: 'Team wiki update',
        summary: 'Request to update the team wiki. Scope is not fully specified; treat as a routine documentation task pending clarification.',
        recommended_next_steps: [
          'Clarify which wiki sections need updating',
          'Assign to a documentation owner',
        ],
        risk_level: 'low',
        confidence: 0.55,
      },
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
  ],
}
