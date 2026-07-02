import type { AiKnowledgeSource, AiKnowledgeSourceId } from '@/types/ai'

// Sprint 8.1 — Knowledge Source Registry (metadata only).
//
// Declares which existing entities/tables may be retrieved for AI context, at
// which scopes, which fields are readable, and which identify a citation. This is
// a READ-MODEL: it holds no query and grants no access. The retrieval engine
// (lib/ai/retrieval.ts) enforces org/department/project scoping when it actually
// reads these tables. No secret/env/system data is ever a knowledge source.

const KNOWLEDGE_SOURCES: Record<AiKnowledgeSourceId, AiKnowledgeSource> = {
  requests: {
    id: 'requests',
    entity_type: 'request',
    supported_scope: ['organization', 'department', 'project', 'entity'],
    searchable_fields: ['intent'],
    citation_fields: ['id', 'intent'],
    status: 'active',
  },
  tasks: {
    id: 'tasks',
    entity_type: 'task',
    supported_scope: ['organization', 'department', 'project', 'entity'],
    searchable_fields: ['title'],
    citation_fields: ['id', 'title', 'status'],
    status: 'active',
  },
  work_packets: {
    id: 'work_packets',
    entity_type: 'work_packet',
    supported_scope: ['organization', 'department', 'entity'],
    searchable_fields: ['title', 'objective'],
    citation_fields: ['id', 'title', 'status'],
    status: 'active',
  },
  outputs: {
    id: 'outputs',
    entity_type: 'output',
    supported_scope: ['organization', 'department', 'project', 'entity'],
    searchable_fields: ['title'],
    citation_fields: ['id', 'title', 'status', 'output_type'],
    status: 'active',
  },
  decisions: {
    id: 'decisions',
    entity_type: 'decision',
    supported_scope: ['organization', 'department', 'project', 'entity'],
    searchable_fields: ['summary'],
    citation_fields: ['id', 'summary', 'status'],
    status: 'active',
  },
  approvals: {
    id: 'approvals',
    entity_type: 'approval',
    supported_scope: ['organization', 'department', 'entity'],
    searchable_fields: ['trigger_reason'],
    citation_fields: ['id', 'category', 'status'],
    status: 'active',
  },
}

export function listKnowledgeSources(): AiKnowledgeSource[] {
  return Object.values(KNOWLEDGE_SOURCES)
}

export function getKnowledgeSource(id: string): AiKnowledgeSource | undefined {
  return KNOWLEDGE_SOURCES[id as AiKnowledgeSourceId]
}
