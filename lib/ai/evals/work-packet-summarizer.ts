import type { AiPromptEvalSuite } from '@/types/ai'

// Sprint 7.9 — Evaluation suite for WORK_PACKET_SUMMARIZER@v1.
//
// Static, mock-safe cases pairing a work-packet input with a representative model
// output to score against the version's schema + rubric. No live provider, no DB.
// These are the golden cases a future WORK_PACKET_SUMMARIZER@v2 must also pass
// before activation.

export const WORK_PACKET_SUMMARIZER_V1_SUITE: AiPromptEvalSuite = {
  id: 'work_packet_summarizer_v1',
  prompt_id: 'WORK_PACKET_SUMMARIZER',
  prompt_version_id: 'WORK_PACKET_SUMMARIZER@v1',
  description: 'Golden cases for the work-packet summarizer: valid structured drafts across low/medium/high risk.',
  pass_threshold: 0.8,
  cases: [
    {
      id: 'api_integration_low_risk',
      description: 'Well-scoped integration work packet → low risk.',
      input_payload: {
        title: 'Integrate CRM webhook',
        objective: 'Add a webhook receiver so CRM contact updates sync into the platform within 5 minutes.',
      },
      candidate_output: {
        title: 'CRM webhook integration',
        summary: 'Work packet to build a webhook receiver that syncs CRM contact updates into the platform within a five-minute SLA.',
        recommended_next_steps: [
          'Define the webhook payload contract',
          'Implement the receiver endpoint with validation',
          'Add retry + idempotency handling',
        ],
        risk_level: 'low',
        confidence: 0.8,
      },
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
    {
      id: 'data_migration_medium_risk',
      description: 'Migration touching production data → medium risk.',
      input_payload: {
        title: 'Migrate legacy accounts table',
        objective: 'Move 200k rows from the legacy accounts table to the new schema without downtime.',
      },
      candidate_output: {
        title: 'Legacy accounts table migration',
        summary: 'Work packet to migrate 200k account rows to the new schema with zero downtime, requiring careful backfill and cutover planning.',
        recommended_next_steps: [
          'Design a dual-write backfill strategy',
          'Validate row counts and checksums',
          'Plan a reversible cutover window',
        ],
        risk_level: 'medium',
        confidence: 0.68,
      },
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
    {
      id: 'auth_rework_high_risk',
      description: 'Authentication rework → high risk.',
      input_payload: {
        title: 'Replace session auth with tokens',
        objective: 'Rework authentication from server sessions to signed tokens across all services.',
      },
      candidate_output: {
        title: 'Authentication rework: sessions → tokens',
        summary: 'Work packet to replace server-session authentication with signed tokens across all services; high blast radius requiring staged rollout and strong review.',
        recommended_next_steps: [
          'Inventory every auth entry point',
          'Design token issuance and revocation',
          'Stage rollout behind a feature flag with rollback',
        ],
        risk_level: 'high',
        confidence: 0.62,
      },
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
    {
      id: 'sparse_objective_low_risk',
      description: 'Sparse objective still yields a valid, conservative draft.',
      input_payload: {
        title: 'Tidy the deploy scripts',
        objective: 'Clean up deploy scripts.',
      },
      candidate_output: {
        title: 'Deploy script cleanup',
        summary: 'Work packet to clean up deploy scripts. Scope is not fully specified; treat as a routine maintenance task pending clarification.',
        recommended_next_steps: [
          'Identify which deploy scripts are in scope',
          'Add comments and remove dead steps',
        ],
        risk_level: 'low',
        confidence: 0.55,
      },
      expected_fields: ['title', 'summary', 'recommended_next_steps', 'risk_level', 'confidence'],
    },
  ],
}
