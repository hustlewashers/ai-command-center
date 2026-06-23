# Phase F Runtime Operations & Hardening Plan

Data model design for the AI Command Center **Runtime Operations & Hardening Layer** — the six tables that close the operational loop opened by Phases A–E by adding platform-level audit, job management, scheduling, failure handling, observability metrics, and agent activity tracking.

> **Canonical entities:** [system-entities.md](system-entities.md) §12 Execution Log (complemented, not replaced)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md) §2 System Layer
> **Approval gates:** [approval-rules.md](approval-rules.md)
> **Phase C execution:** [phase-c-execution-layer-migration-plan.md](phase-c-execution-layer-migration-plan.md)
> **Phase D governance:** [phase-d-governance-layer-migration-plan.md](phase-d-governance-layer-migration-plan.md)
> **Phase E knowledge:** [phase-e-knowledge-output-layer-migration-plan.md](phase-e-knowledge-output-layer-migration-plan.md)

This document is **planning only**. No SQL, migrations, or Supabase commands are included.

Phase F depends on all Phase A–E migrations having been applied successfully.

---

## Distinction: Execution Logs vs Phase F Tables

`execution_logs` (Phase C) is the canonical, append-only audit trail of entity-scoped actions: tool calls, state transitions, errors, and approval actions on requests, tasks, and workflows. It is an operational record and is treated as a first-class entity in [system-entities.md](system-entities.md) §12.

Phase F tables operate at a different layer:

| Phase F table | Layer | Distinct from `execution_logs` because |
|---|---|---|
| `audit_events` | Platform security/admin | Records auth, RLS denials, schema changes, org settings — not task-level operations |
| `background_jobs` | Runtime orchestration | Tracks runnable work units with retry state; feeds `execution_logs` but is not one |
| `scheduled_tasks` | Scheduling | Defines recurring triggers; not an audit of events that occurred |
| `dead_letter_queue` | Failure handling | Captures permanently failed work for manual review; post-processing artifact |
| `runtime_metrics` | Observability | Aggregated counters and gauges; not a record of a specific action |
| `agent_activity` | Agent observability | Fine-grained per-agent session trace; complements but does not duplicate `execution_logs` |

---

## Relationship to Existing Tables

