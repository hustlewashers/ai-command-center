# Sprint 5 — Runtime Execution Engine Architecture Plan

Design specification for the **AI Command Center Runtime Execution Engine** — the active layer that processes `background_jobs`, invokes tools and agents, enforces approval gates, and writes observability records to `execution_logs`, `agent_activity`, `runtime_metrics`, and `audit_events`.

> **Phase F tables:** [phase-f-runtime-hardening-plan.md](phase-f-runtime-hardening-plan.md)
> **Migration 018:** `supabase/migrations/018_runtime_hardening.sql`
> **Application service architecture:** [phase-g9-application-service-architecture.md](phase-g9-application-service-architecture.md)
> **Approval gates:** [approval-rules.md](approval-rules.md)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)
> **System entities:** [system-entities.md](system-entities.md)

This document is **design only**. It introduces no SQL, migrations, schema changes, or application code. Implementation follows in Sprint 5.2+.

---

## 1. Purpose

The Runtime Execution Engine is the **active layer** of the AI Command Center. It is the bridge between the declarative data model (Supabase tables) and actual runtime behavior:

- The data model defines *what work exists* and *what state entities are in*.
- The execution engine defines *how that work gets done* and *what happens when it fails*.

Without the engine, `background_jobs` are inert rows. The engine is what picks them up, dispatches them to handlers, calls tools, enforces approval gates, handles retries, writes observability data, and routes failures to the dead-letter queue.

The engine operates within a hard constraint: **it does not invent new entity types, redefine existing lifecycles, or bypass RLS**. It executes within the boundaries established by Phases A–F and the G-phase API layer.

---

## 2. Scope

### In scope for Sprint 5.1 (this document — design only)

- Architecture definition for the MVP runtime worker
- Job dispatch model per `job_type`
- Agent activity lifecycle (session model)
- Execution log write obligations per event type
- Approval gate enforcement in the engine (Categories A and B)
- Service-role boundary definition (what uses the key and what does not)
- Failure handling and retry protocol
- Dead-letter queue insertion trigger and operator resolution flow
- Metrics collection and emission model
- API surface required to expose engine state (endpoints not yet built)
- UI surface required for operator visibility (pages not yet built)
- Security rules binding on all engine code
- Risk register
- MVP build sequence and definition of done

### Out of scope for Sprint 5.1

- Multi-agent coordination (one agent per job for MVP)
- Realtime subscriptions (`supabase_realtime` has no member tables as of v0.4.0)
- Knowledge sync implementation (`knowledge_sync` job_type handler deferred)
- Webhook emission implementation (`webhook_emit` handler — Category A, high risk, deferred after approval flow is proven)
- GovCon-specific domain rules (inherit from core gates; no separate implementation)
- Frontend charts for `runtime_metrics` (dashboard card only for MVP)
- Agent-to-agent orchestration (not in scope until a multi-agent session model is designed)

---

## 3. Current Runtime Substrate

### What is deployed (as of v0.4.0)

| Component | State |
|-----------|-------|
| `background_jobs` table | Deployed (migration `018`); RLS enabled; no rows |
| `scheduled_tasks` table | Deployed; RLS enabled; no rows |
| `dead_letter_queue` table | Deployed; RLS enabled; no rows |
| `runtime_metrics` table | Deployed; RLS enabled; no rows |
| `agent_activity` table | Deployed; RLS enabled; readable via `GET /api/agent-activity` |
| `execution_logs` table | Deployed (migration `007`); RLS enabled; readable via `GET /api/execution-logs` |
| `audit_events` table | Deployed; RLS enabled; no application reads yet |
| Grants (019) | Applied — SELECT on observability tables; INSERT/UPDATE scoped by role |
| RLS policies (020) | Applied — deny-by-default with role-scoped SELECT/INSERT/UPDATE |
| Dashboard | Shows recent `agent_activity` and `execution_logs` rows |
| Work Queue | Quick actions call PATCH endpoints; no job enqueueing yet |

### What does not exist yet

| Missing component | Required for |
|-------------------|-------------|
| Service-role Supabase client | All engine-side INSERTs/UPDATEs that bypass RLS |
| Job enqueue helper | Creating `background_jobs` rows from application code |
| Worker endpoint | Picking up and executing jobs |
| Job handlers (per `job_type`) | Doing the actual work of each job type |
| `background_jobs` API routes | Exposing jobs to the operator UI |
| `dead_letter_queue` API routes | Exposing DLQ to the operator UI |
| `scheduled_tasks` API routes | Managing recurring schedule definitions |
| `runtime_metrics` API routes | Querying aggregated metrics |
| Background jobs / DLQ / Schedules pages | UI for operator visibility and intervention |
| Approval gate check in engine | Blocking Category A jobs until approval is granted |
| Stale job sweep | Resetting stuck `processing` rows after worker crash |
| Metrics emission | Writing `runtime_metrics` rows after each worker run |

### Key architectural constraints inherited from G9

1. **Two trust tiers only** — Client-Safe (RLS-bound, `authenticated`) and Service-Role (RLS-bypassing). No mixed-tier paths.
2. **RLS is primary** — The engine never substitutes its own row filter for RLS.
3. **Agents signal, not govern** — Agents cannot INSERT `approvals`, `decisions`, or `blockers`. They write `agent_activity` only.
4. **Approval gates are application-enforced** — The DB does not block every forbidden transition; the engine must check gates at the Layer 5 boundary before executing privileged job types.
5. **Everything material is logged** — Every job execution produces at minimum one `execution_logs` row. Agent-handled jobs also produce `agent_activity` rows.

---

## 4. Execution Engine Responsibilities

The engine has exactly eight responsibilities. It does nothing outside these.

