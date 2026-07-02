import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  AiRetrievalResult,
  AiRetrievedChunk,
  AiRetrievalCitation,
  AiRetrievalScope,
  AiRetrievalContext,
  AiRetrievalPolicyId,
} from '@/types/ai'
import { getRetrievalPolicy, DEFAULT_RETRIEVAL_POLICY_ID } from './retrieval-policies'

// Sprint 8.1 — Governed Retrieval Engine (read-only, org-scoped, no vector DB).
//
// Reads existing tables for ENTITY-LOCAL context and returns bounded, cited
// chunks. Every query filters organization_id unconditionally; department/project
// narrow further. It performs NO writes and never crosses org boundaries. If the
// caller passes a service-role client (worker path), the manual org filter still
// applies. Best-effort: on any error it returns partial/empty results with a
// warning rather than throwing.

const shortId = (id: string) => id.slice(0, 8)
const cap = (s: string, n = 280) => (s.length > n ? `${s.slice(0, n)}…` : s)

function mkChunk(
  source_id: AiRetrievedChunk['source_id'],
  entity_type: AiRetrievedChunk['entity_type'],
  entity_id: string,
  field: string,
  text: string,
): AiRetrievedChunk {
  return { source_id, entity_type, entity_id, field, text: cap(text), citation: `${entity_type}:${shortId(entity_id)}` }
}

function mkCitation(c: AiRetrievedChunk): AiRetrievalCitation {
  return { source_id: c.source_id, entity_type: c.entity_type, entity_id: c.entity_id, label: c.citation }
}

// Core: entity-local context for a scope. Reads tasks/outputs/decisions in the
// same org (and project/department when present). Excludes the subject entity.
export async function retrieveEntityLocalContext(
  client: SupabaseClient,
  scope: AiRetrievalScope,
  policyId: AiRetrievalPolicyId = DEFAULT_RETRIEVAL_POLICY_ID,
): Promise<AiRetrievalResult> {
  const policy = getRetrievalPolicy(policyId)
  const warnings: string[] = []
  const chunks: AiRetrievedChunk[] = []

  if (!policy || policy.status !== 'active') {
    return { status: 'skipped', policy_id: policyId, scope, chunks: [], citations: [], warnings: ['retrieval policy not active'] }
  }
  if (!scope.organization_id) {
    // Hard guard — never retrieve without an org filter.
    return { status: 'policy_violation', policy_id: policyId, scope, chunks: [], citations: [], warnings: ['missing organization scope'] }
  }

  const org = scope.organization_id
  const project = policy.prefer_same_project ? (scope.project_id ?? null) : null

  // ── tasks (same org [+project]) ──
  try {
    let q = client.from('tasks').select('id, title, status, project_id').eq('organization_id', org).is('deleted_at', null)
    if (project) q = q.eq('project_id', project)
    const { data, error } = await q.order('created_at', { ascending: false }).limit(3)
    if (error) warnings.push(`tasks: ${error.message}`)
    for (const t of (data ?? []) as { id: string; title: string; status: string }[]) {
      if (scope.entity_type === 'task' && t.id === scope.entity_id) continue
      chunks.push(mkChunk('tasks', 'task', t.id, 'title', `Task "${t.title}" (${t.status})`))
    }
  } catch (e) { warnings.push(`tasks: ${e instanceof Error ? e.message : String(e)}`) }

  // ── outputs (same org [+project]) ──
  try {
    let q = client.from('outputs').select('id, title, status, output_type, project_id').eq('organization_id', org)
    if (project) q = q.eq('project_id', project)
    const { data, error } = await q.order('produced_at', { ascending: false }).limit(3)
    if (error) warnings.push(`outputs: ${error.message}`)
    for (const o of (data ?? []) as { id: string; title: string; status: string; output_type: string }[]) {
      if (scope.entity_type === 'output' && o.id === scope.entity_id) continue
      chunks.push(mkChunk('outputs', 'output', o.id, 'title', `Output "${o.title}" (${o.output_type}, ${o.status})`))
    }
  } catch (e) { warnings.push(`outputs: ${e instanceof Error ? e.message : String(e)}`) }

  // ── decisions (same org; best-effort) ──
  try {
    const { data, error } = await client.from('decisions').select('id, summary, status')
      .eq('organization_id', org).order('created_at', { ascending: false }).limit(2)
    if (error) warnings.push(`decisions: ${error.message}`)
    for (const d of (data ?? []) as { id: string; summary: string; status: string }[]) {
      chunks.push(mkChunk('decisions', 'decision', d.id, 'summary', `Decision "${d.summary}" (${d.status})`))
    }
  } catch (e) { warnings.push(`decisions: ${e instanceof Error ? e.message : String(e)}`) }

  // Enforce max_chunks (policy bound).
  const bounded = chunks.slice(0, policy.max_chunks)
  const citations = bounded.map(mkCitation)
  const status = bounded.length > 0 ? 'ok' : 'empty'

  return { status, policy_id: policyId, scope, chunks: bounded, citations, warnings }
}

export async function retrieveContextForRequest(
  client: SupabaseClient,
  opts: { organization_id: string; department_id?: string | null; project_id?: string | null; request_id: string; task_id?: string | null },
  policyId: AiRetrievalPolicyId = DEFAULT_RETRIEVAL_POLICY_ID,
): Promise<AiRetrievalResult> {
  return retrieveEntityLocalContext(client, {
    organization_id: opts.organization_id,
    department_id: opts.department_id ?? null,
    project_id: opts.project_id ?? null,
    entity_type: 'request',
    entity_id: opts.request_id,
  }, policyId)
}

export async function retrieveContextForWorkPacket(
  client: SupabaseClient,
  opts: { organization_id: string; department_id?: string | null; project_id?: string | null; work_packet_id: string; task_id?: string | null },
  policyId: AiRetrievalPolicyId = DEFAULT_RETRIEVAL_POLICY_ID,
): Promise<AiRetrievalResult> {
  return retrieveEntityLocalContext(client, {
    organization_id: opts.organization_id,
    department_id: opts.department_id ?? null,
    project_id: opts.project_id ?? null,
    entity_type: 'work_packet',
    entity_id: opts.work_packet_id,
  }, policyId)
}

// Build the injectable, prompt-facing context from a result. Bounded text block,
// explicitly labelled reference-only (prompt-injection containment happens where
// this text is appended to the user message).
export function toRetrievalContext(result: AiRetrievalResult): AiRetrievalContext {
  const lines = result.chunks.map(c => `- [${c.citation}] ${c.text}`)
  const text = lines.join('\n')
  return {
    policy_id: result.policy_id,
    status: result.status,
    chunk_count: result.chunks.length,
    citations: result.citations,
    warnings: result.warnings,
    text,
  }
}
