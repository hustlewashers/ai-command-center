# Phase D Governance Layer Migration Plan

Data model design for the AI Command Center **Governance Layer** — the three tables that make approval gates, recorded decisions, and progress impediments first-class database citizens.

> **Canonical entities:** [system-entities.md](system-entities.md) §6 Decision · §7 Approval · §13 Blocker  
> **Approval gates:** [approval-rules.md](approval-rules.md)  
> **Department routing:** [department-map.md](department-map.md)  
> **Phase C execution layer:** [phase-c-execution-layer-migration-plan.md](phase-c-execution-layer-migration-plan.md)

This document is **planning only**. No SQL, migrations, or Supabase commands are included.

Phase D depends on all Phase A (`001`, `002`), Phase B (`003`, `004`, `005`, `006`), and Phase C (`007`, `008`, `009`, `010`) migrations having been applied successfully.

---

## Relationship to Existing Tables

Phase D rows integrate governance checkpoints into the execution flow established in Phases A–C.

| Phase D table | Connects to | Via |
|---------------|-------------|-----|
| `approvals` | `organizations` | `organization_id` |
| `approvals` | `users` | `requested_by_user_id` (nullable — may be agent or automation) |
| `approvals` | `users` | `approver_user_id` (nullable — unset until assigned or actioned) |
| `approvals` | `departments` | `department_id` (the department that owns the approval gate) |
| `approvals` | `tasks` | polymorphic via `subject_type = 'task'` + `subject_id` |
| `approvals` | `work_packets` | polymorphic via `subject_type = 'work_packet'` + `subject_id` |
| `approvals` | `decisions` | polymorphic via `subject_type = 'decision'` + `subject_id` |
| `decisions` | `organizations` | `organization_id` |
| `decisions` | `tasks` | `task_id` (required — decisions are always made in task context) |
| `decisions` | `users` | `decided_by_user_id` (nullable — decisions may be agent-made) |
| `blockers` | `organizations` | `organization_id` |
| `blockers` | `users` | `reported_by_user_id` (required — always a traceable actor) |
| `blockers` | `users` | `assigned_to_user_id` (nullable — may be unassigned initially) |
| `blockers` | `departments` | `department_id` (the department responsible for resolution) |
| `blockers` | `tasks` | polymorphic via `blocked_entity_type = 'task'` + `blocked_entity_id` |
| `blockers` | `work_packets` | polymorphic via `blocked_entity_type = 'work_packet'` + `blocked_entity_id` |

**Forward references to Phase E:** `approvals.subject_type` accepts `'output'` in the check constraint to support the Phase E Output table. The FK cannot be enforced at the DB level until Phase E. Application layer enforces this until then.

**Polymorphic FKs:** `approvals.subject_id`, `blockers.blocked_entity_id`, and `decisions`-to-approval (`decision_id` in `approvals`) are not enforced by DB-level FKs due to polymorphism or forward references. All must be co-tenancy-validated by the application layer and by RLS `with check` clauses in Phase D RLS policies.

---

## 1. `approvals`

### Purpose

An authorization gate record. Created when an actor (human or agent) requests permission for a high-risk action before it executes. Remains open until approved, rejected, expired, or withdrawn. Governs lifecycle transitions in subject entities (`tasks`, `work_packets`, `decisions`, and future `outputs`).

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `department_id` | `uuid` | NOT NULL | FK → `departments.id`, `on delete restrict`; the department that owns the gate |
| `subject_type` | `text` | NOT NULL | Check: `('task', 'work_packet', 'decision', 'output')` |
| `subject_id` | `uuid` | NOT NULL | Polymorphic — DB-level FK not enforceable across types; application-enforced co-tenancy |
| `category` | `text` | NOT NULL | Check: `('a', 'b', 'c')`; maps to approval-rules.md Category A/B/C |
| `trigger_reason` | `text` | NOT NULL | Human-readable description of what triggered this gate |
| `requested_by_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; null if raised by automation or system |
| `approver_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; null until explicitly assigned or acted on |
| `approver_role` | `text` | NOT NULL | Role description copied from approval-rules.md (e.g. `'department_lead'`, `'engineering_lead'`, `'operations_lead'`) — snapshot at creation time |
| `status` | `text` | NOT NULL | Default `'pending'`; check: `('pending','approved','rejected','expired','withdrawn')` |
| `decided_at` | `timestamptz` | NULL | Populated when status leaves `pending` |
| `decision_note` | `text` | NULL | Approver's rationale on grant or denial |
| `expires_at` | `timestamptz` | NULL | Deadline — 48-hour default from approval-rules.md; null means no timeout enforced by DB |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by `set_updated_at()` trigger |

