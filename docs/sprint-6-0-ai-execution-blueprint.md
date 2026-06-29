# Sprint 6.0 — AI Execution Architecture Blueprint

**Status:** Design only. No code, no LLM calls, no dependencies, no migrations, no runtime/workflow changes.
**Version context:** `v0.5.16-detail-ui-complete`.
**Source of truth for shapes:** existing migrations (`007`, `011`, `014`, `018`, `023`), `types/workflows.ts`, `types/workflow-runs.ts`, `lib/workflows/*`, `lib/jobs/*`.

---

## 1. Purpose

Define **how AI becomes a governed workflow step inside the existing runtime** — not a new service, not a sidecar, not a privileged actor. This document is the contract the first AI build sprint (6.1) implements against. It fixes the seams (step type, registries, persistence, governance, metrics, recovery) so that adding AI changes *one step executor branch and a few additive tables/grants*, and nothing about how the worker, approvals, recovery, or observability already work.

The guiding sentence, repeated throughout:

> **AI is a `call_ai` workflow step, executed by the existing worker, persisted through `workflow_step_runs`, narrated through `execution_logs` and `agent_activity`, measured through `runtime_metrics`, recovered through the existing recovery engine, and gated by the existing approval model. It may *propose*; only a human may *approve* a governed transition.**

---

## 2. Current Platform State

What already exists and will be **reused unchanged**:

| Capability | Implementation | Reused for AI as |
|---|---|---|
| Background worker | `lib/jobs/{enqueue,claim,dispatch,sweep}.ts`, `job_type='workflow_step'` | the thing that runs AI |
| Workflow engine | `lib/workflows/{registry,execute,step-executor}.ts` | AI is one more step type |
| Workflow registry (in-code) | `WORKFLOWS` in `lib/workflows/registry.ts` | pattern copied for prompt registry |
| Run persistence | `workflow_runs`, `workflow_step_runs` (migration 023) | AI output lands in `output_payload` |
| Observability | `execution_logs` (007) | AI narrative + decisions |
| Agent telemetry | `agent_activity` (018) | AI "who/what/when/how long" |
| Metrics | `runtime_metrics` (018) | AI cost / tokens / latency |
| Recovery | `lib/workflows/recovery.ts` (retry/resume/restart/cancel) | recover failed AI steps |
| Triggers | `lib/workflows/triggers.ts` | start AI workflows from requests |
| Approvals | `approvals` (011) + `app/approvals/*` + `PATCH /api/approvals/[id]` | human gate on AI proposals |
| Governance | RLS + service-role separation; `read_only` cannot mutate; agents cannot bypass approvals | unchanged for AI |

What does **not** exist yet and is in scope to *design* (build later): a `call_ai` step type, a prompt registry, a model router, a structured-output contract, an AI agent identity/session, and AI cost metrics.

---

## 3. Why AI Must Be a Workflow Step

Three platform invariants force this shape:

1. **One execution path.** Everything that mutates state already runs as a `workflow_step` background job through `dispatch → handleWorkflowStep → executeWorkflow → executeStep`. A second path for AI would duplicate retry/DLQ, persistence, RLS, and audit — and would be the thing that eventually bypasses a gate. AI must enter through the same door.
2. **One audit/recovery surface.** `workflow_runs`/`workflow_step_runs`/`execution_logs` already answer "what ran, what did it produce, why did it fail, can I recover it." An AI call that doesn't write there is invisible and unrecoverable. Making AI a step gives it run rows, step rows, logs, and recovery *for free*.
3. **Governance is structural, not advisory.** Governed transitions (output delivered, task done, approval resolved) are guarded by RLS + approval gates. An AI step that holds service-role and writes business records directly would route *around* those gates. Constraining AI to a step that can only *propose drafts* keeps governance structural.

**Consequence:** AI inherits, rather than re-implements, every property the runtime already guarantees.

---

## 4. AI Execution Architecture

Unchanged control flow, with the new branch shown:

```
request/manual trigger
   └─ triggers.ts → enqueue(job_type='workflow_step', payload{workflow_id, inputs})
        └─ worker: claim → dispatch → handleWorkflowStep
             └─ executeWorkflow(workflowId, ctx)        # lib/workflows/execute.ts (UNCHANGED)
                  ├─ workflow_runs row (running)
                  ├─ for each step:
                  │     ├─ workflow_step_runs row (running)
                  │     ├─ executeStep(step, ctx, accumulated)   # step-executor.ts
                  │     │     └─ case 'call_ai':  ◄── NEW BRANCH ONLY
                  │     │            buildContext → router.resolve → provider.call
                  │     │            → validate(structured output)
                  │     │            → agent_activity + execution_logs + runtime_metrics
                  │     │            → return { output: <validated> }
                  │     ├─ step_run update (completed/failed, output_payload, duration_ms)
                  │     └─ run update (accumulated, current_step_*)
                  └─ run row (completed/failed)
```

New modules (additive, no edits to the executor loop except the `case 'call_ai'`):

- `lib/ai/prompts.ts` — in-code prompt registry.
- `lib/ai/router.ts` — logical-model → provider/model resolution.
- `lib/ai/provider.ts` — thin provider client (the *only* place that touches an LLM SDK/HTTP).
- `lib/ai/contract.ts` — structured-output schema descriptors + `validateAiOutput`.
- `lib/ai/execute-call-ai.ts` — the step handler, called from `executeStep`'s new `case 'call_ai'`.
- `types/ai.ts` — `CallAiParams`, `AiResult`, schema types.

The executor (`execute.ts`) and dispatcher (`dispatch.ts`) do **not** change. Only `step-executor.ts` gains one `case`.

---

## 5. New Workflow Step Type: `call_ai`

Add `'call_ai'` to `WorkflowStepType` in `types/workflows.ts`:

```ts
export type WorkflowStepType =
  | 'write_execution_log' | 'create_task' | 'create_work_packet'
  | 'create_output' | 'request_approval' | 'complete'
  | 'call_ai'   // NEW
```

Step definition `params` for a `call_ai` step (validated at executor entry):

```ts
interface CallAiParams {
  prompt_id: string            // key into the in-code prompt registry
  model?: string               // logical alias, e.g. 'default'/'fast' (router resolves)
  output_schema_id: string     // key into the structured-output contract registry
  input_keys?: string[]        // which accumulated/ctx keys are allowed into the prompt
  max_output_tokens?: number   // soft cap; provider-enforced
  temperature?: number         // optional
}
```

Contract for the `call_ai` branch:

- **Reads only** from `ctx` (the workflow inputs) and `accumulated` (prior step outputs), filtered to `input_keys`. It performs **no ad-hoc DB reads** (data-access boundary, §18).
- **Returns** `{ step_id, type:'call_ai', success, output }` where `output` is the **validated** structured object. The executor already does `Object.assign(accumulated, result.output)` and writes `workflow_step_runs.output_payload = result.output` — so AI output persistence is automatic.
- **Never** writes business records (`tasks`, `outputs`, `approvals`, …) directly. Subsequent *non-AI* steps (`create_output`, `request_approval`) turn AI proposals into **draft** records.
- On any failure (provider error, timeout, invalid output, budget exceeded) it **throws** — the existing executor `try/catch` marks the step+run `failed` and the run becomes recoverable.

---

## 6. Prompt Registry Design

In-code first (mirrors `lib/workflows/registry.ts`). No DB-backed prompts in MVP.

```ts
// lib/ai/prompts.ts
interface PromptTemplate {
  id: string
  description: string
  output_schema_id: string         // default schema this prompt targets
  system: string                   // static system prompt
  render: (vars: Record<string, unknown>) => string   // builds the user message from whitelisted vars
  default_model?: string
}
const PROMPTS: Record<string, PromptTemplate> = { request_summary_v1: { … } }
export function getPrompt(id: string): PromptTemplate | undefined
```

