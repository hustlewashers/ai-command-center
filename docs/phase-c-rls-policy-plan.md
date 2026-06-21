# Phase C RLS Policy Plan

Row Level Security policy design and table grant requirements for the **AI Command Center Execution Layer** tables.

> **Phase C table definitions:** [phase-c-execution-layer-migration-plan.md](phase-c-execution-layer-migration-plan.md)  
> **Phase A/B RLS precedent:** [005-rls-policy-plan.md](005-rls-policy-plan.md)  
> **Approval gates:** [approval-rules.md](approval-rules.md)  
> **Department routing:** [department-map.md](department-map.md)

This document is **planning only**. No SQL, migrations, or Supabase commands are included.

Scope: the four tables created in `supabase/migrations/007_execution_layer.sql`:
`requests`, `work_packets`, `tasks`, `execution_logs`.

All `private.*` helper functions required for policy evaluation were established in `005_rls_policies.sql`. No new helper functions are required for Phase C.

---

## 1. Security Goals

These goals extend those in [005-rls-policy-plan.md](005-rls-policy-plan.md) §1 with Phase C-specific concerns.

| Goal | Rationale |
|------|-----------|
| **Org isolation** | Every Phase C row carries `organization_id`. No row may be read by or written from outside the caller's org. |
| **Department-scoped writes** | `work_packets` and `tasks` are fully department-owned. Writes are restricted to users and agents in the owning department, plus org admins. |
| **Request open-entry, routed-exit** | `requests` may be inserted by any authenticated org member (automation, webhook, human). Reads are org-scoped for most roles; triage roles read all. Status updates narrow to routed department and org admin after triage. |
| **Append-only `execution_logs`** | No UPDATE or DELETE on `execution_logs` from the authenticated path. Only INSERT is allowed. No authenticated user writes `status` directly — that is a service-role-only operation. |
| **Agent narrowing** | Agent users read only tasks assigned to them. They insert `execution_logs` for their assigned context but cannot read or modify other agents' or humans' work packets, tasks, or requests. |
| **Actor pinning** | `execution_logs.actor` must be set to the caller's user id or a trusted automation identifier. Application layer enforces this; RLS cannot pin a free-text field. |
| **No DELETE privilege** | No authenticated role receives table-level DELETE on any Phase C table. Hard-delete is blocked at the privilege layer. Soft-delete is expressed as an UPDATE to `deleted_at`. |
| **Soft-delete filtering** | All SELECT policies on `requests`, `work_packets`, and `tasks` include `deleted_at is null`. `execution_logs` has no `deleted_at` column. |
| **No approval gate in RLS** | `work_packets.approval_required_before_start = true` is application-enforced. Phase C RLS does not attempt to block status transitions — that requires Phase D `approvals` rows. |

---

## 2. Role Model

The five schema roles from `001_foundation.sql` apply without modification. Phase C introduces role-specific behaviors for `agent` that did not appear in Phase A/B.

| Role | Phase C access summary |
|------|----------------------|
| `org_admin` | Full read/write on all four Phase C tables within org |
| `department_lead` | Full read/write on own department's `work_packets` and `tasks`; reads all `requests` in org; inserts own `requests`; inserts `execution_logs` for own department context |
| `department_member` | Same department scope as lead for reads and execution writes; cannot change `work_packets.department_id` after insert |
| `agent` | Reads only tasks where `assigned_to_user_id = current_user_id()`; reads `work_packets` linked to those tasks; reads `requests` linked to those tasks; inserts `execution_logs` for assigned tasks |
| `read_only` | Reads own department's `work_packets` and `tasks`, own submitted `requests`; no writes |

### Helper functions already available

All helpers live in the `private` schema, established in `005_rls_policies.sql`, and require no new functions:

| Function | Returns | Used for |
|----------|---------|----------|
| `private.current_user_id()` | `uuid` | Pinning `author_user_id`, `created_by`; agent task scope |
| `private.current_organization_id()` | `uuid` | Org isolation on every table |
| `private.current_department_id()` | `uuid` | Department-scoped reads/writes on `work_packets`, `tasks` |
| `private.current_role()` | `text` | Role branching |
| `private.is_org_admin()` | `boolean` | Admin shortcut for broad-access branches |

---

## 3. Organization Isolation Rules

Identical to [005-rls-policy-plan.md](005-rls-policy-plan.md) §3. Repeated here for completeness.