| # | Responsibility | Output |
|---|----------------|--------|
| 1 | **Poll for eligible jobs** | Claim rows from `background_jobs` where status ∈ {queued, retrying} and scheduled_for ≤ now() |
| 2 | **Dispatch by job_type** | Route each claimed job to the appropriate handler function |
| 3 | **Enforce approval gates** | Check for approved `approvals` row before executing Category A/B gated job types |
| 4 | **Execute job logic** | Handler performs the actual work (call tool, send notification, spawn sub-job) |
| 5 | **Write execution_logs** | Append one or more `execution_logs` rows recording what happened |
| 6 | **Write agent_activity** | Append `agent_activity` rows for every agent-handled job (session model) |
| 7 | **Handle failure and retry** | Increment retry_count; requeue with back-off; on exhaustion, move to DLQ |
| 8 | **Emit runtime_metrics** | Upsert aggregated counters after each worker run |

The engine does not: infer business logic, make unilateral decisions about entity state, mutate RLS policies, read or write the service_role key to a response, or pass credentials to agent handlers.

---

## 5. Job Lifecycle

### State machine

```
                    ┌─────────────────────────────┐
                    │                             │
[created] ──────► queued ──────► processing ──► completed
                    │               │
                    │               ├─► retrying ──► processing (loops until max_retries)
                    │               │        │
                    │               │        └── (max_retries reached) ──► failed ──► [DLQ entry]
                    │               │
                    └──► cancelled  └──► cancelled (unsafe stop by org_admin)
```

### Transition rules

| Transition | Actor | Conditions |
|-----------|-------|------------|
| `queued` → `processing` | Worker | scheduled_for ≤ now(); job successfully claimed (optimistic update) |
| `processing` → `completed` | Worker | Handler returned successfully; execution_logs written |
| `processing` → `retrying` | Worker | Handler raised retryable error; retry_count < max_retries |
| `retrying` → `processing` | Worker | scheduled_for reached; job reclaimed |
| `processing` → `failed` | Worker | retry_count = max_retries and handler raised error; OR non-retryable error |
| `queued` → `cancelled` | org_admin via PATCH | Before pickup |
| `processing` → `cancelled` | org_admin via PATCH | Unsafe stop; started_at preserved |
| `failed` → *(terminal)* | — | Immutable; retry only via new DLQ re-queue job |

### Fields updated on each transition

| Transition | Fields written by engine |
|-----------|--------------------------|
| → `processing` | `status`, `started_at`, `updated_at` |
| → `completed` | `status`, `completed_at`, `updated_at` |
| → `retrying` | `status`, `retry_count`, `last_error`, `scheduled_for`, `updated_at` |
| → `failed` | `status`, `completed_at`, `last_error`, `updated_at` |
| → `cancelled` | `status`, `updated_at` (started_at preserved) |

### Back-off schedule for retrying

| retry_count | scheduled_for offset |
|-------------|----------------------|
| 1 | now() + 30 seconds |
| 2 | now() + 2 minutes |
| 3 | now() + 10 minutes |
| 4 | now() + 1 hour |
| default max_retries | 3 (per background_jobs schema default) |

Custom `max_retries` on a job row overrides the schedule length. The back-off formula is `min(30 * 2^(retry_count - 1), 3600)` seconds, capped at 1 hour.

---

## 6. Agent Activity Lifecycle

Each agent-handled job maps to a **session**: a bounded sequence of `agent_activity` rows sharing a common `session_id` (application-generated UUID per job invocation). Sessions are not stored as first-class rows — they are reconstructed by querying `agent_activity` on `(agent_user_id, session_id)`.

### Session structure

```
session_start
   │
   ├── tool_call          (zero or more — each tool invoked)
   ├── decision_made      (zero or more — agent records proposed decisions)
   ├── knowledge_record_created  (zero or more)
   ├── output_produced    (zero or more — draft outputs created)
   ├── approval_requested (zero or more — agent signals a gate is needed)
   ├── error_raised       (zero or more — tool or logic errors)
   │
session_end
```

### Row fields set per activity type

| activity_type | tool_name | status | execution_log_id |
|---------------|-----------|--------|------------------|
| `session_start` | null | `completed` | null |
| `tool_call` | tool invoked | `completed` / `failed` / `skipped` | reference if log written |
| `decision_made` | null | `completed` | reference if log written |
| `knowledge_record_created` | null | `completed` | reference if log written |
| `output_produced` | null | `completed` | reference if log written |
| `approval_requested` | null | `completed` | reference if log written |
| `error_raised` | null (or tool name if tool error) | `failed` | reference if log written |
| `session_end` | null | `completed` | null |

### Key constraint: agents signal, do not govern

An agent writes `agent_activity` rows only. The agent does **not**:
- INSERT `approvals` — it writes `approval_requested` to `agent_activity` and the engine creates the approval row via service-role
- INSERT `decisions` — it writes `decision_made` to `agent_activity` and a human creates the `decisions` row
- INSERT `blockers` — not permitted
- UPDATE task/work_packet status directly — status transitions go through PATCH endpoints with Layer 5 gate checks

The engine reads `agent_activity` rows to determine what downstream actions are needed (e.g., seeing `approval_requested` triggers creation of an `approvals` row and an `approval_notification` job).

### Who writes agent_activity

| Path | Client | When |
|------|--------|------|
| Agent service identity | authenticated (agent role) | During execution — pinned to `agent_user_id = current_user_id()` |
| Engine bypass (service-role) | service_role | When writing on behalf of a system-managed agent identity |

Both paths are valid. The authenticated path is the default for real agent users. The service-role path is used for system-managed/simulated agent sessions where the session is managed by the engine rather than a live agent process.

---

## 7. Execution Log Lifecycle

`execution_logs` is the canonical, entity-scoped, append-only audit trail. Every job execution must produce at least one `execution_logs` row. Multiple rows per job are expected for complex jobs.

### Required log entries per event

