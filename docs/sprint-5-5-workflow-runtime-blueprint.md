# Sprint 5.5 — Workflow Runtime Blueprint

**Status:** Architecture only — no code, no migrations, no schema changes.
**Date:** 2026-06-28
**Sprint tag:** v0.5.4-business-execution (base)
**Next sprint:** 5.6 — Workflow Run Persistence

---

## 1. Purpose

Sprint 5.4 proved the execution engine works: a `workflow_step` background job can run a
multi-step workflow, create real database rows, and record activity. But the observability
model is entirely built on `execution_logs`, a human-readable narrative table that was
never designed to be queried for structured workflow state.

This blueprint defines the target architecture for workflow runtime maturity:
structured `workflow_runs` and `workflow_step_runs` tables, step-level timing,
resume/retry semantics, and the observability surfaces that let operators understand
what the system is doing. It also sets the architecture for the future growth of the
system — AI steps, tool calls, integration hooks — without requiring a rewrite.

The guiding principle for everything that follows:

> **AI becomes a workflow step later, not a separate runtime.**

The executor stays generic. Registries (tools, agents, integrations) plug into the
existing step-dispatch system. The workflow is always the unit of work; agents are
workers within that unit, not orchestrators above it.

---

## 2. Current Runtime State

As of v0.5.4, the runtime stack consists of:

### Tables (Phase F, migrations 018–022)
| Table | Role |
|---|---|
| `background_jobs` | Job queue. Tracks runnable state, retries, scheduling. |
| `dead_letter_queue` | Permanently failed jobs awaiting manual resolution. |
| `scheduled_tasks` | Recurring or one-off schedule definitions. |
| `runtime_metrics` | Aggregated observability data written per worker run. |
| `agent_activity` | Per-agent session activity. Append-only. |
| `audit_events` | Platform-level security and admin audit log. Append-only. |
| `execution_logs` | Human-readable narrative of system events. Per phase. |

### In-code workflow stack (Sprint 5.4)
| File | Role |
|---|---|
| `lib/workflows/registry.ts` | In-code `WorkflowDefinition` registry. Keyed by `workflow_id`. |
| `lib/workflows/execute.ts` | Orchestrates step iteration, writes execution_logs, returns result. |
| `lib/workflows/step-executor.ts` | Dispatches individual step types. Writes to business tables. |
| `lib/jobs/handlers/workflow-step.ts` | Bridge: background_job → workflow executor. |
| `lib/jobs/dispatch.ts` | Registry-pattern dispatcher for all job types. |
| `types/workflows.ts` | TypeScript types: definition, context, step result, execution result. |

### Currently registered step types
| Step type | What it does |
|---|---|
| `write_execution_log` | Writes a narrative note to `execution_logs`. |
| `create_task` | INSERTs a row into `tasks`. Output: `task_id`. |
| `create_work_packet` | INSERTs a row into `work_packets`. Reads `task_id` from accumulated. |
| `create_output` | Deferred — writes a note log and returns success. |
| `request_approval` | Deferred — writes a note log and returns success. |
| `complete` | Terminal step — breaks the step loop. |

### Currently registered workflow
| Workflow | Steps |
|---|---|
| `request_to_task` | log_start → create_task_1 → create_wp_1 → log_complete → complete |

### Observability (current)
- Worker runs write `runtime_metrics` rows for queue depth, DLQ size, duration.
- Workflow start/end and step failures write `execution_logs` rows.
- No structured `workflow_run` or `step_run` rows exist.
- To find a specific workflow run, you must grep `execution_logs.metadata->>'workflow_id'`.

---

## 3. Problem With Current Execution-Logs-Only Model

`execution_logs` is a narrative table. It was built to record *what happened* in human-
readable text, not to be queried for *how long things took* or *which step failed*.

Concrete limitations with the current model:

| Problem | Impact |
|---|---|
| No structured `workflow_run` identity | Can't list "all runs of workflow X" without full-table scanning `execution_logs.metadata`. |
| No step-level timing | Can't know that `create_task_1` takes 120 ms and `create_wp_1` takes 8 ms. |
| No step-level state | On failure, the DLQ captures the job, not the step index. Resume means re-running the whole workflow from step 1. |
| No resume semantics | `create_task` on re-run creates a duplicate task. There is no idempotency mechanism. |
| No accumulated output persistence | `accumulated` only exists in memory. If the worker crashes mid-run, it's gone. |
| `execution_logs.context_id` is a UUID but has no FK | You can't join `execution_logs` to a `workflow_runs` table that doesn't exist yet. |
| Metric category `workflow_execution` has no data | The `runtime_metrics` constraint allows it but nothing writes to it. |
| Operator can't see step detail from dashboard | `/background-jobs` shows job-level status only. There is no workflow detail page. |
| DLQ entry doesn't record which step failed | The `dead_letter_queue.error_summary` has the message but no structured `step_id`. |

The solution is not to replace `execution_logs` — it serves a valuable narrative role —
but to add a structured parallel layer: `workflow_runs` and `workflow_step_runs`.

---

## 4. Workflow Run Concept

A **workflow run** is one complete invocation of a named workflow definition. It is the
unit of structured observability for workflows.

Key properties:
- One workflow run is created per `workflow_step` background job that enters execution.
- It has a status that mirrors the job's status but is scoped to the workflow layer.
- It holds the `inputs` (the `WorkflowExecutionContext`) and the final `accumulated` dict.
- It records `started_at`, `completed_at`, and `failed_at` timestamps.
- If the run fails, it records the `failed_step_id` so resume can start from there.
- It links to its originating `background_job_id`.
- It survives job cleanup — the run history is permanent.

A workflow run is the anchor for all step run rows. It also becomes the target for
execution_log `context_id` writes (replacing `job_id` fallback).

**Lifecycle:** `pending` → `running` → `completed` | `failed` | `cancelled`
**Resume lifecycle:** `failed` → `resuming` → `running` → `completed` | `failed`

---

## 5. Workflow Step Run Concept

A **workflow step run** is one execution of a single step within a workflow run.