| Phase F table | Connects to | Via |
|---|---|---|
| `audit_events` | `organizations` | `organization_id` (required) |
| `audit_events` | `users` | `actor_user_id` (nullable — system events have no user) |
| `background_jobs` | `organizations` | `organization_id` |
| `background_jobs` | `users` | `created_by_user_id` (nullable) |
| `background_jobs` | `tasks` | `related_task_id` (nullable — job may be spawned from a task) |
| `background_jobs` | `requests` | `related_request_id` (nullable — job may originate from a request) |
| `background_jobs` | `work_packets` | `related_work_packet_id` (nullable — job may execute a work packet step) |
| `scheduled_tasks` | `organizations` | `organization_id` |
| `scheduled_tasks` | `users` | `created_by_user_id` (nullable) |
| `scheduled_tasks` | `departments` | `owner_department_id` (nullable — for routing and RLS) |
| `dead_letter_queue` | `organizations` | `organization_id` |
| `dead_letter_queue` | `background_jobs` | `job_id` (the failed job that produced this entry) |
| `runtime_metrics` | `organizations` | `organization_id` |
| `runtime_metrics` | `departments` | `department_id` (nullable — metrics may be org-wide or department-scoped) |
| `agent_activity` | `organizations` | `organization_id` |
| `agent_activity` | `users` | `agent_user_id` (the agent's user record) |
| `agent_activity` | `tasks` | `task_id` (nullable — activity scoped to an assigned task) |
| `agent_activity` | `work_packets` | `work_packet_id` (nullable) |

**Indirect relationships by reference (no FK; polymorphic or text identifiers):**

- `audit_events.entity_type` / `entity_id` can reference any core entity row for context; enforced by application, not DB FK.
- `background_jobs.payload` (jsonb) may embed references to `outputs`, `knowledge_records`, `approvals`, `decisions`, or `execution_logs`.
- `runtime_metrics` aggregates data derived from `tasks`, `execution_logs`, `approvals`, `outputs`, `background_jobs`, and `agent_activity` but holds no FK to those tables.
- `agent_activity` connects to `execution_logs` by reference (activity rows note which execution log entry the agent action produced), not a hard FK.

---

## Operational Flow

The Phase F layer wraps Phase C–E operations into a runnable, observable, and recoverable system:

```text
External trigger / scheduled cron / user action
         │
         ▼
  background_jobs row created (status = 'queued')
  ─ job_type encodes what must be done
  ─ payload carries subject references (task_id, request_id, etc.)
         │
  job runner picks up row (status → 'processing')
  ─ agent_activity row created when an agent handles the job
  ─ execution_logs entries written as side effects
         │
    ┌────┴────┐
    │         │
 success    failure
    │         │
 status →   retry_count incremented
 'completed'  │
 metrics       if retry_count ≥ max_retries
 emitted       │
               ▼
         dead_letter_queue row created (status = 'failed')
         ─ original payload preserved
         ─ last error captured
         ─ awaits manual review or re-queue
         │
         ▼
  runtime_metrics rows upserted
  ─ job throughput, failure rate, latency
  ─ agent task completion rate
  ─ department workload indicators
         │
         ▼
  audit_events rows written for:
  ─ org config changes
  ─ RLS denials
  ─ auth events
  ─ schema migrations applied
  ─ approval decisions by admins
  ─ job retry limit breaches
```

For scheduled work:

```text
  scheduled_tasks row (status = 'active', cron_expression)
         │
  scheduler fires at cron time
         │
         ▼
  background_jobs row created from schedule
  ─ parent_schedule_id references the scheduled_tasks row
  ─ remainder of flow identical to above
```

---

## 1. `audit_events`

### Purpose

Platform-level security and admin audit envelope. Records auth events, RLS access denials, org/user settings changes, schema migration applications, and admin approval actions. Complements `execution_logs` (which records entity-scoped operational events) by capturing the system and security layer. Append-only; no `deleted_at`.

### Required Fields

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `event_category` | `text` | NOT NULL | Check: `('auth','security','admin','system','migration')` |
| `event_type` | `text` | NOT NULL | Free-form sub-classification; check `length(trim(event_type)) > 0` |
| `actor_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; null for system-generated events |
| `actor_role` | `text` | NULL | Role at time of event (snapshotted); null for system events |
| `entity_type` | `text` | NULL | Polymorphic: entity class the event concerns (e.g. `'user'`, `'department'`, `'approval'`) |
| `entity_id` | `uuid` | NULL | Polymorphic: id of affected entity; no DB FK |
| `ip_address` | `text` | NULL | Requestor IP at event time; null for internal/system events |
| `summary` | `text` | NOT NULL | Human-readable description; check `length(trim(summary)) > 0` |
| `metadata` | `jsonb` | NOT NULL | Structured event detail; default `'{}'::jsonb` |
| `severity` | `text` | NOT NULL | Default `'info'`; check: `('info','warn','error','critical')` |
| `occurred_at` | `timestamptz` | NOT NULL | Default `now()` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |

No `updated_at` (append-only). No `deleted_at`.

### Foreign Keys

| Column | References | On delete |
|---|---|---|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `actor_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|---|---|---|
| `audit_events_org_occurred_at_idx` | `(organization_id, occurred_at DESC)` | Primary timeline query |
| `audit_events_org_category_idx` | `(organization_id, event_category)` | Filter by category (auth/security/admin) |
| `audit_events_org_actor_idx` | `(organization_id, actor_user_id)` WHERE `actor_user_id IS NOT NULL` | Per-user audit trail |
| `audit_events_entity_idx` | `(organization_id, entity_type, entity_id)` WHERE `entity_id IS NOT NULL` | Events for a specific entity |
| `audit_events_severity_idx` | `(organization_id, severity, occurred_at DESC)` WHERE `severity IN ('warn','error','critical')` | Alert/incident review |

### Status Values

Not applicable. `audit_events` is append-only; status is represented by `severity`.

### Ownership Rules

- `organization_id` is pinned on INSERT.
- System/service-role generated only; never writable by authenticated users (including org_admin).
- No UPDATE or DELETE permitted for `authenticated`.

### RLS Considerations

- SELECT: `org_admin` only; no department-scoped access; no agent access. `read_only` excluded.
- INSERT: system role only via service account; `authenticated` users have no INSERT policy. Application layer inserts on their behalf.
- No UPDATE or DELETE policies.
- `ip_address` is PII-adjacent — do not expose via API to non-admin roles.

### Initial Seed Requirements

None at migration time. The migration tooling may emit a `system`-category event upon Phase F migration application.

---

## 2. `background_jobs`

### Purpose

Tracks runnable work units — async tasks the platform must execute (e.g., send webhook, run a scheduled trigger, execute a workflow step, or process a dead-letter retry). Acts as the platform's internal job queue table. Feeds `execution_logs` with results but is not itself an audit table.

### Required Fields

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `job_type` | `text` | NOT NULL | Check: `('workflow_step','approval_notification','scheduled_trigger','webhook_emit','output_delivery','dead_letter_retry','knowledge_sync','other')` |
| `status` | `text` | NOT NULL | Default `'queued'`; check: `('queued','processing','completed','failed','cancelled','retrying')` |
| `payload` | `jsonb` | NOT NULL | Job-specific input; default `'{}'::jsonb`; must be jsonb object |
| `priority` | `integer` | NOT NULL | Default `5`; lower is higher priority (1–10 scale) |
| `retry_count` | `integer` | NOT NULL | Default `0` |
| `max_retries` | `integer` | NOT NULL | Default `3` |
| `last_error` | `text` | NULL | Last failure message; null until first failure |
| `scheduled_for` | `timestamptz` | NULL | If set, job is not eligible for pickup before this time |
| `started_at` | `timestamptz` | NULL | Set when status → `processing` |
| `completed_at` | `timestamptz` | NULL | Set when status → `completed` or `failed` |
| `parent_schedule_id` | `uuid` | NULL | FK → `scheduled_tasks.id`, `on delete set null`; set when spawned by a schedule |
| `related_task_id` | `uuid` | NULL | FK → `tasks.id`, `on delete set null` |
| `related_request_id` | `uuid` | NULL | FK → `requests.id`, `on delete set null` |
| `related_work_packet_id` | `uuid` | NULL | FK → `work_packets.id`, `on delete set null` |
| `created_by_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by trigger |

`parent_schedule_id` has a forward reference to `scheduled_tasks`. Migration must create `scheduled_tasks` first, or use a deferred FK or `ALTER TABLE` after both tables exist.

### Foreign Keys

| Column | References | On delete |
|---|---|---|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `parent_schedule_id` | `public.scheduled_tasks.id` | SET NULL |
| `related_task_id` | `public.tasks.id` | SET NULL |
| `related_request_id` | `public.requests.id` | SET NULL |
| `related_work_packet_id` | `public.work_packets.id` | SET NULL |
| `created_by_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|---|---|---|
| `background_jobs_org_status_priority_idx` | `(organization_id, status, priority, scheduled_for)` WHERE `status IN ('queued','retrying')` | Job runner pickup queue |
| `background_jobs_org_job_type_idx` | `(organization_id, job_type)` | Filter by job type |
| `background_jobs_org_created_at_idx` | `(organization_id, created_at DESC)` | Timeline view |
| `background_jobs_related_task_idx` | `(related_task_id)` WHERE `related_task_id IS NOT NULL` | Jobs for a task |
| `background_jobs_schedule_idx` | `(parent_schedule_id)` WHERE `parent_schedule_id IS NOT NULL` | Jobs spawned by a schedule |

### Status Values

| Status | Meaning |
|---|---|
| `queued` | Waiting to be picked up |
| `processing` | Currently being executed |
| `completed` | Finished successfully |
| `failed` | Exhausted retries; moved to dead-letter |
| `cancelled` | Stopped before execution |
| `retrying` | Scheduled for a retry attempt |

### Ownership Rules

- `organization_id` is pinned on INSERT.
- `created_by_user_id` is null (system-spawned) or self-pinned.
- Jobs may be cancelled by `org_admin` or by the creating user/service.
- `max_retries` defaults to 3; can be overridden per job type at INSERT time.
- Once `status = 'failed'`, the job is immutable; retry requires a new row or a dead-letter re-queue.

### RLS Considerations

- SELECT: `org_admin` reads all; `department_lead`/`department_member` read jobs related to their department's tasks, requests, or work packets via `related_task_id`, `related_request_id`, `related_work_packet_id`; agents read jobs linked to their assigned task only.
- INSERT: service role and `org_admin` only; department users do not directly enqueue jobs.
- UPDATE: service role only (job runner); `org_admin` may cancel.
- No DELETE policy for `authenticated`.

### Initial Seed Requirements

None.

---

## 3. `scheduled_tasks`

### Purpose

Defines recurring or one-off scheduled triggers that spawn `background_jobs` at a configured time or interval. Decouples schedule configuration from job execution. Not an audit trail — does not record what ran; `background_jobs` and `execution_logs` do.

### Required Fields

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `name` | `text` | NOT NULL | Human-readable identifier; check `length(trim(name)) > 0` |
| `description` | `text` | NULL | Purpose of the schedule |
| `job_type` | `text` | NOT NULL | Job type to spawn; must be a value in `background_jobs.job_type` check |
| `payload_template` | `jsonb` | NOT NULL | Base payload to pass to spawned jobs; default `'{}'::jsonb` |
| `cron_expression` | `text` | NULL | Standard cron string (5-part); null for one-off schedules |
| `run_at` | `timestamptz` | NULL | For one-off schedules; null for recurring |
| `last_run_at` | `timestamptz` | NULL | Populated after each spawn |
| `next_run_at` | `timestamptz` | NULL | Computed next scheduled fire time |
| `owner_department_id` | `uuid` | NULL | FK → `departments.id`, `on delete set null`; department accountable for this schedule |
| `created_by_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null` |
| `status` | `text` | NOT NULL | Default `'active'`; check: `('active','paused','completed','archived')` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete |

Exactly one of `cron_expression` or `run_at` must be non-null (enforced by application; a check constraint `(cron_expression IS NOT NULL) != (run_at IS NOT NULL)` may be added at migration time).

### Foreign Keys

| Column | References | On delete |
|---|---|---|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `owner_department_id` | `public.departments.id` | SET NULL |
| `created_by_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|---|---|---|
| `scheduled_tasks_org_status_next_run_idx` | `(organization_id, status, next_run_at)` WHERE `status = 'active'` | Scheduler polling |
| `scheduled_tasks_org_department_idx` | `(organization_id, owner_department_id)` WHERE `owner_department_id IS NOT NULL` | Department schedule view |
| `scheduled_tasks_org_created_at_idx` | `(organization_id, created_at DESC)` | Timeline |

### Status Values

| Status | Meaning |
|---|---|
| `active` | Will fire on next scheduled time |
| `paused` | Temporarily suspended; will not spawn new jobs |
| `completed` | One-off schedule ran; no further firings |
| `archived` | Decommissioned |

### Ownership Rules

- `organization_id` pinned on INSERT.
- `owner_department_id` is optional but recommended for department-scoped schedules.
- Only `org_admin` or `department_lead` (in owning department) may INSERT or update schedule definition.
- Soft-delete via `deleted_at`; physical deletion is service-role-only.

### RLS Considerations

- SELECT: `org_admin` reads all; `department_lead`/`department_member`/`read_only` read schedules in their owning department.
- INSERT/UPDATE: `org_admin` and `department_lead` only in owning department.
- No DELETE policy for `authenticated`.

### Initial Seed Requirements

None at migration time; specific platform-level recurring jobs (e.g., approval expiry sweep, knowledge index refresh) may be seeded in a follow-on application bootstrap migration.

---

## 4. `dead_letter_queue`

### Purpose

Captures `background_jobs` that have exhausted all retries and cannot be automatically resolved. Preserves the original payload, error context, and job reference for manual review, re-queuing, or discard. Append-style; entries are reviewed and marked, not deleted.

### Required Fields

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `job_id` | `uuid` | NOT NULL | FK → `background_jobs.id`, `on delete restrict`; references the failed job |
| `job_type` | `text` | NOT NULL | Denormalized from `background_jobs.job_type` for query convenience |
| `original_payload` | `jsonb` | NOT NULL | Snapshot of `background_jobs.payload` at failure time |
| `error_summary` | `text` | NOT NULL | Human-readable last error; check `length(trim(error_summary)) > 0` |
| `error_detail` | `jsonb` | NULL | Stack trace, headers, or extended diagnostic data |
| `retry_count` | `integer` | NOT NULL | Total retries attempted before permanent failure |
| `resolution_status` | `text` | NOT NULL | Default `'pending_review'`; check: `('pending_review','requeued','discarded','escalated')` |
| `resolved_by_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; who took action |
| `resolved_at` | `timestamptz` | NULL | When resolution action was taken |
| `resolution_note` | `text` | NULL | Manual note on why it was discarded, re-queued, etc. |
| `failed_at` | `timestamptz` | NOT NULL | Default `now()`; when the job reached permanent failure |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |

No `updated_at` trigger; `resolved_at` covers mutation tracking. No `deleted_at`.

### Foreign Keys

| Column | References | On delete |
|---|---|---|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `job_id` | `public.background_jobs.id` | RESTRICT |
| `resolved_by_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|---|---|---|
| `dlq_org_resolution_failed_at_idx` | `(organization_id, resolution_status, failed_at DESC)` WHERE `resolution_status = 'pending_review'` | Operations review queue |
| `dlq_org_job_type_idx` | `(organization_id, job_type)` | Filter by job type |
| `dlq_job_id_idx` | `(job_id)` | Lookup by failed job |
| `dlq_org_failed_at_idx` | `(organization_id, failed_at DESC)` | Timeline |

### Status Values

| Status | Meaning |
|---|---|
| `pending_review` | Awaiting operator attention |
| `requeued` | Operator created a new `background_jobs` row to retry |
| `discarded` | Operator decided not to retry; no further action |
| `escalated` | Escalated to incident/blocker for broader investigation |

### Ownership Rules

- `organization_id` pinned on INSERT.
- System/service role only may INSERT (triggered by job runner on permanent failure).
- `resolved_by_user_id` is null-or-self; only `org_admin` or the resolving operator may set it.
- No physical DELETE for `authenticated`.

### RLS Considerations

- SELECT: `org_admin` and `department_lead` (scoped via `background_jobs.related_task_id`/`related_work_packet_id` co-tenancy) read entries relevant to their department; `read_only` excluded.
- INSERT: service role only.
- UPDATE: `org_admin` and `department_lead` may update `resolution_status`, `resolution_note`, and `resolved_by_user_id`/`resolved_at`.
- No DELETE policy.

### Initial Seed Requirements

None.

---

## 5. `runtime_metrics`

### Purpose

Stores aggregated operational counters, gauges, and rates for platform observability — job throughput, agent performance, workflow execution times, department workload, and error rates. Not a per-event audit; complements `execution_logs` and `agent_activity` with aggregate signals. Rows are upserted on a time-bucket + dimension key basis.

### Required Fields

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `metric_name` | `text` | NOT NULL | Fully qualified metric identifier; check `length(trim(metric_name)) > 0`. Examples: `jobs.completed_per_hour`, `agent.task_completion_rate`, `approvals.pending_count` |
| `metric_category` | `text` | NOT NULL | Check: `('runtime_health','user_activity','agent_performance','workflow_execution','governance')` |
| `dimension_type` | `text` | NULL | Scope of the metric: `'org'`, `'department'`, `'agent'`, `'job_type'`, `'workflow'` |
| `dimension_id` | `uuid` | NULL | Id of the scoping entity (e.g., department id, user id); no DB FK |
| `department_id` | `uuid` | NULL | FK → `departments.id`, `on delete set null`; denormalized for RLS support |
| `value_int` | `bigint` | NULL | Integer count or gauge |
| `value_float` | `double precision` | NULL | Float rate, ratio, or latency |
| `unit` | `text` | NOT NULL | Measurement unit; check: `('count','ms','seconds','percent','bytes','rate_per_min')` |
| `window_start` | `timestamptz` | NOT NULL | Start of the aggregation window |
| `window_end` | `timestamptz` | NOT NULL | End of the aggregation window |
| `recorded_at` | `timestamptz` | NOT NULL | Default `now()`; when this row was written/upserted |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |

Exactly one of `value_int` or `value_float` should be non-null; application enforces this.

### Foreign Keys

| Column | References | On delete |
|---|---|---|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `department_id` | `public.departments.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|---|---|---|
| `runtime_metrics_org_name_window_idx` | `(organization_id, metric_name, window_start DESC)` | Time series query by metric |
| `runtime_metrics_org_category_window_idx` | `(organization_id, metric_category, window_start DESC)` | Category dashboard |
| `runtime_metrics_org_dept_idx` | `(organization_id, department_id, metric_category)` WHERE `department_id IS NOT NULL` | Department-scoped metrics |
| `runtime_metrics_window_idx` | `(window_start, window_end)` | Range queries and cleanup |

### Status Values

Not applicable. `runtime_metrics` has no lifecycle status; it is an aggregate store, not an entity with state transitions.

### Ownership Rules

- `organization_id` pinned on INSERT.
- `department_id` is optional; org-wide metrics omit it.
- Only service role may INSERT or UPSERT; no direct writes from `authenticated`.
- Rows older than a configured retention window may be purged by service role; application should implement a retention policy.

### RLS Considerations

- SELECT: `org_admin` reads all; `department_lead`/`department_member`/`read_only` read metrics scoped to their department (where `department_id = private.current_department_id()`) or org-wide metrics (where `department_id IS NULL`).
- INSERT/UPDATE: service role only; no `authenticated` user policy.
- No DELETE policy for `authenticated`.
- `dimension_id` is not FK-verified; application must ensure it references a valid entity before writing.

### Initial Seed Requirements

None at migration time. The metrics collection pipeline populates this table at runtime.

---

## 6. `agent_activity`

### Purpose

Fine-grained per-agent session trace: captures what an agent did, which task it was assigned to, what tools it invoked, and what outputs or decisions it produced during a session. More granular than `execution_logs` (which records entity-scoped events) and more focused than `background_jobs` (which manages runnable work). Supports agent performance review, session debugging, and behavioral auditing.

### Required Fields

| Field | Type | Nullable | Notes |
|---|---|---|---|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `agent_user_id` | `uuid` | NOT NULL | FK → `users.id`, `on delete restrict`; must be a user with `role = 'agent'` |
| `session_id` | `uuid` | NOT NULL | Groups all activity rows for a single agent invocation; application-generated |
| `task_id` | `uuid` | NULL | FK → `tasks.id`, `on delete set null`; assigned task context |
| `work_packet_id` | `uuid` | NULL | FK → `work_packets.id`, `on delete set null` |
| `activity_type` | `text` | NOT NULL | Check: `('tool_call','decision_made','knowledge_record_created','output_produced','approval_requested','error_raised','session_start','session_end','other')` |
| `tool_name` | `text` | NULL | Tool invoked; null for non-tool events |
| `summary` | `text` | NOT NULL | Human-readable description; check `length(trim(summary)) > 0` |
| `metadata` | `jsonb` | NOT NULL | Structured detail (inputs, outputs, tool params); default `'{}'::jsonb` |
| `execution_log_id` | `uuid` | NULL | Soft reference to a matching `execution_logs` row; no DB FK (append-only table) |
| `duration_ms` | `integer` | NULL | Wall-clock duration of the activity in milliseconds |
| `status` | `text` | NOT NULL | Default `'completed'`; check: `('completed','failed','skipped','flagged')` |
| `occurred_at` | `timestamptz` | NOT NULL | Default `now()` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |

Append-only; no `updated_at` or `deleted_at`.

### Foreign Keys

| Column | References | On delete |
|---|---|---|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `agent_user_id` | `public.users.id` | RESTRICT |
| `task_id` | `public.tasks.id` | SET NULL |
| `work_packet_id` | `public.work_packets.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|---|---|---|
| `agent_activity_org_agent_session_idx` | `(organization_id, agent_user_id, session_id)` | Session replay and review |
| `agent_activity_org_task_idx` | `(organization_id, task_id, occurred_at DESC)` WHERE `task_id IS NOT NULL` | Activity for a task |
| `agent_activity_org_activity_type_idx` | `(organization_id, activity_type, occurred_at DESC)` | Filter by activity type |
| `agent_activity_org_status_idx` | `(organization_id, status)` WHERE `status IN ('failed','flagged')` | Error / incident review |
| `agent_activity_org_occurred_at_idx` | `(organization_id, occurred_at DESC)` | Timeline |

### Status Values

| Status | Meaning |
|---|---|
| `completed` | Activity succeeded |
| `failed` | Activity raised an error |
| `skipped` | Activity was planned but not executed (e.g., tool call skipped due to profile restriction) |
| `flagged` | Activity completed but was marked for review (e.g., unusual output, policy proximity) |

### Ownership Rules

- `organization_id` and `agent_user_id` pinned on INSERT.
- `session_id` is application-generated and groups the session's rows.
- Only the agent service identity (or service role) may INSERT; no human INSERT.
- Append-only; no UPDATE or DELETE for `authenticated`.

### RLS Considerations

- SELECT: `org_admin` reads all; `department_lead`/`department_member` read activity where `task_id` belongs to their department; agents read their own activity (`agent_user_id = private.current_user_id()`).
- INSERT: agent service identity only, with `agent_user_id = private.current_user_id()` pinning.
- No UPDATE or DELETE policy.
- `execution_log_id` is a soft reference (text identifier, no FK) — do not join directly in RLS; reference only in application layer.

### Initial Seed Requirements

None.

---

## Audit Requirements

The following events must be captured across `audit_events`, `execution_logs`, and `agent_activity`. Which table captures each event depends on the actor and context:

| Event category | Captured in | Required fields |
|---|---|---|
| User login / logout | `audit_events` | `event_category='auth'`, `actor_user_id`, `ip_address`, `occurred_at` |
| RLS access denial | `audit_events` | `event_category='security'`, `actor_user_id`, `entity_type`, `entity_id`, `summary` with policy name |
| Org settings change | `audit_events` | `event_category='admin'`, `entity_type='organization'`, old/new values in `metadata` |
| User role change / suspension | `audit_events` | `event_category='admin'`, `entity_type='user'`, `entity_id`, old/new role in `metadata` |
| Schema migration applied | `audit_events` | `event_category='migration'`, `summary` with migration filename, `actor_user_id=null` |
| Approval decision by admin | `audit_events` + `execution_logs` | Both: `audit_events` for the admin action; `execution_logs` `event_type='approval_action'` for the entity context |
| Failed job (permanent) | `audit_events` + `dead_letter_queue` | `audit_events` `event_category='system'` severity `'error'`; DLQ row with full error |
| External communication attempt | `execution_logs` | `event_type='tool_call'`, `actor=agent_id`, Category A approval reference in `metadata` |
| Deployment / config change | `audit_events` | `event_category='migration'` or `'admin'`, `summary` with change detail |
| Agent tool call | `agent_activity` + `execution_logs` | `agent_activity` `activity_type='tool_call'`; `execution_logs` `event_type='tool_call'` |
| Agent decision | `agent_activity` + `decisions` | `agent_activity` `activity_type='decision_made'`; `decisions` row |
| Agent error | `agent_activity` | `activity_type='error_raised'`, `status='failed'`, `metadata` with error detail |
| Approval status change | `execution_logs` | `event_type='approval_action'`, `context_type='task'` (or `'work_packet'`/`'output'`) |
| Output delivered | `execution_logs` | `event_type='state_change'`, `summary` noting delivery; `outputs.delivered_at` populated |

---

## Job / Queue Model

### Job Types

| Job type | Purpose |
|---|---|
| `workflow_step` | Executes one step in a workflow instance |
| `approval_notification` | Sends notification that an approval is pending |
| `scheduled_trigger` | Fires a recurring platform action from `scheduled_tasks` |
| `webhook_emit` | Emits an outbound webhook payload; Category A approval required |
| `output_delivery` | Delivers an output to the target system or requester |
| `dead_letter_retry` | Re-queues a DLQ entry for another attempt |
| `knowledge_sync` | Refreshes or rebuilds a knowledge index from execution data |
| `other` | Catch-all for platform-defined extensions |

### Retry States

| State | Transition |
|---|---|
| `queued` → `processing` | Job runner picks up the row |
| `processing` → `completed` | Job completed successfully |
| `processing` → `retrying` | Error on current attempt; `retry_count < max_retries` |
| `retrying` → `processing` | Next attempt started |
| `processing` → `failed` | Error on attempt where `retry_count = max_retries` |
| `queued` → `cancelled` | Operator or system cancels before pickup |
| `processing` → `cancelled` | `org_admin` or `service_role` stops an in-progress job (unsafe, stale, duplicated, manually stopped, or superseded); `started_at` is preserved from the moment of pickup |

### Failure Handling

1. On each error: increment `retry_count`, set `last_error`, set `status = 'retrying'`, compute `scheduled_for` using exponential back-off (`2^retry_count * base_interval_seconds`).
2. When `retry_count >= max_retries`: set `status = 'failed'`, create a `dead_letter_queue` row with the current `payload` snapshot, write an `audit_events` row (`event_category='system'`, `severity='error'`).
3. DLQ entry `resolution_status` defaults to `'pending_review'`. Operator reviews and either re-queues (creates a new `background_jobs` row, links via `parent_schedule_id` or new FK) or discards.

### Dead-Letter Conditions

A job enters the dead-letter queue when any of the following occur:

- `retry_count` reaches `max_retries` without success.
- A non-retryable error is raised (e.g., validation failure, missing subject entity).
- The job payload references a deleted or inaccessible entity (co-tenancy failure).
- A `webhook_emit` or `output_delivery` job receives a permanent 4xx from the target (not 5xx, which is retryable).

### Job Ownership

- Jobs are org-scoped and may be department-scoped via their related entity FKs.
- Service role creates and updates jobs; `authenticated` users do not enqueue jobs directly.
- `org_admin` may cancel a job or mark a DLQ entry as discarded/escalated.
- `department_lead` may view and resolve DLQ entries for their department's jobs.

---

## Metrics Model

### Runtime Health Metrics

| Metric name | Category | Unit | Description |
|---|---|---|---|
| `jobs.queued_count` | `runtime_health` | `count` | Current number of unprocessed jobs |
| `jobs.completed_per_hour` | `runtime_health` | `rate_per_min` | Job throughput rate |
| `jobs.failed_count` | `runtime_health` | `count` | Jobs in failed state |
| `jobs.dlq_pending_count` | `runtime_health` | `count` | DLQ entries pending review |
| `jobs.avg_latency_ms` | `runtime_health` | `ms` | Average time from queued to completed |
| `db.rls_denial_count` | `runtime_health` | `count` | RLS policy denials in window |

### User Activity Metrics

| Metric name | Category | Unit | Description |
|---|---|---|---|
| `users.active_sessions` | `user_activity` | `count` | Active users in window |
| `users.approvals_actioned` | `user_activity` | `count` | Approvals granted/rejected by humans in window |
| `users.tasks_completed` | `user_activity` | `count` | Tasks moved to `done` by human actors |
| `users.outputs_delivered` | `user_activity` | `count` | Outputs status → `delivered` in window |

### Agent Performance Metrics

| Metric name | Category | Unit | Description |
|---|---|---|---|
| `agent.session_count` | `agent_performance` | `count` | Agent session starts in window |
| `agent.task_completion_rate` | `agent_performance` | `percent` | Ratio of assigned tasks completed without error |
| `agent.tool_calls_per_session` | `agent_performance` | `count` | Average tool calls per session |
| `agent.error_rate` | `agent_performance` | `percent` | Ratio of agent activity rows with `status='failed'` |
| `agent.avg_session_duration_ms` | `agent_performance` | `ms` | Average wall-clock session duration |
| `agent.knowledge_records_created` | `agent_performance` | `count` | Knowledge records authored by agents in window |

### Workflow Execution Metrics

| Metric name | Category | Unit | Description |
|---|---|---|---|
| `workflow.step_completion_rate` | `workflow_execution` | `percent` | Completed / total workflow step jobs |
| `workflow.avg_step_latency_ms` | `workflow_execution` | `ms` | Average latency per workflow step job |
| `approvals.pending_count` | `governance` | `count` | Open approval rows in `pending` status |
| `approvals.avg_resolution_time_ms` | `governance` | `ms` | Average time from `pending` to terminal status |
| `blockers.open_count` | `governance` | `count` | Open blocker rows per department |

---

## Service Role Responsibilities

Phase F tables split write ownership between the Postgres `service_role` (which bypasses RLS and is used by the platform's backend runtime) and `authenticated` users (who operate within RLS boundaries). The table below defines which operations belong to each actor class.

### Write Ownership by Table

| Table | service_role | authenticated — org_admin | authenticated — dept_lead / member | authenticated — agent |
|---|---|---|---|---|
| `audit_events` | INSERT (system events, migration markers) | — | — | — |
| `background_jobs` | INSERT (enqueue), UPDATE (status transitions, retry) | INSERT (manual trigger), UPDATE (cancel), SELECT | SELECT (dept-scoped) | SELECT (task-scoped) |
| `scheduled_tasks` | UPDATE (last_run_at, next_run_at) | INSERT, UPDATE, SELECT | dept_lead: INSERT + UPDATE (owning dept) + SELECT; dept_member: SELECT only | — |
| `dead_letter_queue` | INSERT (on job permanent failure) | UPDATE (resolution), SELECT | UPDATE (resolution, dept-scoped), SELECT | — |
| `runtime_metrics` | INSERT / UPSERT (metric ingestion) | SELECT | SELECT (dept-scoped) | — |
| `agent_activity` | INSERT (system/bypass path) | SELECT | SELECT (dept-scoped) | INSERT (own rows only, `agent_user_id = current_user_id()`) |

### Key Rules

- **`service_role` bypasses RLS.** It does not consume `authenticated` grants. Tables that are service-role-write-only (e.g., `dead_letter_queue` INSERT, `runtime_metrics` INSERT) require no INSERT grant on `authenticated`.
- **Dead-letter resolution is human/operator, not service-role.** The `GRANT SELECT, UPDATE on dead_letter_queue` covers resolution by `org_admin` and `department_lead`. `service_role` handles INSERT.
- **Agent activity self-insert is pinned.** The `020` INSERT policy must enforce `agent_user_id = private.current_user_id()`. No agent may INSERT a row claiming another agent's identity.
- **Audit events are system-only.** No `authenticated` INSERT policy exists; all entries are created by the platform runtime via `service_role` or by Supabase auth hooks.
- **Metrics ingestion is pipeline-only.** No `authenticated` INSERT policy exists for `runtime_metrics`; the collection pipeline uses `service_role`.
- **`REVOKE UPDATE on audit_events, runtime_metrics, agent_activity`** (in `019`) makes append-only intent DB-enforced, not just convention.

---

## Migration Order

```
[already applied]
Phase A–E: 001 through 017

[Phase F — Runtime Operations & Hardening — six new migrations]

018_runtime_hardening.sql
  └── CREATE TABLE public.audit_events
        depends on: organizations, users
  └── CREATE TABLE public.scheduled_tasks
        depends on: organizations, departments, users
  └── CREATE TABLE public.background_jobs
        depends on: organizations, tasks, requests, work_packets, users
        note: background_jobs.parent_schedule_id references scheduled_tasks;
              create scheduled_tasks first within this migration
  └── CREATE TABLE public.dead_letter_queue
        depends on: organizations, background_jobs, users
  └── CREATE TABLE public.runtime_metrics
        depends on: organizations, departments
  └── CREATE TABLE public.agent_activity
        depends on: organizations, users (role='agent'), tasks, work_packets
  └── enable RLS deny-by-default on all six tables
  └── attach set_updated_at() trigger to background_jobs, scheduled_tasks
  └── no RLS policies yet
  └── no grants yet

019_phase_f_grants.sql
  └── GRANT SELECT, INSERT, UPDATE on background_jobs, scheduled_tasks
  └── GRANT SELECT on audit_events, runtime_metrics
  └── GRANT SELECT, UPDATE on dead_letter_queue
        — INSERT is service_role only; no authenticated INSERT grant required
  └── GRANT SELECT, INSERT on agent_activity
  └── REVOKE INSERT on dead_letter_queue from authenticated
  └── REVOKE UPDATE on audit_events, runtime_metrics, agent_activity from authenticated
  └── REVOKE DELETE on all six tables from authenticated

020_phase_f_rls_policies.sql
  └── CREATE policies for audit_events (SELECT only — org_admin)
  └── CREATE policies for background_jobs (SELECT, INSERT, UPDATE)
  └── CREATE policies for scheduled_tasks (SELECT, INSERT, UPDATE)
  └── CREATE policies for dead_letter_queue (SELECT, UPDATE)
  └── CREATE policies for runtime_metrics (SELECT)
  └── CREATE policies for agent_activity (SELECT, INSERT)
```

**Creation order within `018`:**
1. `audit_events` (depends only on Phase A tables)
2. `scheduled_tasks` (depends on `organizations`, `departments`, `users`)
3. `background_jobs` (depends on `scheduled_tasks` for `parent_schedule_id` FK)
4. `dead_letter_queue` (depends on `background_jobs`)
5. `runtime_metrics` (depends on `organizations`, `departments`)
6. `agent_activity` (depends on `organizations`, `users`, `tasks`, `work_packets`)

---

## Dependency Graph

```
organizations ◄──── audit_events.organization_id
                    audit_events.actor_user_id ────────────► users (nullable)

organizations ◄──── scheduled_tasks.organization_id
                    scheduled_tasks.owner_department_id ───► departments (nullable)
                    scheduled_tasks.created_by_user_id ────► users (nullable)

organizations ◄──── background_jobs.organization_id
                    background_jobs.parent_schedule_id ────► scheduled_tasks (nullable)
                    background_jobs.related_task_id ───────► tasks (nullable)
                    background_jobs.related_request_id ────► requests (nullable)
                    background_jobs.related_work_packet_id ► work_packets (nullable)
                    background_jobs.created_by_user_id ────► users (nullable)

organizations ◄──── dead_letter_queue.organization_id
                    dead_letter_queue.job_id ──────────────► background_jobs
                    dead_letter_queue.resolved_by_user_id ─► users (nullable)

organizations ◄──── runtime_metrics.organization_id
                    runtime_metrics.department_id ─────────► departments (nullable)

organizations ◄──── agent_activity.organization_id
                    agent_activity.agent_user_id ──────────► users (role='agent')
                    agent_activity.task_id ─────────────────► tasks (nullable)
                    agent_activity.work_packet_id ─────────► work_packets (nullable)

-- Soft references (no DB FK; application-enforced):
agent_activity.execution_log_id ────────────────────────► execution_logs
audit_events.entity_type / entity_id ────────────────── any core entity
runtime_metrics.dimension_type / dimension_id ─────────► any scoping entity
background_jobs.payload ────────────────────────────────► any referenced entity (jsonb)
```

---

## Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **`background_jobs` creates a forward-reference to `scheduled_tasks`** — `parent_schedule_id` FK requires `scheduled_tasks` to exist first. The single-migration approach requires strict table creation order within `018`. | Medium | Document and enforce creation order (scheduled_tasks before background_jobs). Alternatively use `ALTER TABLE ... ADD FOREIGN KEY` at the end of the migration after both tables are created. |
| 2 | **`audit_events` has no `deleted_at` and no correction mechanism** — incorrect audit rows cannot be amended without service-role intervention. | Low | This is intentional (append-only guarantee). Corrections are recorded as new rows with a reference to the erroneous row in `metadata`. Document the correction pattern explicitly in the migration plan. |
| 3 | **`runtime_metrics` has no FK to `dimension_id` subjects** — stale dimension references (deleted departments, retired workflows) will persist as orphaned metric rows. | Low | Metrics are aggregate data, not governance records. Implement a periodic cleanup job (via `background_jobs`) that nullifies `dimension_id` for deleted entities. |
| 4 | **`agent_activity.execution_log_id` is a soft reference** — no integrity guarantee between agent activity rows and their corresponding `execution_logs` entries. Out-of-sequence writes or partial failures may leave orphan references. | Low | Document as soft reference only. Application must emit both rows atomically in a transaction. If `execution_logs` INSERT fails, `execution_log_id` should be left null. |
| 5 | **`audit_events` IP address is PII** — storing `ip_address` on audit rows subjects the platform to data minimization obligations under applicable privacy regulations. | Medium | Restrict `ip_address` read to `org_admin` only via RLS. Add a retention/anonymization schedule. Document the PII status of this column in the migration comment. |
| 6 | **`runtime_metrics` row volume may grow unbounded** — time-series aggregate rows written every few minutes will accumulate rapidly. | Medium (performance) | Implement a rolling retention policy (service-role `DELETE`) for rows older than a configurable window (e.g., 90 days). Partition the table by `window_start` in a future Phase G hardening migration if volume justifies it. |
| 7 | **`agent_activity` may duplicate `execution_logs`** — both tables can record tool calls and state changes for agents. Without clear write ownership the same event is persisted twice with diverging `summary` text. | Medium | Define a strict rule: `execution_logs` is the canonical entity-scoped record; `agent_activity` is the per-agent session view. The agent runtime must write both, but treat `execution_logs` as authoritative for governance and `agent_activity` as a query convenience layer. |
| 8 | **RLS on `background_jobs` department-scoping is indirect** — visibility through `related_task_id`/`related_work_packet_id` requires EXISTS subqueries joining to `tasks`/`work_packets.department_id`. Performance depends on FK index quality on those tables. | Low (performance) | Index `background_jobs.related_task_id` and `related_work_packet_id` (Phase C tables already have partial indexes on `department_id`). Benchmark at load. |
| 9 | **`dead_letter_queue` resolution is manual** — failed jobs await human review indefinitely. If the queue grows without active triage, it accumulates silently. | Low | Add a `background_jobs` job of type `scheduled_trigger` that sweeps DLQ entries older than a configurable threshold and emits an `audit_events` row escalating the count to the ops team. |
| 10 | **`scheduled_tasks.cron_expression` is not DB-validated** — an invalid cron string will pass INSERT and only fail when the scheduler attempts to parse it at runtime. | Low | Add an application-layer validation step before INSERT. Optionally add a Postgres `CHECK` constraint using a regexp for basic 5-part cron format validation. Document the constraint in the migration. |
| 11 | **`agent_activity` RLS INSERT policy must pin `agent_user_id = private.current_user_id()`** — without this pin an agent could INSERT rows claiming another agent's identity. | High (security, pre-emptive) | RLS INSERT `WITH CHECK` must include `agent_user_id = private.current_user_id()`. This must be verified in the `020` audit before applying. |
| 12 | **Phase F does not include `blocker_research_assets`** — noted as deferred in Phase E. The junction table should be added in Phase F but is not in the current six-table scope. | Low | Add `blocker_research_assets` to `018_runtime_hardening.sql` scope if the team decides Phase F is the right place. Otherwise defer explicitly to Phase G. |