| Event | event_type | context_type | actor | Required fields |
|-------|-----------|--------------|-------|-----------------|
| Tool invoked (Category C) | `tool_call` | task or request | agent_user_id | tool name in summary; metadata contains input/output |
| Tool invoked (Category A/B) | `tool_call` | task | agent_user_id | approval_id reference in metadata |
| Entity status change | `state_change` | task / request / workflow | agent or human user_id | old_status → new_status in summary |
| Approval requested | `state_change` | task / work_packet / output | agent_user_id | approver role in metadata |
| Approval granted | `approval_action` | task / work_packet / output | approver_user_id | decision_note in metadata |
| Approval rejected | `approval_action` | task / work_packet / output | approver_user_id | decision_note in metadata |
| Approval expired | `state_change` | task / work_packet / output | system | timeout duration in metadata |
| Job completed | `state_change` | task or request (via related_*) | system | job_id in metadata |
| Job failed (DLQ) | `error` | task or request | system | job_id, error summary in metadata |
| Agent error | `error` | task | agent_user_id | error message in summary; stack in metadata |
| Agent note | `note` | task | agent_user_id | free-form observation |
| Output delivered | `state_change` | request or workflow | system | output_id in metadata |

### Write path

All `execution_logs` writes from the engine use the **service-role client** (bypasses RLS) to guarantee the audit trail is written even when the subject entity's RLS would restrict the agent's own write access. The `actor` column carries the actual human or agent user_id so attribution is preserved.

This means `execution_logs` writes in the engine are service-role only. The RLS INSERT policies on `execution_logs` cover authenticated agents writing their own logs; the engine uses the service-role path for system-attributed entries where no single user is the actor.

---

## 8. Background Job Model

### Job types and handlers

| job_type | Handler responsibility | Writes to | Approval gated? |
|----------|----------------------|-----------|-----------------|
| `workflow_step` | Execute one step in a workflow instance; advance work_packet state | execution_logs, agent_activity | Yes — if step is Category A/B |
| `approval_notification` | Notify the designated approver that an approval row is pending | execution_logs | No — notification only |
| `scheduled_trigger` | Spawn a new background_job from a scheduled_tasks row; update last_run_at / next_run_at | background_jobs, scheduled_tasks | No |
| `webhook_emit` | Emit an outbound HTTP payload to an external target | execution_logs, audit_events | Yes — Category A always |
| `output_delivery` | Deliver an output to the target system or requester; advance output status to delivered | outputs, execution_logs | Yes — Category A always |
| `dead_letter_retry` | Re-queue a DLQ entry as a new background_jobs row; update dlq resolution_status | background_jobs, dead_letter_queue | No |
| `knowledge_sync` | Rebuild or refresh a knowledge index from execution data | knowledge_records | No — deferred to Sprint 6 |
| `other` | Extension point; handler dispatches on payload.sub_type | varies | Payload-defined |

### Job payload conventions

Each job_type uses a predictable payload structure. Payloads carry **IDs, not values** — no credentials, secrets, or large blobs.

```json
// workflow_step
{ "workflow_id": "uuid", "step_index": 3, "work_packet_id": "uuid" }

// approval_notification
{ "approval_id": "uuid", "approver_role": "department_lead", "subject_type": "work_packet", "subject_id": "uuid" }

// scheduled_trigger
{ "schedule_id": "uuid", "spawn_job_type": "workflow_step", "spawn_payload": { ... } }

// webhook_emit
{ "webhook_url_ref": "env_key_name", "approval_id": "uuid", "body_template_id": "uuid" }

// output_delivery
{ "output_id": "uuid", "approval_id": "uuid", "delivery_method": "email|webhook|download" }

// dead_letter_retry
{ "dlq_entry_id": "uuid", "original_job_id": "uuid" }
```

`webhook_url_ref` names an environment variable; the handler resolves the URL server-side. Webhook URLs never appear in payload jsonb.

### Job priority scale

| Priority | Intended use |
|----------|-------------|
| 1–2 | Approval notifications (time-sensitive, human-blocking) |
| 3–4 | Output delivery, webhook_emit (external commitment) |
| 5 (default) | Workflow steps, scheduled triggers |
| 6–8 | Knowledge sync, metrics collection |
| 9–10 | Dead-letter retry, housekeeping |

---

## 9. Tool Invocation Model

Tools are authorized per-agent via `tool_profiles`. Each task carries a `tool_profile_id` reference. The engine resolves the profile at job start and enforces tool boundaries for the session.

### Tool authorization check (per invocation)

```
1. Load agent's assigned tool_profile (via related_task.tool_profile_id)
2. Check if tool_name is in tool_profile.allowed_tools[]
3. Check if tool_name falls under a Category A or B gate

   Category A (always blocked until approved):
   - send_email, emit_webhook, destructive_shell, commit_protected_branch,
     create_scheduled_automation, deliver_output, domain_submission

   Category B (blocked when flagged):
   - Any tool not in allowed_tools[]
   - Exceeds cost/budget constraint in work_packet

4. If Category C (no gate, tool in profile):
   → Execute immediately
   → Write agent_activity row (activity_type='tool_call', status='completed')
   → Write execution_logs row (event_type='tool_call')

5. If Category A/B gate required:
   → Do NOT execute
   → Write agent_activity row (activity_type='approval_requested')
   → Engine creates approvals row (INSERT via service-role)
   → Engine enqueues approval_notification job
   → Job pauses (status='retrying', scheduled_for = now() + 5 minutes for re-check)
   → On re-check: if approval.status = 'approved', resume; if 'rejected'/'expired', fail job
```

### Tool execution result handling