Key properties:
- One row per step attempted during a workflow run.
- Holds `step_id` (the definition ID like `create_task_1`) and `step_type` (e.g. `create_task`).
- Has its own `status`: `pending` → `running` → `completed` | `failed` | `skipped`.
- Records `started_at` and `completed_at` for per-step timing.
- Stores `inputs_snapshot` — the accumulated dict as it existed when the step started.
- Stores `output` — the dict returned by the step on success.
- Stores `error` — the error message string on failure.
- Has its own `retry_count` for future step-level retry (distinct from job retry).

Step runs are append-only within a run. On resume, a new workflow run is created
(child of the original) and new step run rows are written starting from the failed step.
The failed step run row in the original run is never mutated — it remains as history.

---

## 6. Workflow Run State Machine

```
                     ┌──────────┐
          enqueue    │          │
        ──────────►  │  pending │
                     │          │
                     └────┬─────┘
                          │ executor starts
                          ▼
                     ┌──────────┐
                     │          │
                     │  running │ ◄─────────────────────────┐
                     │          │                           │
                     └──┬───┬───┘                           │
                        │   │                               │
          all steps ok  │   │ step fails                    │
                        │   │                               │
                        ▼   ▼                               │
              ┌───────────┐ ┌──────────┐  operator        │
              │           │ │          │  triggers resume   │
              │ completed │ │  failed  │ ─────────────────►┌┴─────────┐
              │           │ │          │                    │          │
              └───────────┘ └──────────┘                   │ resuming │
                                │                          │          │
                   operator     │                          └──────────┘
                   cancels      ▼
                          ┌───────────┐
                          │           │
                          │ cancelled │
                          │           │
                          └───────────┘
```

**State transition rules:**

| From | To | Trigger |
|---|---|---|
| `pending` | `running` | Executor writes first step run row |
| `running` | `completed` | All steps succeed; `complete` step reached |
| `running` | `failed` | Any step throws; error is unrecoverable for this run |
| `running` | `cancelled` | Operator action (future: approval step timeout) |
| `failed` | `resuming` | Operator triggers resume via API |
| `resuming` | `running` | New child run begins execution from `failed_step_id` |
| `resuming` | `failed` | Child run also fails |

A `resuming` run spawns a child workflow run (linked via `parent_run_id`). It does not
mutate the failed parent run. The child inherits `accumulated` from the parent's last
successful step.

---

## 7. Step Run State Machine

```
              ┌─────────┐
              │         │
              │ pending │
              │         │
              └────┬────┘
                   │ step starts
                   ▼
              ┌─────────┐
              │         │
              │ running │
              │         │
              └──┬───┬──┘
                 │   │
      success    │   │  error
                 │   │
                 ▼   ▼
        ┌──────────┐ ┌────────┐
        │          │ │        │
        │completed │ │ failed │
        │          │ │        │
        └──────────┘ └────────┘

              ┌─────────┐
              │         │    (future: conditional step evaluation)
              │ skipped │
              │         │
              └─────────┘
```

**Step-level retry** (future, not Sprint 5.6):
- A failed step run row has `retry_count`.
- Step-level retry re-executes only that step, writes a new step run row with
  `retry_count + 1`, and does not re-run prior steps.
- Step-level retry requires the step to declare `is_idempotent: true`.

In Sprint 5.6, step-level retry is not implemented. Failures bubble up to the job
retry mechanism. Step run rows are written once per attempt.

---

## 8. Resume / Retry Semantics

### Definitions

| Term | Meaning |
|---|---|
| **Retry** | Re-run the workflow from step 1. A new background_job is enqueued. |
| **Resume** | Re-run the workflow starting from the failed step. A child workflow_run is created from the same background_job or a new one. |
| **Step-level retry** | Re-run a single failed step in isolation (future — not Sprint 5.6). |

### Why resume requires idempotency planning

Steps that write business records are **not inherently idempotent**. If `create_task_1`
succeeded and `create_wp_1` failed, resuming from `create_wp_1` is safe — `task_id` is
already in `accumulated`. But retrying from step 1 would call `create_task_1` again and
create a duplicate task.

**Sprint 5.6 rule:** Resume starts from the failed step using the parent run's
`accumulated` dict. Retry (from step 1) is an explicit operator action with a
warning about potential duplicate records.

### Idempotency per step type

| Step type | Idempotent? | Resume-safe? | Notes |
|---|---|---|---|
| `write_execution_log` | Yes | Yes | Each call creates a new log row; duplicates are harmless. |
| `create_task` | No | Conditional | Safe on resume if this step previously failed. Unsafe on full retry. |
| `create_work_packet` | No | Conditional | Safe on resume; needs `task_id` from accumulated. |
| `create_output` | No | Conditional | Not implemented; same rules will apply. |
| `request_approval` | No | Conditional | Future: approval ID must not be duplicated. |
| `invoke_agent` (future) | No | Conditional | Agent outputs are non-deterministic. |
| `complete` | Yes | Yes | Terminal; no side effects. |

### Accumulated dict on resume

When a resume is triggered:
1. The parent run's `accumulated` dict is read from the `workflow_runs` table.
2. A child `workflow_run` row is created with `inputs` = parent's `inputs`,
   `accumulated` = parent's `accumulated`, `parent_run_id` = parent's `id`.
3. Execution begins from the step *after* `parent.failed_step_id` (or at
   `parent.failed_step_id` itself if the operator wants to retry that step).
4. New `workflow_step_run` rows are written for each step executed in the child run.

---

## 9. Failure Handling

### Current model (v0.5.4)
1. Step throws → `executeWorkflow` catches → writes `flagged` execution_log → returns `success: false`.
2. Handler sees `success: false` → throws to dispatcher.
3. Dispatcher catches → either increments retry or writes DLQ.
4. DLQ entry has `error_summary` (string) and `error_detail` (JSON with stack).

### Target model (Sprint 5.6+)

