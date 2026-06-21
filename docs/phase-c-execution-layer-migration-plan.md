# Phase C Execution Layer Migration Plan

Data model design for the AI Command Center **Execution Layer** — the four high-churn operational tables that capture every piece of real work.

> **Canonical entities:** [system-entities.md](system-entities.md) §1 Request · §4 Task · §5 Work Packet · §12 Execution Log  
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md) §3 Execution Layer  
> **Work Packet fields:** [work-packet-template.md](work-packet-template.md)  
> **Approval gates:** [approval-rules.md](approval-rules.md)  
> **Department routing:** [department-map.md](department-map.md)

This document is **planning only**. No SQL, migrations, or Supabase commands are included.

Phase C depends on all Phase A (`001`, `002`) and Phase B (`003`, `004`, `005`, `006`) migrations having been applied successfully.

---

## Relationship to Existing Tables

Phase C rows connect upward into the Registry and System layers established in Phases A and B.

| Phase C table | Connects to | Via |
|---------------|-------------|-----|
| `requests` | `organizations` | `organization_id` |
| `requests` | `users` | `submitted_by_user_id` (nullable — automation/webhook requests have no user) |
| `requests` | `departments` | `routed_department_id` (nullable — set at triage) |
| `requests` | `projects` | `project_id` (nullable — may scope to existing project) |
| `work_packets` | `organizations` | `organization_id` |
| `work_packets` | `departments` | `department_id` (required — the department that owns and executes this packet) |
| `work_packets` | `users` | `author_user_id` (the person or agent who authored the packet) |
| `tasks` | `organizations` | `organization_id` |
| `tasks` | `projects` | `project_id` (required) |
| `tasks` | `departments` | `department_id` (required) |
| `tasks` | `users` | `assigned_to_user_id` (nullable — may be unassigned or agent) |
| `tasks` | `users` | `created_by` (required) |
| `tasks` | `requests` | `request_id` (nullable — some tasks are created directly) |
| `tasks` | `work_packets` | `work_packet_id` (nullable — task may precede or exist without a packet) |
| `tasks` | `workflows` | `workflow_id` (nullable — task may run outside a workflow) |
| `tasks` | `tool_profiles` | `tool_profile_id` (nullable — inherits from department default if absent) |
| `execution_logs` | `organizations` | `organization_id` |
| `execution_logs` | `requests` | polymorphic via `context_type='request'` + `context_id` |
| `execution_logs` | `tasks` | polymorphic via `context_type='task'` + `context_id` |
| `execution_logs` | `workflows` | polymorphic via `context_type='workflow'` + `context_id` |

### Key design notes

- **`work_packets` carries a direct `department_id` FK** to `departments`. This makes `work_packets` a first-class department-owned entity rather than inheriting ownership indirectly through `parent_id`. It has no direct FK to `requests` or `tasks` at the table level; those connections use a polymorphic `parent_type` + `parent_id` pair. Application layer ensures the parent row belongs to the same org and that `department_id` is consistent with the parent's owning department.
- **`tasks` references `work_packets` via `work_packet_id`** (standard FK, nullable), complementing the reverse polymorphic reference from `work_packets.parent_id`. Both directions coexist; the FK from `tasks` is the structural one and is used for RLS and query joins.
- **`execution_logs` is append-only.** No UPDATE or DELETE access is granted from the authenticated client path. The `status` field (`recorded` → `flagged` → `reviewed` → `corrected`) is the only mutable surface, and only for platform admin use.

---

## Execution Flow

The canonical flow from inbound intent to audit record:

```text
[external trigger]
        │
        ▼
 requests (received)
        │ triage: assign routed_department_id
        ▼
 requests (triaged)
        │ create work specification
        ▼
 work_packets (draft)
        │ author completes template; optionally requires approval
        ▼
 work_packets (ready / pending_approval → ready)
        │ decompose into tasks
        ▼
 tasks (backlog → ready → in_progress)
        │ agent or human executes; tool calls logged
        ▼
 execution_logs (tool_call / state_change / note / error)
        │
        ▼
 tasks (in_review → done)
        │
        ▼
 work_packets (accepted)
        │
        ▼
 requests (completed)
```