| Outcome | agent_activity.status | execution_logs entry | Further action |
|---------|----------------------|---------------------|----------------|
| Success | `completed` | event_type='tool_call' | Continue session |
| Retryable error (timeout, 5xx) | `failed` | event_type='error' | Increment job retry_count |
| Non-retryable error (404, schema) | `failed` | event_type='error' | Fail job immediately → DLQ |
| Skipped (tool not in profile, approval pending) | `skipped` | event_type='note' | See Category B flow above |
| Flagged (tool executed but output suspicious) | `flagged` | event_type='note' | Write agent_activity with status='flagged'; continue |

---

## 10. Human Approval Boundaries

Approval gates are the most critical security invariant in the engine. The engine **never executes Category A job types without a verified approved approval row**.

### Gate check protocol (Category A jobs)

```
function checkApprovalGate(jobType, relatedApprovalId, supabase):
  if jobType not in CATEGORY_A_JOB_TYPES:
    return APPROVED  // no gate

  if relatedApprovalId is null:
    // No approval exists — create one
    approval = INSERT approvals (status='pending', category='a', subject=job.related_*, ...) via service-role
    approval_notification_job = INSERT background_jobs (type='approval_notification', payload={approval_id: approval.id}) via service-role
    return PENDING

  row = SELECT approvals WHERE id = relatedApprovalId (via service-role)
  if row.status = 'approved':   return APPROVED
  if row.status = 'pending':    return PENDING
  if row.status = 'rejected':   return REJECTED (fail job, non-retryable)
  if row.status = 'expired':    return EXPIRED (fail job, non-retryable)
  if row.status = 'withdrawn':  return WITHDRAWN (fail job, non-retryable)
```

`CATEGORY_A_JOB_TYPES = ['webhook_emit', 'output_delivery']`

### Gate check protocol (Category B — work_packet approval_required)

```
function checkWorkPacketGate(workPacketId, supabase):
  wp = SELECT work_packets WHERE id = workPacketId (via RLS-scoped authenticated client)
  if wp.status = 'pending_approval':
    // Approval gate is active — pause
    return PENDING
  if wp.status in ['ready', 'in_execution']:
    return APPROVED
  // any other status is a payload error
  return REJECTED
```

### Approval resolution: engine vs human

| Action | Who performs it | How |
|--------|-----------------|-----|
| Create approval row | Engine (service-role) | When gate check finds no approval and Category A job runs |
| Notify approver | Engine (via approval_notification job) | approval_notification handler sends in-platform notification |
| Grant/reject approval | Human operator | PATCH /api/approvals/:id via Work Queue or Approvals page |
| Resume blocked job | Engine (on next worker run) | Gate re-check finds status='approved'; job proceeds |
| Create blocker on expiry | Engine (service-role) | After approval expires; writes blocker row noting the expired gate |

### What the engine never does

- Never sets `approvals.status = 'approved'` on its own behalf
- Never creates `decisions` rows (only humans create decisions)
- Never grants itself elevated access by skipping the gate check on Category A jobs
- Never allows an agent's `agent_activity` `approval_requested` row to substitute for an actual `approvals` row

---

## 11. Service-Role Boundaries

The service-role Supabase client bypasses RLS. Its use is sealed to a minimal set of server-side locations. The service-role key must never appear in browser bundles, API responses, or agent payloads.

### Allowed service-role write operations

| Table | Operations | Location | Reason |
|-------|-----------|----------|--------|
| `background_jobs` | INSERT, UPDATE | Worker endpoint, job handlers | Enqueue and status transitions; RLS INSERT is service-role-only |
| `dead_letter_queue` | INSERT | Worker (on permanent failure) | No authenticated INSERT policy |
| `runtime_metrics` | INSERT, UPSERT | Worker (post-run) | No authenticated INSERT policy |
| `audit_events` | INSERT | Worker (on permanent failure, gate events) | No authenticated INSERT policy |
| `agent_activity` | INSERT | Worker (system path) | When engine writes on behalf of agent |
| `execution_logs` | INSERT | Worker (all job outcomes) | System-attributed entries where actor ≠ current user |
| `approvals` | INSERT | Worker (Category A gate check) | Engine creates approval row; no agent INSERT policy |
| `scheduled_tasks` | UPDATE (last_run_at, next_run_at) | scheduled_trigger handler | Workers update schedule state |
| `blockers` | INSERT | Worker (approval expiry) | Creates blocker when gate expires |

### Service-role client location

A single module: `lib/supabase/service.ts`

```
lib/
  supabase/
    server.ts     ← existing; creates authenticated client (RLS-bound)
    service.ts    ← new; creates service-role client (RLS-bypassing)
                     called only from:
                     - app/api/worker/run/route.ts
                     - lib/jobs/handlers/*.ts
                     - lib/jobs/enqueue.ts (service-role enqueue path)
```

### What never uses service-role

- All entity CRUD API routes (`/api/tasks`, `/api/approvals`, etc.) — use `createClient()` (authenticated)
- Dashboard and all UI pages — use `createClient()` (authenticated)
- All client-side code — no access to service_role at all
- Agent self-writes to `agent_activity` (authenticated agent identity, not service-role)

---

## 12. Failure Handling

### Retryable vs non-retryable errors

| Error type | Retryable? | Disposition |
|-----------|-----------|-------------|
| Network timeout to external service | Yes | Increment retry_count, requeue with back-off |
| 5xx from external HTTP target | Yes | Increment retry_count |
| Supabase transient connection error | Yes | Increment retry_count |
| Tool execution timeout (< 30 seconds) | Yes | Increment retry_count |
| 4xx from external HTTP target (except 429) | No | Fail immediately → DLQ |
| 429 (rate limited) | Yes | Requeue with longer back-off (1 hour) |
| Payload references deleted entity (FK null) | No | Fail immediately → DLQ |
| Schema validation failure in payload | No | Fail immediately → DLQ |
| Approval gate: status 'rejected' | No | Fail immediately → DLQ |
| Approval gate: status 'expired' | No | Fail immediately → DLQ |
| Worker process crash (job left in 'processing') | Special | Stale claim sweep resets to 'queued' after 10 minutes |

