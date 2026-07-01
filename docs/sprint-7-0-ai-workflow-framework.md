# Sprint 7.0 — AI Workflow Framework

**Status:** Implemented. Framework/coordination sprint — no new AI capability, no new provider, no tools, no retrieval, no agents, no runtime-engine or recovery redesign, no migrations.
**Version context:** `v0.6.6-ai-draft-review-ux` → `v0.7.0-ai-workflow-framework`.

---

## 1. Purpose

Generalize the AI layer so a **new governed AI workflow can be added declaratively** — by registering a prompt, a runtime workflow, and a metadata entry — instead of hand-writing bespoke readiness, provenance, and UI logic each time.

This sprint adds a **coordination / read-model layer** on top of the existing runtime. It does **not** move workflow execution. The runtime workflow registry (`lib/workflows/registry.ts`) and the executor (`lib/workflows/step-executor.ts`) still own how steps run. The governance model from the Sprint 6.0 blueprint is unchanged: **AI proposes drafts; only a human approves a governed transition.**

---

## 2. The layers, and who owns what

| Layer | File | Owns |
|---|---|---|
| Prompt registry | `lib/ai/prompts.ts` | System prompts + structured-output schemas (in-code, versioned) |
| Model router | `lib/ai/router.ts` | Static model + pricing per prompt |
| Runtime workflow registry | `lib/workflows/registry.ts` | The actual **steps** a workflow executes |
| Step executor | `lib/workflows/step-executor.ts` | The `call_ai` branch + all governed writes |
| **AI workflow registry (new)** | `lib/ai/workflows.ts` | **Metadata**: which prompt + runtime workflow, required inputs, output target, approval requirement, readiness requirements, status |
| Readiness | `lib/workflows/readiness/ai-summary.ts` | Whether an AI workflow can be triggered for a request (reads requirements from the registry) |
| Draft-review read model | `lib/ai/draft-review.ts` | Resolving AI provenance for request/output/approval detail (recognizes any registered AI workflow) |
| AI Operations UI | `app/ai-operations/page.tsx` | Displays the prompt registry **and** the AI workflow registry |

The AI workflow registry is a **read model**. It never executes anything and holds no privilege. `approval_required` and `output_target.status = 'draft'` are declarative reminders of governance the runtime already enforces — the registry cannot loosen them.

---

## 3. How to add a new AI workflow

Four steps, all additive:

### Step 1 — Register the prompt
In `lib/ai/prompts.ts`, add a `AiPromptDefinition` (id, `version`, `purpose`, `model`, `low`, `system_prompt`, `output_schema`). Add the new id to `AiPromptId` in `types/ai.ts`. A prompt is **never edited in place** once shipped — bump `version` / add a new id instead.

Pricing for a new model goes in `lib/ai/router.ts` (`PRICING`).

### Step 2 — Register the runtime workflow (the steps)
In `lib/workflows/registry.ts`, add a `WorkflowDefinition` whose steps follow the governed draft pattern:

```
log_start        write_execution_log
<ai step>        call_ai        (params.prompt_id, params.input_keys)
create_*         create_output  (status: 'draft' — NEVER delivered)
request_review   request_approval  (opens a PENDING approval)
complete         complete
```

The `call_ai` step reads **only** whitelisted `input_keys` from `ctx`/`accumulated` — no ad-hoc DB reads (blueprint §18). Any data the model needs must be placed into `accumulated` by a **prior, RLS-respecting, non-AI step**.

### Step 3 — Register AI workflow metadata
In `lib/ai/workflows.ts`, add an `AiWorkflowDefinition` and its id to `AiWorkflowId` in `types/ai.ts`:

```ts
my_ai_workflow: {
  id:                  'my_ai_workflow',
  name:                'My AI Workflow',
  purpose:             '…',
  prompt_id:           'MY_PROMPT',          // from Step 1
  runtime_workflow_id: 'my_ai_workflow',     // from Step 2 (the registry key)
  trigger_entity_type: 'request',
  required_inputs:     ['organization_id', 'department_id', 'project_id', 'task_id', …],
  output_target:       { type: 'output', output_type: 'report', status: 'draft' },
  approval_required:   true,
  readiness: {
    require_project: true, require_department: true, require_linked_task: true,
    block_active_run: true, block_active_job: true, block_failed: true, block_completed: true,
  },
  status: 'active',
}
```