Step 1 — Step-level capture (new):
- Before a step starts, write a `workflow_step_run` row with `status = 'running'`.
- On success, update to `status = 'completed'`, write `output`, record timing.
- On failure, update to `status = 'failed'`, write `error` string.

Step 2 — Run-level capture (new):
- The `workflow_run` row is updated: `status = 'failed'`, `failed_at = now()`,
  `failed_step_id = step.id`.
- The `accumulated` dict up to the point of failure is persisted.

Step 3 — Job-level capture (existing, unchanged):
- Handler throws → dispatcher handles retry/DLQ as today.
- DLQ entry is enriched: `error_detail` includes `workflow_run_id` and `failed_step_id`.

Step 4 — Resume path (new, Sprint 5.6 or later):
- Operator calls `POST /api/workflow-runs/[id]/resume`.
- System reads `failed_step_id` and `accumulated` from the run.
- Enqueues a new background_job with enriched payload pointing to parent run.
- Child run is created with `status = 'resuming'`.

### Failure classification (future)

| Class | Handling |
|---|---|
| **Transient** (network timeout, rate limit) | Job-level retry with backoff. Step run row shows retry attempt. |
| **Data error** (missing required field) | Job fails immediately. Step run row shows validation error. Resume requires payload fix. |
| **Permission error** (missing grant) | Same as data error. Requires migration fix, then retry. |
| **Business logic conflict** (duplicate key) | Same as data error. May require dedup logic in step executor. |
| **Approval blocked** (future) | Workflow pauses at `request_approval` step. Run status = `waiting_approval`. |

---

## 10. Observability Model

The target observability stack has three layers:

### Layer 1 — `execution_logs` (narrative, existing)
Human-readable text. Written by executors and handlers. Not structured for
aggregation. Stays unchanged. Becomes supplementary context for step run detail.

### Layer 2 — `workflow_runs` + `workflow_step_runs` (structured, new in Sprint 5.6)
The authoritative structured record of what happened. Supports:
- List all runs of workflow X.
- Find all failed runs in the last 7 days.
- Calculate P50/P95 step duration for `create_task` across all runs.
- Find the last successful accumulated output for a given organization.

### Layer 3 — `runtime_metrics` (aggregate, existing + expanded)
Windowed aggregates written by the worker at the end of each run. After Sprint 5.6,
workflow metrics join worker health metrics.

### Cross-layer links

| From | To | How |
|---|---|---|
| `workflow_step_run` | `execution_logs` | `execution_log_id` column on step run (nullable) |
| `workflow_run` | `background_jobs` | `background_job_id` column on run |
| `background_jobs` | `workflow_runs` | `workflow_run_id` column on job (nullable, new column) |
| `workflow_run` | `tasks` | `accumulated->>'task_id'` (JSON path, no FK) |
| `workflow_run` | `work_packets` | `accumulated->>'work_packet_id'` (JSON path, no FK) |
| `runtime_metrics` | `workflow_runs` | `dimension_type='workflow'`, `dimension_id` = run ID |

The JSON-path links to `tasks` and `work_packets` are intentional — they avoid FK
complexity while preserving navigability. The UI follows the JSON value to build links.

---

## 11. Workflow Detail Page Design

**Route:** `/workflows/[id]`

**Sections:**

```
┌─────────────────────────────────────────────────────────────┐
│ ← Workflows    Request → Task    [request_to_task]          │
├─────────────────────────────────────────────────────────────┤
│ Description: Turns an incoming request into a task and      │
│              work packet scaffold.                          │
│ Source: in-code registry    Steps: 5                        │
├─────────────────────────────────────────────────────────────┤
│ STEP DEFINITIONS                                            │
│  1. log_start          write_execution_log                  │
│  2. create_task_1      create_task                          │
│  3. create_wp_1        create_work_packet                   │
│  4. log_complete       write_execution_log                  │
│  5. complete           complete                             │
├─────────────────────────────────────────────────────────────┤
│ RUN STATISTICS (last 30 days)                               │
│  Total: 14   Completed: 12   Failed: 2   Avg: 1,240 ms     │
├─────────────────────────────────────────────────────────────┤
│ RECENT RUNS                                                 │
│  ID       Status     Started              Duration  Failed  │
│  a3f1…    completed  Jun 28 17:27         1,204 ms  —       │
│  b9e2…    failed     Jun 27 14:03         380 ms    create_task_1 │
│  ...                                                        │
└─────────────────────────────────────────────────────────────┘
```

**Data sources:**
- Definition: `listWorkflows()` or future `workflow_definitions` DB table.
- Stats: aggregated from `workflow_runs` (count by status, avg duration).
- Recent runs: last 20 `workflow_runs` rows ordered by `started_at DESC`.

---

## 12. Workflow Runs List Page Design

**Route:** `/workflow-runs`

**Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│ ← Home    Workflow Runs                      [filter: all ▼]│
├─────────────────────────────────────────────────────────────┤
│ 3 completed   1 failed   0 running   0 cancelled            │
├─────────────────────────────────────────────────────────────┤
│ Workflow         Status      Started        Duration  Failed │
│ Request → Task   ● completed Jun 28 17:27   1,204 ms  —     │
│ Request → Task   ● failed    Jun 28 16:05   380 ms    create_task_1 │
│ Request → Task   ● completed Jun 27 09:11   1,190 ms  —     │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘
```

**Click-through:** clicking a row opens `/workflow-runs/[id]`.

**Run detail page — `/workflow-runs/[id]`:**

```
┌─────────────────────────────────────────────────────────────┐
│ ← Workflow Runs    Run a3f1c2d…   ● completed               │
├─────────────────────────────────────────────────────────────┤
│ Workflow: Request → Task    Job: 680f0e…                    │
│ Started: Jun 28 17:27:49   Duration: 1,204 ms               │
│ Org: 4f63c864-...                                           │
├─────────────────────────────────────────────────────────────┤
│ STEP TIMELINE                                               │
│  Step             Type                 Status    Duration   │
│  log_start        write_execution_log  ✓          43 ms     │
│  create_task_1    create_task          ✓         892 ms     │
│  create_wp_1      create_work_packet  ✓          211 ms     │
│  log_complete     write_execution_log  ✓          38 ms     │
│  complete         complete             ✓           0 ms     │
├─────────────────────────────────────────────────────────────┤
│ CREATED ENTITIES                                            │
│  Task:        8a3f…   (→ /tasks/8a3f)                       │
│  Work Packet: d9c1…   (→ /work-packets/d9c1)                │
├─────────────────────────────────────────────────────────────┤
│ INPUTS                                                      │
│  { organization_id, department_id, project_id, ... }        │
└─────────────────────────────────────────────────────────────┘
```

**Data sources:**
- `workflow_runs` row for header, inputs, accumulated.
- `workflow_step_runs` rows for step timeline.
- `accumulated` JSON parsed for entity links.

---

## 13. Runtime Metrics Expansion

The existing `runtime_metrics` table has `metric_category = 'workflow_execution'` as an
allowed value but nothing currently writes to it. Sprint 5.6 and beyond populate it.

### New metrics (Sprint 5.6)

| `metric_name` | `unit` | `metric_category` | `dimension_type` | Written when |
|---|---|---|---|---|
| `workflow_run_completed` | `count` | `workflow_execution` | `workflow` | Workflow run completes. |
| `workflow_run_failed` | `count` | `workflow_execution` | `workflow` | Workflow run fails. |
| `workflow_run_duration_ms` | `ms` | `workflow_execution` | `workflow` | Workflow run completes (success only). |

### Dimension mapping
- `dimension_type = 'workflow'`
- `dimension_id` = ??? — **problem**: `runtime_metrics.dimension_id` is `uuid` but
  `workflow_id` is a text slug (e.g. `request_to_task`). Options:
  - A) Add `dimension_slug text` to `runtime_metrics` (schema change, needs migration).
  - B) Keep `dimension_id = organization_id` and add `metric_name` with workflow id
    encoded (e.g. `workflow_run_completed:request_to_task`).
  - C) Leave `dimension_id = null` for `dimension_type = 'workflow'` and encode
    `workflow_id` in the existing `metadata` column once we add it.

**Recommended: Option B** for Sprint 5.6. The metric name encodes the workflow:
`workflow_run_completed` written once per org per worker run with a `metadata` JSON
column (added to `runtime_metrics` in a future migration) to carry `workflow_id`.
This avoids a schema change now. Option A is the right long-term fix.

### Existing worker metrics (unchanged)

| `metric_name` | `unit` | Written by |
|---|---|---|
| `worker_run_completed` | `count` | `recordWorkerMetrics()` per org |
| `worker_queue_depth` | `count` | `queryQueueStats()` |
| `worker_dlq_size` | `count` | `queryQueueStats()` |
| `worker_jobs_succeeded` | `count` | Worker run summary |
| `worker_jobs_failed` | `count` | Worker run summary |
| `worker_run_duration_ms` | `ms` | Worker run timing |

---

## 14. Database Model Proposal

### Table: `workflow_runs`

```sql
create table public.workflow_runs (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete restrict,
  workflow_id         text not null,          -- e.g. 'request_to_task'
  background_job_id   uuid references public.background_jobs(id) on delete set null,
  parent_run_id       uuid references public.workflow_runs(id) on delete set null,
  status              text not null default 'pending',
  inputs              jsonb not null default '{}'::jsonb,
  accumulated         jsonb not null default '{}'::jsonb,
  failed_step_id      text,
  error               text,
  resume_attempt      integer not null default 0,
  started_at          timestamptz,
  completed_at        timestamptz,
  failed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint workflow_runs_workflow_id_not_empty
    check (length(trim(workflow_id)) > 0),
  constraint workflow_runs_status_check
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'resuming')),
  constraint workflow_runs_inputs_is_object
    check (jsonb_typeof(inputs) = 'object'),
  constraint workflow_runs_accumulated_is_object
    check (jsonb_typeof(accumulated) = 'object'),
  constraint workflow_runs_resume_attempt_check
    check (resume_attempt >= 0)
);
```

### Table: `workflow_step_runs`

```sql
create table public.workflow_step_runs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete restrict,
  workflow_run_id   uuid not null references public.workflow_runs(id) on delete cascade,
  step_id           text not null,            -- matches WorkflowStepDefinition.id
  step_type         text not null,            -- matches WorkflowStepType
  sequence_number   integer not null,         -- 0-based position in step array
  status            text not null default 'pending',
  inputs_snapshot   jsonb not null default '{}'::jsonb,  -- accumulated at step start
  output            jsonb,
  error             text,
  execution_log_id  uuid,                     -- soft ref to execution_logs (no FK)
  retry_count       integer not null default 0,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint workflow_step_runs_step_id_not_empty
    check (length(trim(step_id)) > 0),
  constraint workflow_step_runs_step_type_not_empty
    check (length(trim(step_type)) > 0),
  constraint workflow_step_runs_sequence_number_check
    check (sequence_number >= 0),
  constraint workflow_step_runs_status_check
    check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),
  constraint workflow_step_runs_retry_count_check
    check (retry_count >= 0),
  constraint workflow_step_runs_inputs_is_object
    check (jsonb_typeof(inputs_snapshot) = 'object'),
  constraint workflow_step_runs_output_is_object
    check (output is null or jsonb_typeof(output) = 'object'),
  unique (workflow_run_id, step_id, retry_count)
);
```

### Column added to `background_jobs`

```sql
alter table public.background_jobs
  add column workflow_run_id uuid references public.workflow_runs(id) on delete set null;
```

This creates a nullable cross-reference. It is not a circular dependency because
`workflow_runs.background_job_id` is also nullable. The executor writes the
`workflow_run` first, then sets `background_jobs.workflow_run_id` after creation.

### Indexes

```sql
-- workflow_runs
create index workflow_runs_org_workflow_idx
  on public.workflow_runs (organization_id, workflow_id, started_at desc);

create index workflow_runs_org_status_idx
  on public.workflow_runs (organization_id, status, started_at desc);

