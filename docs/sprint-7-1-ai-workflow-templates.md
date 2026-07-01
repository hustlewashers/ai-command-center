# Sprint 7.1 — AI Workflow Templates

**Status:** Implemented. Adds a reusable **template** layer above the AI workflow registry. No new production AI workflow, no new provider/tools/retrieval/agents, no runtime-engine or recovery change, no migrations, no DB-backed workflows, no prompts for inactive templates.
**Version context:** `v0.7.0-ai-workflow-framework` → `v0.7.1-ai-workflow-templates`.

---

## 1. Why templates exist

The Sprint 7.0 framework let a new AI workflow be *registered* declaratively, but each registration still re-derived the same choices from scratch: what output to produce, that a human approval must gate it, which readiness requirements apply, and which actions are forbidden. Templates capture the **repeatable shape of a class of governed AI workflows** so those choices are made once, consistently, and are visible as documentation. A template is a **blueprint**; a registered AI workflow is an **instantiation** of one.

Templates are pure serializable metadata — a coordination / read-model + documentation layer. They **never execute, hold no privilege, register no prompt, and create no runtime workflow.**

---

## 2. How the layers differ

| Layer | File | What it is | Executes? |
|---|---|---|---|
| **Template** | `lib/ai/workflow-templates.ts` | A reusable blueprint for a *class* of AI workflows (output target, approval policy, readiness policy, governance boundaries) | No |
| **AI workflow (registry)** | `lib/ai/workflows.ts` | A concrete registered AI workflow: a specific prompt + runtime workflow + inputs, optionally citing a `template_id` | No (metadata) |
| **Runtime workflow** | `lib/workflows/registry.ts` | The actual ordered **steps** the engine runs | Yes |
| **Prompt** | `lib/ai/prompts.ts` | A single system prompt + structured-output schema used by one `call_ai` step | Provider call |

- **Template vs runtime workflow:** a template has **no steps** and cannot run. A runtime workflow is the executable step list. A template describes the *pattern* many runtime workflows share.
- **Template vs prompt:** a prompt is a single model instruction + schema. A template may reference a `default_prompt_id`, but it is a whole-workflow pattern (inputs → draft output → approval gate), not a model instruction. One template can be instantiated with different prompts.

---

## 3. Current template catalog

| Template ID | Category | Status | Backs |
|---|---|---|---|
| `ai_draft_output_from_entity` | draft | **active** | `request_ai_summary` |
| `ai_classification_with_review` | classification | experimental | — (blueprint only) |
| `ai_recommendation_with_approval` | recommendation | experimental | — (blueprint only) |

Only the first is `active` and actually backs a registered workflow. The other two are blueprints for future workflows: **no prompt and no runtime workflow exist for them yet.** `isAiWorkflowTemplateActive(id)` returns `true` only for `ai_draft_output_from_entity`.

Each template declares `governed_actions_allowed` (draft/propose only: produce a draft output, open a pending approval, write logs) and `forbidden_actions` (deliver output, approve/reject an approval, transition a task/work packet, mutate governed state directly, call external tools, auto-trigger without a human).

---

## 4. How to instantiate a new AI workflow from a template

A template does **not** create a workflow. Instantiation is still the four additive steps from Sprint 7.0, with the template as the checklist for the choices:

1. **Register the prompt** in `lib/ai/prompts.ts` (+ `AiPromptId` in `types/ai.ts`). If the template's `default_prompt_id` is `null` (classification/recommendation), you must supply one.
2. **Build the runtime workflow** (steps) in `lib/workflows/registry.ts`, following the governed draft pattern: `log_start → call_ai → create_output (draft) → request_approval (pending) → complete`.
3. **Register the AI workflow** in `lib/ai/workflows.ts` (+ its id in `AiWorkflowId`), copying the template's `default_output_target`, `default_approval_policy`, `default_readiness_policy`, and inputs — then set `template_id` to the template you followed.
4. **Readiness** comes from the registered workflow's `readiness` block (the template's `default_readiness_policy` is the recommended starting point). The evaluator reads those flags — no new evaluator needed for the same trigger surface.

The `AiWorkflowTemplateInstantiationPlan` type expresses what such a registration would look like as data (read-model only — it registers nothing).

---

## 5. Examples of future workflows (illustrative — not built)

| Future workflow | Template | Target entity | Notes |
|---|---|---|---|
| `request_risk_assessment` | `ai_classification_with_review` | request | AI proposes a risk level; human reviews before any governed change. |
| `task_priority_recommendation` | `ai_recommendation_with_approval` | task | AI proposes a priority/next action; approval gate remains. |
| `work_packet_summary` | `ai_draft_output_from_entity` | work_packet | Draft summary output, pending approval. |
| `decision_draft` | `ai_recommendation_with_approval` | decision | AI drafts a decision recommendation; human decides. |

Each would need its own prompt + runtime workflow + registry entry (§4). None is available until registered.

---

## 6. Governance rules (unchanged, restated by every template)

1. **AI proposes drafts; only a human approves a governed transition.** Every template requires approval (`default_approval_policy.required = true`, `must_precede_governed_change = true`).
2. **No auto-delivery.** `default_output_target.status` is always `draft`.
3. **No governed mutation by AI.** The `call_ai` step writes no business records; draft materialization and the pending approval happen in separate non-AI steps.
4. **No approval bypass.** A template cannot mark anything pre-approved.
5. **No new external entry point, no tools, no retrieval, no agents.** Templates add none of these — they only document the pattern.

---

## 7. What NOT to do

- Do **not** treat a template as runnable — it has no steps and no execution path.
- Do **not** register a prompt or runtime workflow for an `experimental` template until you are actually building that workflow.
- Do **not** relax `forbidden_actions` or set an output target to a non-`draft` status to "skip" approval.
- Do **not** add a `template_id` to a registered workflow whose shape doesn't actually match that template.
- Do **not** move execution logic into the template layer; execution stays in `lib/workflows/registry.ts` + the step executor.

---

## 8. Files touched this sprint

- `types/ai.ts` — template types (`AiWorkflowTemplateId`, `AiWorkflowTemplateDefinition`, `AiWorkflowTemplateInput`, `AiWorkflowTemplateOutputTarget`, `AiWorkflowTemplateApprovalPolicy`, `AiWorkflowTemplateReadinessPolicy`, `AiWorkflowTemplateInstantiationPlan`); `template_id?` added to `AiWorkflowDefinition`.
- `lib/ai/workflow-templates.ts` (new) — registry: `listAiWorkflowTemplates`, `getAiWorkflowTemplate`, `isAiWorkflowTemplateActive`.
- `lib/ai/workflows.ts` — `request_ai_summary.template_id = 'ai_draft_output_from_entity'`.
- `app/ai-operations/page.tsx` — **AI Workflow Templates** section; template column on the AI Workflow Registry table.
- `docs/sprint-7-1-ai-workflow-templates.md` (this file).

Unchanged: `lib/workflows/registry.ts`, the step executor, readiness logic, recovery, provider, approvals. No runtime behavior changed.