| Rule | Implementation |
|------|---------------|
| All reads are org-scoped | `organization_id = private.current_organization_id()` on every `using` clause |
| All inserts are org-pinned | `NEW.organization_id = private.current_organization_id()` on every `with check` clause |
| Soft-deleted rows hidden from reads | `deleted_at is null` on every SELECT `using` clause (`requests`, `work_packets`, `tasks`); not applicable to `execution_logs` |
| No cross-org FKs enforced by policy | FK targets (`departments`, `projects`, `requests`, `work_packets`) are verified by co-tenancy EXISTS sub-selects in `with check` clauses |

---

## 4. Department Scope Rules

| Table | Primary scope anchor | Scope strategy |
|-------|---------------------|----------------|
| `requests` | `routed_department_id` (nullable) | Org-wide read for all authenticated members; row-creation is open; status updates narrowed to routed department + admin |
| `work_packets` | `department_id` (NOT NULL) | Direct column match: `department_id = private.current_department_id()`; no subquery through `parent_id` needed |
| `tasks` | `department_id` (NOT NULL) | Same pattern as `work_packets`; agents further narrowed to `assigned_to_user_id` |
| `execution_logs` | `organization_id` only at SELECT | No `department_id` column; org-admin reads all; department members read via subquery to their tasks (simplified initial policy: org-wide read for active members) |

### Department scope precedence for Phase C

```text
org_admin
  → reads and writes all Phase C rows in org

department_lead
  → reads all requests in org (triage visibility)
  → reads and writes work_packets where department_id = own dept
  → reads and writes tasks where department_id = own dept
  → inserts execution_logs for own dept context

department_member
  → reads all requests in org (intake awareness)
  → reads and writes work_packets where department_id = own dept
  → reads and writes tasks where department_id = own dept
  → inserts execution_logs for own dept context

agent
  → reads only tasks where assigned_to_user_id = current_user_id()
  → reads work_packets linked to those tasks (via work_packet_id)
  → reads requests linked to those tasks (via request_id)
  → inserts execution_logs for assigned task context only
  → no write access to work_packets or requests

read_only
  → reads own dept work_packets and tasks
  → reads own submitted requests (submitted_by_user_id = current_user_id())
  → no writes
```

---

## 5. Table-by-Table RLS Policies

All policies target `to authenticated`. No policy targets `anon`. All policies use `private.*` helpers from `005`. Org isolation is assumed on every clause below without repeating the full expression.

---

### `requests`

`requests` has no `department_id` column. It starts life unrouted (`routed_department_id IS NULL`) and acquires a department at triage. RLS must accommodate both states.

| Operation | Policy name | Who | Condition |
|-----------|-------------|-----|-----------|
| SELECT | `requests_select_org_members` | All active org members | Own org; `deleted_at is null` |
| INSERT | `requests_insert_org_members` | All active org members | `organization_id` pinned; `submitted_by_user_id` must be null or the caller's own id; `status = 'received'` on new rows |
| UPDATE | `requests_update_triage_and_admin` | `org_admin`, `department_lead`, `department_member` of routed dept | Own org; `deleted_at is null`; non-admin callers restricted to rows where `routed_department_id = current_department_id()` or they are the submitter (`submitted_by_user_id = current_user_id()`) for cancellation only |
| DELETE | *(none)* | No one | Soft-delete via UPDATE `deleted_at` only |

**`submitted_by_user_id` pinning note:** Because automation and webhook requests have `submitted_by_user_id = null`, the INSERT policy cannot unconditionally require `submitted_by_user_id = current_user_id()`. Instead the `with check` clause must allow either `submitted_by_user_id is null` or `submitted_by_user_id = current_user_id()`. The application layer is responsible for setting the correct value based on source.

**Status gate note:** RLS can pin `status = 'received'` on INSERT via `with check` to prevent a caller from inserting a pre-triaged request. Triage advances status through UPDATE.

---

### `work_packets`

`work_packets.department_id` is NOT NULL, making this table cleanly department-scoped.