Rules:
- Templates are **pure functions of whitelisted variables** — `render` receives only the keys named in the step's `input_keys`, never the raw `ctx`/DB.
- Versioned by id suffix (`_v1`); a prompt is never edited in place once referenced by a shipped workflow (parallels "never edit a migration").
- The registry is the single source of system prompts; nothing else may inline a prompt string.
- **Future** (not MVP): a `prompts`/`prompt_versions` table + RLS, loaded the same way `workflow_runs` envisages a DB-backed workflow registry. The in-code interface is chosen so the swap is mechanical.

---

## 7. Model Routing Design

`lib/ai/router.ts` maps a **logical alias** to a concrete provider+model so workflows never hardcode a vendor model id.

```ts
interface ResolvedModel { provider: 'anthropic'; model: string; max_input_tokens: number; price_in: number; price_out: number }
export function resolveModel(alias = 'default'): ResolvedModel
```

- MVP: one alias (`default`) → one model, read from env (`AI_DEFAULT_MODEL`). `fast`/`smart` aliases reserved but may resolve to the same model initially.
- Pricing constants (per-1K input/output tokens) live with the router so cost is computable locally without a billing call.
- Routing is **static and declarative** in MVP — no dynamic/auto model selection, no failover-to-other-vendor (that is §21 future).
- Provider keys are resolved **inside `provider.ts` only**, from server-only env (§19).

---

## 8. Structured Output Contract

AI steps must return **structured, validated** data — never free text dumped into a business record. Output is always a JSON object matching a registered schema.

```ts
// lib/ai/contract.ts  (no new deps — hand-rolled descriptors)
type FieldType = 'string' | 'number' | 'boolean' | 'string[]'
interface OutputSchema { id: string; fields: Record<string, { type: FieldType; required: boolean; max_len?: number }> }
const SCHEMAS: Record<string, OutputSchema> = {
  summary_v1: { id:'summary_v1', fields: {
    summary:   { type:'string',   required:true,  max_len: 4000 },
    key_points:{ type:'string[]', required:false },
    confidence:{ type:'number',   required:false },
  }},
}
```

- Each `call_ai` step names an `output_schema_id`. The provider is asked to produce JSON for that schema (system-prompt instruction + response parsing).
- The validated object is what lands in `workflow_step_runs.output_payload` and `accumulated`. Downstream steps consume **typed fields** (e.g. `accumulated.summary`), never raw model text.
- No dependency added: validation is a small in-code function (§9), not zod/ajv.

---

## 9. Validation and Schema Enforcement

`validateAiOutput(schema, parsed) -> { ok: true, value } | { ok: false, errors }`:

1. **Parse** provider text as JSON. JSON parse failure → invalid (step fails).
2. **Shape check** against the schema: required fields present, types match, `max_len` enforced, unknown fields dropped (not errored).
3. **Coerce conservatively** (trim strings, clamp `string[]` length); never invent missing required fields.
4. On invalid output the step **throws** `AppError('validation', …)` — caught by the executor → step `failed`. (One bounded in-step reformat retry is allowed, §16, before failing.)

Enforcement guarantees the rest of the platform only ever sees well-typed AI output, so `create_output`/`request_approval` steps can rely on field presence.

---

## 10. Human Review / Approval Gates

**AI proposes; humans dispose.** No AI step performs a governed transition.

- A `call_ai` step output is a **proposal** (a structured draft), persisted only as step output until a *non-AI* step materializes it.
- The MVP pattern: `call_ai` → `create_output` (status `draft`) → `request_approval` (creates a **pending** `approvals` row, `subject_type='output'`, `subject_id=<draft output>`).
- The draft output stays `draft`/`in_review`; **delivery/acceptance requires a human** to resolve the approval via the existing `PATCH /api/approvals/[id]` (UI shipped in 5.14). The approval state machine and RLS are unchanged.
- AI **cannot** set an approval to `approved`, move an output to `delivered`, or transition a task — those remain human-only RLS-gated transitions. This is structural: the AI step holds no path to them.

---

## 11. Agent Activity Integration

`agent_activity` (migration 018) is the per-actor telemetry surface. AI writes one row per `call_ai` execution.

