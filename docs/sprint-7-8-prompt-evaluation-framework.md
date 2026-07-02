# Sprint 7.8 — Prompt Evaluation Framework

**Status:** Implemented. Adds an in-code, offline, deterministic evaluation framework so prompt **versions** can be scored and compared **before** activation. Diagnostics / evaluation only — no new production AI workflows, no provider/behavior change, no retrieval, no tools, no agents, no migrations. `request_ai_summary` is unchanged; AI stays draft-only and human-approval-gated.
**Version context:** `v0.7.7-ai-registry-integrity` → `v0.7.8-prompt-evaluation-framework`.

---

## 1. Why evaluation exists

Prompt versioning (Sprint 7.2) makes a prompt id a stable alias whose behavior is pinned to a version, with an `active_version` the runtime uses. But nothing checked whether a *new* version is actually good before it became active. Evaluation closes that gap: a suite of **golden cases** scores a version against its own structured-output contract and a small rubric, deterministically and offline, so a version can be judged — and a v2 compared to v1 — before `active_version` is ever moved.

The framework is **read-only and provider-free**: it makes no network call and writes nothing. It validates mock-safe candidate outputs with the *same* `validateAiOutput` used at runtime, so a version that passes eval is guaranteed schema-consistent with the runtime path.

---

## 2. How it works

- A **suite** (`AiPromptEvalSuite`) binds a set of cases to a specific `prompt_version_id` with a `pass_threshold`.
- A **case** (`AiPromptEvalCase`) pairs an `input_payload` (what would be sent) with a mock-safe `candidate_output` (a representative model result) and the `expected_fields` that must be present and non-empty.
- The **runner** (`lib/ai/evals/run.ts`) resolves the version from the registry, validates each candidate against the version's `output_schema`, then scores:
  - **schema_valid** — passes `validateAiOutput` (hard gate),
  - **required_fields_present** — all required schema fields present & non-empty,
  - **completeness** — fraction of `expected_fields` present & non-empty,
  - **risk_level_valid** — only when the schema declares a `risk_level` enum,
  - **next_steps_present** — only when the schema declares `recommended_next_steps`.
  - Aggregate `score` = mean of the applicable components, gated on schema validity.
- A case **passes** when it is schema-valid, has all required fields, and `score >= pass_threshold`. A suite **passes** only when every case passes.

The result (`AiPromptEvalSuiteResult`) is serializable: `{ total, passed, failed, average_score, status, results[], ran_at }`.

---

## 3. How to add cases

1. Open (or create) a suite file under `lib/ai/evals/` — e.g. `request-summarizer.ts` exports `REQUEST_SUMMARIZER_V1_SUITE`.
2. Add an `AiPromptEvalCase`: a realistic `input_payload`, a **mock-safe** `candidate_output` shaped for the version's schema, and the `expected_fields`.
3. Cover the meaningful axes of the output (e.g. low/medium/high `risk_level`, sparse vs rich input).
4. Register any new suite in the `SUITES` array in `lib/ai/evals/run.ts`. It appears in **AI Operations → Prompt Evaluation** automatically.

Keep candidates mock-safe (no secrets, no PII) — these fixtures live in the repo.

---

## 4. How to compare versions later

When a `PROMPT@v2` is added (append-only, per Sprint 7.2):
1. Create a `PROMPT@v2` suite reusing the **same cases** (ideally the v1 golden cases plus any new ones the change targets).
2. Run both suites; compare `average_score`, per-case `status`, and the score breakdowns. v2 should meet or beat v1 on the golden cases and improve on the cases motivating the change.
3. Only then move `active_version` to v2 (and deprecate v1 per Sprint 7.2).

Because cases carry `input_payload`, the same fixtures can later be replayed against the **live** provider in CI to compare real model output, not just contract conformance.

---

## 5. What blocks activation

Activation is a **manual** decision — the framework never activates anything. The guidance (also shown on the AI Ops panel): **do not move a prompt's `active_version` to a version whose eval suite does not pass.** A version whose suite is `failed`/`partial` must not be activated. This complements the registry integrity validator (Sprint 7.7), which already errors if an *active* item lacks a resolvable prompt/version — together they gate both "is the wiring intact" and "is the version good."

---

## 6. Future CI path

`runPromptEvalSuite()` / `runAllPromptEvalSuites()` are pure functions returning serializable results, so they are natural CI gates:
- A unit test can assert `runAllPromptEvalSuites().every(s => s.status === 'passed')` and fail the build on any regression.
- A future **live-eval** job can replay each case's `input_payload` against the real provider (behind the worker secret) and score the *actual* output with the same rubric — turning these fixtures into golden regression tests for model behavior.
- Combined with `validateAiRegistry().ok === true`, this gives a single pre-merge check for both registry integrity and prompt quality.

---

## 7. What NOT to do

- Do **not** let evaluation mutate or auto-activate anything — it is read-only diagnostics.
- Do **not** activate a version whose suite is not passing.
- Do **not** put secrets/PII in eval fixtures — they are committed to the repo.
- Do **not** make eval depend on a live provider or a database — it must stay deterministic and offline.
- Do **not** relax `pass_threshold` or trim `expected_fields` just to turn a suite green — fix the version instead.

---

## 8. Files touched this sprint

- `types/ai.ts` — `AiPromptEvalStatus`, `AiPromptEvalScore`, `AiPromptEvalCase`, `AiPromptEvalResult`, `AiPromptEvalSuite`, `AiPromptEvalSuiteResult`.
- `lib/ai/evals/request-summarizer.ts` (new) — golden suite for `REQUEST_SUMMARIZER@v1`.
- `lib/ai/evals/run.ts` (new) — deterministic runner + suite registry.
- `app/ai-operations/page.tsx` — **Prompt Evaluation** panel + activation guidance.
- `docs/sprint-7-8-prompt-evaluation-framework.md` (this file).

Unchanged: `lib/ai/prompts.ts`, `lib/ai/provider.ts`, `lib/ai/execute-call-ai.ts`, the workflow engine, approvals, recovery. `request_ai_summary` still executes at `REQUEST_SUMMARIZER@v1` exactly as before.