| Operation | Policy name | Who | Condition |
|-----------|-------------|-----|-----------|
| SELECT | `work_packets_select_dept_scope` | Own department members + org admin | `department_id = private.current_department_id()` or `org_admin`; `deleted_at is null` |
| INSERT | `work_packets_insert_dept_scope` | `org_admin`, `department_lead`, `department_member` | `organization_id` pinned; `department_id` pinned to caller's dept (non-admin) or any same-org dept (admin); `author_user_id = current_user_id()`; co-tenancy EXISTS check on `department_id` |
| UPDATE | `work_packets_update_dept_scope` | `org_admin`, `department_lead` (own dept) | Own org; `department_id = current_department_id()` or `org_admin`; `deleted_at is null`; `author_user_id` immutability and approval gate are application-enforced |
| DELETE | *(none)* | No one | Soft-delete only |

**`department_member` update note:** Department members may insert work packets but UPDATE is restricted to department leads and admins. This matches the plan's ownership rules ("department members may update `status`, `scope`, and `acceptance_criteria`") but since RLS cannot grant by column, the simplest correct rule is: lead/admin can UPDATE; members cannot. If member self-service updates are required, a second narrower UPDATE policy can be added in a follow-up migration.

**`parent_id` co-tenancy:** `with check` must verify the parent row (`tasks` or `projects`) exists in the same org. Since `parent_type` is constrained to `task` or `project`, the INSERT check uses an OR EXISTS across both target tables, filtering by `organization_id`. Application layer additionally validates `department_id` consistency with the parent's owning department.

---

### `tasks`

`tasks.department_id` is NOT NULL. Tasks have an additional agent-specific SELECT branch.

| Operation | Policy name | Who | Condition |
|-----------|-------------|-----|-----------|
| SELECT | `tasks_select_dept_scope` | `org_admin`, `department_lead`, `department_member`, `read_only` (own dept) | `department_id = private.current_department_id()` or `org_admin`; `deleted_at is null` |
| SELECT | `tasks_select_agent_assigned` | `agent` | `assigned_to_user_id = private.current_user_id()`; own org; `deleted_at is null` |
| INSERT | `tasks_insert_dept_scope` | `org_admin`, `department_lead`, `department_member` | `organization_id` pinned; `department_id` pinned to caller's dept (non-admin); `created_by = current_user_id()`; co-tenancy EXISTS on `project_id` and `department_id` |
| UPDATE | `tasks_update_dept_scope` | `org_admin`, `department_lead`, `department_member` (own dept) | Own org; `department_id = current_department_id()` or `org_admin`; `deleted_at is null` |
| DELETE | *(none)* | No one | Soft-delete only |

**Two SELECT policies on `tasks`:** Supabase evaluates permissive policies with OR, so a user matching either policy can SELECT. An org admin or department member in their own department satisfies the first policy. An agent satisfies the second. These are mutually exclusive by role design.

**FK co-tenancy in INSERT `with check`:**
- `project_id`: EXISTS in `public.projects` where `organization_id = current_organization_id()`.
- `department_id`: EXISTS in `public.departments` where `organization_id = current_organization_id()`.
- `request_id` (nullable): if not null, EXISTS in `public.requests` where `organization_id = current_organization_id()`.
- `work_packet_id` (nullable): if not null, EXISTS in `public.work_packets` where `organization_id = current_organization_id()` and `department_id = NEW.department_id`.
- `workflow_id`, `tool_profile_id` (nullable): if not null, EXISTS in respective table where `organization_id = current_organization_id()`.

All nullable FK co-tenancy checks use the pattern: `column is null or exists (...)`.

**`created_by` pinning:** `created_by = private.current_user_id()` in INSERT `with check`. Immutability after creation is application-enforced (RLS cannot distinguish which columns changed).

---

### `execution_logs`

`execution_logs` is append-only with no `department_id` column. The SELECT strategy is simplified for the initial migration.

| Operation | Policy name | Who | Condition |
|-----------|-------------|-----|-----------|
| SELECT | `execution_logs_select_org_members` | All active org members | Own org (simplified: all authenticated members read all logs in their org; no department subquery in initial policy) |
| INSERT | `execution_logs_insert_org_members` | All active org members | `organization_id` pinned; `context_id` co-tenancy application-enforced (not DB-level due to polymorphism) |
| UPDATE | *(none)* | No one | No update path from authenticated client |
| DELETE | *(none)* | No one | Rows are permanent |

**Simplified SELECT rationale:** Because `execution_logs.context_id` is polymorphic (pointing to `requests`, `tasks`, or `workflows`), a department-scoped SELECT policy requires a multi-branch EXISTS subquery that is expensive and complex. The initial policy grants org-wide read for all active members — acceptable for an internal-only system where all logs belong to the same organization's work. A narrowed, department-scoped policy can be introduced in a later migration once the context subquery pattern is tested.