> `approvals` has **no `deleted_at`**. Approval records are governance artifacts; they are not soft-deleted. Status `withdrawn` captures cancellation. Hard delete is service-role-only.

### Foreign Keys

| Column | References | On delete |
|--------|-----------|-----------|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `department_id` | `public.departments.id` | RESTRICT |
| `requested_by_user_id` | `public.users.id` | SET NULL |
| `approver_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `approvals_organization_status_idx` | `(organization_id, status)` | Filter pending/expired gates across an org |
| `approvals_organization_department_status_idx` | `(organization_id, department_id, status)` | Department dashboard; RLS support |
| `approvals_subject_idx` | `(organization_id, subject_type, subject_id)` | Lookup approvals for a specific subject entity |
| `approvals_approver_user_id_idx` | `(approver_user_id)` WHERE `approver_user_id IS NOT NULL` | Find all approvals assigned to a specific user |
| `approvals_expires_at_idx` | `(expires_at)` WHERE `expires_at IS NOT NULL AND status = 'pending'` | Expiry background job |
| `approvals_organization_created_at_idx` | `(organization_id, created_at DESC)` | Timeline views |

### Status Values

| Status | Meaning | Can be set by |
|--------|---------|--------------|
| `pending` | Awaiting review | Set on INSERT only |
| `approved` | Authorization granted | Approver (authenticated) |
| `rejected` | Authorization denied | Approver (authenticated) |
| `expired` | Not acted on within window | Background job / service role |
| `withdrawn` | Request cancelled by requester | Requester (department lead / admin) |

### Ownership Rules

- `organization_id` is org-pinned on INSERT.
- `department_id` is the department that governs the gate; non-admin inserters pin it to their own department.
- `requested_by_user_id` is null-or-self pinned (same pattern as `requests.submitted_by_user_id`).
- Only `org_admin` and `department_lead` of the owning department may act (approve/reject/withdraw).
- Status transitions are one-directional: `pending` → terminal state only. An expired/rejected approval is never re-opened; a new `approvals` row is created per `approval-rules.md` §Timeout and Escalation.

### RLS Considerations

- SELECT: all org members read approvals in their org (same as `requests`).
- INSERT: `org_admin`, `department_lead`, `department_member`, `agent` in own org; `department_id` pinned to caller's dept for non-admins; `requested_by_user_id` null-or-self.
- UPDATE: `org_admin` (any); `department_lead` of owning dept (status transitions only); `department_member` cannot update status. Status may only move from `pending` to a terminal state.
- No DELETE policy for `authenticated`. No soft-delete column.
- `expired` status is set by a service-role background process (no `authenticated` UPDATE policy needed for expiry).

### Initial Seed Requirements

None. Approval records are created at runtime in response to events.

---

## 2. `decisions`

### Purpose

Records a choice made during task execution — what was decided, the rationale, and by whom. Decisions create an auditable reasoning trail and may trigger a linked `approvals` row when the decision type requires authorization (per `approval-rules.md` §Decision ↔ Approval Interaction).

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `task_id` | `uuid` | NOT NULL | FK → `tasks.id`, `on delete restrict`; decisions always live in task context |
| `summary` | `text` | NOT NULL | What was decided; check `length(trim(summary)) > 0` |
| `rationale` | `text` | NOT NULL | Why this option was chosen; check `length(trim(rationale)) > 0` |
| `decided_by_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; null for agent or system decisions |
| `decided_at` | `timestamptz` | NOT NULL | Default `now()` |
| `status` | `text` | NOT NULL | Default `'proposed'`; check: `('proposed','confirmed','pending_approval','approved','rejected','superseded')` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by `set_updated_at()` trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete marker; superseded decisions are typically status-marked, but soft-delete is available for hard-mistaken entries |

