# RLS Policy Plan — Phase 005

Row Level Security policy design for the **AI Command Center** Supabase runtime.

> **Canonical entities:** [system-entities.md](system-entities.md)  
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md) §6 RLS Assumptions  
> **Approval gates:** [approval-rules.md](approval-rules.md)  
> **Department routing:** [department-map.md](department-map.md)

This document is **planning only**. No SQL, migrations, or Supabase commands are included.

Scope: the six tables that exist after migrations `001` through `004`:
`organizations`, `users`, `departments`, `projects`, `tool_profiles`, `workflows`.

---

## 1. Security Goals

| Goal | Rationale |
|------|-----------|
| **Org isolation** | No row from organization A is ever visible to a user authenticated to organization B. This is the primary multi-tenancy boundary. |
| **Role-gated writes** | Write operations are restricted by the user's `role` field — not only by table-level SQL privileges. |
| **Department-scoped reads** | For department-owned tables, reads are limited to rows belonging to the user's own department unless the user has elevated access (`org_admin`, `department_lead`). |
| **Service role bypass** | Migrations, seeds, and backend service operations run as the Supabase service role, which bypasses RLS entirely. This is expected and must not be confused with client access. |
| **Deny by default** | All six tables already have RLS enabled with no policies. The goal of `005` is to open minimum necessary access, not to open everything. |
| **Soft-delete awareness** | All SELECT policies must exclude rows where `deleted_at IS NOT NULL`. Hard-deleted (unreachable) rows are implicitly excluded; soft-deleted rows require an explicit filter. |
| **No cross-org writes** | Insert policies must pin `organization_id` to the calling user's org. No policy may permit inserting a row into another org. |

---

## 2. Role Model

The existing schema (`001_foundation.sql` `users_role_check`) defines five roles:

| Role | Value in schema | Access intent |
|------|----------------|---------------|
| Org Admin | `org_admin` | Full read and write across the entire organization |
| Department Lead | `department_lead` | Full read/write within their department; may approve within department |
| Department Member | `department_member` | Read/write scoped to their assigned department |
| Agent | `agent` | Narrow write access to execution rows for assigned work; cannot manage registry rows |
| Read Only | `read_only` | Read only within their department or project scope; no writes |

> `platform_admin` is deferred — see §6.

### JWT Claim Strategy

Supabase RLS policies reference `auth.uid()` and custom JWT claims embedded in the token. Policies for `005` rely on the following pattern:

```text
auth.uid()            →  links to public.users.auth_user_id
public.users.role     →  determines permission level
public.users.organization_id  →  enforces tenancy
public.users.department_id    →  enforces department scope
```

Because `public.users` stores `auth_user_id → auth.users.id`, policies perform a sub-select to resolve the calling user's `organization_id`, `role`, and `department_id`. This sub-select is the **anchor** for all other RLS conditions.

**Important:** The bootstrap user (`bootstrap@ai-command-center.local`) has `auth_user_id = null`, so it cannot authenticate through Supabase Auth and will never match `auth.uid()`. It is a placeholder only; all real access goes through properly provisioned `auth.users` records.

---

## 3. Organization Isolation Rules

These rules apply to **every table** in scope. They are prerequisites for all table-specific policies.

| Rule | Implementation approach |
|------|------------------------|
| A user can only access rows where `organization_id` matches their own org | Sub-select: `organization_id = (select organization_id from public.users where auth_user_id = auth.uid() and deleted_at is null)` |
| No row from another org is ever returned | Enforced by the above clause on every SELECT policy |
| A user can only insert rows with their own `organization_id` | `NEW.organization_id = (select organization_id from public.users where auth_user_id = auth.uid() and deleted_at is null)` |
| Soft-deleted rows are invisible to non-admin queries | `deleted_at is null` on all SELECT policies |
| Org admins may read soft-deleted rows for audit | Optional: omit `deleted_at` filter for `org_admin` role on specific tables if auditing requires it. Deferred to `006`. |

---

## 4. Department Scope Rules

Department-scoped rules layer on top of org isolation.

| Scope | When it applies | Policy shape |
|-------|-----------------|--------------|
| **Full org** | `org_admin` role | No additional filter beyond org isolation |
| **Own department** | `department_lead`, `department_member`, `agent`, `read_only` | `department_id = (select department_id from public.users ...)` |
| **Cross-department read** | Registry tables (`departments`, `tool_profiles`) | All org members read all active rows in org |
| **No department** | `agent` role on registry tables | Agents read registry; cannot write registry |