**No UPDATE policy — important detail:** Since no UPDATE policy exists, any UPDATE attempt by an `authenticated` user will be silently rejected by RLS even if the table-level UPDATE grant exists (which it should not — see §8). This provides double defense for the append-only requirement.

**`actor` field — cannot be RLS-pinned:** `actor` is `text`, not a UUID FK. RLS cannot enforce its value. The application layer must set `actor` to `auth.uid()::text`, an agent identifier, or `'system'` based on the request context. This is documented as a known gap.

---

## 6. `created_by` / `actor` Pinning Rules

| Table | Field | Pinning method | Enforced by |
|-------|-------|---------------|-------------|
| `work_packets` | `author_user_id` | `with check`: `author_user_id = private.current_user_id()` | RLS INSERT policy |
| `tasks` | `created_by` | `with check`: `created_by = private.current_user_id()` | RLS INSERT policy |
| `requests` | `submitted_by_user_id` | Conditional: `submitted_by_user_id is null or submitted_by_user_id = private.current_user_id()` | RLS INSERT policy |
| `execution_logs` | `actor` | Not RLS-enforceable (free-text); must be `auth.uid()::text` or a trusted identifier | Application layer |

`author_user_id` and `created_by` immutability after insert is enforced by application layer, not by RLS (RLS cannot inspect which columns are changing in an UPDATE).

---

## 7. `execution_logs` Append-Only Rules

These rules reinforce the append-only design from `007_execution_layer.sql`:

| Rule | Enforcement layer |
|------|------------------|
| No UPDATE via client path | RLS: no UPDATE policy exists; even if table-level UPDATE grant were present, RLS would deny it |
| No DELETE via client path | Table-level privilege: no DELETE grant issued to `authenticated` on `execution_logs` |
| No `deleted_at` column | Schema: the column does not exist in `007`; cannot be set |
| No `updated_at` column | Schema: the column does not exist; `set_updated_at()` trigger not attached |
| Corrections create new rows | Application convention: new row carries `metadata.corrects_log_id` referencing the original |
| `status` values `flagged`/`reviewed` | Set via service role only; no client-path UPDATE policy exists |
| `context_id` co-tenancy | Application layer validates that the referenced `requests`, `tasks`, or `workflows` row belongs to the same org |

**Defense in depth:** Even if the table-level UPDATE grant were accidentally issued, the absence of any RLS UPDATE policy means the RLS engine would block all updates (Postgres returns zero rows, not an error). The correct defense is to issue no UPDATE grant at all, which §8 enforces.

---

## 8. Required Table Grants

A companion grants migration must be applied alongside the Phase C RLS policy migration. The pattern follows `006_table_grants.sql`.

### `schema public` usage

`authenticated` already has `USAGE` on `public` from `006`. No additional schema grant is needed.

### Per-table grants

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| `requests` | ✅ `authenticated` | ✅ `authenticated` | ✅ `authenticated` | ❌ revoke |
| `work_packets` | ✅ `authenticated` | ✅ `authenticated` | ✅ `authenticated` | ❌ revoke |
| `tasks` | ✅ `authenticated` | ✅ `authenticated` | ✅ `authenticated` | ❌ revoke |
| `execution_logs` | ✅ `authenticated` | ✅ `authenticated` | ❌ do not grant | ❌ revoke |

**`execution_logs` UPDATE must not be granted.** This is the principal difference from the other three tables. The revoke is defensive even though Supabase may not have granted UPDATE by default.

### Grant SQL intent (not implementation)

```text
grant select, insert, update on public.requests, public.work_packets, public.tasks
  to authenticated;

grant select, insert on public.execution_logs
  to authenticated;

revoke delete on public.requests, public.work_packets, public.tasks, public.execution_logs
  from authenticated;

revoke update on public.execution_logs
  from authenticated;
```

---

