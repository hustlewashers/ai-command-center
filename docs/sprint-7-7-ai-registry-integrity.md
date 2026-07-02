# Sprint 7.7 — AI Registry Integrity & Visualization

**Status:** Implemented. Adds cross-reference integrity validation and visual traceability for the AI registry stack. Read-model / diagnostics ONLY — nothing becomes executable; no autonomous behavior, tools, retrieval, runtime workflows, prompts, or models; no engine/recovery redesign; no migrations. AI stays draft-only and human-approval-gated.
**Version context:** `v0.7.6-ai-plan-registry` → `v0.7.7-ai-registry-integrity`.

---

## 1. Why integrity validation exists

Sprints 7.0–7.6 built a seven-layer registry stack (plan → agent → skill → capability → template → workflow → prompt version), where each layer references ids in the layers below. As the stack grows, a typo, a deleted item, or an `active` item pointing at a `planned` dependency would silently break the chain — invisible until something downstream failed. The integrity validator turns those latent problems into **visible errors and warnings** on the AI Operations page, and the stack map makes the active "golden path" traceable at a glance. Both are pure diagnostics: they read the registries and compute, executing and mutating nothing.

---

## 2. Registry dependency order

References flow **downward** through the stack (each layer may reference the layers below it):

```
plan → agent → skill → capability → template → workflow → prompt → prompt_version
```

Concretely the validator checks:
- **plans** → agents / skills / capabilities / workflows (top-level allow-lists + per-step refs)
- **agents** → skills / capabilities / workflows / prompts
- **skills** → capabilities / prompts / agents
- **capabilities** → skills / prompts / templates / agents
- **workflows** → agent / capability / template / prompt / **runtime workflow** (in `lib/workflows/registry.ts`)
- **templates** → default prompt (required if the template is active)
- **prompts** → an active version must resolve

It also asserts two governance invariants: agents and plans must keep their execution-bearing flags (`may_execute_workflows`, `may_mutate_governed_state`, `may_deliver_outputs`) false, and every active plan must contain a human-review / approval checkpoint step.

---

## 3. Error vs warning

- **Error** (`ok: false`): a real broken or governance-violating reference. Examples: a referenced id does not exist; an **active** item depends on a **planned/inactive** dependency; an active workflow's prompt has no active version; an active plan has no human-review checkpoint; a prompt's `active_version` resolves to nothing; an agent/plan sets an execution flag true.
- **Warning** (still `ok: true` if no errors): expected, non-blocking gaps. Examples: a **planned** skill/capability has no prompt yet; a template referenced by a planned capability is absent. Warnings are informational — they document intentional "not built yet" states without failing the check.

The report shape: `{ ok, errors[], warnings[], counts, checked_at }`, each issue being `{ code, from, message }` where `from` is the owning `"kind:id"`.

---

## 4. How to add a registry item safely

1. Add the item as `planned` first, referencing only ids that already exist (or leaving optional links null).
2. Load `/ai-operations` → **AI Registry Integrity**. A planned item with no prompt yields a *warning*, which is fine; a *dangling reference* yields an *error* — fix it before proceeding.
3. Keep governance flags at their safe defaults (execution flags false; approval required).

## 5. Required checks before activating a planned item

Before flipping any item's `status` to `active`, the integrity check must stay `ok` with the item active. That means:
- Its referenced prompt exists **and** has an active version.
- None of its dependencies are still `planned`/inactive (no `active_*_planned_*` errors).
- For a plan: it retains a human-review / approval checkpoint step.
- For a workflow: its runtime workflow exists in `lib/workflows/registry.ts`.
- Governance invariants still hold (execution flags false).

If activating an item introduces an error, do not ship the activation — build the missing dependency first.

---

## 6. Visualization

- **AI Registry Integrity** panel: OK/Errors status, per-layer counts, an errors table (empty → "Registry integrity checks passed."), and a warnings table.
- **AI Registry Stack Map**: the canonical active chain rendered as `Plan → Agent → Skill → Capability → Template → Workflow → Prompt → Prompt Version`, each node showing id + status, with a red `MISSING` marker if a link is broken. No external graph library — plain flex/text. A fuller node/edge graph is available via `buildAiRegistryGraph()` for future use.

---

## 7. Future CI / test path

`validateAiRegistry()` is a pure function returning a serializable report, so it is a natural unit-test / CI gate: a future test can assert `validateAiRegistry().ok === true` and fail the build on any dangling reference or governance violation — catching registry drift before it reaches the UI. `buildAiRegistryGraph()` can likewise back a snapshot test of the stack shape. Neither requires a database or a running provider.

---

## 8. What NOT to do

- Do **not** make integrity validation mutate or "auto-fix" the registries — it is read-only diagnostics.
- Do **not** downgrade a real dangling reference to a warning to make the panel green — fix the reference.
- Do **not** activate an item while it introduces an integrity error.
- Do **not** add an external graph/visualization dependency — keep the map plain text/tables.
- Do **not** treat the stack map's `active` labels as "executable" — the underlying plans/agents remain non-executable metadata.

---

## 9. Files touched this sprint

- `lib/ai/registry-integrity.ts` (new) — `validateAiRegistry()` + report types.
- `lib/ai/registry-graph.ts` (new) — `buildAiRegistryGraph()`, `activeRequestSummaryChain()` + graph types.
- `app/ai-operations/page.tsx` — **AI Registry Integrity** panel + **AI Registry Stack Map** section.
- `docs/sprint-7-7-ai-registry-integrity.md` (this file).

Unchanged: all registry data files, `lib/workflows/registry.ts`, the step executor, prompts, provider, readiness, recovery, approvals. `request_ai_summary` still executes at `REQUEST_SUMMARIZER@v1` exactly as before. Nothing became executable.
