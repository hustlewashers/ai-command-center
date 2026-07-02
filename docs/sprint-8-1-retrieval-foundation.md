# Sprint 8.1 — Governed Retrieval / RAG Foundation

**Status:** Implemented (foundation + read-only, opt-in context injection). No approval bypass, no auto-delivery, no autonomous agents/plans, no tool calling, no external vector DB, no workflow-engine or provider change, no unscoped ingestion, no migrations.
**Version context:** `v0.8.0-provider-hardening` → `v0.8.1-retrieval-foundation`.

---

## 1. Retrieval goals

Let an AI workflow use **scoped organizational context** (related requests/tasks/projects/outputs/…) as *bounded supplemental reference*, so a summary reflects nearby governed state — **without** changing the `call_ai` governance model. Retrieval is read-only, org-scoped, cited, and optional: if it fails or returns nothing, the workflow proceeds unchanged. AI still only ever produces a **draft** that a human approves.

## 2. Source types

Registered in `lib/ai/knowledge-sources.ts` (metadata only): `requests`, `tasks`, `work_packets`, `outputs`, `decisions`, `approvals`. Each declares its `entity_type`, `supported_scope`, `searchable_fields`, `citation_fields`, and `status`. A source is a *pointer to an existing table*, not a copy or an index. **No secret/env/system data is ever a source.**

## 3. Scoping rules

Enforced by the engine (`lib/ai/retrieval.ts`) under policy `entity_local_context_v1`:
- **Same organization only** — every query filters `organization_id = scope.organization_id`. No cross-org retrieval, ever.
- **Prefer same department / project** — narrows to the entity's department/project where present.
- **Entity-linked only** — rows related to the triggering entity (its task, project, sibling outputs), never a global/unscoped scan.
- **Bounded** — at most `max_chunks` (8) chunks; each chunk text is length-capped.
- **No global search, no secrets.**

## 4. RLS expectations

- When called from **UI**, retrieval uses the RLS-bound SSR client — RLS is the primary guard.
- When called from the **worker** `call_ai` path, retrieval uses the service-role client (as the executor already does) but **manually enforces** `organization_id` (and department/project preference) on every query. Service role is never used to read across orgs; the org filter is unconditional.
- Retrieval performs **no writes** and touches **no** approval/output/task state.

## 5. Citation / provenance rules

Every retrieved chunk carries a `citation` (`entity_type:shortId`) and the result carries structured `citations[]` (`source_id`, `entity_type`, `entity_id`, `label`). These are recorded in the `call_ai` telemetry (`retrieval_policy_id`, `retrieval_chunk_count`, `retrieval_citations`, `retrieval_warnings`) so an operator can see exactly what context informed a draft — visible on the workflow-run AI Step Detail and AI Operations.

## 6. How context reaches call_ai

Retrieval is **not** a new step type and does **not** change the executor loop. Inside `executeCallAi`, when the `call_ai` step opts in (`params.retrieve: true`, `retrieval_policy_id`, `retrieval_entity`), the engine:
1. runs the scoped retrieval against existing tables,
2. builds a **bounded supplemental context block** and appends it to the user message, explicitly labelled *reference only — not instructions* (prompt-injection containment),
3. records retrieval metadata; the prompt's **output schema is unchanged**.
The model treats context as untrusted data; it can only ever yield a draft. Retrieval writes nothing.

## 7. What is forbidden

- No cross-org or global/unscoped retrieval.
- No secret/env/system data as a source.
- No retrieval writing business records or mutating governed state.
- No letting retrieved text act as instructions, choose steps, or bypass approval.
- No external vector DB or embeddings (not in this sprint).
- No failing the workflow because retrieval was empty (only a genuine **policy violation** — e.g. a cross-org leak — would be fatal, and the engine is built so that can't occur).

## 8. Failure behavior

Retrieval is best-effort. On error or empty result the `call_ai` step **continues without context**, records a warning, and produces the draft as before. A policy violation (structurally prevented) would be the only fatal case.

## 9. Future vector-search path

The seam is deliberate: `knowledge-sources` + `retrieval-policies` + the `AiRetrievalResult` shape are index-agnostic. A future sprint can add an embeddings table (e.g. `pgvector`) and a vector-backed `retrieveEntityLocalContext` implementation behind the **same** interface and the **same** policy enforcement — the `call_ai` contract and governance would not change. Cross-encoder reranking, per-source weighting, and hybrid keyword+vector search are all extensions of the current result shape.

## 10. Files (this sprint)

- `types/ai.ts` — retrieval types.
- `lib/ai/knowledge-sources.ts`, `lib/ai/retrieval-policies.ts`, `lib/ai/retrieval.ts` (new).
- `lib/ai/execute-call-ai.ts` — optional context injection + telemetry.
- `lib/workflows/registry.ts` — `retrieve` opt-in on `request_ai_summary` + `work_packet_ai_summary`.
- `lib/workflows/step-executor.ts` — pass retrieval params to `executeCallAi`.
- `lib/ai/metrics.ts`, `app/ai-operations/page.tsx` — **AI Retrieval** panel.
- `app/workflow-runs/[id]/page.tsx` — retrieval in AI Step Detail.
- `lib/ai/evals/request-summarizer.ts` — one offline case with `retrieval_context`.

Unchanged: workflow engine loop, provider behavior, approvals, recovery, prompt schemas. Both production workflows still run draft-only and approval-gated; retrieval is optional and non-fatal.