## 9. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | **`execution_logs.actor` cannot be RLS-pinned** — free-text field could be set to any value by the application | Medium | Application layer must enforce `actor = auth.uid()::text` for user-sourced events. Document in API layer. |
| 2 | **`execution_logs` SELECT is org-wide** (simplified initial policy) — department members can read all org logs, not just logs for their tasks | Low | Acceptable for initial internal deployment. Narrow to department-task subquery in a follow-up once the `tasks` RLS pattern is verified. |
| 3 | **`requests` UPDATE is open to all org members for their own rows** — a submitter can cancel any request they submitted regardless of triage state | Low | Acceptable; submitter cancellation is explicitly listed in approval rules. If triage locks are required, add a status-gate check to the UPDATE `using` clause. |
| 4 | **`work_packets.parent_id` co-tenancy** is application-enforced — a caller could theoretically INSERT a work_packet pointing to a project in a different org if application validation fails | Medium | RLS INSERT `with check` must include an EXISTS sub-select verifying the parent row's `organization_id`. Covers the failure case if application validation is missing. |
| 5 | **`tasks` INSERT co-tenancy on nullable FKs** adds multiple EXISTS sub-selects per INSERT | Low (performance) | Each sub-select is covered by FK indexes from `007`. Acceptable at current scale; revisit with load testing. |
| 6 | **Agent `assigned_to_user_id` NULL** — an agent user with no assigned task sees zero tasks under the agent-scoped policy | Low | Intentional; agents must have a task assignment before they can read it. Not a security gap, but document expected behavior. |
| 7 | **No `department_member` UPDATE on `work_packets`** — the initial policy restricts UPDATE to leads and admins | Low | Members can insert packets but cannot update them. If member-led status updates are needed immediately, add a narrow member UPDATE policy (e.g., only `status` changes on own-dept rows authored by self). |
| 8 | **Phase D approval gating is absent** — `approval_required_before_start = true` cannot block execution at DB level until Phase D `approvals` table exists | High (gating) | Application layer must block `work_packets.status → in_execution` when the flag is set. RLS does not help here; this remains fully application-enforced until `008`. |
| 9 | **`requests` INSERT `status` pin** — pinning `status = 'received'` in `with check` prevents inserting a pre-triaged request, but agents and automations submitting batch requests may need a broader initial status range | Low | Review with first real automation integration; adjust the check if `status = 'triaged'` at insert is a valid case. |
| 10 | **Soft-deleted `requests` not readable by org_admin for audit** — the initial SELECT policy includes `deleted_at is null` for all roles | Low | Add an org-admin audit SELECT policy (without `deleted_at` filter) in the Phase C grants migration or a follow-on `009`. |

---

## 10. Migration Order

Phase C RLS and grants must follow the Phase C table creation:

```
[already applied]
007_execution_layer.sql
  └── creates requests, work_packets, tasks, execution_logs
  └── RLS enabled (deny-by-default), no policies, no grants

[next: two new migrations]

008_phase_c_grants.sql
  └── grants SELECT+INSERT+UPDATE on requests, work_packets, tasks to authenticated
  └── grants SELECT+INSERT only on execution_logs to authenticated
  └── revokes DELETE on all four tables from authenticated
  └── revokes UPDATE on execution_logs from authenticated
  └── does NOT create policies (grants have no row-level effect without policies)

009_phase_c_rls_policies.sql
  └── creates policies for requests (3 policies)
  └── creates policies for work_packets (3 policies)
  └── creates policies for tasks (4 policies: dept scope, agent scope, insert, update)
  └── creates policies for execution_logs (1 SELECT + 1 INSERT)
  └── does NOT modify 005 or 006
  └── does NOT create Phase D tables or policies
```

**Ordering constraint:** Grants (`008`) should be applied before or alongside policies (`009`). A policy without a grant means the operation is denied at the privilege layer before RLS is even evaluated; the combination is fully inert until both are present.

---

## Policy Summary Reference

| Table | SELECT | INSERT | UPDATE |
|-------|--------|--------|--------|
| `requests` | All org members (org-wide) | All org members; `submitted_by_user_id` null or self | Routed dept + submitter (cancel) + org admin |
| `work_packets` | Own dept + org admin | Own dept members + org admin; `author_user_id` pinned | Dept lead + org admin only |
| `tasks` | Own dept + org admin; agents: assigned only | Own dept members + org admin; `created_by` pinned | Own dept members + org admin |
| `execution_logs` | All org members (simplified) | All org members; no status or actor pin via RLS | *(none — append-only)* |

All SELECT policies: `deleted_at is null` (except `execution_logs` — no such column).
All INSERT policies: `organization_id` pinned.
No DELETE via client path on any table.
No UPDATE on `execution_logs` via client path.