create index workflow_runs_background_job_idx
  on public.workflow_runs (background_job_id)
  where background_job_id is not null;

create index workflow_runs_parent_run_idx
  on public.workflow_runs (parent_run_id)
  where parent_run_id is not null;

-- workflow_step_runs
create index workflow_step_runs_run_idx
  on public.workflow_step_runs (workflow_run_id, sequence_number);

create index workflow_step_runs_org_type_idx
  on public.workflow_step_runs (organization_id, step_type, started_at desc);

create index workflow_step_runs_failed_idx
  on public.workflow_step_runs (organization_id, status, started_at desc)
  where status = 'failed';
```

### RLS posture

Enable RLS on both tables with deny-by-default (no policies in migration 023).
Policies come in migration 024 following the same pattern as prior phases.
Service-role bypasses RLS; executor uses service_role throughout.

---

## 15. API Surface Proposal

All routes are server-side (Next.js App Router, Server Components or Route Handlers).
Authenticated routes use the existing `resolveUserContext` pattern.

### Workflow Runs

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/workflow-runs` | JWT | List runs for the user's org. Params: `workflow_id`, `status`, `limit`, `offset`. |
| `GET` | `/api/workflow-runs/[id]` | JWT | Single run with all step runs. |
| `POST` | `/api/workflow-runs/[id]/resume` | JWT + role check | Enqueue a resume job from the failed step. |
| `POST` | `/api/workflow-runs/[id]/cancel` | JWT + role check | Cancel a pending or running run. |

### Workflow Definitions

| Method | Route | Auth | Description |
|---|---|---|---|
| `GET` | `/api/workflows` | JWT | List workflow definitions (from registry). |
| `GET` | `/api/workflows/[id]` | JWT | Definition + run statistics for last 30 days. |

### Dev / Test

| Method | Route | Auth | Description |
|---|---|---|---|
| `POST` | `/api/dev/enqueue-workflow-test` | worker secret | Existing. Enqueues `request_to_task` test job. |

### Response shapes (abbreviated)

```typescript
// GET /api/workflow-runs
{
  runs: WorkflowRunRow[],
  total: number,
  has_more: boolean
}

// GET /api/workflow-runs/[id]
{
  run: WorkflowRunRow,
  steps: WorkflowStepRunRow[],
  entity_links: {
    task_id?: string,
    work_packet_id?: string,
    // ... other accumulated UUID keys
  }
}

// GET /api/workflows/[id]
{
  definition: WorkflowDefinition,
  stats: {
    total_runs: number,
    completed: number,
    failed: number,
    avg_duration_ms: number | null
  }
}
```

---

## 16. UI Surface Proposal

### New pages

| Route | Page | Description |
|---|---|---|
| `/workflows` | Workflow Registry | List all in-code workflows. Click-through to detail. |
| `/workflows/[id]` | Workflow Detail | Definition, step list, run stats, recent runs. |
| `/workflow-runs` | Workflow Runs | All runs table with status filter. |
| `/workflow-runs/[id]` | Run Detail | Step timeline, inputs, created entities, error detail. |

### Updated pages

| Route | Change |
|---|---|
| `/background-jobs` | Add `workflow_run_id` column. Jobs of type `workflow_step` get a link to the corresponding run detail page. |

### Navigation
Add "Workflows" and "Workflow Runs" to the AppNav sidebar under a "Runtime" group
alongside the existing "Background Jobs" link.

### Component patterns
- Step timeline: ordered `<table>` or `<ol>` of step runs with status badge, timing, and
  collapsible output/error JSON.
- Status badges: reuse the `STATUS_COLOR` pattern from `/background-jobs/page.tsx`.
- Entity links: parse `accumulated` JSON for UUID-valued keys matching known entity types;
  render as `<Link href="/tasks/[id]">` etc.
- Server Components for all list and detail pages (no client state needed for read-only).

---

## 17. Migration Strategy

### Sprint 5.6 migration: `023_workflow_run_tables.sql`

Scope (one migration):
1. Create `workflow_runs` table.
2. Create `workflow_step_runs` table.
3. Add `workflow_run_id` column to `background_jobs`.
4. Create all indexes.
5. Enable RLS on both new tables (deny-by-default).
6. Do NOT add RLS policies (next migration).

### Sprint 5.6 migration: `024_workflow_run_grants.sql`

Scope (one migration):
1. `GRANT SELECT, INSERT, UPDATE ON workflow_runs TO service_role`.
2. `GRANT SELECT, INSERT, UPDATE ON workflow_step_runs TO service_role`.
3. `GRANT UPDATE ON background_jobs TO authenticated` — **wait**: `background_jobs`
   already has `GRANT SELECT, INSERT, UPDATE ON public.background_jobs TO service_role`
   from migration 021. No new grant needed for service_role. For `authenticated` read
   via RLS policies: defer to `025_workflow_run_rls_policies.sql`.

### Sprint 5.6 migration: `025_workflow_run_rls_policies.sql`

RLS policies for authenticated users:
- `workflow_runs`: SELECT where `organization_id = auth.jwt()->>'org_id'`.
- `workflow_step_runs`: SELECT via join to `workflow_runs` where org matches.
- No authenticated INSERT or UPDATE (writes are service_role only).

### Order of application
023 → 024 → 025. Each is idempotent given the previous has applied. All three are
created and pushed in Sprint 5.6. No modification of migrations 001–022.

---

## 18. Backward Compatibility With Current `execution_logs`

**Rule: execution_logs writes are never removed.** They are the human-readable narrative
layer and may be read by humans, future audit tooling, and the governance layer.

Changes in Sprint 5.6:
- `execute.ts` continues to write execution_logs at workflow start, step events, and
  workflow end (exactly as today).
- Additionally, `execute.ts` writes `workflow_runs` and `workflow_step_runs` rows.
- Step run rows include `execution_log_id` pointing to the log row written for that step.
- The `execution_logs` row metadata gains `workflow_run_id` and `step_run_id` keys
  (in the existing `metadata jsonb` column — no schema change required).

