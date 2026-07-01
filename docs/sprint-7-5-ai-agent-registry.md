# Sprint 7.5 — AI Agent Registry

**Status:** Implemented. Adds an AI **agent** layer: governed roles that may *eventually* compose skills, capabilities, and workflows. Registry / read-model only. **Agents do not act autonomously yet — they are governed metadata only.** No agent execution, autonomous behavior, tool calling, retrieval, multi-agent orchestration, new runtime workflows, prompts, or models; no engine/recovery redesign; no migrations. AI stays draft-only and human-approval-gated.
**Version context:** `v0.7.4-ai-skill-registry` → `v0.7.5-ai-agent-registry`.

---

## 1. Why agents exist

The registry stack now names prompts, skills (operations), capabilities (business purposes), templates (shapes), and workflows (execution). What it did not name is a **role** that pursues a goal by composing several of those — the unit a future goal-oriented, governed agent would occupy. An **agent** is that role: a bounded, governed identity with an explicit allow-list of skills, capabilities, workflows, and prompts it *may* compose, plus a governance policy that hard-forbids execution, mutation, and delivery in this sprint.

Defining agents as metadata now fixes the seam (blueprint §22): a later agent-execution sprint can bring these roles to life under the same draft-only, human-approval-gated guarantees, rather than inventing an ungoverned agent path.

Agents are pure serializable metadata — a coordination / read-model + documentation layer. They **never execute, hold no privilege, register no prompt, create no runtime workflow, and orchestrate nothing.**

---

## 2. Agent vs the rest of the stack

- **Agent vs skill:** a skill is a single reusable operation (`summarize_request`). An agent is a *role* that may compose one or more skills toward a goal (`request_summary_assistant` composes `summarize_request`).
- **Agent vs capability:** a capability names what the AI does for a business purpose (`request_summarization`). An agent is *who* would carry out that purpose within a bounded scope and governance policy.
- **Agent vs workflow:** a runtime workflow is the executable step list. An agent has no steps and cannot run; it references the workflows it *may* invoke via a human-triggered governed path (`allowed_workflow_ids`). The workflow executes; the agent, this sprint, does not.
- **Agent vs prompt:** a prompt is a single model instruction + schema. An agent references the prompts (`default_prompt_ids`) its skills would use; it is a role, not an instruction.

The full stack, top to bottom: **agent** (role) → **capability** (purpose) → **skill** (operation) → **template** (shape) → **prompt version** (instruction) → **runtime workflow** (execution).

---

## 3. Why agents are non-executable in this sprint

Autonomy is the highest-risk addition to a governed platform: an executing agent that could pick its own steps, run workflows, or resolve approvals would route around every gate the platform enforces structurally. This sprint deliberately ships the **vocabulary and governance envelope** first — the allow-lists and hard-false flags — so that when execution is added later it is constrained by an already-reviewed policy. Concretely, every agent's `governance_policy` sets `may_execute_workflows`, `may_mutate_governed_state`, and `may_deliver_outputs` to `false` (enforced by the type system: those fields are the literal `false`). Agents can only ever *propose drafts via a governed, human-triggered workflow* — the same guarantee as every other AI layer.

---

## 4. How future agents may compose skills

A future agent-execution sprint would let an agent select and sequence its `allowed_skill_ids` toward a goal (e.g. "summarize, then classify, then recommend"), where each skill runs as a governed `call_ai` step producing a draft, and each governed transition still waits on a human approval. The agent chooses *which* operations and *in what order*, within its declared `scope` and allow-lists; it never gains a path to execute a governed transition itself. The registry defines exactly what each agent is permitted to compose, so that future orchestration is bounded by data reviewed today.

---

## 5. Current agent catalog

