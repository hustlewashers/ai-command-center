# Sprint 7.2 — Prompt Versioning

**Status:** Implemented. Introduces prompt versioning as a first-class in-code abstraction so every AI output is traceable to a specific prompt version. Still in-code only — no DB-backed prompt registry, no new provider/tools/retrieval/agents, no runtime-engine or recovery change, no migrations, no prompt tables.
**Version context:** `v0.7.1-ai-workflow-templates` → `v0.7.2-prompt-versioning`.

---

## 1. Why prompt versioning exists

An AI output is only trustworthy if you can say *exactly which instruction produced it*. Before this sprint a prompt was a single flat definition; if it changed, past outputs silently referred to "the prompt" with no way to know which wording/model/schema was in effect. Versioning pins each output to an immutable prompt **version**, so provenance (on the request, output, approval, and workflow-run surfaces) can show `REQUEST_SUMMARIZER@v1` rather than an ambiguous name.

---

## 2. Prompt id vs prompt version

- **Prompt id** (`AiPromptId`, e.g. `REQUEST_SUMMARIZER`) is a **stable alias**. Workflows and the `call_ai` step reference the id; they never hardcode a version.
- **Prompt version** is an **immutable, numbered instance** of that id — a specific `system_prompt`, `model`, `low` flag, and `output_schema`, plus provenance (`version_id`, `status`, `released_at`, `change_note`, `replaced_by?`, `deprecated_at?`).
- **Version id** (`AiPromptVersionId`, e.g. `REQUEST_SUMMARIZER@v1`) is the human-and-machine-readable handle stamped onto every output.

The registry entry (`AiPromptRegistryEntry`) ties them together: `{ id, active_version, versions[] }`.

---

## 3. Active version behavior

Each prompt id has exactly one `active_version`. `getActivePromptVersion(id)` returns it, and the `call_ai` executor uses **only** the active version. `getPrompt(id)` is a compatibility wrapper that returns the active version's executable definition (unchanged signature for the router/provider/validator). For `REQUEST_SUMMARIZER`, `active_version = 1` → behavior is byte-for-byte identical to Sprint 7.1: model `gpt-5.5`, `low: true`, same system prompt and schema.

---

## 4. How to add a new prompt version

Versions are **append-only** — never edit a shipped version in place (parallels "never edit a migration").

1. Add a new `AiPromptVersionDefinition` to the prompt's `versions[]` in `lib/ai/prompts.ts` with the next `version` number, a new `version_id` (`PROMPT@v2`), `status: 'experimental'` (or `'active'`), a `released_at`, and a `change_note`.
2. When ready to promote it, set the entry's `active_version` to the new number.
3. Mark the previous version `status: 'deprecated'`, set its `deprecated_at`, and set its `replaced_by` to the new `version_id`.

No other code changes are needed — the executor always resolves the active version, and provenance surfaces read the version stamped on each output.

## 5. How to deprecate a prompt version

Set the old version's `status: 'deprecated'`, `deprecated_at`, and `replaced_by`. Deprecated versions stay in the registry (past outputs still reference them for provenance) but are never selected for execution once `active_version` points elsewhere. Never delete a version that shipped output.

---

## 6. How output provenance uses `prompt_version`

The `call_ai` executor (`lib/ai/execute-call-ai.ts`) stamps version metadata everywhere an output is recorded — **additively**, no field removed:

- **`workflow_step_runs.output_payload`** — `prompt_version`, `prompt_version_id`, `low`, `validation_status`, `output_schema_fields` (alongside the existing `ai_result`, `prompt_id`, `model`, `confidence`).
- **`execution_logs.metadata`** — `prompt_version`, `prompt_version_id`, `low` on both the `started` and `completed` phases; the completed log also carries `validation_status` and `output_schema_fields`.
- **`agent_activity.metadata`** — `prompt_version`, `prompt_version_id`.
- **`runtime_metrics`** — unchanged; `metric_name` already carries semantics, and the run/step dimension links back to the versioned step output.

Read surfaces show it:
- **Request** AI Draft Review, **Output** AI Provenance, **Approval** AI Review Context (via `lib/ai/draft-review.ts`, which now returns `prompt_version` + `prompt_version_id`).
- **Workflow Run** `call_ai` step detail (prompt id, version, version id, model, low, validation status, ai result).
- **AI Operations** — Prompt Registry (active version + status) and a full **Prompt Versions** table.

---

## 7. What NOT to do

- Do **not** edit a shipped version in place — add a new version.
- Do **not** delete a version that produced output — provenance depends on it.
- Do **not** point `call_ai` at a specific version; it always uses the active one via the id.
- Do **not** remove or rename existing `output_payload`/log fields — provenance additions are purely additive to avoid breaking older rows.
- Do **not** introduce a DB prompt table yet (out of scope for this sprint).

---

## 8. Future DB-backed prompt registry path

The in-code shapes are chosen so the eventual swap is mechanical: a `prompts` + `prompt_versions` table (with RLS) would back the same `AiPromptRegistryEntry` / `AiPromptVersionDefinition` shapes, loaded through the same accessors (`getActivePromptVersion`, `getPromptVersion`, `listPromptVersions`). Execution and provenance would not change — only the source of the registry. Versioning-as-data now is what makes that migration additive later.

---

## 9. Files touched this sprint

- `types/ai.ts` — `AiPromptAlias`, `AiPromptVersionId`, `AiPromptVersionStatus`, `AiPromptVersionDefinition`, `AiPromptRegistryEntry`; version fields added to `AiExecutionOutput`.
- `lib/ai/prompts.ts` — versioned registry + accessors (`listPrompts`, `listPromptVersions`, `getPromptEntry`, `getPromptVersion`, `getActivePromptVersion`, compat `getPrompt`).
- `lib/ai/execute-call-ai.ts` — version provenance in output + logs + agent_activity.
- `lib/workflows/step-executor.ts` — `call_ai` output_payload carries version fields (additive).
- `lib/ai/draft-review.ts` — returns `prompt_version` + `prompt_version_id`.
- `app/requests/[id]/page.tsx`, `app/outputs/[id]/page.tsx`, `app/approvals/[id]/page.tsx`, `app/workflow-runs/[id]/page.tsx` — surface prompt version.
- `app/ai-operations/page.tsx` — versioned Prompt Registry + Prompt Versions table.

Unchanged: provider behavior, workflow engine, recovery, approvals. `REQUEST_SUMMARIZER` still executes at `@v1` exactly as before.