**What existing dashboards see:** unchanged. The `/background-jobs` page query does not
join `workflow_runs`. The `execution_logs` table is still populated. `runtime_metrics`
worker health rows continue writing as before.

**What breaks:** nothing in the existing code. `execute.ts` is the only file that
changes structurally (adds two new table writes). All other files stay the same.

---

## 19. Future Database-Backed Workflow Registry

### Current state
`lib/workflows/registry.ts` is an in-code `Record<string, WorkflowDefinition>`.
`getWorkflow(id)` and `listWorkflows()` are the only public interface.

### Target state
A `workflow_definitions` table holds the authoritative definition, enabling:
- Versioning (multiple versions of the same workflow).
- Operator-editable descriptions without code deployment.
- Future visual builder editing the `steps` JSONB column.
- Rollout gates (`status = 'draft' | 'active' | 'deprecated'`).

### Migration path (future sprint, not 5.6)

```sql
create table public.workflow_definitions (
  id          uuid primary key default gen_random_uuid(),
  workflow_id text not null unique,         -- 'request_to_task'
  name        text not null,
  description text,
  steps       jsonb not null,              -- WorkflowStepDefinition[]
  version     integer not null default 1,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
```

### Registry adapter (no executor changes required)

```typescript
// lib/workflows/registry.ts (future)
export async function getWorkflow(id: string): Promise<WorkflowDefinition | undefined> {
  // 1. Try DB
  const { data } = await getServiceClient()
    .from('workflow_definitions')
    .select('*')
    .eq('workflow_id', id)
    .eq('status', 'active')
    .maybeSingle()
  if (data) return toWorkflowDefinition(data)

  // 2. Fall back to in-code (bootstrapped workflows)
  return IN_CODE_WORKFLOWS[id]
}
```

The executor (`execute.ts`) calls `getWorkflow()` and receives a `WorkflowDefinition`
regardless of source. No executor changes are needed to migrate the registry to DB.

Bootstrap migration: INSERT the in-code `request_to_task` definition into
`workflow_definitions` during the migration that creates the table.

---

## 20. Future Tool Registry

### Concept
Tools are named, versioned, executable capabilities that a workflow step can invoke.
A `tool_registry` table defines what tools exist, how to call them, and what permissions
they require.

### Architecture principle
A tool call is a **step type**, not a workflow. `invoke_tool` is added to `WorkflowStepType`.
The step executor dispatches to the tool runtime. Tool outputs flow into `accumulated`
exactly like any other step.

### Proposed `tool_registry` table (future)

```sql
create table public.tool_registry (
  id              uuid primary key default gen_random_uuid(),
  tool_id         text not null unique,      -- 'supabase_query', 'http_fetch', etc.
  name            text not null,
  description     text,
  tool_type       text not null,             -- 'db_query', 'http', 'file_op', 'external_service'
  config          jsonb not null default '{}', -- connection info, endpoint templates
  approval_required boolean not null default false,
  status          text not null default 'active',
  created_at      timestamptz not null default now()
);
```

### Step type: `invoke_tool`

```typescript
// In WorkflowStepDefinition.params:
{
  tool_id: 'supabase_query',
  input_mapping: { sql: "SELECT * FROM tasks WHERE id = '{{accumulated.task_id}}'" }
}
```

The step executor resolves the tool from registry, applies `input_mapping` (template
substitution against `accumulated`), executes, and returns output.

### Tool calls and approvals
Sensitive tool types (`external_service`, `file_op`) require `approval_required = true`.
The step executor checks this flag and inserts a `request_approval` step inline before
executing the tool. **No tool can bypass this check.**

### Observability
Tool invocations are written to `agent_activity` with `activity_type = 'tool_call'`
and the step run's `execution_log_id`. The `tool_name` column already exists on
`agent_activity`.

---

## 21. Future AI Agent Registry

### Architecture principle (non-negotiable)

> **AI is a workflow step. It is not the workflow orchestrator.**

Agents execute within a step. They read from `accumulated`, produce output, and return
to the executor. They cannot enqueue additional workflow runs, cannot approve their own
outputs, and cannot escalate their own permissions.

### Proposed `agent_registry` table (future)

```sql
create table public.agent_registry (
  id                    uuid primary key default gen_random_uuid(),
  agent_id              text not null unique,      -- 'summarizer', 'task_planner', etc.
  name                  text not null,
  model                 text not null,             -- 'claude-sonnet-4-6'
  system_prompt_template text,
  max_tokens            integer not null default 4096,
  tools_allowed         text[] not null default '{}',  -- tool_ids
  approval_required     boolean not null default true, -- output requires human review
  status                text not null default 'active',
  created_at            timestamptz not null default now()
);
```

### Step type: `invoke_agent`

```typescript
// In WorkflowStepDefinition.params:
{
  agent_id: 'task_planner',
  input_mapping: { context: "{{accumulated.task_id}}" },
  output_schema: { plan: 'string', estimated_hours: 'number' }
}
```

The step executor calls the Anthropic API using the agent's model and system prompt.
Output is validated against `output_schema` before flowing into `accumulated`.

### Governance constraints enforced by the executor

1. Agent outputs **always** flow through `request_approval` before being used to
   write business records (tasks, work_packets, outputs). The `invoke_agent` step
   cannot skip this if `agent_registry.approval_required = true`.
2. Agent steps write to `agent_activity` (session_id = workflow_run_id).
3. Agents cannot call `invoke_agent` recursively (depth check in executor).
4. Agent tool calls are logged before and after execution with full IO in `metadata`.

---

## 22. Future Integration Registry

### Concept
Integrations are external service connections — webhooks, OAuth providers, REST APIs,
message queues. They are distinct from tools: an integration is a **connection**, a
tool is an **action using a connection**.

### Proposed `integration_registry` table (future)