Variations:
- A **Request** may spawn tasks directly without a Work Packet when scope is narrow.
- A **Task** may be created directly on a project without an originating request (internal/planned work).
- A **Workflow** instance drives task sequencing automatically; execution logs are emitted per step.
- Work Packet approval gates insert a `pending_approval` pause before `in_execution`.

---

## Approval Interaction

Approval rows (Phase D table, not yet created) gate work at two Phase C surfaces:

### Work Packet gate (Category B — conditional)

| Trigger | Condition | Effect on `work_packets` |
|---------|-----------|--------------------------|
| `approval_required_before_start = true` | Set by author per [approval-rules.md](approval-rules.md) | Status must stay `pending_approval` until an approval row with `status = 'approved'` exists |
| Budget constraint exceeded | `constraints.budget_ceiling` breached | Same gate; approver role is department lead |
| Tool outside default profile | Tool not in `tool_profiles.allowed_tools` | Platform lead approval required before task execution |

### Task-level gate (Category A — always required)

| Trigger | Effect on `tasks` |
|---------|-------------------|
| External email send | Task remains `in_review` until approved |
| Production deploy, protected branch commit | Task blocked |
| Destructive shell command | Task blocked |
| Webhook to production target | Task blocked |

### Execution Log requirement

Every approval request, grant, and denial must produce an `execution_logs` row with `event_type = 'approval_action'` and `context_type = 'task'` or `'request'`. This is application-layer logic — no FK from `execution_logs` to `approvals` exists yet, but `metadata` jsonb can carry the approval reference until Phase D FKs are added.

---

## 1. `requests`

### Purpose