Registering here makes the workflow appear in **AI Operations → AI Workflow Registry** and makes its runs recognized by the draft-review read model automatically (see §5).

### Step 4 — Define readiness
Readiness is **declarative** via the `readiness` block above. The evaluator in `lib/workflows/readiness/ai-summary.ts` reads these flags rather than hardcoding them: each requirement flag gates the corresponding blocker. Toggling a flag to `false` removes that gate for that workflow.

For a genuinely different trigger surface or blocker set, add a sibling readiness module modeled on `ai-summary.ts` and drive it from the same requirement flags. Do **not** weaken `request_ai_summary`'s requirements.

---

## 4. Where readiness comes from

`getRequestAiSummaryReadiness()` still performs the same reads (linked task, latest AI run, active job, pending approval) and returns the same `RequestAiSummaryReadiness` shape (draft/approval/run links, blockers, recommended action). The only change: the blocker conditions are now gated by the registry's `readiness` requirements. For `request_ai_summary` every flag is `true`, so **behavior is identical** to Sprint 6.5/6.6. A `DEFAULT_READINESS_REQUIREMENTS` fallback (all `true`) guarantees behavior never silently loosens if the registry entry is missing.

---

## 5. How draft provenance is detected

`getAiDraftReviewContext(supabase, { request_id | output_id | approval_id | workflow_run_id })` resolves the governed AI run backing an entity and returns its provenance (prompt, model, confidence, risk, summary, next steps, linked output/approval/request). It now scopes run lookups to `aiRuntimeWorkflowIds()` — **every** registered AI workflow's runtime id — instead of a single hardcoded id. So a newly registered AI workflow's drafts get provenance on the output/approval/request detail pages with no further wiring. `is_ai` is still true **only** when a run from a registered AI workflow is actually found — provenance is never invented.

---

## 6. How approval gating works

Unchanged and structural:

- The `call_ai` step writes **no** business records — it returns validated structured output only.
- A later `create_output` step materializes a **draft** output (`status='draft'`).
- A `request_approval` step opens a **pending** `approvals` row (`subject_type='output'`). AI cannot set it to `approved`.
- Delivery/acceptance requires a **human** resolving that approval via `PATCH /api/approvals/[id]` (UI from Sprint 5.14). The approval state machine and RLS are untouched.

`approval_required: true` in the registry documents this; it does not implement it. The gate is enforced by the runtime and RLS, not the read model.

---

## 7. What must never be bypassed

1. **AI holds no governance privilege.** It may only produce step output + draft records via non-AI steps. It cannot resolve approvals, deliver outputs, or transition tasks.
2. **No approval bypass.** Every AI-originated draft terminates at a pending human approval. The registry cannot mark something pre-approved.
3. **No auto-delivery.** Outputs stay `draft` until a human acts.
4. **No new external entry point.** AI is reachable only through the existing trigger → `workflow_step` job path.
5. **Provider egress stays confined** to `lib/ai/provider.ts` (server-only key). The registry/read models never touch the provider.
6. **`call_ai` reads only whitelisted `input_keys`** — no ad-hoc DB reads; retrieval (if ever added) is a prior non-AI step.
7. **Prompts are append-only** once shipped (version, don't edit in place).

---

## 8. Files touched this sprint

- `types/ai.ts` — `AiWorkflowId`, `AiWorkflowReadinessRequirements`, `AiWorkflowOutputTarget`, `AiWorkflowStatus`, `AiWorkflowDefinition`.
- `lib/ai/workflows.ts` (new) — registry: `getAiWorkflow`, `listAiWorkflows`, `getAiWorkflowByRuntimeId`, `aiRuntimeWorkflowIds`.
- `lib/workflows/readiness/ai-summary.ts` — reads requirements from the registry (identical behavior for `request_ai_summary`).
- `lib/ai/draft-review.ts` — recognizes any registered AI workflow via `aiRuntimeWorkflowIds()`.
- `app/ai-operations/page.tsx` — new **AI Workflow Registry** section.
- `docs/sprint-7-0-ai-workflow-framework.md` (this file).

Out of scope (unchanged): runtime executor loop, recovery engine, provider, workflow execution ownership, migrations.