### Failure protocol (per job attempt)

```
try:
  handler.execute(job)

  // Success path
  UPDATE background_jobs SET status='completed', completed_at=now()
  INSERT execution_logs (event_type='state_change', summary='job completed')
  emit_metrics()

catch RetryableError as e:
  new_retry_count = job.retry_count + 1

  if new_retry_count <= job.max_retries:
    back_off = compute_backoff(new_retry_count)
    UPDATE background_jobs SET
      status='retrying',
      retry_count=new_retry_count,
      last_error=e.message,
      scheduled_for=now() + back_off

  else:
    // Exhausted retries
    permanent_fail(job, e)

catch NonRetryableError as e:
  permanent_fail(job, e)

function permanent_fail(job, error):
  UPDATE background_jobs SET status='failed', completed_at=now(), last_error=error.message
  INSERT dead_letter_queue (job_id, original_payload, error_summary, retry_count)
  INSERT audit_events (event_category='system', severity='error', summary='Job permanently failed')
  INSERT execution_logs (event_type='error', summary=error.message, actor='system')
  emit_metrics()
```

### Stale claim sweep

When the worker process crashes after setting `status='processing'` but before completing, the job is permanently stuck. The stale claim sweep runs at the start of each worker invocation:

```
UPDATE background_jobs SET
  status = 'queued',
  scheduled_for = null,
  last_error = 'Reset by stale claim sweep after worker crash'
WHERE
  status = 'processing'
  AND updated_at < now() - INTERVAL '10 minutes'
  AND organization_id = ctx.organizationId  -- service-role bypasses but scopes by org
```

This uses service-role because the current authenticated user may not have UPDATE on `background_jobs` in processing state.

---

## 13. Dead Letter Queue Flow

### Entry creation

A DLQ entry is created by the worker via service-role on permanent job failure:

```
INSERT dead_letter_queue:
  organization_id: job.organization_id
  job_id: job.id
  job_type: job.job_type
  original_payload: job.payload  -- snapshot at failure time
  error_summary: job.last_error
  error_detail: { stack, attempt_count, last_attempted_at }
  retry_count: job.retry_count
  resolution_status: 'pending_review'
  failed_at: now()
```

### Operator resolution flow

Operators interact with DLQ entries via the `/dead-letter-queue` page and `PATCH /api/dead-letter-queue/:id`.

| Resolution | API action | Engine follow-up |
|------------|-----------|-----------------|
| `requeued` | PATCH resolution_status='requeued', resolution_note | Engine creates new background_jobs row (via `dead_letter_retry` job or directly); original job remains failed |
| `discarded` | PATCH resolution_status='discarded', resolution_note | No further action; the DLQ entry is closed |
| `escalated` | PATCH resolution_status='escalated', resolution_note | Operator manually creates a Blocker row; DLQ entry is closed |

### Re-queue mechanics

When an operator re-queues a DLQ entry:
1. The `PATCH /api/dead-letter-queue/:id` endpoint validates the operator has org_admin or dept_lead role
2. The endpoint creates a new `background_jobs` row with the original `original_payload`, `job_type`, reset `retry_count=0`
3. The endpoint sets `dead_letter_queue.resolution_status = 'requeued'`, `resolved_at = now()`, `resolved_by_user_id = ctx.userId`
4. The new job picks up on the next worker run

The original failed job row is never mutated after it reaches `status='failed'`.

---

## 14. Metrics Flow

### Collection triggers

Metrics are written by the worker at the **end of each worker run** after all jobs in the batch are processed. This is a fire-and-forget upsert using service-role.

### Metrics written per worker run

| metric_name | category | unit | Source |
|------------|----------|------|--------|
| `jobs.queued_count` | `runtime_health` | `count` | SELECT count from background_jobs WHERE status='queued' |
| `jobs.processing_count` | `runtime_health` | `count` | SELECT count WHERE status='processing' (should be near 0 between runs) |
| `jobs.completed_per_run` | `runtime_health` | `count` | Completed in this worker run |
| `jobs.failed_count` | `runtime_health` | `count` | SELECT count WHERE status='failed' |
| `jobs.dlq_pending_count` | `runtime_health` | `count` | SELECT count FROM dead_letter_queue WHERE resolution_status='pending_review' |
| `approvals.pending_count` | `governance` | `count` | SELECT count FROM approvals WHERE status='pending' |
| `blockers.open_count` | `governance` | `count` | SELECT count FROM blockers WHERE status='open' |