The primary intake row for all inbound intent — human, automation, webhook, or scheduled job. Every piece of work in the Command Center traces to a request or a direct project task. Maps to [system-entities.md](system-entities.md) §1 Request.

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id` ON DELETE RESTRICT |
| `source` | `text` | NOT NULL | CHECK: `human`, `automation`, `webhook`, `scheduled_job` |
| `intent` | `text` | NOT NULL | Short statement; CHECK `length(trim(intent)) > 0` |
| `submitted_at` | `timestamptz` | NOT NULL | Default `now()`; not updated after insert |
| `submitted_by_user_id` | `uuid` | NULL | FK → `users.id` ON DELETE SET NULL; null for automation/webhook |
| `routed_department_id` | `uuid` | NULL | FK → `departments.id` ON DELETE SET NULL; null until triaged |
| `project_id` | `uuid` | NULL | FK → `projects.id` ON DELETE SET NULL; optional scope anchor |
| `metadata` | `jsonb` | NOT NULL | DEFAULT `'{}'`; stores source-specific context (headers, payload, etc.) |
| `status` | `text` | NOT NULL | CHECK: `received`, `triaged`, `in_progress`, `completed`, `rejected`, `cancelled` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by `set_updated_at()` trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete |

### Foreign Keys

| Column | References | ON DELETE |
|--------|-----------|-----------|
| `organization_id` | `public.organizations(id)` | RESTRICT |
| `submitted_by_user_id` | `public.users(id)` | SET NULL |
| `routed_department_id` | `public.departments(id)` | SET NULL |
| `project_id` | `public.projects(id)` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `requests_organization_status_idx` | `(organization_id, status)` | Primary filter for the request queue |
| `requests_organization_source_idx` | `(organization_id, source)` | Filter by intake channel |
| `requests_routed_department_id_idx` | `(routed_department_id)` | Department inbox queries |
| `requests_project_id_idx` | `(project_id)` | Reverse-lookup from project |
| `requests_submitted_by_user_id_idx` | `(submitted_by_user_id)` | User's own submissions |
| `requests_organization_submitted_at_idx` | `(organization_id, submitted_at DESC)` | Time-ordered intake queue |

### Status Values

`received` → `triaged` → `in_progress` → `completed` / `rejected` / `cancelled`

### Ownership Rules

- **Insert:** Any authenticated org member who can submit work. Operations department or platform admin triages.
- **Update:** The routed department and org admin update `status` and `routed_department_id`. Submitter may cancel their own request.
- **Triage:** Only `org_admin`, `department_lead`, or members of the routed department may advance status past `received`.

### RLS Considerations

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | All org members | Own org; `deleted_at is null`. Operations/routed department reads all; submitter reads own. Two policies needed. |
| INSERT | All active org members | Own org; `organization_id` and `submitted_by_user_id` pinned. Source validation left to app layer. |
| UPDATE | Routed department (lead/member), org admin | Own org; own department or org admin; `deleted_at is null` |
| DELETE | None | Soft-delete only via UPDATE |

### Initial Seed Requirements

None. Requests are runtime data, not bootstrap data.

---

## 2. `work_packets`

### Purpose

Structured work specification and handoff artifact. Captures objective, scope, acceptance criteria, and execution constraints for a task or project slice. Maps to [system-entities.md](system-entities.md) §5 Work Packet and [work-packet-template.md](work-packet-template.md).

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id` ON DELETE RESTRICT |
| `title` | `text` | NOT NULL | CHECK `length(trim(title)) > 0` |
| `objective` | `text` | NOT NULL | CHECK `length(trim(objective)) > 0` |
| `scope` | `jsonb` | NOT NULL | DEFAULT `'{"in":[],"out":[]}'`; must be object; CHECK `jsonb_typeof(scope) = 'object'` |
| `acceptance_criteria` | `jsonb` | NOT NULL | DEFAULT `'[]'`; must be array; CHECK `jsonb_typeof(acceptance_criteria) = 'array'` |
| `department_id` | `uuid` | NOT NULL | FK → `departments.id` ON DELETE RESTRICT; the department that owns and executes this packet |
| `parent_type` | `text` | NOT NULL | CHECK: `task`, `project` |
| `parent_id` | `uuid` | NOT NULL | Polymorphic FK: points to `tasks.id` or `projects.id`; org co-tenancy and department consistency enforced by application layer |
| `priority` | `text` | NOT NULL | DEFAULT `normal`; CHECK: `low`, `normal`, `high`, `critical` |
| `constraints` | `jsonb` | NOT NULL | DEFAULT `'{}'`; must be object; CHECK `jsonb_typeof(constraints) = 'object'` |
| `approval_required_before_start` | `boolean` | NOT NULL | DEFAULT `false` |
| `author_user_id` | `uuid` | NOT NULL | FK → `users.id` ON DELETE RESTRICT |
| `status` | `text` | NOT NULL | CHECK: `draft`, `ready`, `pending_approval`, `in_execution`, `accepted`, `superseded`, `cancelled` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; `set_updated_at()` trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete |

### Foreign Keys

| Column | References | ON DELETE |
|--------|-----------|-----------|
| `organization_id` | `public.organizations(id)` | RESTRICT |
| `department_id` | `public.departments(id)` | RESTRICT |
| `author_user_id` | `public.users(id)` | RESTRICT |

`parent_id` is **intentionally not a DB-level FK**. Because it is polymorphic (points to either `tasks` or `projects`), referential integrity is enforced by the application layer. A check constraint validates `parent_type` values; a Postgres `constraint trigger` could be added in a future hardening migration. Application layer must also verify that `department_id` matches the parent row's owning department.

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `work_packets_organization_status_idx` | `(organization_id, status)` | Org-wide queue and dashboard queries |
| `work_packets_organization_department_status_idx` | `(organization_id, department_id, status)` | Department work queue (primary RLS query) |
| `work_packets_organization_parent_idx` | `(organization_id, parent_type, parent_id)` | Reverse-lookup from task or project |
| `work_packets_author_user_id_idx` | `(author_user_id)` | Author's packets |
| `work_packets_approval_required_idx` | `(organization_id, department_id, approval_required_before_start)` WHERE `approval_required_before_start = true` | Gate monitoring per department |
| `work_packets_organization_created_at_idx` | `(organization_id, created_at DESC)` | Time-ordered queue |