```sql
create table public.integration_registry (
  id                  uuid primary key default gen_random_uuid(),
  integration_id      text not null unique,   -- 'slack_notify', 'github_pr', etc.
  name                text not null,
  integration_type    text not null,          -- 'webhook', 'oauth', 'api_key', 'database'
  config_encrypted    text,                   -- encrypted JSON; decrypted at runtime only
  health_check_url    text,
  status              text not null default 'active',
  created_at          timestamptz not null default now()
);
```

### Security rules
- Credentials are stored encrypted in `config_encrypted`. The encryption key is
  a server-side secret (`INTEGRATION_ENCRYPTION_KEY`), never in the DB.
- Credentials are decrypted by `getServiceClient()` at execution time only.
- Decrypted credentials never appear in step outputs, `accumulated`, or `execution_logs`.
- Integration credentials are never logged. The executor redacts them before writing
  any observability row.

### Step types using integrations
- `webhook_emit`: POST to an external URL with payload from `accumulated`.
- `external_api_call`: Generic REST call with method, headers, body templating.

These are already listed in `JobType` as `webhook_emit`. In the full registry model,
they become workflow step types as well as job types.

---

## 23. Security / Governance Rules

These rules are architecture-level invariants. They apply to every sprint and every
future contributor. They do not expire.

| # | Rule | Where enforced |
|---|---|---|
| 1 | `SUPABASE_SERVICE_ROLE_KEY` must never use `NEXT_PUBLIC_` prefix. | Code review gate. `lib/supabase/service.ts` is server-only. |
| 2 | Service-role key must never reach the browser or be logged. | `service.ts` never imported from client components. |
| 3 | Agents cannot approve their own outputs. | `request_approval` step must follow any `invoke_agent` step when `approval_required = true`. Enforced in executor. |
| 4 | Agents cannot bypass the approval gate by re-routing through a different job type. | Dispatch registry has no agent-to-approval bypass path. |
| 5 | No DELETE is granted to any role via migration. | All migrations reviewed for DELETE grant absence. |
| 6 | Worker endpoints are protected by `x-worker-secret`. | `app/api/worker/run/route.ts` checks secret on every request. |
| 7 | Dev endpoints return 404 in production. | `NODE_ENV === 'production'` guard in all `app/api/dev/**` routes. |
| 8 | Tool credentials are never written to `accumulated`, `execution_logs`, or `runtime_metrics`. | Executor must redact before any observability write. |
| 9 | `workflow_runs` and `workflow_step_runs` are append-style. Completed/failed rows are never deleted. | No `DELETE` policy; soft-cancel only via `status = 'cancelled'`. |
| 10 | Resume requires authenticated user with appropriate role. | `POST /api/workflow-runs/[id]/resume` checks `resolveUserContext` and role. |
| 11 | Step accumulator values are typed. Numeric IDs must be UUIDs. | Executor validates FK-bound values before INSERT. |
| 12 | AI step depth is limited to 1 (no recursive agent calls). | Executor tracks depth in context; throws if depth > 1. |

---

## 24. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Step idempotency on resume.** `create_task` called twice creates a duplicate task. | High | Sprint 5.6: resume starts from the failed step, not step 1. Re-running prior successful steps is blocked by resume semantics. Retry (from step 1) shows an explicit warning. |
| **`workflow_run_id` circular reference.** `background_jobs.workflow_run_id` → `workflow_runs.background_job_id` creates a mutual FK cycle. | Medium | Both columns are nullable and use `ON DELETE SET NULL`. The cycle is safe because neither row holds the other hostage. Created first: `workflow_run`. FK set after: `background_jobs.workflow_run_id`. |
| **Worker stale sweep killing long-running workflows.** Sweep resets jobs in `processing` for more than 10 min. A long workflow (10+ steps, external calls) may be swept mid-run. | Medium | Future: make sweep threshold configurable per job type. Short-term: `workflow_step` jobs get longer stale threshold (30 min). Add check before sweep: `workflow_run.status = 'running'` jobs are excluded from sweep for `workflow_step` type. |
| **`accumulated` size growth.** Deep workflows accumulate large output dicts stored in a JSONB column. | Low | Monitor `pg_column_size(accumulated)`. Add `max_accumulated_bytes` check in executor if needed. Short-term: log a warning if accumulated exceeds 64 KB. |
| **Execution log volume.** Each step writes 1–2 execution_log rows. A 10-step workflow writes 12 rows per run. At scale this is large. | Low | `execution_logs` is already an append-only table with indexes. Retention policy (prune rows older than N days) is a future ops concern, not a Sprint 5.6 concern. |
| **`runtime_metrics.dimension_id` type mismatch.** Workflow IDs are text slugs; the column is UUID. | Low | Use Option B (encode workflow_id in metric_name) for Sprint 5.6. Proper fix (Option A: add `dimension_slug`) is a future schema migration. |
| **Resume race condition.** Two operators trigger resume simultaneously. | Low | `workflow_runs.status` update to `'resuming'` is atomic. Second UPDATE sees status already `'resuming'` and the API returns 409. |
| **`workflow_step_runs` unique constraint collision.** `unique(workflow_run_id, step_id, retry_count)` fails if the same step is retried and the row already exists. | Low | Retry increments `retry_count`. The constraint is on the combination, so retries are distinguished by `retry_count`. |

---

## 25. Sprint 5.6 Implementation Plan

All eight tasks are concrete and sequenced. No task should begin until the prior one
is merged or confirmed complete (the schema must exist before the executor can use it).

### Task 1 — Migration 023: workflow run tables
**File:** `supabase/migrations/023_workflow_run_tables.sql`
- Create `workflow_runs` table per Section 14 spec.
- Create `workflow_step_runs` table per Section 14 spec.
- Add `workflow_run_id uuid` column to `background_jobs` (nullable, FK).
- Create all indexes.
- Enable RLS (deny-by-default, no policies).
- Run `npx supabase db push` and `npx supabase db lint --linked`.

### Task 2 — Migration 024: grants
**File:** `supabase/migrations/024_workflow_run_grants.sql`
- `GRANT SELECT, INSERT, UPDATE ON workflow_runs TO service_role`.
- `GRANT SELECT, INSERT, UPDATE ON workflow_step_runs TO service_role`.
- No DELETE. No RLS changes.