### Foreign Keys

| Column | References | On delete |
|--------|-----------|-----------|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `task_id` | `public.tasks.id` | RESTRICT |
| `decided_by_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `decisions_organization_task_id_idx` | `(organization_id, task_id)` | Look up all decisions for a task |
| `decisions_organization_status_idx` | `(organization_id, status)` | Audit and pending-approval dashboards |
| `decisions_decided_by_user_id_idx` | `(decided_by_user_id)` WHERE `decided_by_user_id IS NOT NULL` | Per-actor decision history |
| `decisions_organization_created_at_idx` | `(organization_id, created_at DESC)` | Timeline views |

**Soft-delete-aware partial unique index:** None required; multiple decisions per task are expected and valid.

### Status Values

| Status | Meaning |
|--------|---------|
| `proposed` | Decision recorded but not validated; autonomous logging (Category C) |
| `confirmed` | Accepted as final; no approval needed |
| `pending_approval` | Requires authorization before taking effect |
| `approved` | Approved and in effect |
| `rejected` | Denied or overturned |
| `superseded` | Replaced by a later decision on the same matter |

### Ownership Rules

- `organization_id` and `task_id` are required on INSERT.
- `decided_by_user_id` is null-or-self pinned for authenticated users; service role may insert null for system/agent decisions.
- Decisions belong to the department that owns the task (`tasks.department_id`). Department scope for RLS derives from the parent task — `decisions` has no direct `department_id` column (derives via `task_id → tasks.department_id`).
- Org admins and department leads may update status. Department members may insert decisions and move to `pending_approval`. Only leads/admins may move to `confirmed`, `approved`, or `rejected`.

### RLS Considerations

- SELECT: org members see decisions in their org where `deleted_at is null`; department members see only decisions for tasks in their department (join via `task_id`). Org admin sees all.
- INSERT: `org_admin`, `department_lead`, `department_member` in their own department's tasks; `decided_by_user_id` null-or-self pinned; co-tenancy check that `task_id` is in same org.
- UPDATE: `org_admin` (any); `department_lead` of the task's owning department. Status guard: non-admin callers cannot move status directly to `approved`/`rejected` — those transitions are approver-only.
- No DELETE policy for `authenticated`.

### Initial Seed Requirements

None.

---

## 3. `blockers`

### Purpose

Represents an active impediment that prevents a task or work packet from progressing. Blockers make stalled work visible, assignable, and resolvable. Creating a blocker is a Category C autonomous action (no approval required, but must be logged).

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `department_id` | `uuid` | NOT NULL | FK → `departments.id`, `on delete restrict`; department responsible for resolution |
| `description` | `text` | NOT NULL | What is blocking progress; check `length(trim(description)) > 0` |
| `blocked_entity_type` | `text` | NOT NULL | Check: `('task', 'work_packet')`; `project`-level blockers deferred to Phase E |
| `blocked_entity_id` | `uuid` | NOT NULL | Polymorphic; DB-level FK not enforceable; application co-tenancy-validated |
| `severity` | `text` | NOT NULL | Default `'medium'`; check: `('low', 'medium', 'high', 'critical')` |
| `reported_by_user_id` | `uuid` | NOT NULL | FK → `users.id`, `on delete restrict`; always a traceable actor |
| `assigned_to_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; person responsible for resolution |
| `resolution_note` | `text` | NULL | Required (application-enforced) when status moves to `resolved` or `won_t_fix` |
| `status` | `text` | NOT NULL | Default `'open'`; check: `('open','investigating','pending_external','resolved','won_t_fix')` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by `set_updated_at()` trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete; resolved blockers may be soft-deleted after a retention period |