### Scope Precedence

```text
org_admin → full org access (narrowed by table rules, never expanded)
department_lead → own department read/write + registry reads
department_member → own department read/write + registry reads
agent → assigned work rows only + registry reads
read_only → own department reads only + registry reads
```

---

## 5. Table-by-Table Policies

Each table defines **SELECT**, **INSERT**, **UPDATE**, and **DELETE** (or soft-delete via UPDATE) policies. All policies layer on top of §3 org isolation.

---

### `organizations`

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | All authenticated org members | Own org only; `deleted_at is null` |
| INSERT | None via client | Org creation is a service-role operation only (migrations and admin tooling) |
| UPDATE | `org_admin` only | Own org; cannot change `id` or `slug` |
| DELETE | None via client | Hard-delete blocked; soft-delete via UPDATE `deleted_at` for `org_admin` only |

**Rationale:** Users should be able to see their own organization's name and status. Only service-role operations provision new orgs. Org admins may update org-level settings (e.g., `status`, `name`) but slug mutation is application-layer restricted to prevent index breakage.

---

### `users`

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | All org members | Own org; `deleted_at is null`. A user may always read their own row (`id = current_user_id`). |
| SELECT (peers) | `department_lead`, `org_admin` | Own org + own department (lead) or all org (admin) |
| INSERT | `org_admin` | Own org; must set `organization_id` to caller's org |
| UPDATE | `org_admin` | Own org; may change `role`, `status`, `department_id` |
| UPDATE (self) | Any authenticated user | Own row only; may update `display_name` only; cannot change `role` or `organization_id` |
| DELETE | None via client | Soft-delete only: `org_admin` may set `deleted_at` |

**Rationale:** Users need to read their own profile and that of peers to resolve display names on tasks and work packets. Role assignment is admin-only to prevent privilege escalation. Self-service is narrowed to non-privileged fields.

**Risk:** Department members can list peers in their org with a naive SELECT policy — if membership privacy is a future requirement, this must be narrowed in a later migration.

---

### `departments`

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | All org members | Own org; `deleted_at is null`; `status != 'archived'` (or: `status = 'active'`) |
| INSERT | `org_admin` | Own org; `organization_id` pinned |
| UPDATE | `org_admin` | Own org; may update `name`, `mission`, `status`, `default_tool_profile_id` |
| DELETE | None via client | Soft-delete only: `org_admin` sets `deleted_at` |

**Rationale:** All org members need to read the department list to route requests, display department names on tasks, and select departments when creating projects. Only org admins add or modify departments — department structure is registry-level configuration.

**Note:** `default_tool_profile_id` updates must be validated application-side to ensure the target profile belongs to the same org. The FK constraint guarantees referential integrity but not org co-tenancy.

---

### `projects`

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | `org_admin`, `department_lead` (own dept) | Own org; `owning_department_id` matches user's department (lead) or full org (admin); `deleted_at is null` |
| SELECT | `department_member`, `read_only` | Own org; `owning_department_id = user's department_id` |
| SELECT | `agent` | Own org; `owning_department_id = user's department_id` |
| INSERT | `org_admin`, `department_lead` | Own org; `owning_department_id` must be user's own department (lead) or any (admin); `organization_id` pinned |
| UPDATE | `org_admin`, `department_lead` (own dept) | Own org; own department (lead); can update `name`, `objective`, `status`, `workflow_template_id` |
| DELETE | None via client | Soft-delete only: `org_admin` or `department_lead` sets `deleted_at` |

**Rationale:** Projects are department-owned. Department members do not automatically see other departments' projects — this keeps cross-department visibility invitation-based (future `project_members` table). Department leads can create projects for their own department. Org admins have full visibility for oversight.

**Future gap:** No `project_members` junction table exists yet. Cross-department collaborators cannot be granted project access via RLS until that table is introduced (Phase C+).

---

### `tool_profiles`

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT | All org members | Own org; `deleted_at is null`; `status != 'archived'` |
| INSERT | `org_admin` | Own org; `organization_id` pinned; `owner_department_id` must be in same org |
| UPDATE | `org_admin` | Own org; can update `name`, `description`, `allowed_tools`, `constraints`, `status` |
| DELETE | None via client | Soft-delete only: `org_admin` sets `deleted_at` |

**Rationale:** Tool profiles are org-wide registry rows — every member needs to read them to understand their tool boundaries (agents and tasks reference `tool_profile_id`). Write access is admin-only because changing a profile's `allowed_tools` affects all agents and tasks that reference it. This matches the `supabase-runtime-data-model.md` §6 assumption: "All org members read; Platform lead writes."