### Status Values

`draft` → `ready` / `pending_approval` → `in_execution` → `accepted` / `superseded` / `cancelled`

### Ownership Rules

- **Department** (`department_id`) is explicit and immutable after insert. It determines routing, auditing, and RLS scope directly — no join through `parent_id` is needed.
- **Author** (`author_user_id`) is set at creation and immutable thereafter; enforced by `author_user_id` pinning in the INSERT policy.
- Application layer must validate that `department_id` matches the owning department of the parent task or project at insert time.
- Org admin and department leads of the owning department may update any mutable field; department members may update `status`, `scope`, and `acceptance_criteria` on their own department's packets.

### RLS Considerations

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | Own department members (lead/member/agent); org admin | `department_id = current_department_id()` or `org_admin`; `deleted_at is null` |
| INSERT | Org admin, department lead, department member (own dept) | `organization_id` pinned; `department_id` pinned to caller's dept (lead/member) or any dept (admin); `author_user_id` pinned |
| UPDATE | Org admin, department lead (own dept) | `department_id = current_department_id()` or `org_admin`; `approval_required_before_start` gate application-enforced |
| DELETE | None | Soft-delete only via UPDATE |

`department_id` is now a first-class RLS anchor for `work_packets`, identical in pattern to `tasks.department_id` and `workflows.department_id`. The `007_rls_phase_c.sql` migration can use `private.current_department_id()` directly without any polymorphic subquery.

### Initial Seed Requirements

None.

---

## 3. `tasks`

### Purpose

