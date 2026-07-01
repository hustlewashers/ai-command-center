# Sprint 7.3 — AI Capability Registry

**Status:** Implemented. Adds a reusable **capability** layer between prompts and workflows. Registry / read-model only — no new runtime workflows, prompts, models, providers, tools, retrieval, or agents; no engine/recovery redesign; no migrations. AI stays draft-only and human-approval-gated.
**Version context:** `v0.7.2-prompt-versioning` → `v0.7.3-ai-capability-registry`.

---

## 1. Why capabilities exist

Prompts, templates, and workflows all answered *how* the AI runs. Nothing named *what the AI does* in reusable terms. Without that, every new workflow re-declares its purpose, governance intent, output expectations, and evaluation metadata from scratch, and there is no way to group "all the summarization things" or "all the risk things" across prompts and workflows.

A **capability** captures *what the AI does* (summarize, classify, recommend, assess risk, …) once, independent of any single prompt version or runtime workflow. Workflows then **reference** a capability instead of duplicating its intent.

Capabilities are pure serializable metadata — a coordination / read-model + documentation layer. They **never execute, hold no privilege, register no prompt, and create no runtime workflow.**

---

## 2. Capability vs prompt

- A **prompt** (`lib/ai/prompts.ts`) is a single versioned model instruction + output schema. It is executable.
- A **capability** is the *kind of work* a prompt is used for. `request_summarization` is the capability; `REQUEST_SUMMARIZER@v1` is one prompt version that realizes it. A capability may reference a `default_prompt_id`, or `null` when no prompt exists yet (planned).

## 3. Capability vs workflow template

- A **template** (`lib/ai/workflow-templates.ts`) is a reusable *structural blueprint* (inputs → draft output → approval gate) for a class of workflows.
- A **capability** is the *semantic intent* (what the output means and how quality is judged). A capability names a `default_template_id` it typically instantiates through. Example: `request_summarization` → template `ai_draft_output_from_entity`.

## 4. Capability vs runtime workflow

- A **runtime workflow** (`lib/workflows/registry.ts`) is the executable ordered step list; the engine runs it.
- A **capability** has no steps and cannot run. A registered AI workflow ties them together: it cites a `capability_id` (what), a `template_id` (shape), a `prompt_id` (instruction), and a `runtime_workflow_id` (execution).

---

## 5. Current capability catalog

| Capability ID | Category | Status | Default prompt | Default template | Realized by |
|---|---|---|---|---|---|
| `request_summarization` | summarization | **active** | `REQUEST_SUMMARIZER` | `ai_draft_output_from_entity` | `request_ai_summary` |
| `risk_assessment` | risk_assessment | planned | — | `ai_classification_with_review` | — |
| `action_recommendation` | recommendation | planned | — | `ai_recommendation_with_approval` | — |
| `classification` | classification | planned | — | `ai_classification_with_review` | — |

Only `request_summarization` is `active`. The rest are `planned`: declared intent with **no prompt and no runtime workflow**. `isAiCapabilityActive(id)` returns `true` only for `request_summarization`. Accessors: `listAiCapabilities`, `listActiveAiCapabilities`, `getAiCapability`, `isAiCapabilityActive`.

Every capability declares `allowed_actions` (draft/propose only), `forbidden_actions` (deliver, approve/reject, transition, mutate governed state, call tools, auto-trigger), and a `governance_policy` where `may_mutate_governed_state` is always `false`.

---

## 6. How to add a new capability

1. Add an `AiCapabilityId` in `types/ai.ts` and a definition in `lib/ai/capabilities.ts`: category, purpose, description, supported target entities, `default_prompt_id`/`default_template_id` (may be `null`), `output_contract`, `governance_policy` (draft-only, approval-required), `evaluation_signals`, allowed/forbidden actions, and `status: 'planned'`.
2. It immediately appears in **AI Operations → AI Capability Registry** as documentation.

## 7. How to activate a planned capability

A capability becomes `active` only when a real workflow realizes it — it is not activated in isolation:

1. Register the prompt (`lib/ai/prompts.ts`, versioned) and set the capability's `default_prompt_id`.
2. Build the runtime workflow (`lib/workflows/registry.ts`) following the capability's template pattern (`log_start → call_ai → create_output (draft) → request_approval (pending) → complete`).
3. Register the AI workflow (`lib/ai/workflows.ts`) with `capability_id`, `template_id`, `prompt_id`, `runtime_workflow_id`.
4. Flip the capability `status` to `active`.

---

## 8. Governance rules (unchanged, restated per capability)

1. **AI proposes drafts; only a human approves a governed transition.** Every capability's `governance_policy.approval_required` and `human_review_required` are `true`.
2. **Draft-only.** `output_contract.status` and `governance_policy.draft_only` are always draft/true; `may_mutate_governed_state` is always `false`.
3. **No approval bypass, no auto-delivery, no tools/retrieval/agents** — a capability adds none of these; it only documents intent.

---

## 9. Examples

- **`request_summarization`** (active) — summarize a request into a structured draft; realized by `request_ai_summary` using `REQUEST_SUMMARIZER@v1`.
- **`risk_assessment`** (planned) — propose a risk level + rationale as a draft; would use the `ai_classification_with_review` template once a prompt and workflow exist.
- **`action_recommendation`** (planned) — propose next actions as a draft; would use `ai_recommendation_with_approval`.
- **`classification`** (planned) — propose a label/category as a draft; would use `ai_classification_with_review`.

---

## 10. What NOT to do

- Do **not** treat a capability as runnable — it has no steps.
- Do **not** register a prompt or runtime workflow for a `planned` capability until you are actually building it.
- Do **not** flip a capability to `active` without a registered, working workflow behind it.
- Do **not** set `may_mutate_governed_state` to anything but `false`, or relax `forbidden_actions`, to skip approval.
- Do **not** move execution logic into the capability layer — execution stays in `lib/workflows/registry.ts` + the step executor.

---

## 11. Files touched this sprint

- `types/ai.ts` — `AiCapabilityId`, `AiCapabilityCategory`, `AiCapabilityStatus`, `AiCapabilityOutputContract`, `AiCapabilityGovernancePolicy`, `AiCapabilityDefinition`; `capability_id?` added to `AiWorkflowDefinition`.
- `lib/ai/capabilities.ts` (new) — registry + accessors.
- `lib/ai/workflows.ts` — `request_ai_summary.capability_id = 'request_summarization'`.
- `app/ai-operations/page.tsx` — **AI Capability Registry** section; capability column on the AI Workflow Registry table.
- `docs/sprint-7-3-ai-capability-registry.md` (this file).

Unchanged: `lib/workflows/registry.ts`, the step executor, prompts, provider, readiness, recovery, approvals. `request_ai_summary` still executes at `REQUEST_SUMMARIZER@v1` exactly as before.
