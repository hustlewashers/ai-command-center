# Sprint 8.0 — Provider Hardening

**Status:** Implemented. Hardens the single AI egress point for production: timeouts, bounded retries, structured error classification, optional (fail-closed) mock fallback, and provider provenance in telemetry. The governed workflow model is **unchanged** — a provider failure fails the `call_ai` step normally (recoverable) and never bypasses an approval or auto-delivers. No workflow-engine/approval changes, no retrieval/tools, no new production workflows, no migrations. The mock fallback is preserved.
**Version context:** `v0.7.9-work-packet-summary` → `v0.8.0-provider-hardening`.

---

## 1. Provider modes

| Mode | Meaning |
|---|---|
| `live` | A real provider (OpenAI) call succeeded. |
| `mock` | The deterministic mock was used **by configuration** — no key, or `AI_PROVIDER_MODE=mock`. |
| `fallback` | A live call was attempted, failed terminally, and the mock was used as a fallback (only when allowed). |

`provider_id` is `openai` or `mock`. The mode is recorded on every AI execution (output payload, execution logs, agent activity) and summarized on **AI Operations → Provider Health**.

## 2. Environment variables

All server-only (never `NEXT_PUBLIC`). See `.env.example`.

| Var | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Provider key. Presence toggles live vs mock. Never logged/returned/persisted. |
| `OPENAI_MODEL` | prompt's model | Optional model override. |
| `OPENAI_TIMEOUT_MS` | `30000` | Per-attempt timeout (AbortController). Clamped 1000–300000. |
| `OPENAI_MAX_RETRIES` | `2` | Retries for transient failures. Clamped 0–6. |
| `AI_PROVIDER_MODE` | live-if-key, else mock | Force `live` or `mock`. |
| `AI_ALLOW_MOCK_FALLBACK` | `true` dev / `false` prod | If a live call fails, fall back to the mock. |

## 3. Retry policy

- Retryable HTTP statuses: **408, 409, 429, 500, 502, 503, 504**; plus **timeout** and network errors.
- Non-retryable: **400 / 401 / 403 / 404 / 422** (auth / bad request / configuration) — fail fast, no retry.
- Total attempts = `OPENAI_MAX_RETRIES + 1`, with short exponential backoff (250ms · 2ⁿ, capped 2s).
- Each attempt is recorded in `attempts[]` with its `error_type`, `status`, and latency; `retry_count` = live attempts beyond the first.

## 4. Error classification

`auth_error` (401/403), `rate_limited` (429), `timeout` (AbortController), `server_error` (5xx / network), `configuration_error` (400/404/422 / live-without-key), `invalid_response` (non-JSON / empty body), `unknown`. The type is attached to failure logs and (for fallbacks) to the completed telemetry, and surfaced in the Provider Health "Common Error" and the workflow-run AI Step Detail.

## 5. Fallback policy & failure behavior

- **Live fails + fallback allowed** → mock is used, `fallback_used=true`, `provider_mode='fallback'`, the last live `error_type` preserved in metadata. The step **succeeds** with a mock draft (still draft-only, still approval-gated).
- **Live fails + fallback NOT allowed** → the provider throws a structured `AiProviderCallError`; `executeCallAi` logs the failure (`status='flagged'`, `error_type`) and rethrows, so the `call_ai` step **fails normally** and the run is **recoverable** via the existing recovery engine. No partial governed state is written (the AI step writes no business records).
- **A provider failure never** approves, delivers, or transitions anything. Governance is untouched.

## 6. Production recommendation

1. **Disable mock fallback in production:** set `AI_ALLOW_MOCK_FALLBACK=false` (also the default when `NODE_ENV=production`). This makes provider outages fail closed and visible, instead of silently substituting mock drafts.
2. **Configure the live provider:** set `OPENAI_API_KEY` (and optionally `OPENAI_MODEL`, `OPENAI_TIMEOUT_MS`, `OPENAI_MAX_RETRIES`).
3. **Monitor AI Operations → Provider Health:** watch `status`, failures, fallbacks, latency, and common error type. A rising `rate_limited`/`server_error` count or any `fallback` in prod is an alert.
4. **Smoke test live** with `POST /api/dev/enqueue-ai-live-smoke-test` (dev-only, `x-worker-secret` gated). `{ "force_live": true }` returns a clean 400 `configuration_error` if no key is set; otherwise it enqueues `request_ai_summary` down the normal governed path.

## 7. Telemetry recorded per AI execution

Additive to existing fields, in `workflow_step_runs.output_payload`, `execution_logs.metadata`, and `agent_activity.metadata`: `provider_id`, `provider_mode`, `fallback_used`, `attempts_count`, `retry_count`, `timeout_ms`, `model_used`, and `error_type` (on failure/fallback). `runtime_metrics` is unchanged (no metadata column; token/latency/cost rows already exist).

## 8. What NOT to do

- Do **not** let a provider failure bypass approval or write a business record — failures must fail the step and remain recoverable.
- Do **not** enable mock fallback in production unless you explicitly accept silent mock substitution.
- Do **not** log, return, or persist `OPENAI_API_KEY` — config helpers expose only its presence.
- Do **not** retry non-retryable errors (auth/bad-request) — that just amplifies a misconfiguration.
- Do **not** move provider calls out of `lib/ai/provider.ts` — it remains the single, auditable egress point.

## 9. Files touched this sprint

- `types/ai.ts` — provider types (`AiProviderId/Status/Mode/Config/Attempt/Error/HealthSummary`), extended `AiProviderResult` + `AiExecutionOutput`.
- `lib/ai/provider-config.ts` (new) — env-driven config.
- `lib/ai/provider.ts` — timeout, retries, classification, fallback, attempt history.
- `lib/ai/execute-call-ai.ts` — provider provenance in output + logs + agent_activity; error_type on failure.
- `lib/workflows/step-executor.ts` — provider fields in `call_ai` output payload.
- `lib/ai/metrics.ts` — `getAiProviderHealth`.
- `app/ai-operations/page.tsx` — **Provider Health** section.
- `app/workflow-runs/[id]/page.tsx` — provider fields in AI Step Detail.
- `app/api/dev/enqueue-ai-live-smoke-test/route.ts` — config echo + `configuration_error` on force_live without key.
- `.env.example` — new provider vars.

Unchanged: the workflow engine, approvals, recovery, prompts, registries. `request_ai_summary` and `work_packet_ai_summary` still run draft-only and approval-gated; the mock fallback is preserved.