Hard constraints from the schema (must be satisfied by the build sprint):
- `agent_user_id` **NOT NULL** → there must be a designated **AI agent user** (`users.role='agent'`) per organization.
- `session_id` **NOT NULL** → the executor opens/uses an **agent session** for the run (one session per `workflow_run`, reused across its `call_ai` steps).
- `activity_type` is constrained to `('tool_call','decision_made','knowledge_record_created','output_produced','approval_requested','error_raised','session_start','session_end','other')` — a `call_ai` maps to **`tool_call`** (the model is the tool); a proposal that yields a draft output maps the *downstream* `create_output` to **`output_produced`**; failures → **`error_raised`**.

Row written by the `call_ai` step (service-role):
```
{ organization_id, agent_user_id: <AI agent>, session_id: <run session>,
  task_id?, work_packet_id?, activity_type: 'tool_call', tool_name: 'ai:'+model,
  summary: 'call_ai '+prompt_id+' → '+output_schema_id,
  metadata: { workflow_run_id, step_id, prompt_id, model, tokens_in, tokens_out, latency_ms },  // NO prompt/secret content
  execution_log_id: <linked log id>, duration_ms, status: 'completed'|'failed' }
```

Prerequisite (build-sprint, not now): a **grant migration** giving `service_role` INSERT on `agent_activity` (and `agent_sessions`), mirroring migration 022's pattern for business tables.

---

## 12. Execution Logs Integration

`execution_logs` (007) is the human-readable narrative. The `call_ai` step writes log rows using the **existing** vocabulary (no schema change):