**Schema gap:** `Platform lead` is a semantic role from `approval-rules.md` but maps to `org_admin` in the current schema. A future `platform_lead` or `department_lead + command-center department` check would be more accurate. Deferred to `006`.

---

### `workflows`

Workflow access is split by `kind`:

- **Templates** (`kind = 'template'`): Registry rows. All org members read; only `org_admin` creates or modifies.
- **Instances** (`kind = 'instance'`): Execution rows owned by a department. Department members read/write their own department's instances.

| Operation | Who | Condition |
|-----------|-----|-----------|
| SELECT (templates) | All org members | Own org; `kind = 'template'`; `deleted_at is null`; `status != 'archived'` |
| SELECT (instances) | `org_admin`, `department_lead` (own dept), `department_member` (own dept), `agent` (own dept) | Own org; `kind = 'instance'`; `department_id = user's department_id`; `deleted_at is null` |
| INSERT (template) | `org_admin` | Own org; `kind = 'template'`; `organization_id` pinned |
| INSERT (instance) | `org_admin`, `department_lead`, `department_member` | Own org; `kind = 'instance'`; `department_id` must equal user's own `department_id` |
| UPDATE (template) | `org_admin` | Own org; `kind = 'template'`; can update `name`, `definition`, `status`, `tool_profile_id` |
| UPDATE (instance) | `org_admin`, `department_lead` (own dept) | Own org; `kind = 'instance'`; own dept |
| DELETE | None via client | Soft-delete only: `org_admin` sets `deleted_at` |

**Rationale:** The template/instance split matches the `workflows_template_shape_check` constraint and the data model ownership note ("Engineering/Command Center owns templates; assigned department owns instances"). Agents read workflow templates to understand their orchestration context but do not create or modify templates.

---

## 6. Bootstrap User Considerations

The `bootstrap@ai-command-center.local` user (`role = 'org_admin'`, `auth_user_id = null`) requires specific handling:

| Consideration | Detail |
|---------------|--------|
| **Cannot authenticate through Supabase Auth** | `auth_user_id` is `null`; `auth.uid()` will never match this row. The bootstrap user is a seed placeholder, not a real auth principal. |
| **RLS policies do not apply to it** | Since no real Auth session maps to it, it will never trigger client-path RLS. All seed operations ran as service role before `005` policies existed. |
| **Do not include it in policy logic** | Policies must not contain special-case checks for bootstrap email or id — that would create a hardcoded backdoor. |
| **Real org admin provisioning** | Before any human uses the system, a real Supabase Auth user must be created and linked to a `public.users` row with `role = 'org_admin'` and a valid `auth_user_id`. That user will satisfy the `org_admin` branches of all `005` policies. |
| **`platform_admin` deferral** | `platform_admin` is not a schema role. When multi-org administration is needed, add it as a role value in `users_role_check` (migration to `001` or new migration) and write matching policy branches. Until then, `org_admin` is the highest client-accessible role. |

---

## 7. Service Role / Migration Assumptions

| Assumption | Detail |
|------------|--------|
| **Service role bypasses all RLS** | Supabase `service_role` key is used for migrations, seeds (including `004`), and backend automation. It always bypasses RLS. Never expose the service role key to client-side code. |
| **Anon role has no access** | The `anon` Postgres role has no SELECT, INSERT, UPDATE, or DELETE on any of the six tables. No `005` policy grants anonymous access. |
| **Authenticated role only** | All client-facing policies use `to authenticated` (or the equivalent Supabase RLS policy target). |
| **Policy ordering** | Supabase evaluates permissive policies with OR — a user satisfies a table-level SELECT if they match any one permissive SELECT policy on that table. Restrictive policies (AND logic) are not used in `005`. |
| **Sub-select performance** | The `(select ... from public.users where auth_user_id = auth.uid() and deleted_at is null)` sub-select will run once per query and is covered by the `users_auth_user_id_active_key` partial unique index from `002`. This is acceptable for current scale. |
| **No `security definer` functions in `005`** | All policies use inline sub-selects rather than security-definer helper functions to keep the policy surface auditable. If performance becomes a concern, a security-definer helper (with pinned `search_path`) may be introduced in `006`. |
| **Triggers do not enforce RLS** | The `set_updated_at()` trigger (from `002`) is a `before update` trigger and does not involve `auth.uid()`. It is unaffected by RLS policy changes. |

---