### Foreign Keys

| Column | References | On delete |
|--------|-----------|-----------|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `department_id` | `public.departments.id` | RESTRICT |
| `reported_by_user_id` | `public.users.id` | RESTRICT |
| `assigned_to_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `blockers_organization_status_idx` | `(organization_id, status)` WHERE `status NOT IN ('resolved', 'won_t_fix')` | Active blockers overview |
| `blockers_organization_department_status_idx` | `(organization_id, department_id, status)` | Department blocker queue; RLS support |
| `blockers_blocked_entity_idx` | `(organization_id, blocked_entity_type, blocked_entity_id)` | Look up blockers for a given task or work packet |
| `blockers_assigned_to_user_id_idx` | `(assigned_to_user_id)` WHERE `assigned_to_user_id IS NOT NULL` | Find all blockers assigned to a user |
| `blockers_severity_idx` | `(organization_id, severity, status)` WHERE `status NOT IN ('resolved', 'won_t_fix')` | High/critical active blocker escalation |
| `blockers_organization_created_at_idx` | `(organization_id, created_at DESC)` | Timeline views |

### Status Values

| Status | Meaning |
|--------|---------|
| `open` | Active impediment; newly reported |
| `investigating` | Owner assigned; root cause being determined |
| `pending_external` | Waiting on outside party or dependency |
| `resolved` | Blocker cleared; work may resume |
| `won_t_fix` | Accepted as permanent constraint; per `approval-rules.md`, override requires Approval |

### Ownership Rules

- `organization_id` is org-pinned on INSERT.
- `department_id` is required. For non-admins it must match their own department. Org admin may create blockers for any department.
- `reported_by_user_id` is always the calling user (RLS-pinned); automation-reported blockers go through service role.
- `assigned_to_user_id` must be in the same org if not null.
- `resolution_note` is enforced at the application layer when status → `resolved` or `won_t_fix`; no DB check constraint because the column is not pinned to specific statuses.

### RLS Considerations

- SELECT: org-wide for all members (blockers are operationally visible); `deleted_at is null`.
- INSERT: `org_admin`, `department_lead`, `department_member`, `agent` in own org; `reported_by_user_id` pinned to caller; `department_id` pinned to caller's dept for non-admins; co-tenancy check on `blocked_entity_id` (via `blocked_entity_type` branch, checking `tasks` or `work_packets`).
- UPDATE: `org_admin` (any); `department_lead`/`department_member` in owning department. Status is not gated by RLS but per-transition rules are application-enforced (e.g. `won_t_fix` override requires an `approvals` row).
- No DELETE policy for `authenticated`. Soft-delete via `deleted_at`.

### Initial Seed Requirements

None.

---

## Governance Flow

The canonical flow from an execution event to a resolved governance record:

```text
[Task / Work Packet reaches a gate trigger]
         │
         ▼
  approval_required_before_start = true
  or Category A / B trigger event occurs
         │
         ▼
  approvals row created (status = 'pending')
  subject entity status frozen
  (task → 'in_review' / work_packet → 'pending_approval')
         │
    ┌────┴─────┐
    │          │
 approved   rejected / expired
    │          │
    ▼          ▼
 subject    subject returns to prior state
 proceeds   or task → 'blocked'
                  │
                  ▼
            blockers row created
            (status = 'open')
                  │
         investigating → resolved
                  │
                  ▼
            task → 'ready' or 'backlog'
                  │
                  ▼
         execution_logs entry recorded
         (event_type = 'state_change' or 'approval_action')