The atomic unit of executable work. The central table of the Execution Layer — almost every other table references a task or is referenced by one. Maps to [system-entities.md](system-entities.md) §4 Task.

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id` ON DELETE RESTRICT |
| `title` | `text` | NOT NULL | CHECK `length(trim(title)) > 0` |
| `project_id` | `uuid` | NOT NULL | FK → `projects.id` ON DELETE RESTRICT |
| `department_id` | `uuid` | NOT NULL | FK → `departments.id` ON DELETE RESTRICT |
| `request_id` | `uuid` | NULL | FK → `requests.id` ON DELETE SET NULL |
| `work_packet_id` | `uuid` | NULL | FK → `work_packets.id` ON DELETE SET NULL |
| `workflow_id` | `uuid` | NULL | FK → `workflows.id` ON DELETE SET NULL |
| `tool_profile_id` | `uuid` | NULL | FK → `tool_profiles.id` ON DELETE SET NULL; inherits department default if null |
| `priority` | `text` | NOT NULL | DEFAULT `normal`; CHECK: `low`, `normal`, `high`, `critical` |
| `assigned_to_user_id` | `uuid` | NULL | FK → `users.id` ON DELETE SET NULL; null for unassigned or pure-agent tasks |
| `created_by` | `uuid` | NOT NULL | FK → `users.id` ON DELETE RESTRICT |
| `status` | `text` | NOT NULL | DEFAULT `backlog`; CHECK: `backlog`, `ready`, `in_progress`, `blocked`, `in_review`, `done`, `cancelled` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; `set_updated_at()` trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete |

### Foreign Keys

| Column | References | ON DELETE |
|--------|-----------|-----------|
| `organization_id` | `public.organizations(id)` | RESTRICT |
| `project_id` | `public.projects(id)` | RESTRICT |
| `department_id` | `public.departments(id)` | RESTRICT |
| `request_id` | `public.requests(id)` | SET NULL |
| `work_packet_id` | `public.work_packets(id)` | SET NULL |
| `workflow_id` | `public.workflows(id)` | SET NULL |
| `tool_profile_id` | `public.tool_profiles(id)` | SET NULL |
| `assigned_to_user_id` | `public.users(id)` | SET NULL |
| `created_by` | `public.users(id)` | RESTRICT |

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `tasks_organization_department_status_idx` | `(organization_id, department_id, status)` | Department task queue (primary RLS query) |
| `tasks_organization_project_id_idx` | `(organization_id, project_id)` | Project task list |
| `tasks_request_id_idx` | `(request_id)` WHERE `request_id IS NOT NULL` | Request → task reverse-lookup |
| `tasks_work_packet_id_idx` | `(work_packet_id)` WHERE `work_packet_id IS NOT NULL` | Work packet → task reverse-lookup |
| `tasks_workflow_id_idx` | `(workflow_id)` WHERE `workflow_id IS NOT NULL` | Workflow orchestration queries |
| `tasks_assigned_to_user_id_idx` | `(assigned_to_user_id)` WHERE `assigned_to_user_id IS NOT NULL` | User's task inbox |
| `tasks_created_by_idx` | `(created_by)` | Creator queries |
| `tasks_organization_status_idx` | `(organization_id, status)` | Org-wide status dashboards |
| `tasks_organization_created_at_idx` | `(organization_id, created_at DESC)` | Time-ordered task feed |

### Status Values

`backlog` → `ready` → `in_progress` → `blocked` / `in_review` → `done` / `cancelled`

`blocked` is a lateral state; a task returns to `in_progress` or `ready` when its Blocker is resolved.

### Ownership Rules

- Department of `department_id` owns the task.
- `created_by` is pinned at insert; immutable.
- `assigned_to_user_id` may change as work moves through the department.
- Org admin and department leads of the owning department may update all fields; department members may update `status`, `assigned_to_user_id`, and `priority` on tasks in their department.

### RLS Considerations

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | Department lead/member/agent (own dept); org admin | `department_id = current_department_id()` or `org_admin` |
| INSERT | Org admin, department lead, department member (own dept) | `organization_id`, `created_by`, `department_id` pinned |
| UPDATE | Org admin, department lead (own dept), department member (own dept, limited fields) | `department_id` scope; `created_by` immutable via app layer |
| DELETE | None | Soft-delete only |

**Agent-specific RLS:** Agent users should read only tasks where `assigned_to_user_id = current_user_id()`. This is a narrower policy branch within the department scope. Implement as a separate agent-scoped SELECT policy alongside the department policy.

### Initial Seed Requirements

None. Tasks are created at runtime.

---

## 4. `execution_logs`

### Purpose

Append-only action audit trail capturing every material event during a request, task, or workflow execution. Maps to [system-entities.md](system-entities.md) §12 Execution Log.

This is the **only table in Phase C that must not allow UPDATE or DELETE from the client path**. Corrections are made by inserting a new row with `status = 'corrected'` that references the original, not by mutating existing rows.

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id` ON DELETE RESTRICT |
| `event_type` | `text` | NOT NULL | CHECK: `tool_call`, `state_change`, `error`, `note`, `approval_action` |
| `actor` | `text` | NOT NULL | Free-text: user id, agent id, or `system`; CHECK `length(trim(actor)) > 0` |
| `occurred_at` | `timestamptz` | NOT NULL | Default `now()`; represents the event time, not the insert time |
| `summary` | `text` | NOT NULL | Human-readable description of the event; CHECK `length(trim(summary)) > 0` |
| `context_type` | `text` | NOT NULL | CHECK: `request`, `task`, `workflow` |
| `context_id` | `uuid` | NOT NULL | Polymorphic FK: points to `requests.id`, `tasks.id`, or `workflows.id`; not DB-level FK due to polymorphism |
| `metadata` | `jsonb` | NOT NULL | DEFAULT `'{}'`; must be object; CHECK `jsonb_typeof(metadata) = 'object'` |
| `status` | `text` | NOT NULL | DEFAULT `recorded`; CHECK: `recorded`, `flagged`, `reviewed`, `corrected` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()`; immutable after insert |

### Design Notes

- **No `updated_at` column.** `execution_logs` is append-only; no row is ever updated. The `set_updated_at()` trigger must not be attached.
- **No `deleted_at` column.** Soft-delete is not applicable. Rows are permanent. Corrections produce new rows.
- **`context_id` is polymorphic.** Like `work_packets.parent_id`, this is not a DB-level FK. An application-layer check ensures the referenced row exists in the same org.
- **No `created_by` FK column.** `actor` is free text because some events are emitted by agents (not `public.users` rows), the `system` itself, or external automations. If a user ID is the actor, it is stored as text and cross-referenced by the application layer.

### Foreign Keys

| Column | References | ON DELETE |
|--------|-----------|-----------|
| `organization_id` | `public.organizations(id)` | RESTRICT |

All other relationships are polymorphic or free-text, enforced at application layer.

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `execution_logs_organization_context_idx` | `(organization_id, context_type, context_id)` | Primary lookup: all logs for a given task/request/workflow |
| `execution_logs_organization_event_type_idx` | `(organization_id, event_type)` | Filter by event category (e.g., all `approval_action` events) |
| `execution_logs_organization_occurred_at_idx` | `(organization_id, occurred_at DESC)` | Time-ordered audit feed |
| `execution_logs_organization_status_idx` | `(organization_id, status)` WHERE `status != 'recorded'` | Flag and review queue |
| `execution_logs_actor_idx` | `(actor)` | Agent attribution queries |

All indexes should be non-unique (append-only table; no uniqueness constraints needed).

### Status Values

`recorded` (immutable unless flagged) → `flagged` → `reviewed` → `corrected`

Note: `corrected` rows are NEW rows, not mutations of the original. The correction row references the original via `metadata.corrects_log_id`.

### Ownership Rules

- **INSERT only** from the client path. Any authenticated member of the context entity's department may insert logs.
- **No UPDATE, no DELETE** from the client path. Status changes (`flagged` → `reviewed`) are service-role operations or reserved for future platform admin policies in a later migration.
- Org admin has read-all access within their org.

### RLS Considerations

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | Org admin | All rows in org |
| SELECT | Department lead/member | Rows where `context_type='task'` and `context_id` in their department's tasks (requires subquery); or `context_type='request'` where they are the routed department |
| INSERT | Any active org member | `organization_id` pinned; `context_id` co-tenancy enforced application-side |
| UPDATE | None from client | `status` changes are service-role only |
| DELETE | None | Rows are permanent |

**Note:** The SELECT subquery for department-scoped log reads is complex because `context_id` is polymorphic. The initial `007_rls_phase_c.sql` may implement a simplified policy (org admin reads all; any org member reads logs for tasks in their department via a join). This is flagged as a known risk.

### Initial Seed Requirements

None. Execution logs are generated at runtime.

---

## Migration Order

Phase C tables must be created in this exact sequence to satisfy FK dependencies:

```
1. requests
   └─ depends on: organizations, users, departments, projects

