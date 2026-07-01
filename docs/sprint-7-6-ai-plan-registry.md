# Sprint 7.6 — AI Plan Registry

**Status:** Implemented. Adds an AI **plan** layer: governed, ordered sequences composing agents, skills, capabilities, and workflows with human-review checkpoints. Registry / read-model only. **Plans do not execute yet — they are governed metadata only.** No plan execution, autonomous behavior, tool calling, retrieval, multi-agent orchestration runtime, new runtime workflows, prompts, or models; no engine/recovery redesign; no migrations. AI stays draft-only and human-approval-gated.
**Version context:** `v0.7.5-ai-agent-registry` → `v0.7.6-ai-plan-registry`.

---

## 1. Why plans exist

The registry stack names prompts, skills, capabilities, templates, workflows, and agents (roles). What it did not name is a **multi-step sequence**: how several of those combine, in order, with explicit human gates between them, to reach an outcome. A **plan** is that sequence — a governed, ordered list of steps (agent/skill/capability/workflow) punctuated by `approval_checkpoint` / `human_review` steps. It is the unit a future orchestration layer would walk.

Defining plans as metadata now fixes the seam: a later orchestration sprint can execute these sequences under the same draft-only, human-approval-gated guarantees, rather than inventing an ungoverned "run a plan" path. Crucially, the human gates are *part of the plan's declared shape*, so review is structural, not bolted on.

Plans are pure serializable metadata — a coordination / read-model + documentation layer. They **never execute, orchestrate nothing, register no prompt, create no runtime workflow, and hold no privilege.**

---

## 2. Plan vs the rest of the stack

- **Plan vs agent:** an agent is a *role* (who). A plan is an *ordered sequence* (a recipe) that may invoke one or more agents' steps toward a multi-step outcome. `request_summary_review_plan` composes the `request_summary_assistant`.
- **Plan vs skill:** a skill is a single operation. A plan sequences skills (and other steps) with gates between them.
- **Plan vs capability:** a capability is a business purpose. A plan may span several purposes across its steps (e.g. triage = assess risk + classify + review).
- **Plan vs workflow:** a runtime workflow is one executable step list the engine runs *today*. A plan is a higher-level sequence that *references* workflows as steps; it has no execution of its own. A plan step of kind `workflow` points at an existing governed workflow (`request_ai_summary`); the plan does not run it — a human-triggered path does.
- **Plan vs prompt:** a prompt is a single model instruction. A plan is many steps above that; it references prompts only transitively through its skills/workflows.

The full stack, top to bottom: **plan** (sequence) → **agent** (role) → **capability** (purpose) → **skill** (operation) → **template** (shape) → **prompt version** (instruction) → **runtime workflow** (execution).

---

## 3. Why plans are non-executable in this sprint

Executing a plan means *orchestration* — automatically advancing from one governed step to the next. That is precisely where an ungoverned system would skip an approval or chain actions autonomously. This sprint ships the **sequence vocabulary and its governance envelope** first: each plan declares its steps (including the mandatory human checkpoints), its allow-lists, and hard-false execution flags (`may_execute_workflows`, `may_mutate_governed_state`, `may_deliver_outputs` are the literal `false`, type-enforced). When orchestration is added later, it is constrained by an already-reviewed plan shape in which the human gates are non-optional.

---

## 4. How future orchestration may execute plans

A future orchestration sprint would walk a plan's `steps` in order: run each AI step as a governed `call_ai` workflow producing a draft, then **halt at each `approval_checkpoint` / `human_review` step until a human acts**. It advances only on human approval; it never resolves an approval, delivers an output, or transitions an entity itself. The plan's `allowed_*` lists bound exactly which agents/skills/capabilities/workflows the orchestrator may touch, so runtime behavior is confined to data reviewed today. Orchestration is explicitly **out of scope** here.

---

## 5. Current plan catalog

| Plan ID | Category | Status | Agents | Skills | Workflows |
|---|---|---|---|---|---|
| `request_summary_review_plan` | review | **active** | `request_summary_assistant` | `summarize_request` | `request_ai_summary` |
| `request_risk_triage_plan` | triage | planned | `risk_review_analyst` | `assess_entity_risk`, `classify_entity` | — |
| `action_recommendation_plan` | recommendation | planned | `action_recommendation_advisor` | `recommend_next_action` | — |
| `operations_monitoring_plan` | monitoring | planned | `operations_monitor` | — | — |

