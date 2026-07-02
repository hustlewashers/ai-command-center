import type { AiRetrievalPolicy, AiRetrievalPolicyId } from '@/types/ai'

// Sprint 8.1 — Retrieval Policy Registry.
//
// A retrieval policy is the declarative rule-set the retrieval engine enforces:
// what scope is allowed, how many chunks, and hard prohibitions. Policies never
// loosen platform governance — they only constrain retrieval further.

const RETRIEVAL_POLICIES: Record<AiRetrievalPolicyId, AiRetrievalPolicy> = {
  entity_local_context_v1: {
    id: 'entity_local_context_v1',
    description: 'Entity-local context only: same organization, prefer same department and project, entity-linked rows only. No cross-org, no global search, no secret/env data.',
    same_org_only: true,
    prefer_same_department: true,
    prefer_same_project: true,
    entity_linked_only: true,
    max_chunks: 8,
    forbid_secrets: true,
    forbid_global_search: true,
    status: 'active',
  },
}

export function listRetrievalPolicies(): AiRetrievalPolicy[] {
  return Object.values(RETRIEVAL_POLICIES)
}

export function getRetrievalPolicy(id: string): AiRetrievalPolicy | undefined {
  return RETRIEVAL_POLICIES[id as AiRetrievalPolicyId]
}

export const DEFAULT_RETRIEVAL_POLICY_ID: AiRetrievalPolicyId = 'entity_local_context_v1'