[Decisions during execution]
         │
         ▼
  decisions row created (status = 'proposed')
  ─ autonomous: no approval needed (Category C)
  ─ high-risk: status → 'pending_approval'
               approvals row created with subject_type = 'decision'
```

---

## Approval Gates

Mapping from `approval-rules.md` to database records:

### Category A — Always Required

| Trigger | `approvals.category` | `subject_type` | `approver_role` |
|---------|---------------------|----------------|----------------|
| Send external email | `'a'` | `'task'` or `'output'` (Phase E) | `'operations_lead'` |
| Emit webhook to production | `'a'` | `'task'` | `'engineering_lead'` |
| Execute destructive shell command | `'a'` | `'task'` | `'engineering_lead'` |
| Commit to protected branch | `'a'` | `'task'` | `'engineering_lead'` |
| Create scheduled automation | `'a'` | `'task'` | `'operations_lead'` |
| Deliver Output to external requester | `'a'` | `'output'` (Phase E) | `'operations_lead'` |
| GovCon domain submission | `'a'` | `'output'` (Phase E) | `'domain_owner'` |

### Category B — Required When Specified

| Trigger | `approvals.category` | `subject_type` | `approver_role` |
|---------|---------------------|----------------|----------------|
| `work_packets.approval_required_before_start = true` | `'b'` | `'work_packet'` | `'department_lead'` |
| Decision status → `pending_approval` | `'b'` | `'decision'` | `'department_lead'` |
| Tool outside assigned Tool Profile | `'b'` | `'task'` | `'platform_lead'` |
| Budget constraint exceeded | `'b'` | `'work_packet'` | `'department_lead'` |

### Category C — Logged, Not Gated

Category C actions do not create `approvals` rows. They create `execution_logs` rows only. No Phase D record is required.

### `approvals.subject_type = 'output'` note

`output` is accepted in the check constraint of `approvals.subject_type` because Category A events reference outputs. The `outputs` table does not yet exist (Phase E). Until Phase E is applied, any `approvals` row with `subject_type = 'output'` has `subject_id` pointing at a non-existent row. This is a known forward-reference gap and must be documented in the Phase E plan. Application layer must block `subject_type = 'output'` inserts until Phase E completes.

---

## Migration Order

```
[already applied]
Phase A: 001, 002
Phase B: 003, 004, 005, 006
Phase C: 007, 008, 009, 010

[Phase D — three new tables]

011_governance_layer.sql
  └── CREATE TABLE public.decisions
        depends on: organizations, tasks (Phase C)
  └── CREATE TABLE public.approvals
        depends on: organizations, departments, users, decisions (Phase D)
  └── CREATE TABLE public.blockers
        depends on: organizations, departments, users, tasks, work_packets (Phase C)
  └── enable RLS deny-by-default on all three
  └── attach set_updated_at() trigger to all three
  └── no RLS policies yet

012_phase_d_grants.sql
  └── GRANT SELECT, INSERT, UPDATE on decisions, approvals, blockers to authenticated
  └── REVOKE DELETE on all three from authenticated

013_phase_d_rls_policies.sql
  └── CREATE policies for decisions (SELECT, INSERT, UPDATE)
  └── CREATE policies for approvals (SELECT, INSERT, UPDATE)
  └── CREATE policies for blockers (SELECT, INSERT, UPDATE)
```

**Creation order within `011`:**

1. `decisions` must come before `approvals` because `approvals.subject_type = 'decision'` references it at the application layer (no FK, but logical dependency).
2. `blockers` has no dependency on `decisions` or `approvals`; either order after `decisions` is safe.

---

## Dependency Graph

```
organizations ◄──── approvals.organization_id
                    approvals.department_id ────► departments
                    approvals.requested_by_user_id ──► users
                    approvals.approver_user_id ──► users
                    approvals.subject_id ──► tasks (polymorphic)
                                        ──► work_packets (polymorphic)
                                        ──► decisions (polymorphic)
                                        ──► outputs (Phase E, forward ref)

