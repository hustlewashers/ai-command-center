# Sprint 7.4 — AI Skill Registry

**Status:** Implemented. Adds an AI **skill** layer: reusable AI operations that capabilities compose and future agents will orchestrate. Registry / read-model only — no agents, tool calling, retrieval, new runtime workflows, prompts, or models; no engine/recovery redesign; no migrations. AI stays draft-only and human-approval-gated.
**Version context:** `v0.7.3-ai-capability-registry` → `v0.7.4-ai-skill-registry`.

---

## 1. Why skills exist

The registry stack now names *what the AI does for a business purpose* (capability) but not *the underlying operation* in reusable, purpose-independent terms. A **skill** is the most granular reusable unit: a single AI operation (summarize, classify, extract, recommend, compare, prioritize, assess_risk, route). One skill can serve many capabilities; a capability composes one or more skills. Naming skills explicitly is what lets a **future agent** orchestrate operations ("summarize, then classify, then recommend") without re-deriving each one.

Skills are pure serializable metadata — a coordination / read-model + documentation layer. They **never execute, hold no privilege, register no prompt, and create no runtime workflow.**

---

## 2. Skill vs capability

- A **capability** (`lib/ai/capabilities.ts`) names *what the AI does for a business purpose* (e.g. `request_summarization`) and carries the governance/output contract for that purpose.
- A **skill** (`lib/ai/skills.ts`) names the *underlying operation* independent of purpose (e.g. `summarize_request`, category `summarize`). A capability points at a `default_skill_id`; a skill points back at a `default_capability_id`. Example: capability `request_summarization` composes skill `summarize_request`.

## 3. Skill vs prompt

- A **prompt** is a single versioned model instruction + schema; it is executable.
- A **skill** is the operation a prompt performs. `summarize_request` is the skill; `REQUEST_SUMMARIZER@v1` is the prompt that realizes it. A skill names a `default_prompt_id`, or `null` when no prompt exists yet (planned).

## 4. Skill vs workflow

- A **runtime workflow** (`lib/workflows/registry.ts`) is the executable step list the engine runs.
- A **skill** has no steps and cannot run. A workflow executes a skill *indirectly*: it runs a `call_ai` step with the skill's prompt, inside the capability's template shape. The skill is the semantic operation; the workflow is the governed execution.

The full chain: **skill** (operation) → **capability** (business purpose) → **template** (structural shape) → **prompt version** (instruction) → **runtime workflow** (execution).

---

## 5. How future agents will compose skills

An agent (not built — see Sprint 6.0 blueprint §22) would select and sequence skills by id, exactly as `call_ai` selects a prompt. Because each skill declares its `supported_input_entities`, `output_contract`, `governance_policy`, and `forbidden_actions`, an agent can chain them while every step remains draft-only and human-gated. The skill registry is the vocabulary an agent orchestrates over; this sprint defines that vocabulary without adding any agent.

---

## 6. Current skill catalog

| Skill ID | Category | Status | Default capability | Default prompt |
|---|---|---|---|---|
| `summarize_request` | summarize | **active** | `request_summarization` | `REQUEST_SUMMARIZER` |
| `classify_entity` | classify | planned | `classification` | — |
| `assess_entity_risk` | assess_risk | planned | `risk_assessment` | — |
| `recommend_next_action` | recommend | planned | `action_recommendation` | — |
| `extract_entity_facts` | extract | planned | — | — |

Only `summarize_request` is `active`. The rest are `planned`: declared operations with **no prompt and no runtime workflow**. `isAiSkillActive(id)` returns `true` only for `summarize_request`. Accessors: `listAiSkills`, `listActiveAiSkills`, `getAiSkill`, `isAiSkillActive`.

Every skill declares `allowed_actions` (draft/propose only), `forbidden_actions` (deliver, approve/reject, transition, mutate governed state, call tools, auto-trigger), and a `governance_policy` where `may_mutate_governed_state` is always `false`.

---

## 7. How to add a new skill

1. Add an `AiSkillId` in `types/ai.ts` and a definition in `lib/ai/skills.ts`: category, purpose, description, supported input entities, supported output types, `default_capability_id`/`default_prompt_id` (may be `null`), required/optional inputs, `output_contract`, `governance_policy` (draft-only, approval-required), `evaluation_signals`, allowed/forbidden actions, and `status: 'planned'`.
2. It immediately appears in **AI Operations → AI Skill Registry** as documentation.

## 8. How to activate a planned skill

A skill becomes `active` only when a real prompt + workflow realize it:

1. Register the prompt (`lib/ai/prompts.ts`, versioned) and set the skill's `default_prompt_id`.
2. Ensure/activate the capability that composes the skill (set the capability's `default_skill_id`, flip its status).
3. Build the runtime workflow (`lib/workflows/registry.ts`) and register the AI workflow (`lib/ai/workflows.ts`, with `capability_id`).
4. Flip the skill `status` to `active`.

---

## 9. Governance rules (unchanged, restated per skill)

1. **AI proposes drafts; only a human approves a governed transition.** Every skill's `governance_policy.approval_required` and `human_review_required` are `true`.
2. **Draft-only.** `output_contract.status` and `governance_policy.draft_only` are always draft/true; `may_mutate_governed_state` is always `false`.
3. **No approval bypass, no auto-delivery, no tools/retrieval/agents** — a skill adds none of these; it only names an operation.

---

## 10. What NOT to do

- Do **not** treat a skill as runnable — it has no steps.
- Do **not** register a prompt or runtime workflow for a `planned` skill until you are actually building it.
- Do **not** flip a skill to `active` without a registered prompt + working workflow behind it.
- Do **not** set `may_mutate_governed_state` to anything but `false`, or relax `forbidden_actions`, to skip approval.
- Do **not** move execution logic into the skill layer — execution stays in `lib/workflows/registry.ts` + the step executor.

---

## 11. Files touched this sprint

- `types/ai.ts` — `AiSkillId`, `AiSkillCategory`, `AiSkillStatus`, `AiSkillInput`, `AiSkillOutputContract`, `AiSkillGovernancePolicy`, `AiSkillDefinition`; `default_skill_id?` added to `AiCapabilityDefinition`.
- `lib/ai/skills.ts` (new) — registry + accessors.
- `lib/ai/capabilities.ts` — `default_skill_id` set on each capability (`request_summarization → summarize_request`, etc.).
- `app/ai-operations/page.tsx` — **AI Skill Registry** section; Default Skill column on the AI Capability Registry table.
- `docs/sprint-7-4-ai-skill-registry.md` (this file).

Unchanged: `lib/workflows/registry.ts`, the step executor, prompts, provider, readiness, recovery, approvals. `request_ai_summary` still executes at `REQUEST_SUMMARIZER@v1` exactly as before.