| Agent ID | Category | Status | Allowed skills | Allowed capabilities | Allowed workflows |
|---|---|---|---|---|---|
| `request_summary_assistant` | assistant | **active** | `summarize_request` | `request_summarization` | `request_ai_summary` |
| `risk_review_analyst` | analyst | planned | `assess_entity_risk`, `classify_entity` | `risk_assessment`, `classification` | — |
| `action_recommendation_advisor` | analyst* | planned | `recommend_next_action` | `action_recommendation` | — |
| `operations_monitor` | monitor | planned | — | — | — |

\* "advisor" is not in the `AiAgentCategory` enum, so this agent is categorized as `analyst`.

`active` means the agent's composed chain (its skills/capability/workflow) is registered and working — **not** that the agent executes; it does not. The rest are `planned`. `isAiAgentActive(id)` returns `true` only for `request_summary_assistant`. Accessors: `listAiAgents`, `listActiveAiAgents`, `getAiAgent`, `isAiAgentActive`.

Every agent declares `allowed_actions` (propose/observe for human review only), `forbidden_actions` (execute workflow, deliver, approve/reject, transition, mutate governed state, call tools, act autonomously, orchestrate other agents), and the hard-false governance flags above. `operations_monitor` is read-only by design — it composes nothing and would only surface observations for humans.

---

## 6. How to add / activate an agent

**Add (planned):** add an `AiAgentId` in `types/ai.ts` and a definition in `lib/ai/agents.ts` with scope, allow-lists (may be empty), `governance_policy` (execution flags false), evaluation signals, allowed/forbidden actions, and `status: 'planned'`. It appears in **AI Operations → AI Agent Registry** as documentation.

**Activate:** an agent becomes `active` only when its composed chain is registered and working (prompts + capability + workflow all exist and are active). Flip `status` to `active`. Making an agent *executable* is explicitly out of scope here and requires a future sprint with its own governance review — activation in this registry never implies execution.

---

## 7. Governance rules

1. **Agents do not act autonomously.** Non-executable metadata only; `may_execute_workflows` is always `false`.
2. **AI proposes drafts; only a human approves a governed transition.** `requires_human_approval` is `true`; `may_mutate_governed_state` and `may_deliver_outputs` are always `false`.
3. **Audit logging required.** `requires_audit_logging` is `true` — any future execution must be fully observable.
4. **No approval bypass, no auto-delivery, no tools/retrieval/multi-agent orchestration** — agents add none of these; they only declare a governed role.

---

## 8. What NOT to do

- Do **not** make an agent executable, or add autonomous/orchestration behavior — out of scope; needs a dedicated governed sprint.
- Do **not** set any of `may_execute_workflows` / `may_mutate_governed_state` / `may_deliver_outputs` to anything but `false`.
- Do **not** register a prompt or runtime workflow for a `planned` agent until you are actually building that chain.
- Do **not** flip an agent to `active` without a registered, working composed chain behind it.
- Do **not** move execution logic into the agent layer — execution stays in `lib/workflows/registry.ts` + the step executor.

---

## 9. Files touched this sprint

- `types/ai.ts` — `AiAgentId`, `AiAgentCategory`, `AiAgentStatus`, `AiAgentScope`, `AiAgentGovernancePolicy`, `AiAgentDefinition`; `supported_agent_ids?` added to `AiSkillDefinition` and `AiCapabilityDefinition`; `agent_id?` added to `AiWorkflowDefinition`.
- `lib/ai/agents.ts` (new) — registry + accessors.
- `lib/ai/skills.ts`, `lib/ai/capabilities.ts`, `lib/ai/workflows.ts` — descriptive agent links on the active + planned chains.
- `app/ai-operations/page.tsx` — **AI Agent Registry** section; agent-link columns on the Skill, Capability, and Workflow tables.
- `docs/sprint-7-5-ai-agent-registry.md` (this file).

Unchanged: `lib/workflows/registry.ts`, the step executor, prompts, provider, readiness, recovery, approvals. `request_ai_summary` still executes at `REQUEST_SUMMARIZER@v1` exactly as before. **Agents do not act autonomously yet — they are governed metadata only.**