organizations ◄──── decisions.organization_id
                    decisions.task_id ────────────► tasks
                    decisions.decided_by_user_id ─► users (nullable)

organizations ◄──── blockers.organization_id
                    blockers.department_id ───────► departments
                    blockers.reported_by_user_id ─► users
                    blockers.assigned_to_user_id ─► users (nullable)
                    blockers.blocked_entity_id ──► tasks (polymorphic)
                                               ──► work_packets (polymorphic)

tasks ◄─ decisions (task_id, required)
tasks ◄─ approvals (subject_id when subject_type = 'task', polymorphic)
tasks ◄─ blockers (blocked_entity_id when blocked_entity_type = 'task', polymorphic)

work_packets ◄─ approvals (subject_id when subject_type = 'work_packet', polymorphic)
work_packets ◄─ blockers (blocked_entity_id when blocked_entity_type = 'work_packet', polymorphic)
```

---

## Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | **`approvals.subject_id` cross-table polymorphism** — the same column must point at `tasks`, `work_packets`, `decisions`, or `outputs`. No DB-level FK enforces co-tenancy on the target row | Medium | RLS `with check` uses branched EXISTS sub-selects per `subject_type`. Application layer enforces `outputs` until Phase E. |
| 2 | **`blockers.blocked_entity_type` excludes `project`** — `system-entities.md` §13 lists project-level blockers as valid but Phase D limits to `task` and `work_packet` | Low | `project` is added to the check constraint in Phase E or a follow-on migration when the `outputs`/knowledge layer tables stabilize. Document as intentional deferral. |
| 3 | **`decisions` has no `department_id` column** — department scope for RLS must be derived via `task_id → tasks.department_id`. This requires a JOIN in RLS policy `using` clauses | Medium | Acceptable pattern; use `exists (select 1 from public.tasks t where t.id = task_id and t.department_id = private.current_department_id())` in SELECT/INSERT policies. Performance is covered by the `tasks_organization_department_status_idx` index. |
| 4 | **`approvals.expires_at` is not enforced by the DB** — expiry requires a background job or Supabase pg_cron rule to transition `pending` → `expired` | High (operationally) | Functional gap until a scheduled job exists. Application layer must check `expires_at < now()` on every approval read and surface the expired state. Phase D SQL is correct; operational enforcement is a runtime concern. |
| 5 | **`won_t_fix` override requires an Approval** — `approval-rules.md` states overriding a `won_t_fix` blocker requires approval, but this cannot be enforced by RLS (no transition-state check) | Medium | Application layer must create an `approvals` row before allowing a `won_t_fix` status change. Document as invariant in Phase D RLS plan. |
| 6 | **`decisions.status` transitions** — RLS can gate who can update but cannot enforce which transitions are legal (e.g. `proposed → approved` directly without going through `pending_approval`) | Medium | Application layer enforces valid state machine. RLS enforces who (role/department), not which direction. |
| 7 | **Forward reference to Phase E `outputs`** — `approvals.subject_type` check constraint includes `'output'` but no FK exists | Low | Application layer blocks `subject_type = 'output'` inserts until Phase E. Constraint future-proofs the check without requiring a migration change in Phase E. |
| 8 | **No `approvals` timeout enforcement** — if the expiry job fails, `pending` approvals block subject entities indefinitely | High (operational) | Monitor via `approvals_expires_at_idx`. Implement expiry notification in Phase D operational runbook. |
| 9 | **`approvals` has no `deleted_at`** — status `withdrawn` is the soft-cancel; no physical removal path for authenticated users | Low | Intentional. Governance artifacts must be retained. Hard delete is service-role-only and requires explicit justification. |
| 10 | **`decisions` derived department scope is heavier than direct FK** — each RLS read/insert policy fires an EXISTS subquery through `tasks` | Low (performance) | Covered by FK index on `decisions.task_id` and the composite index on `tasks.organization_id, department_id`. Acceptable at current scale. |