2. work_packets
   └─ depends on: organizations, departments, users
   └─ department_id is a required FK to departments
   └─ parent_id is polymorphic; no DB-level FK to tasks or projects

3. tasks
   └─ depends on: organizations, projects, departments, users,
                  requests (new), work_packets (new), workflows, tool_profiles

4. execution_logs
   └─ depends on: organizations
   └─ context_id is polymorphic; no DB-level FK to requests/tasks/workflows

5. [updated_at triggers]
   └─ requests, work_packets, tasks each get set_updated_at()
   └─ execution_logs does NOT get the trigger (append-only)

6. RLS enabled (deny-by-default) on all four tables immediately

7. Table grants: SELECT + INSERT + UPDATE for requests, work_packets, tasks
                 SELECT + INSERT only for execution_logs (no UPDATE/DELETE grant)

8. Phase C RLS policies (separate migration: 007_rls_phase_c.sql)
```

---

## Dependency Graph

```text
organizations
│
├── users
│   └── requests.submitted_by_user_id (nullable)
│   └── work_packets.author_user_id
│   └── tasks.assigned_to_user_id (nullable)
│   └── tasks.created_by
│
├── departments
│   └── requests.routed_department_id (nullable)
│   └── work_packets.department_id (required)
│   └── tasks.department_id (required)
│
├── projects
│   └── requests.project_id (nullable)
│   └── tasks.project_id (required)
│
├── tool_profiles
│   └── tasks.tool_profile_id (nullable)
│
├── workflows
│   └── tasks.workflow_id (nullable)
│
├── requests (new)      ←── tasks.request_id (nullable)
│
├── work_packets (new)  ←── tasks.work_packet_id (nullable)
│                       ←── work_packets.parent_id (polymorphic, no FK)
│
└── tasks (new)         ←── execution_logs.context_id (polymorphic, no FK)
                        ←── work_packets.parent_id when parent_type='task'