- `event_type='tool_call'` for the AI invocation (allowed value already exists), or `'note'` for informational lines; `'error'` on failure.
- `context_type='workflow'`, `context_id = workflow_run_id` (consistent with how `execute.ts` already logs).
- `actor = 'agent:ai'` (or `'user:'+agentUserId`) so AI-authored logs are attributable and distinguishable from `worker:workflow-executor`.
- `status='recorded'` normally; `'flagged'` on failure (consistent with the executor's existing failure log).
- `metadata` carries `{ workflow_run_id, step_id, prompt_id, model, output_schema_id, tokens_in, tokens_out, latency_ms }` — **never** prompt text, model input, secrets, or full output.

This keeps AI inside the same timeline already rendered on workflow-run/request detail pages (no UI work required to *see* AI activity).

---

## 13. Workflow Runs / Step Runs Integration

No new persistence tables. AI uses what migration 023 already provides:

- The `call_ai` step gets a `workflow_step_runs` row (created `running` before execution, exactly like every other step).
- `input_payload` = the `accumulated` snapshot at step start (already written by the executor) — gives reproducible "what the AI saw" (post-whitelist context can also be recorded in `metadata` of the log, not the prompt itself).
- `output_payload` = the **validated structured AI output** (the executor already persists `result.output` here).
- `duration_ms`, `status`, `retry_count` behave identically to other steps.
- The parent `workflow_runs` row tracks `current_step_*`, `accumulated`, and final status as usual — so AI runs appear in the existing Workflow Runs list/detail with zero new UI.

---

## 14. Runtime Metrics and Cost Tracking

`runtime_metrics` (018) records cost/latency. The XOR constraint (`value_int` vs `value_float`, exactly one) dictates the encoding:

| metric_name | category | unit | value |
|---|---|---|---|
| `ai_tokens_input` | `agent_performance` | `tokens` | `value_int` |
| `ai_tokens_output` | `agent_performance` | `tokens` | `value_int` |
| `ai_latency_ms` | `agent_performance` | `ms` | `value_int` |
| `ai_cost_usd` | `agent_performance` | `usd` | `value_float` |

- Each metric row sets `dimension_type='workflow_run'` (or `'workflow_step'`), `dimension_id=<run/step id>`, `department_id` from ctx, and a `window_start/window_end` bracketing the call.
- Cost = `tokens_in/1000*price_in + tokens_out/1000*price_out` using the router's pricing constants — computed locally, no billing API.
- These power per-run, per-workflow, per-department cost/latency rollups and a future dashboard "AI cost" card. **Measurability is a Definition-of-Done item, not optional.**
- Prerequisite (build-sprint): `service_role` INSERT grant on `runtime_metrics` (same grant-migration as §11).

---

## 15. Failure Handling

AI introduces new failure classes; all map onto the **existing** failure machinery (no new handling path):

| Class | Cause | Step result | Where it surfaces |
|---|---|---|---|
| Transient provider | 429/5xx/network/timeout | throw → step `failed` | run `failed`; job retry/backoff via dispatcher |
| Invalid output | non-JSON / schema-invalid (after 1 reformat retry) | throw `validation` | step `failed`, `error_message` records the validation reason |
| Budget/limit | token/cost cap exceeded | throw `validation`/`rate_limited` | step `failed`; no partial business write |
| Refusal/empty | model returns nothing usable | throw | step `failed` |
| Downstream | a *later* `create_output` fails | that step fails (AI step already succeeded) | normal step failure |

Because the `call_ai` step writes **no** business records itself, a failed AI step leaves **no** partial governed state — only step/run/log/activity rows marked failed. This is what makes recovery safe (§16).

---

## 16. Retry / Resume Semantics for AI Steps

Reuse the recovery engine (`lib/workflows/recovery.ts`: retry / resume / restart / cancel) verbatim. AI's **non-determinism** is the only new consideration:

- **Resume** (idempotency-safe path): re-creates the run from the failed step with inherited `accumulated`. Re-running a failed `call_ai` step is **safe** because the step itself wrote nothing irreversible; it just calls the model again. *Prior* successful steps are not re-run. **Resume is the recommended action for failed AI runs** (the existing `recommended_action` already prefers resume).
- **In-step reformat retry** (bounded): a single immediate re-ask when output is invalid JSON/shape, *before* failing the step. Capped (e.g. 1) to bound cost; not a substitute for job-level retry.
- **Retry/Restart** (from step 0): allowed, but re-runs *all* prior steps including any side-effecting ones → may duplicate drafts. The UI already warns on restart; AI runs inherit that warning. Operators should prefer **resume**.
- **Determinism note:** because the model may return different output on resume, the *output_payload* of a resumed run can differ from the original attempt — this is expected and visible in run lineage (parent/child runs). No idempotency key is promised for AI output in MVP.

---

## 17. Security and Governance Rules

Non-negotiable, inherited from existing platform rules:

1. **AI holds no governance privilege.** It runs inside the service-role executor but its *only* outputs are step `output_payload` + draft records via non-AI steps. It cannot resolve approvals, deliver outputs, or transition tasks.
2. **`read_only` and agents cannot bypass approvals** — unchanged. The AI agent user is `role='agent'`; agents already cannot perform governed transitions under RLS.
3. **No new external entry point.** AI is reachable only through a workflow step enqueued by the existing trigger path; there is no "AI API" a client can hit to act ungoverned.
4. **Provider SDK/HTTP is confined to `lib/ai/provider.ts`** (server-only), the single egress point — auditable and mockable.
5. **Dev/test endpoints** that exercise AI must 404 in production and require `WORKER_RUN_SECRET`, exactly like existing dev endpoints.
6. **Prompt-injection containment:** model output is treated as **untrusted data**, validated against a schema, and can only ever become a *draft proposal* — never an executed instruction. AI output is never `eval`'d, never used to choose the next step, never used to construct privileged queries.

---

## 18. Data Access Rules

- The `call_ai` step reads **only** `ctx` + `accumulated`, filtered to the step's `input_keys`. It performs **no ad-hoc table reads**.
- Any business data an AI step needs must be fetched by a **prior, RLS-respecting, non-AI step** and placed into `accumulated` deliberately. This keeps the data the model sees explicit, reviewable, and bounded — and prevents AI from becoming a wide-open service-role reader.
- Cross-organization / cross-department data never reaches a prompt: prior steps run under the run's `organization_id`/`department_id` context, and only their (already-scoped) outputs flow into `accumulated`.
- The prompt `render(vars)` receives a **whitelisted** subset; the registry, not the caller, decides what is interpolated.

---

## 19. Privacy and Secret Handling

- **Provider API key**: server-only env (e.g. `ANTHROPIC_API_KEY`), resolved **only** in `provider.ts`. Never `NEXT_PUBLIC_*`, never logged, never returned, never written to `output_payload`/`metadata`/`execution_logs`. Same discipline as `SUPABASE_SERVICE_ROLE_KEY` (see `lib/supabase/service.ts`).
- **Never persist** the rendered prompt, the model's raw input, or secret-bearing context into any row. Logs/metrics/activity store *metadata about* the call (ids, token counts, latency, model alias), not the call's content.
- **PII minimization:** prompts interpolate only whitelisted fields; the registry author is responsible for not whitelisting sensitive columns. Document a per-prompt "data touched" note.
- **Output redaction:** validation may strip fields not in the schema, bounding accidental leakage of model-echoed input.

---

## 20. Evaluation / Quality Checks

MVP is intentionally light (no eval framework, no extra deps):

- **Structural validation** (§9) is the baseline quality gate — malformed output fails the step.
- **Confidence field (optional):** schemas may include `confidence:number`; low confidence can be surfaced in the draft and to the human approver (no automated action taken on it).
- **Human-in-the-loop is the eval:** every AI proposal terminates at a human approval, so quality is judged by the approver before anything is delivered.
- **Future:** a `call_ai` "judge" step (AI grading AI), golden-prompt regression tests, and per-prompt acceptance-rate metrics derived from approval outcomes (`approved` vs `rejected` on AI-originated outputs).

---

## 21. Fallback Logic

MVP: **fail-closed, no silent fallback.** If the single configured model errors past retries, the step fails and the run is recoverable — there is no automatic switch to a weaker model that could change behavior unnoticed.

Designed-for-later (not built in MVP):
- Router-level failover (`default` → alternate provider) behind an explicit per-prompt opt-in.
- Degraded mode (return a structured "could not summarize" object) only where a workflow explicitly declares it acceptable.
- Cost-cap fallback to a cheaper alias when a budget threshold is hit.

---

## 22. Future Agent Registry

Not in MVP. The seam: today the AI executor uses one designated agent user + the in-code prompt/router. A future `agents` registry (in-code first, then a table) would define named agents = `(prompt set + model policy + tool allowlist + output contracts + guardrails)`. A `call_agent` step would select an agent by id, exactly as `call_ai` selects a prompt. The `call_ai` design is deliberately a strict subset so `call_agent` is an extension, not a rewrite.

---

## 23. Future Tool Registry

Not in MVP (no external tools, no function-calling that mutates state). The seam: a tool is *another workflow step type* (or a constrained service the AI may *request* via structured output, executed by a subsequent governed step). Tools never execute inside the `call_ai` step; an AI "tool request" is a **proposal** that a later step (human-gated where governed) fulfills. This preserves "AI proposes, the runtime disposes."

---

## 24. Future Knowledge / Retrieval Integration

Not in MVP (no vector store, no embeddings, no new deps). The seam: retrieval is a **prior non-AI step** that fetches RLS-scoped context (from existing tables or a future knowledge store) and writes it into `accumulated`; the `call_ai` step then consumes it through `input_keys`. RAG therefore needs **no change** to the `call_ai` contract — only new upstream steps. Knowledge writes (e.g. `knowledge_record_created` in `agent_activity`) reuse the existing telemetry vocabulary.

---

## 25. MVP Build Plan

Smallest governed slice. One step type, one prompt, one model, one safe workflow.

**Scope:**
- `call_ai` step type (the only executor change).
- In-code prompt registry (`lib/ai/prompts.ts`), one prompt `request_summary_v1`.
- Static model router (`lib/ai/router.ts`), one alias `default`.
- One structured schema `summary_v1` + `validateAiOutput`.
- Provider client (`lib/ai/provider.ts`) — single egress, server-only key.
- Telemetry writers for `agent_activity`, `execution_logs`, `runtime_metrics`.
- **No** DB prompt registry, **no** multi-agent, **no** external tools, **no** retrieval.

**Prerequisite migration (separate, additive — first build sprint, not now):**
- Seed one `users.role='agent'` AI user per org (or per-org on demand) and an `agent_sessions` open path.
- Grant `service_role` INSERT on `agent_activity`, `agent_sessions`, `runtime_metrics` (pattern of migration 022). No new tables required.

**Test workflow `request_ai_summary` (in `lib/workflows/registry.ts`):**
```
log_start            (write_execution_log)
ai_summarize         (call_ai: prompt_id=request_summary_v1, output_schema_id=summary_v1, input_keys=['intent'])
create_summary_draft (create_output: type='report', status='draft', from accumulated.summary)
request_review       (request_approval: subject_type='output', subject_id=<draft>)  → creates PENDING approval
log_complete         (write_execution_log)
complete             (complete)
```
Properties enforced by design:
- **Draft output only** — `status='draft'`, never delivered.
- **No automatic approval** — a real pending `approvals` row awaits a human.
- **No irreversible action** — nothing leaves the org, nothing is delivered, no governed transition occurs.
- **Fully observable/recoverable** — appears in Workflow Runs; a failed AI step is resumable.

**Trigger:** manual only in MVP (operator starts `request_ai_summary` for a request via a `trigger-workflow`-style path); no auto-trigger on request creation until the loop is trusted.

---

## 26. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| AI step gains a path to mutate governed state | High | Step returns output only; governed writes happen in separate human-gated steps; agent role + RLS block transitions |
| Prompt injection turns output into instructions | High | Output is untrusted data, schema-validated, only ever a draft; never used to choose steps or build queries |
| Secret/PII leakage into logs/metrics/output | High | Keys server-only & confined to `provider.ts`; never persist prompt/input/secret; validation strips non-schema fields |
| Non-deterministic resume produces different output | Med | Documented; resume is recommended & safe (no side effects); lineage records parent/child runs |
| Runaway cost / latency | Med | Token/cost caps per step; `runtime_metrics` makes spend visible; fail-closed (no silent escalation) |
| Missing agent user/session blocks `agent_activity` insert | Med | Build-sprint prerequisite: seed agent user + session + grants before enabling the step |
| Provider outage stalls AI workflows | Med | Fail-closed + existing job retry/backoff + recovery; non-AI workflows unaffected |
| Hidden coupling creep (AI reading DB directly) | Med | Data-access rule: `call_ai` reads only `ctx`/`accumulated`; retrieval is an upstream step |
| Scope creep into multi-agent/tools/RAG | Low | Explicitly deferred; seams designed so each is additive |

---

## 27. Definition of Done (for the MVP build sprint that follows)

The AI layer is "done" for MVP when **all** hold:

1. A `call_ai` step executes through the existing worker (`workflow_step` job → `executeStep`) with **no** changes to `execute.ts`/`dispatch.ts` beyond the new `case`.
2. Validated structured output is persisted in `workflow_step_runs.output_payload` and flows into `accumulated`.
3. Each `call_ai` run writes: one `agent_activity` row (AI agent + session), `execution_logs` rows (existing vocabulary, `actor='agent:ai'`), and `runtime_metrics` rows for tokens/latency/cost (XOR-correct).
4. `request_ai_summary` runs end-to-end producing a **draft** output and a **pending** approval — and **no** governed transition occurs without a human resolving that approval.
5. A failed `call_ai` step is **resumable** via the existing recovery engine, leaving no partial governed state.
6. Cost and latency for a run are queryable from `runtime_metrics`.
7. Provider keys never appear in any row, log, or client bundle; the provider SDK is confined to `provider.ts`; dev AI endpoints 404 in production.
8. `npm run typecheck` and `npm run lint` clean; the test workflow verified end-to-end (enqueue → worker → draft output + pending approval) with the provider mocked or live-gated behind the worker secret.

**Out of scope (explicitly not DoD):** DB-backed prompt registry, multi-agent, external tools/function-calling, vector retrieval, automated delivery, automated approval, model failover.