## 8. Policy Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | Sub-select `public.users` lookup on every query may become a hotspot at scale | Low (current) | Covered by partial index; revisit if query volume grows |
| 2 | `org_admin` is the only elevated role; no `platform_lead` check yet | Low | Acceptable for initial release; add `department_lead + command-center` check in `006` |
| 3 | No `project_members` table means cross-department project collaborators cannot read projects they contribute to | Medium | Projects are strictly department-siloed until `project_members` is introduced in a Phase C migration |
| 4 | Soft-deleted row visibility for audit purposes is not covered | Low | Org admins may need to see `deleted_at IS NOT NULL` rows for audit; add an explicit admin audit SELECT policy in `006` or alongside `audit_events` |
| 5 | No write-policy for `created_by` pinning | Medium | INSERT policies must enforce `NEW.created_by = (select id from public.users where auth_user_id = auth.uid())` to prevent impersonation. Must be included in `005` SQL. |
| 6 | `tool_profiles.owner_department_id` cross-org co-tenancy not enforced by FK | Low | FK ensures the row exists; org isolation in the INSERT policy ensures the department is in the same org |
| 7 | `agent` role on `projects` reads their department's projects — if an agent is not assigned a `department_id`, this returns nothing | Low | Agent users should always have `department_id` set; the `004` seed does not create agent users, so no immediate gap |
| 8 | `workflows.department_id` nullable on templates allows templates with no department owner | Low | Permitted by schema; SELECT policy for templates does not filter on `department_id`, so all members read all active templates |
| 9 | `read_only` users can read their department's projects but cannot see the full org directory of projects | Info | Intentional; if broader read scope is needed, introduce a `project_members` row for the read_only user |
| 10 | No policy prevents an `org_admin` from updating `organization_id` on a row to move it cross-org | Low | Application layer must validate `organization_id` immutability; a future `006` check constraint or trigger would be more robust |

---

## 9. Future Tables Not Yet Covered

These tables are planned but do not exist after `004`. Their RLS policy design is deferred and should be addressed in the migration that creates each table.

| Future table | Layer | Notes for RLS design |
|--------------|-------|----------------------|
| `requests` | Execution | Operations department reads all; submitted user reads own; routed department reads once triaged |
| `tasks` | Execution | Department-scoped read/write; agents narrow to assigned `task_id` |
| `work_packets` | Execution | Department of parent task or project; requires `approval_required_before_start` gate logic |
| `execution_logs` | Execution | Insert by context department; no client UPDATE or DELETE; admin read all |
| `decisions` | Governance | Department of parent task; agents insert `proposed`; leads confirm |
| `approvals` | Governance | Requester and named `approver_user_id` read; only approver updates status |
| `blockers` | Governance | Department of blocked entity; escalation creates cross-department visibility |
| `research_assets` | Knowledge | Research department manages quality; creating department has custody |
| `outputs` | Knowledge | Task department reads; external delivery requires approved `approvals` row |
| `knowledge_records` | Knowledge | Polymorphic subject read-through; agents insert for assigned tasks; leads archive |
| `audit_events` | System | Platform admin read only; system-role insert only; no client writes |
| `execution_logs` | System | Append-only; no delete from client path |

> These tables are part of Phase C+ (Execution Layer), Phase D (Governance Layer), and Phase E (Knowledge Layer) per [supabase-runtime-data-model.md](supabase-runtime-data-model.md) §7. Their RLS policies must be planned in a corresponding `phase-c-*-plan.md` document before SQL authoring.

---

## Policy Summary Reference

| Table | SELECT | INSERT | UPDATE | Soft-delete |
|-------|--------|--------|--------|-------------|
| `organizations` | All org members | Service role only | `org_admin` | `org_admin` |
| `users` | All org members (self always; peers via role) | `org_admin` | `org_admin` (full); self (display_name) | `org_admin` |
| `departments` | All org members | `org_admin` | `org_admin` | `org_admin` |
| `projects` | Own dept (members); full org (`org_admin`) | `org_admin`, `department_lead` (own dept) | `org_admin`, `department_lead` (own dept) | `org_admin`, `department_lead` |
| `tool_profiles` | All org members | `org_admin` | `org_admin` | `org_admin` |
| `workflows` | Templates: all; Instances: own dept | `org_admin`, leads/members (instances to own dept) | `org_admin`; leads (own dept instances) | `org_admin` |

All SELECT policies: `deleted_at is null`.  
All INSERT policies: `organization_id` pinned; `created_by` pinned.  
No hard-delete via client path on any table.