### Task 3 — Migration 025: RLS policies
**File:** `supabase/migrations/025_workflow_run_rls_policies.sql`
- Authenticated SELECT on `workflow_runs` where org_id matches JWT.
- Authenticated SELECT on `workflow_step_runs` via join to `workflow_runs`.
- No authenticated INSERT or UPDATE.

### Task 4 — TypeScript types
**File:** `types/workflows.ts`
- Add `WorkflowRunStatus`, `WorkflowStepRunStatus` types.
- Add `WorkflowRun` and `WorkflowStepRun` row types.
- No changes to existing exported types (backward compatible).

### Task 5 — Update executor to write run + step rows
**File:** `lib/workflows/execute.ts`
- On entry: `INSERT workflow_runs` with `status = 'running'`, `inputs`, `started_at`.
- Store `runId` in local variable.
- Pass `runId` into each `executeStep` call.
- On step entry: `INSERT workflow_step_runs` with `status = 'running'`, `inputs_snapshot`, `sequence_number`.
- On step success: `UPDATE workflow_step_runs SET status = 'completed', output, completed_at`.
- On step failure: `UPDATE workflow_step_runs SET status = 'failed', error, completed_at`.
- On run success: `UPDATE workflow_runs SET status = 'completed', accumulated, completed_at`.
- On run failure: `UPDATE workflow_runs SET status = 'failed', failed_step_id, error, accumulated, failed_at`.
- After run row is created: `UPDATE background_jobs SET workflow_run_id = runId`.
- Keep all existing `execution_logs` writes unchanged.
- Add `workflow_run_id` and `step_run_id` to `execution_logs` metadata.

### Task 6 — API route: workflow runs list
**File:** `app/api/workflow-runs/route.ts`
- GET, JWT auth, org-scoped.
- Query params: `workflow_id?`, `status?`, `limit? = 20`, `offset? = 0`.
- Returns `{ runs, total, has_more }`.

### Task 7 — API route: workflow run detail
**File:** `app/api/workflow-runs/[id]/route.ts`
- GET, JWT auth.
- Fetches `workflow_runs` + joined `workflow_step_runs` ordered by `sequence_number`.
- Parses `accumulated` for entity links.
- Returns `{ run, steps, entity_links }`.

### Task 8 — UI: workflow runs list page
**File:** `app/workflow-runs/page.tsx`
- Server Component.
- Status summary cards (completed, failed, running, cancelled).
- Table: workflow_id, status badge, started_at, duration, failed_step_id.
- Each row links to `/workflow-runs/[id]`.

### Task 9 — UI: workflow run detail page
**File:** `app/workflow-runs/[id]/page.tsx`
- Server Component.
- Header: run ID, workflow name, status, duration.
- Step timeline table: step_id, step_type, status, duration.
- Entity links section (parse `accumulated` JSON).
- Inputs JSON (collapsible).
- Error section (if failed).

### Task 10 — Update `/background-jobs` page
**File:** `app/background-jobs/page.tsx`
- Add `workflow_run_id` to `JOB_COLS`.
- For `workflow_step` type jobs: render `workflow_run_id` as a link to
  `/workflow-runs/[workflow_run_id]`.

### Task 11 — Runtime metrics for workflow execution
**File:** `lib/jobs/handlers/workflow-step.ts`
- After `executeWorkflow` returns, record workflow-level metrics:
  - If success: write `workflow_run_completed` and `workflow_run_duration_ms`.
  - If failure: write `workflow_run_failed`.

---

## 26. Definition of Done

Sprint 5.6 is complete when all of the following are true:

### Schema
- [ ] Migrations 023, 024, 025 applied to remote database.
- [ ] `npx supabase db lint --linked` reports "No schema errors found".
- [ ] `workflow_runs` and `workflow_step_runs` tables exist with all columns and indexes.
- [ ] `background_jobs.workflow_run_id` column exists.

### TypeScript
- [ ] `npx tsc --noEmit` passes with zero errors.
- [ ] `WorkflowRun` and `WorkflowStepRun` types exported from `types/workflows.ts`.

### Executor behavior (verified by running workflow end-to-end)
- [ ] After `POST /api/worker/run`, a `workflow_runs` row exists with `status = 'completed'`.
- [ ] Five `workflow_step_runs` rows exist for the `request_to_task` run.
- [ ] Each step run has non-null `started_at`, `completed_at`, and duration > 0 ms.
- [ ] `accumulated` in the `workflow_runs` row contains `task_id` and `work_packet_id`.
- [ ] `background_jobs.workflow_run_id` is set to the run's UUID.
- [ ] `execution_logs` rows still written (backward compat confirmed by querying the table).

### API (verified by curl or Postman)
- [ ] `GET /api/workflow-runs` returns a paginated list with the test run visible.
- [ ] `GET /api/workflow-runs/[id]` returns run + all step runs.
- [ ] `entity_links` in the run detail response contains `task_id` and `work_packet_id`.

### UI (verified by loading pages in browser)
- [ ] `/workflow-runs` renders with status cards and at least one run in the table.
- [ ] `/workflow-runs/[id]` renders step timeline with timings and entity links.
- [ ] `/background-jobs` shows `workflow_run_id` cell with link for `workflow_step` jobs.
- [ ] No console errors on any of the above pages.

### Backward compatibility
- [ ] Existing `/background-jobs` page still loads and shows job data.
- [ ] `execution_logs` table still contains rows written by the workflow executor.
- [ ] `runtime_metrics` worker health rows still written on every `/api/worker/run` call.

### Security
- [ ] `SUPABASE_SERVICE_ROLE_KEY` appears in no client bundle (verified by grep).
- [ ] Dev endpoint `/api/dev/enqueue-workflow-test` still returns 404 when
  `NODE_ENV = 'production'` (verify in staging).
- [ ] No new `GRANT DELETE` statement exists in migrations 023–025.

---

*End of Sprint 5.5 — Workflow Runtime Blueprint*