`active` means the plan's composed chain is registered and working — **not** that the plan executes; it does not. `isAiPlanActive(id)` returns `true` only for `request_summary_review_plan`. Accessors: `listAiPlans`, `listActiveAiPlans`, `getAiPlan`, `isAiPlanActive`.

Every plan step declares `kind`, `required`, `approval_required`, and (for producing steps) an `output_contract`. Each plan ends at a human gate. Every plan declares `allowed_actions` (describe/propose only), `forbidden_actions` (execute plan/workflow, deliver, approve/reject, transition, mutate governed state, call tools, act autonomously, orchestrate at runtime), and the hard-false governance flags.

### The active plan in detail

`request_summary_review_plan` has two steps:
1. **`summarize`** (`kind: workflow`) — run the governed `request_ai_summary` workflow to produce a DRAFT summary output. No delivery.
2. **`human_review`** (`kind: approval_checkpoint`, `approval_required: true`) — a human resolves the pending approval before anything is delivered.

This is exactly what happens today, just now *named as a plan*. Nothing new executes.

---

## 6. How to add / activate a plan

**Add (planned):** add an `AiPlanId` in `types/ai.ts` and a definition in `lib/ai/plans.ts` with category, target entities, ordered `steps` (ending in a human gate), allow-lists, `governance_policy` (execution flags false), signals, allowed/forbidden actions, and `status: 'planned'`. It appears in **AI Operations → AI Plan Registry** as documentation.

**Activate:** a plan becomes `active` only when its composed chain (agents/skills/capabilities/workflows) is registered and working. Flip `status` to `active`. Making a plan *executable* (orchestration) is out of scope and requires a future sprint with its own governance review — activation in this registry never implies execution.

---

## 7. Governance rules

1. **Plans do not execute.** Non-executable metadata only; `may_execute_workflows` is always `false`.
2. **Human gates are structural.** Every plan ends at (and gates governed steps behind) an `approval_checkpoint` / `human_review` step; `requires_human_approval` is `true`.
3. **AI proposes drafts; only a human approves a governed transition.** `may_mutate_governed_state` and `may_deliver_outputs` are always `false`.
4. **Audit logging required.** `requires_audit_logging` is `true` — any future execution must be fully observable.
5. **No approval bypass, no auto-delivery, no tools/retrieval/runtime orchestration** — plans add none of these; they only declare a governed sequence.

---

## 8. What NOT to do

- Do **not** make a plan executable, or add orchestration/autonomous behavior — out of scope; needs a dedicated governed sprint.
- Do **not** set any of `may_execute_workflows` / `may_mutate_governed_state` / `may_deliver_outputs` to anything but `false`.
- Do **not** author a plan without a terminal human-review / approval checkpoint gating its governed steps.
- Do **not** register a prompt or runtime workflow for a `planned` plan until you are actually building that chain.
- Do **not** flip a plan to `active` without a registered, working composed chain behind it.
- Do **not** move execution/orchestration logic into the plan layer — execution stays in `lib/workflows/registry.ts` + the step executor.

---

## 9. Files touched this sprint

- `types/ai.ts` — `AiPlanId`, `AiPlanCategory`, `AiPlanStatus`, `AiPlanStepKind`, `AiPlanStepDefinition`, `AiPlanGovernancePolicy`, `AiPlanDefinition`; `supported_plan_ids?` added to `AiAgentDefinition` and `AiWorkflowDefinition`.
- `lib/ai/plans.ts` (new) — registry + accessors.
- `lib/ai/agents.ts`, `lib/ai/workflows.ts` — descriptive plan links on the active + planned chains.
- `app/ai-operations/page.tsx` — **AI Plan Registry** section; plan-link columns on the Agent and Workflow tables.
- `docs/sprint-7-6-ai-plan-registry.md` (this file).

Unchanged: `lib/workflows/registry.ts`, the step executor, prompts, provider, readiness, recovery, approvals. `request_ai_summary` still executes at `REQUEST_SUMMARIZER@v1` exactly as before. **Plans do not execute yet — they are governed metadata only.**