Latency metrics (computed from this run's completed jobs):
| metric_name | unit | Computation |
|------------|------|-------------|
| `jobs.avg_latency_ms` | `ms` | avg(completed_at - started_at) for jobs completed this run |
| `jobs.max_latency_ms` | `ms` | max(completed_at - started_at) |

### Upsert window

Each metrics row uses a 5-minute window aligned to the nearest 5-minute boundary:
```
window_start = date_trunc('hour', now()) + floor(extract(minute from now()) / 5) * interval '5 minutes'
window_end   = window_start + interval '5 minutes'
```

Upsert key: `(organization_id, metric_name, window_start)`. If a row exists for this window, `value_int`/`value_float` is updated.

### Retention

`runtime_metrics` rows older than 90 days are deleted by a weekly `scheduled_trigger` job. This job is defined in `scheduled_tasks` at platform bootstrap. Target: `SELECT COUNT(*)` from `runtime_metrics WHERE window_start < now() - INTERVAL '90 days'` returns 0 after sweep.

---

## 15. MVP Runtime Worker Design

### Architecture choice: Next.js API route + external scheduler

For MVP, the worker runs as a Next.js route handler triggered by an external HTTP scheduler (Vercel Cron or a simple cron job hitting the endpoint). This choice:
- Requires zero new infrastructure
- Runs in the existing Next.js process
- Has access to service-role env var
- Is directly testable via curl

**Rejected alternatives for MVP:**
- Supabase Edge Functions: more isolation but requires Deno and a separate deploy pipeline; adds complexity before the job model is proven
- Standalone Node.js process: correct long-term but adds ops overhead for MVP
- Supabase pg_cron: executes SQL only, not JS handlers; insufficient for tool calls

### Worker endpoint

```
POST /api/worker/run
Authorization: CRON_SECRET header (constant-time comparison)
Body: { dry_run?: boolean }
```

Response:
```json
{
  "run_id": "uuid",
  "jobs_claimed": 5,
  "jobs_completed": 4,
  "jobs_failed": 1,
  "stale_resets": 0,
  "duration_ms": 1240
}
```

The response never includes job payloads, user IDs, entity data, or error details. Only aggregate counts.

### Worker run flow

```
1. Verify CRON_SECRET — reject with 401 if missing or wrong

2. Stale claim sweep:
   UPDATE background_jobs SET status='queued' WHERE status='processing' AND updated_at < now() - 10min

3. Claim batch (up to 10 jobs per run):
   For each job in (SELECT id FROM background_jobs WHERE status IN ('queued','retrying')
     AND (scheduled_for IS NULL OR scheduled_for <= now())
     ORDER BY priority, created_at LIMIT 10):
     → attempt UPDATE status='processing' WHERE id=job.id AND status IN ('queued','retrying')
     → if rowsAffected = 0: skip (another worker claimed it — optimistic lock)
     → if rowsAffected = 1: add to claimed list

4. Process each claimed job:
   a. Resolve handler by job_type
   b. Run approval gate check if required
   c. If gate: PENDING → requeue for 5 minutes; skip to next job
   d. If gate: REJECTED/EXPIRED → permanent_fail()
   e. Execute handler in try/catch
   f. On success: complete()
   g. On retryable error: retry()
   h. On non-retryable / exhausted: permanent_fail()

5. Emit runtime_metrics (fire-and-forget)

6. Return run summary
```

### Concurrency model

For MVP, each cron invocation runs sequentially (one at a time) through the batch. No parallel job execution within a single run. Multiple concurrent worker invocations are safe because of the optimistic claim (step 3 above): two workers cannot claim the same job.

If the batch consistently hits 10 (the LIMIT), the run cadence should decrease (every 30 seconds) or the batch size should increase to 25. This is a tuning concern post-MVP.

### Handler module structure

```
lib/
  jobs/
    enqueue.ts              ← enqueue(jobType, payload, options) — service-role INSERT
    claim.ts                ← claim job rows (optimistic UPDATE)
    dispatch.ts             ← route by job_type to handler
    sweep.ts                ← stale claim reset
    handlers/
      workflow-step.ts
      approval-notification.ts
      scheduled-trigger.ts
      webhook-emit.ts       ← deferred (Category A, requires approval flow proven first)
      output-delivery.ts    ← deferred (Category A)
      dead-letter-retry.ts
      knowledge-sync.ts     ← deferred to Sprint 6
```

### MVP handler implementation order

Sprint 5.2 builds these in sequence:
1. `approval-notification.ts` — simplest; just writes a log entry (no external calls)
2. `scheduled-trigger.ts` — spawns a new job; tests the self-enqueueing pattern
3. `dead-letter-retry.ts` — re-queues a DLQ entry; tests the DLQ re-queue flow
4. `workflow-step.ts` — executes a workflow step; first real agent invocation

`webhook-emit.ts` and `output-delivery.ts` are deferred until the approval flow is proven end-to-end (Sprint 5.3+).

---

## 16. API Surface Needed

All new endpoints follow the established pattern: `createClient()` for authenticated reads/writes, service-role client only within the worker endpoint and job handlers.

### New endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `POST` | `/api/worker/run` | CRON_SECRET header (not JWT) | Trigger worker run |
| `GET` | `/api/background-jobs` | authenticated | List jobs; filters: status, job_type, related_task_id, related_request_id |
| `POST` | `/api/background-jobs` | authenticated (org_admin) | Manually enqueue a job |
| `PATCH` | `/api/background-jobs/:id` | authenticated (org_admin) | Cancel a job |
| `GET` | `/api/dead-letter-queue` | authenticated | List DLQ entries; filters: resolution_status, job_type |
| `PATCH` | `/api/dead-letter-queue/:id` | authenticated (org_admin, dept_lead) | Resolve a DLQ entry (requeue, discard, escalate) |
| `GET` | `/api/scheduled-tasks` | authenticated | List schedules; filters: status, owner_department_id |
| `POST` | `/api/scheduled-tasks` | authenticated (org_admin, dept_lead) | Create a schedule |
| `PATCH` | `/api/scheduled-tasks/:id` | authenticated (org_admin, dept_lead) | Pause, resume, archive |
| `GET` | `/api/runtime-metrics` | authenticated | Query metrics; filters: metric_name, metric_category, window range |

### Existing endpoints used by the engine (no changes needed)

| Method | Path | Engine usage |
|--------|------|-------------|
| `GET` | `/api/approvals` | Gate check reads approval status |
| `PATCH` | `/api/approvals/:id` | Not used by engine — humans only |
| `GET` | `/api/tasks/:id` | Resolve task context for a job |
| `GET` | `/api/work-packets/:id` | Resolve work packet gate status |

Note: The engine does not use the existing REST API routes for writes. It uses the service-role Supabase client directly to guarantee writes succeed regardless of RLS. The existing API routes remain for human operator use only.

---

## 17. UI Surface Needed

### New pages

| Route | Type | Purpose |
|-------|------|---------|
| `/background-jobs` | Client Component | List jobs with status/type filters; cancel button for org_admin; click row for detail |
| `/background-jobs/:id` | Server Component | Detail: all fields, related entity links, last_error, audit trail |
| `/dead-letter-queue` | Client Component | List pending_review entries; Requeue / Discard / Escalate buttons with note input |
| `/scheduled-tasks` | Client Component | List schedules; Pause / Resume / Archive; "New Schedule" form |
| `/runtime-metrics` | Server Component | KPI cards: queued count, pending approvals, open blockers, DLQ pending, last run time |

### Existing dashboard updates

Add to `/` (Sprint 5.2):
- "Runtime Health" KPI card: jobs.queued_count + jobs.dlq_pending_count
- "Background Jobs" entry in alerts section if dlq_pending_count > 0

### AppNav updates

Add after "Exec Logs":
```
{ href: '/background-jobs', label: 'Jobs' },
{ href: '/dead-letter-queue', label: 'DLQ' },
{ href: '/scheduled-tasks', label: 'Schedules' },
```

---

## 18. Security Rules

These rules are binding on all Sprint 5.2+ implementation. Any code that violates them must be rejected before merge.

| # | Rule | Enforcement |
|---|------|-------------|
| 1 | The service-role key is server-side only. It may not appear in any file that could be served to a browser or included in a client bundle. | Code review; env var never prefixed with `NEXT_PUBLIC_` |
| 2 | The worker endpoint (`POST /api/worker/run`) must compare `CRON_SECRET` with constant-time comparison (`crypto.timingSafeEqual`). Any request without the correct secret returns 401 with no diagnostic detail. | Implementation requirement |
| 3 | The worker response body must not contain job payloads, user IDs, entity content, stack traces, or error messages. Aggregate counts only. | Implementation requirement |
| 4 | Category A job types (`webhook_emit`, `output_delivery`) must fail with a non-retryable error if no `approval_id` is present in the payload or if the approval row does not have `status='approved'`. | Gate check in handler |
| 5 | `agent_activity` inserts via the authenticated path must enforce `agent_user_id = auth.uid()` at the RLS layer. The engine must not insert `agent_activity` rows claiming a different user's identity without using the service-role path. | Existing RLS policy (020); code review |
| 6 | The worker must never INSERT `decisions`, `approvals` (except for gate creation), or `blockers` without an explicit human-originating PATCH request upstream. Exception: the engine may INSERT an `approvals` row when a Category A gate is missing and the job needs to block; and may INSERT a `blockers` row when an approval expires. | Handler implementation review |
| 7 | Job payloads must reference entities by UUID only. No credential material, webhook URLs, API keys, or PII may appear in `background_jobs.payload` or `dead_letter_queue.original_payload`. | Handler implementation review; webhook URLs stored as env key references |
| 8 | The stale claim sweep must never reset a job that completed or failed (status in `completed`, `failed`, `cancelled`). Only `processing` jobs with `updated_at` older than 10 minutes are eligible. | WHERE clause enforcement |
| 9 | DLQ resolution endpoints require explicit role check: `org_admin` or `dept_lead` (scoped to relevant department via background_jobs related entity). `read_only` and `agent` roles get 403. | Layer 4 check in PATCH handler |
| 10 | `runtime_metrics` writes use service-role. No authenticated INSERT policy exists for this table. Any attempt to write metrics from an authenticated route is a violation. | RLS denial (no INSERT policy); code review |
| 11 | The Vercel Cron URL for the worker must not be publicly documented or guessable. The CRON_SECRET provides the primary defense; the URL obscurity is defense-in-depth only. | Deployment configuration |
| 12 | `audit_events` INSERTs from the engine must include `event_category`, `severity`, `summary`, and `organization_id`. Malformed entries should throw, not silently drop, so the failure surfaces in the worker's error path. | Handler implementation |

---

## 19. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **Double-processing** — two concurrent worker invocations claim the same job | High | Optimistic claim: `UPDATE WHERE status IN ('queued','retrying')` returns 0 rows if already claimed; skip those jobs |
| 2 | **Stuck processing jobs** — worker crashes after claiming but before completing | High | Stale claim sweep (§12): reset to 'queued' after 10 minutes of no `updated_at` change |
| 3 | **Service-role key leaks to client** — accidentally bundled in a Next.js page | High | Never prefix with `NEXT_PUBLIC_`; runtime environment variable (`process.env.SUPABASE_SERVICE_ROLE_KEY`); server-only import guard |
| 4 | **Category A bypass** — engine executes webhook_emit or output_delivery without checking approval | High | Gate check is the first operation in each handler; handlers throw `NonRetryableError` if gate not met |
| 5 | **DLQ silent growth** — failed jobs accumulate without operator awareness | Medium | Dashboard alert card (jobs.dlq_pending_count > 0 → active alert); weekly sweep job emits audit_events |
| 6 | **Worker timeout** — single job takes > 60 seconds; Vercel function timeout kills it | Medium | Each handler has a 30-second internal timeout; jobs exceeding it are treated as retryable errors; Vercel timeout is 60 seconds for API routes |
| 7 | **Approval loop** — engine creates approval row, notifies, re-checks, but approval is never acted on | Medium | Approval expiry (48h → `expired` per approval-rules.md); expired approval causes non-retryable fail → DLQ → blocker created |
| 8 | **`execution_logs` write failure** — service-role INSERT to execution_logs fails mid-job | Medium | Wrap in try/catch; log failure to `audit_events`; do not fail the job because of a log write failure (log writes are best-effort; job outcome is primary) |
| 9 | **Metrics table unbounded growth** — 5-minute windows accumulate rapidly | Medium | 90-day retention sweep scheduled from the start; add to `scheduled_tasks` at bootstrap |
| 10 | **Exponential back-off collision** — many jobs enter retrying at the same time and all become eligible simultaneously | Low | Jitter: add ±10% random offset to `scheduled_for` so jobs spread across the window |
| 11 | **Job payload schema drift** — handlers expect payload fields that are not set on older jobs | Low | Validate payload at handler entry; throw `NonRetryableError` with descriptive message; DLQ entry carries the malformed payload for inspection |
| 12 | **agent_activity session_id collisions** — two concurrent sessions generate the same UUID | Low | Engine generates session_id via `crypto.randomUUID()` server-side; collision probability is negligible |
| 13 | **knowledge_sync deferred** — agent outputs and knowledge records are not indexed until Sprint 6 | Low | Acceptable for MVP; `knowledge_sync` jobs can be enqueued but handler returns early with a logged note |

---

## 20. MVP Build Sequence

Ordered list. Each item must be validated (typecheck + lint + manual test) before starting the next.

| # | Item | Sprint | Files |
|---|------|--------|-------|
| 1 | `lib/supabase/service.ts` — service-role client module | 5.2 | `lib/supabase/service.ts` |
| 2 | `lib/jobs/enqueue.ts` — typed enqueue helper; calls service-role INSERT on background_jobs | 5.2 | `lib/jobs/enqueue.ts` |
| 3 | `lib/jobs/sweep.ts` — stale claim reset; called at start of each worker run | 5.2 | `lib/jobs/sweep.ts` |
| 4 | `lib/jobs/claim.ts` — optimistic batch claim (SELECT + UPDATE) | 5.2 | `lib/jobs/claim.ts` |
| 5 | `lib/jobs/handlers/approval-notification.ts` — first handler; writes log entry | 5.2 | `lib/jobs/handlers/approval-notification.ts` |
| 6 | `app/api/worker/run/route.ts` — worker endpoint with CRON_SECRET guard, sweep, claim, dispatch | 5.2 | `app/api/worker/run/route.ts` |
| 7 | `app/api/background-jobs/route.ts` — GET list (authenticated); POST create (org_admin) | 5.2 | `app/api/background-jobs/route.ts` |
| 8 | `app/api/background-jobs/[id]/route.ts` — GET detail; PATCH cancel | 5.2 | `app/api/background-jobs/[id]/route.ts` |
| 9 | `app/background-jobs/page.tsx` — list page with status/type filters | 5.2 | `app/background-jobs/page.tsx` |
| 10 | `lib/jobs/handlers/scheduled-trigger.ts` — spawns child job from scheduled_tasks row | 5.2 | `lib/jobs/handlers/scheduled-trigger.ts` |
| 11 | `lib/jobs/handlers/dead-letter-retry.ts` — re-queues from DLQ | 5.2 | `lib/jobs/handlers/dead-letter-retry.ts` |
| 12 | `app/api/dead-letter-queue/route.ts` — GET list; PATCH resolve | 5.3 | `app/api/dead-letter-queue/route.ts` |
| 13 | `app/api/dead-letter-queue/[id]/route.ts` — PATCH resolve detail | 5.3 | `app/api/dead-letter-queue/[id]/route.ts` |
| 14 | `app/dead-letter-queue/page.tsx` — list with resolve actions | 5.3 | `app/dead-letter-queue/page.tsx` |
| 15 | `app/api/scheduled-tasks/route.ts` + `[id]/route.ts` | 5.3 | `app/api/scheduled-tasks/...` |
| 16 | `app/scheduled-tasks/page.tsx` | 5.3 | `app/scheduled-tasks/page.tsx` |
| 17 | `lib/jobs/metrics.ts` — post-run metrics emission | 5.3 | `lib/jobs/metrics.ts` |
| 18 | `app/api/runtime-metrics/route.ts` | 5.3 | `app/api/runtime-metrics/route.ts` |
| 19 | `lib/jobs/handlers/workflow-step.ts` — first real agent invocation | 5.4 | `lib/jobs/handlers/workflow-step.ts` |
| 20 | Dashboard Runtime Health card + DLQ alert | 5.4 | `app/page.tsx` update |

Sprint 5.2 delivers items 1–11 (worker boots, processes approval_notification and scheduled_trigger jobs, background-jobs UI visible).
Sprint 5.3 delivers items 12–18 (DLQ UI + resolution, schedules UI, metrics collection).
Sprint 5.4 delivers items 19–20 (first agent-invoked job; dashboard health card).

---

## 21. Definition of Done

Sprint 5.2 is done when all of the following are true:

### Functional

- [ ] `POST /api/worker/run` with correct `CRON_SECRET` returns 200 with job summary
- [ ] `POST /api/worker/run` without `CRON_SECRET` returns 401 with no diagnostic detail
- [ ] Worker successfully claims and processes at least one `approval_notification` job end-to-end
- [ ] A job that exceeds `max_retries` enters `dead_letter_queue` with `resolution_status='pending_review'`
- [ ] Stale claim sweep resets a `processing` row with `updated_at` older than 10 minutes back to `queued`
- [ ] `GET /api/background-jobs` returns visible jobs for the authenticated user
- [ ] `PATCH /api/background-jobs/:id` with `status='cancelled'` succeeds for org_admin on a queued job
- [ ] `/background-jobs` page loads and displays job list with status filter

### Security

- [ ] `process.env.SUPABASE_SERVICE_ROLE_KEY` does not appear in any file that is imported by client components
- [ ] Worker response body contains only aggregate counts (no payloads, no user IDs)
- [ ] CRON_SECRET comparison uses `crypto.timingSafeEqual`

### Observability

- [ ] Every job that completes produces at least one `execution_logs` row
- [ ] Every permanently failed job produces one `dead_letter_queue` row and one `audit_events` row
- [ ] Worker run produces `runtime_metrics` upserts for `jobs.queued_count` and `jobs.dlq_pending_count`

### Code quality

- [ ] `npm run typecheck` passes clean
- [ ] `npm run lint` passes clean
- [ ] No service-role client instantiated in any file under `app/` that is not a route handler