```

### Polymorphic reference summary

| Table | Column | Targets |
|-------|--------|---------|
| `work_packets` | `parent_id` | `tasks.id` or `projects.id` |
| `execution_logs` | `context_id` | `requests.id`, `tasks.id`, or `workflows.id` |

Both are resolved by application logic. `parent_type` and `context_type` constrain the valid values; check constraints enforce the allowed string values.

---

## Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | **Polymorphic `parent_id` and `context_id` lack DB-level FK enforcement** | Medium | Application layer must validate org co-tenancy and row existence on every insert. A future constraint trigger migration can add DB-level enforcement without changing the column design. |
| 2 | **`work_packets.department_id` must stay consistent with the parent task or project** — DB constraints cannot enforce this cross-table relationship | Low | Application layer must validate that `department_id` matches the parent's owning department on every insert and on any update that changes `parent_id` or `department_id`. |
| 3 | **`execution_logs` SELECT for non-admin users requires a cross-table subquery** | Medium | Initial policy may allow org-members to read all logs in their org (loose) until a more targeted policy is tested. Must be flagged in the RLS plan for `007`. |
| 4 | **`tasks.tool_profile_id` is nullable** — an agent task with no profile has no tool boundary enforced at DB level | Low | Application layer must default to `departments.default_tool_profile_id` when `tool_profile_id` is null. Document this in the Phase C RLS plan. |
| 5 | **Circular reference potential**: `work_packets.parent_id` can point to a `tasks` row, and `tasks.work_packet_id` can point back to that work packet | Low | Postgres will not detect this application-level cycle. Application layer must prevent self-referential cycles when creating packets and tasks. |
| 6 | **`execution_logs` has no `updated_at` or `deleted_at`** — differs from all other Phase C tables | Low (intentional) | Must be documented clearly in the SQL migration so future developers do not add triggers or soft-delete patterns to this table. |
| 7 | **Approval gate enforcement is application-only** | High (gating) | Until Phase D `approvals` table exists, `work_packets.approval_required_before_start = true` cannot be DB-enforced. Application layer must block status transitions. The `007` RLS migration should explicitly not include approval-gating policies — those belong in `008` alongside the `approvals` table. |
| 8 | **`requests` submitter identity is optional** (`submitted_by_user_id` nullable) — webhook/automation requests have no user principal | Low | Accepted by design; RLS INSERT policy must not require a user ID for requests. `actor` in `execution_logs` handles attribution for non-user sources. |
| 9 | **Phase C RLS for `tasks` requires agent-specific policy** (narrower than department scope) | Medium | Agent users must have a separate SELECT policy limited to `assigned_to_user_id = current_user_id()`. Must be included in `007` design. |
| 10 | **`requests` has no `created_by` FK** — the source of a request is captured by `submitted_by_user_id` (nullable) and `source` (text). | Info | Intentional; different from other tables. The audit trail for request intake is `execution_logs`, not a `created_by` column. |

---

## Phase C vs Phase D Boundary

Phase C (this plan) creates the operational tables. Phase D (Governance Layer: `decisions`, `approvals`, `blockers`) builds the authorization and reasoning infrastructure on top of Phase C rows.

**Do not defer any Phase C table** to Phase D. The four tables above are prerequisites for approval gates (`work_packets` must exist before an `approvals` row can reference `subject_type = 'work_packet'`), decisions (`tasks` must exist before `decisions.task_id` is valid), and blockers (`tasks` and `work_packets` must exist before `blockers.blocked_entity_id` targets them).
