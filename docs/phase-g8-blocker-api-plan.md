# Phase G8 — Blocker API Plan

> **Status:** Architecture only. No code, migrations, schema changes, or Edge Function implementations. Describes the contract for the Blocker API layer against the **deployed** schema (migrations `001`–`020`, project `wbtvrzivthuqqntnorsw`, verified 2026-06-24).
>
> **Source authority:** `011_governance_layer.sql` (schema), `013_phase_d_rls_policies.sql` (RLS, live verified), `018_runtime_hardening.sql` (runtime tables), `020_phase_f_rls_policies.sql` (Phase F RLS), `docs/approval-rules.md`, `docs/system-entities.md`.
>
> **Companion plans:** [phase-g1-auth-context-spine.md](phase-g1-auth-context-spine.md) · [phase-g3-task-api-plan.md](phase-g3-task-api-plan.md) · [phase-g4-work-packet-api-plan.md](phase-g4-work-packet-api-plan.md) · [phase-g5-approval-api-plan.md](phase-g5-approval-api-plan.md) · [phase-g-realtime-publication-plan.md](phase-g-realtime-publication-plan.md)

---

## 1. Purpose

The Blocker API manages impediment records that signal when a task or work packet cannot proceed. Blockers make stalled work visible, assignable, and resolvable through a department-owned lifecycle. They are the primary mechanism for surfacing workflow blockage across the platform — whether the cause is an external dependency, an expired approval, a critical technical constraint, or an accepted-but-not-fixed limitation (`won_t_fix`).

The Blocker API does four things the other governance APIs do not:

1. **Surface impediment state** — a raised blocker on a task should drive `tasks.status → blocked`; its resolution should unblock that task. This is application-side coordination, not DB-enforced, but it is the primary user-visible effect of the Blocker API.
2. **Accept service-role creation** — expired approvals create blockers via a service-role path (the job runner), not through authenticated inserts. The Blocker API contract must accommodate this path alongside the authenticated reporter path.
3. **Gate the `won_t_fix` override** — accepting that a blocker will never be fixed (`won_t_fix`) does not itself require approval. But *overriding* that decision and proceeding despite it does: a Category B Decision (`pending_approval` → `approved` by a dept_lead) is required before the work can continue. This gate is application-enforced, not DB-enforced.
4. **Participate in the realtime set** — `blockers` is in the documented MVP realtime set (alongside `tasks` and `approvals`), though publication is currently deferred per the realtime plan.

---

## 2. Scope

### In Scope

- Creating, reading, updating, and resolving `blockers` table rows via the `authenticated` role with full RLS enforcement.
- Status machine governance: `open → investigating → pending_external → resolved / won_t_fix`.
- Assignment to a user (`assigned_to_user_id`).
- Severity management (`low`, `medium`, `high`, `critical`).
- Resolution with `resolution_note` (application-required; not DB-required).
- `won_t_fix` path and the Category B Decision gate for overriding it.
- Service-role blocker creation on approval expiry.
- Soft-delete via `deleted_at`.
- Interaction with `tasks`, `work_packets`, `approvals`, `background_jobs`, and `execution_logs`.
- Realtime intent vs. current live state.
- Verification matrix (25 tests).

### Out of Scope

- **Project-level blockers.** The deployed `blocked_entity_type` CHECK is `('task', 'work_packet')` only. `'project'` was intentionally deferred beyond Phase D per the migration comment. This plan does not introduce project blockers. A separate migration and API extension is needed when project blockers are required.
- **`blocker_research_assets` junction table.** The runtime data model describes this junction; it is **not deployed** (verified: only `blockers` exists in the `blocker*` namespace). This plan documents blockers as they are deployed, without the junction.
- **No `resolved_at` column.** The runtime data model implies it; the deployed schema has no such column. Resolution timing is derivable from `updated_at` at the moment `status` transitions to `resolved` or `won_t_fix`.
- Internals of the Task, Work Packet, or Approval APIs.
- New roles, schema changes, or migrations.

---

## 3. Blocker Entity Definition

Verified against the live database (`wbtvrzivthuqqntnorsw`, 2026-06-24). Source: `011_governance_layer.sql`.

### Columns

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| `id` | uuid | NO | gen_random_uuid() | PK |
| `organization_id` | uuid | NO | — | FK → organizations RESTRICT |
| `department_id` | uuid | NO | — | FK → departments RESTRICT; **DIRECT** column, not derived through entity |
| `description` | text | NO | — | CHECK: not empty |
| `blocked_entity_type` | text | NO | — | CHECK: `'task'` or `'work_packet'` only |
| `blocked_entity_id` | uuid | NO | — | Polymorphic FK (no DB FK; integrity via RLS EXISTS) |
| `severity` | text | NO | `'medium'` | CHECK: `'low'`, `'medium'`, `'high'`, `'critical'` |
| `reported_by_user_id` | uuid | NO | — | FK → users **RESTRICT** (NOT NULL; reporter cannot be deleted while blocker exists) |
| `assigned_to_user_id` | uuid | YES | NULL | FK → users SET NULL |
| `resolution_note` | text | YES | NULL | Required by application at `resolved`/`won_t_fix`; not by DB |
| `status` | text | NO | `'open'` | CHECK: see §4 |
| `created_at` | timestamptz | NO | now() | Serves as `reported_at` (no separate column) |
| `updated_at` | timestamptz | NO | now() | Updated by trigger on every UPDATE; serves as proxy for `resolved_at` |
| `deleted_at` | timestamptz | YES | NULL | Soft-delete; row invisible to all authenticated roles when set |

### Live Check Constraints

| Constraint | Definition |
|------------|-----------|
| `blockers_description_not_empty` | `length(trim(description)) > 0` |
| `blockers_blocked_entity_type_check` | `blocked_entity_type IN ('task', 'work_packet')` |
| `blockers_severity_check` | `severity IN ('low', 'medium', 'high', 'critical')` |
| `blockers_status_check` | `status IN ('open', 'investigating', 'pending_external', 'resolved', 'won_t_fix')` |

### Live Foreign Keys

| Column | References | On Delete |
|--------|-----------|-----------|
| `organization_id` | `organizations(id)` | RESTRICT |
| `department_id` | `departments(id)` | RESTRICT |
| `reported_by_user_id` | `users(id)` | RESTRICT |
| `assigned_to_user_id` | `users(id)` | SET NULL |

### Key Schema Facts (Critical for Implementers)

1. **`department_id` is a DIRECT column** — the same pattern as `outputs`, the inverse of `decisions`. Department scope for RLS, routing, and visibility is read from the row itself, not derived from the blocked entity at query time. The application must keep `blockers.department_id` aligned with the blocked entity's department; this alignment is enforced by the INSERT/UPDATE RLS EXISTS clause, not a separate DB FK.
2. **`reported_by_user_id` is NOT NULL + RESTRICT** — unlike `decisions.decided_by_user_id` (nullable, SET NULL), the blocker reporter is mandatory and cannot be orphaned. Service-role-created blockers must carry a valid user id.
3. **No `resolved_at` column** — resolution timing is captured via `updated_at` (trigger-maintained) at the moment of transition. If a precise resolved-at timestamp is needed, the application must read `updated_at` at that transition.
4. **No `blocker_research_assets` junction table** — documented in the data model but not deployed. Do not reference it in implementation.
5. **`blocked_entity_type` excludes `'project'`** — any attempt to INSERT with `blocked_entity_type='project'` will fail the DB CHECK constraint.

---

## 4. Blocker Lifecycle

Blockers follow a linear progression from open to terminal. Every status is DB-validated by `blockers_status_check`; transitions are application-governed.

| Status | Meaning | Who may set |
|--------|---------|-------------|
| `open` | Active, unassigned or newly assigned impediment. Default at INSERT. | INSERT (RLS requires this value) |
| `investigating` | Owner assigned; root cause being determined | dept_member, dept_lead, org_admin (UPDATE) |
| `pending_external` | Blocked on an outside party; no further internal action can proceed | dept_member, dept_lead, org_admin (UPDATE) |
| `resolved` | Blocker cleared; work may resume | dept_lead, org_admin (UPDATE) — see §11 |
| `won_t_fix` | Accepted as permanent constraint; work rerouted or cancelled | dept_lead, org_admin (UPDATE) — see §12 |

**Terminal statuses:** `resolved` and `won_t_fix` are soft-terminal. The application may allow reopen (back to `open`) with explicit context; the DB does not prevent it. Terminal rows remain visible for audit until soft-deleted.

**DB-enforced at INSERT:** `status = 'open'` is required by the `blockers_insert_department_scope` WITH CHECK. A caller cannot fabricate a blocker that is already `resolved` or `investigating` at birth.

---

## 5. State Machine

```
                     ┌────────────────────────────────────┐
                     │                                    │
                [INSERT]                                  │ (reopen, application-only)
                     ▼                                    │
         ┌──────────────────────┐                        │
         │         open          │ ◄──────────────────────┘
         └──────────────────────┘
              │           │
              │           └──────────────────────────────┐
              ▼                                          ▼
   ┌──────────────────────┐              ┌──────────────────────────┐
   │     investigating     │             │      pending_external     │
   └──────────────────────┘              └──────────────────────────┘
         │        │                               │         │
         │        └────────────────────┐          │         │
         ▼                             ▼          ▼         ▼
  ┌──────────────┐              ┌─────────────────────────────┐
  │   resolved   │              │         won_t_fix            │
  └──────────────┘              └─────────────────────────────┘
```

### Valid Transitions (Application-Enforced)

| From | To | Condition |
|------|----|-----------|
| `open` | `investigating` | Assignment made or cause identified |
| `open` | `pending_external` | External dependency confirmed |
| `open` | `resolved` | Cause eliminated; resolution_note required |
| `open` | `won_t_fix` | Lead/admin accepts permanent constraint; resolution_note required |
| `investigating` | `pending_external` | Root cause requires external party |
| `investigating` | `resolved` | Cause eliminated; resolution_note required |
| `investigating` | `won_t_fix` | Lead/admin accepts; resolution_note required |
| `pending_external` | `investigating` | External party responded; investigation resumed |
| `pending_external` | `resolved` | External dependency cleared; resolution_note required |
| `pending_external` | `won_t_fix` | External party confirmed no fix; resolution_note required |
| `resolved` | `open` | Blocker recurred (reopen with new description context) |
| `won_t_fix` | `open` | Override decision made (Category B gate required; see §12) |

**Transitions NOT permitted:**
- `resolved → won_t_fix` or `won_t_fix → resolved` (must reopen first)
- Any → `open` without explicit reopen semantics (application must surface context)
- Backwards within the investigating path without justification

---

## 6. Visibility Model

Three RLS policies on `blockers` (source: `013_phase_d_rls_policies.sql`, verified live, unchanged by any later migration):

### `blockers_select_department_scope` (SELECT)

```
USING:
  organization_id = current_organization_id()
  AND deleted_at IS NULL
  AND (
    current_role() = 'org_admin'
    OR (
      current_role() IN ('department_lead', 'department_member', 'read_only')
      AND department_id = current_department_id()
    )
    OR (
      current_role() = 'agent'
      AND (
        -- task blocker: task assigned to agent
        (blocked_entity_type = 'task'
         AND EXISTS (tasks t WHERE t.id = blocked_entity_id
                     AND t.assigned_to_user_id = current_user_id()
                     AND t.deleted_at IS NULL))
        OR
        -- work_packet blocker: a task with that WP is assigned to agent
        (blocked_entity_type = 'work_packet'
         AND EXISTS (tasks t WHERE t.work_packet_id = blocked_entity_id
                     AND t.assigned_to_user_id = current_user_id()
                     AND t.deleted_at IS NULL))
      )
    )
  )
```

**Key points:**
- `read_only` has SELECT access (dept-scoped).
- Agents see blockers on their assigned task, AND blockers on work packets linked to their assigned task (via `tasks.work_packet_id`). This is a two-hop join — the blocker entity itself doesn't carry an agent FK.
- Soft-deleted rows (`deleted_at IS NOT NULL`) are invisible to all authenticated roles.

### `blockers_insert_department_scope` (INSERT)

```
WITH CHECK:
  organization_id = current_organization_id()
  AND deleted_at IS NULL
  AND status = 'open'
  AND reported_by_user_id = current_user_id()   ← self-pin
  AND current_role() IN ('org_admin', 'department_lead', 'department_member')
  AND (current_role() = 'org_admin' OR department_id = current_department_id())
  AND EXISTS (departments d WHERE d.id = department_id AND d.deleted_at IS NULL)
  AND (assigned_to_user_id IS NULL
       OR EXISTS (users u WHERE u.id = assigned_to_user_id AND u.status = 'active' AND u.deleted_at IS NULL))
  AND (
    (blocked_entity_type = 'task' AND EXISTS (tasks t WHERE t.id = blocked_entity_id
                                              AND t.department_id = blockers.department_id
                                              AND t.deleted_at IS NULL))
    OR
    (blocked_entity_type = 'work_packet' AND EXISTS (work_packets wp WHERE wp.id = blocked_entity_id
                                                     AND wp.department_id = blockers.department_id
                                                     AND wp.deleted_at IS NULL))
  )
```

**Key points:**
- Agents and `read_only` are excluded by role check.
- `status = 'open'` is the only valid initial status.
- `reported_by_user_id` must equal the caller's own user id (enforced).
- The blocked entity must be in the same department as the blocker.

### `blockers_update_department_scope` (UPDATE)

```
USING:
  organization_id = current_organization_id()
  AND deleted_at IS NULL
  AND (current_role() = 'org_admin'
       OR (current_role() IN ('department_lead', 'department_member')
           AND department_id = current_department_id()))

WITH CHECK (same role gate plus):
  EXISTS (departments d WHERE d.id = department_id AND d.deleted_at IS NULL)
  AND EXISTS (users u WHERE u.id = reported_by_user_id AND u.deleted_at IS NULL)  ← liveness, not active check
  AND (assigned_to_user_id IS NULL OR EXISTS (users u WHERE u.id = assigned_to_user_id AND u.status = 'active' AND u.deleted_at IS NULL))
  AND (entity EXISTS in same department)
```

**Key point:** The UPDATE WITH CHECK verifies the reporter still EXISTS (not deleted — no `status='active'` check here, unlike INSERT). This is intentional: a reporter may be suspended but the blocker should remain mutable by the department.

---

## 7. Auth Contract

### Role × Operation Matrix

| Role | SELECT | INSERT (raise) | UPDATE (advance/assign/resolve) | Soft-delete | Notes |
|------|--------|---------------|--------------------------------|-------------|-------|
| `org_admin` | All org | All dept | All org | Yes (UPDATE deleted_at) | Org-wide authority |
| `department_lead` | Own dept | Own dept | Own dept | Yes | Full dept lifecycle authority |
| `department_member` | Own dept | Own dept | Own dept | Yes | Members can UPDATE — unlike decisions (where members can only INSERT) |
| `read_only` | Own dept | No | No | No | SELECT only |
| `agent` | Assigned task/WP blockers only | **No** | **No** | No | Read-only; cannot raise or update blockers |

### Key Auth Contrasts vs. Other Governance Entities

| Entity | dept_member INSERT | dept_member UPDATE | agent INSERT | agent UPDATE |
|--------|-------------------|-------------------|-------------|-------------|
| `decisions` | Yes (propose only) | No (leads/admin only) | No | No |
| `approvals` | Yes | No (leads/admin only) | No | No |
| `outputs` | No | Yes | No | No |
| `blockers` | **Yes** | **Yes** | **No** | **No** |

The blocker UPDATE grant to `department_member` is intentional: investigating and resolving blockers is a department-team activity, not restricted to leads. The escalation gate (`won_t_fix`) is application-enforced to require lead/admin authority.

### `won_t_fix` Escalation Authority

Setting `status = 'won_t_fix'` is mechanically an UPDATE (permitted by the dept_member role at the DB layer), but the **application must restrict `won_t_fix` transitions to `org_admin` and `department_lead`** (Layer 4). A department member setting `won_t_fix` should be rejected at the API layer with `forbidden`. This is a documented, deliberate narrowing of what the DB permits.

---

## 8. Create Contract

**Operation:** `blocker.raise`

**Purpose:** Insert a new blocker record signaling that a task or work packet cannot proceed.

**Inputs:**
- `organization_id` (derived from caller via `private.current_organization_id()` — not accepted from client)
- `department_id` (required; must match caller's dept or caller is org_admin)
- `description` (required; non-empty text describing the impediment)
- `blocked_entity_type` (required; `'task'` or `'work_packet'` only)
- `blocked_entity_id` (required; must belong to the specified department)
- `severity` (optional; defaults to `'medium'`)
- `assigned_to_user_id` (optional; must be active user in same org if provided)
- `resolution_note` (not accepted at creation — only at resolution)

**Outputs:** The created blocker row.

**Auth requirements:** `org_admin`, `dept_lead`, or `dept_member`. Agents and `read_only` → RLS 42501.

**RLS expectations:**
- `status = 'open'` is enforced by RLS WITH CHECK — do not attempt to pass another status.
- `reported_by_user_id` is self-pinned by RLS; the application must not accept this from the client.
- `department_id` must align with the blocked entity; RLS performs an EXISTS cross-check.

**Side effects (application-layer, Layer 4):**
- If `blocked_entity_type = 'task'`: advance the task's `status → 'blocked'` (application-side UPDATE on `tasks`). This is NOT DB-enforced; it must be done in the same logical transaction.
- Enqueue an `approval_notification` (or `other`) `background_jobs` row (service-role path) to notify the department lead of a critical blocker.

**Failure modes:**
- `blocked_entity_type = 'project'` → DB CHECK violation.
- Agent caller → RLS 42501.
- Entity not in caller's department → RLS 42501 (entity EXISTS fails).
- Empty description → DB CHECK violation.
- `assigned_to_user_id` for non-active user → RLS 42501.
- Department not active (`deleted_at IS NOT NULL`) → RLS 42501.

**Audit:** `execution_logs` on the blocked entity (`context_type = 'task'` or `'work_packet'`, `event_type = 'state_change'`, summary notes blocker raised with id and description).

**Approval:** None. Raising a blocker is Category C (autonomous, log-only) per `approval-rules.md`.

### Service-Role Creation Path (Approval Expiry)

When `approvals.status → 'expired'`, the job runner creates a blocker on the subject task (per `approval-rules.md`: "Expired Approvals create a Blocker on the subject Task if work cannot proceed"). This INSERT is via `service_role` (bypasses RLS). The service-role code must:
- Set `organization_id` from the approval's `organization_id`.
- Set `department_id` from the approval's `department_id`.
- Set `blocked_entity_type = 'task'`, `blocked_entity_id = <approval.subject_id>` (when subject is a task; if subject is `output` or `work_packet`, the service code must resolve the related task).
- Set `reported_by_user_id` to the approval requester's user id (or a designated service account user id — must be a valid users row).
- Set `severity = 'high'` (expired approval blocking progress is a high-severity signal).
- Set `description` capturing the expired approval id and trigger reason.

---

## 9. Read Contract

**Operations:** `blocker.get` (single), `blocker.list` (filtered collection)

**`blocker.get` — single record**

- **Input:** blocker `id`.
- **Output:** blocker row if visible under RLS; `not_found` otherwise.
- **Auth:** all roles (scoped by SELECT policy). An agent requesting a blocker for a non-assigned entity gets `not_found`, not `forbidden` (invisibility rule, G1 §19).

**`blocker.list` — filtered collection**

- **Input (filters, all optional):**
  - `blocked_entity_type` + `blocked_entity_id` — blockers for a specific entity
  - `status` — filter by one or more statuses (e.g., active: `open,investigating,pending_external`)
  - `severity` — filter by one or more severities
  - `assigned_to_user_id` — filter by assignee
  - `department_id` — org_admin only; non-admin filter is ignored (RLS already scopes to own dept)
- **Output:** ordered by `created_at DESC`; pagination required for production.
- **Auth:** same RLS as SELECT.
- **Note:** A common query pattern is "all open/investigating blockers for this task" — implementers should index `(organization_id, blocked_entity_type, blocked_entity_id, status)` (already provided by `blockers_blocked_entity_idx`).

---

## 10. Update Contract

**Operation:** `blocker.update`

Covers status transitions, assignment changes, and description/severity edits while the blocker is active.

**Inputs (at least one required):**
- `status` — transition (see §5 for valid paths)
- `assigned_to_user_id` — assign or reassign; set to null to unassign
- `severity` — escalate or de-escalate
- `description` — amend description (add context; existing text is overwritten)
- `resolution_note` — required when transitioning to `resolved` or `won_t_fix`

**Auth requirements:** `org_admin`, `dept_lead`, or `dept_member`. Agents and `read_only` → RLS 42501.

**Application constraints (Layer 4):**
- `won_t_fix` transitions restricted to `org_admin` and `dept_lead` only (narrower than what DB permits).
- `resolution_note` must be non-empty when `status` is `resolved` or `won_t_fix`.
- The transition must be valid per §5; illegal transitions → `conflict`.
- `assigned_to_user_id` must belong to the same `organization_id` and have `status = 'active'`.

**Soft-delete:** Setting `deleted_at` to a non-null timestamp (via UPDATE) is the soft-delete operation. Once set, the row becomes invisible to all authenticated roles. Only `org_admin`, `dept_lead`, or `dept_member` can soft-delete (same UPDATE policy gate). The application should offer this as a distinct `blocker.soft_delete` operation rather than exposing raw `deleted_at` to callers.

---

## 11. Resolution Contract

**Operation:** `blocker.resolve`

**Purpose:** Transition a blocker to `resolved`, indicating the impediment is cleared and work may resume.

**Inputs:**
- `id` — blocker id
- `resolution_note` (required by application, not DB)

**Outputs:** Updated blocker row with `status = 'resolved'`.

**Auth requirements:** `org_admin`, `dept_lead`, or `dept_member`. The API should restrict resolution of high-severity blockers to `dept_lead` or `org_admin` (application Layer 4 narrowing — a `dept_member` resolving a critical blocker should require lead acknowledgment).

**Side effects (application-layer):**
- If the blocker is the last `open`/`investigating`/`pending_external` blocker on a task, advance the task's `status` from `'blocked'` back to its prior state (typically `'in_progress'` or `'ready'`). This requires the application to query open blockers on the task before advancing task status.
- Emit `execution_logs` on the blocked entity: `event_type = 'state_change'`, summarizing the resolution and noting `resolution_note`.

**Failure modes:**
- Already `resolved` or `won_t_fix` → `conflict` (Layer 4; reopen first if needed).
- Soft-deleted blocker → `not_found` (invisible under RLS).
- Empty `resolution_note` → `validation` (Layer 4).
- Non-lead `dept_member` resolving `critical` blocker → `forbidden` (Layer 4, if that narrowing is applied).

**Audit:** `execution_logs` on the task/work_packet: `event_type = 'state_change'`, `actor = <caller>`, summary: "Blocker resolved: <resolution_note>".

**Approval:** None. Resolution is Category C.

---

## 12. Escalation Contract

### Status Escalation

**Operation:** `blocker.escalate` (alias for targeted `blocker.update` status transitions to `pending_external` or severity upgrade to `critical`)

**Purpose:** Signal that the blocker has escalated to an external dependency or to maximum severity, requiring broader attention.

**Auth:** same as `blocker.update` — `org_admin`, `dept_lead`, or `dept_member`. However, the application **should** require `dept_lead` or `org_admin` for:
- Transitions to `pending_external` (signals dependency on a party outside the department — a departmental decision).
- Severity upgrades to `critical` (high-visibility signal that may drive emergency escalation paths).

### `won_t_fix` Path

**Operation:** `blocker.accept` (a `blocker.update` transition to `won_t_fix`)

**Purpose:** Accept the blocker as a permanent constraint. Work on the blocked entity must be rerouted or cancelled.

**Auth:** `org_admin` or `dept_lead` only (Layer 4 enforcement; DB permits `dept_member` at the RLS layer — application must narrow this).

**Inputs:**
- `id`
- `resolution_note` (required; must capture the rationale for accepting permanent blockage)

**Side effects:**
- Task linked to this blocker should be reviewed for cancellation or rerouting.
- The related task does NOT automatically advance from `blocked`; the department lead must make an explicit decision about the task.

### `won_t_fix` Override Gate (Category B Decision)

If work must proceed **despite** a `won_t_fix` blocker (i.e., the blocker is to be overridden), the following sequence is required per `approval-rules.md` (Decision ↔ Approval Interaction table: "Override of a Blocker marked `won_t_fix`" → Approval required):

1. A human (dept_lead or org_admin) creates a `decisions` row with:
   - `summary`: description of the override and why work will proceed
   - `status`: `'pending_approval'` (high-risk decision requiring Category B gate)
   - `task_id`: the task blocked by the `won_t_fix` blocker
2. The Approval API creates a `category = 'b'` approval for that decision (`subject_type = 'decision'`).
3. The dept_lead resolves the approval to `'approved'`.
4. The decision advances to `'approved'`.
5. The blocker is then reopened (`won_t_fix → open`) with a note referencing the approved decision.

**DB-enforcement:** None. The DB will allow `won_t_fix → open` without any approval check. The sequence above is entirely application-enforced (Layer 5). The gate is the Decision API + Approval API acting as the chokepoint — not the Blocker API.

**Test for the gap (verification matrix #18):** A caller can mechanically reopen a `won_t_fix` blocker without an approved decision. The Blocker API must pre-check for a resolved Category B approval on the related decision before allowing the reopen.

---

## 13. Task Relationship

**FK pattern:** `blockers.blocked_entity_type = 'task'`, `blockers.blocked_entity_id = tasks.id`. No DB FK from `blockers` to `tasks` — integrity via RLS EXISTS clause. `tasks` → `blockers` is one-to-many (one task may have multiple blockers).

**Department alignment:** `blockers.department_id` must equal `tasks.department_id` — enforced by the RLS INSERT/UPDATE EXISTS clause. The application must not allow cross-department blocker-task associations.

**Task status coordination (application-enforced, Layer 4):**

| Blocker event | Required task effect |
|---------------|---------------------|
| Blocker raised (`open`) | Task `status → 'blocked'` (if not already; atomic with blocker INSERT) |
| Blocker resolved (`resolved`) | If no other open blockers remain, task `status` returns from `'blocked'` to prior state |
| Blocker `won_t_fix` | Task status remains `'blocked'`; dept lead reviews for cancellation or rerouting |
| Blocker soft-deleted | Re-evaluate remaining open blockers; advance task if all cleared |

These transitions are NOT DB-enforced. The Task API and the Blocker API must coordinate at Layer 4. A task's `blocked` status is meaningful only if there is at least one non-terminal, non-deleted blocker on it.

**Agent visibility:** An agent assigned to a task can SELECT blockers where `blocked_entity_type = 'task' AND blocked_entity_id = tasks.id AND tasks.assigned_to_user_id = agent.id`. This lets agents observe what is blocking their assigned task. Agents cannot INSERT or UPDATE the blocker.

**Task RESTRICT FK:** `tasks` itself has no FK to `blockers`. The RESTRICT on `blockers.organization_id` and `blockers.department_id` prevent the owning org/dept from being deleted while blockers exist, but a task being soft-deleted does NOT cascade to blockers. If a task is soft-deleted while it has open blockers, those blocker rows remain in the DB but become invisible via the RLS EXISTS check (`t.deleted_at IS NULL`). Service-role code should soft-delete or mark terminal any blockers on a task being soft-deleted.

---

## 14. Work Packet Relationship

**FK pattern:** `blockers.blocked_entity_type = 'work_packet'`, `blockers.blocked_entity_id = work_packets.id`. Same polymorphic pattern as tasks; no DB FK.

**Department alignment:** `blockers.department_id` must equal `work_packets.department_id` — enforced by RLS EXISTS.

**Work packet status coordination:** Work packets have no `blocked` status (statuses: `draft`, `ready`, `in_execution`, `pending_approval`, `accepted`, `superseded`, `cancelled`). When a blocker is raised on a work packet, the work packet remains in its current status; the blocker is the signal that `in_execution` work cannot proceed. The application should surface open blockers on a work packet before allowing execution operations. There is no automatic work-packet status transition driven by blocker events (unlike tasks).

**Agent visibility:** An agent assigned to a task can see blockers on work packets linked to their assigned task, via `tasks.work_packet_id = blocked_entity_id`. This is the two-hop join in the SELECT policy. If the agent's task has no `work_packet_id`, they cannot see any work-packet blockers.

---

## 15. Approval Relationship

### Blockers Are Not Approval Subjects

`approvals.subject_type` CHECK constraint is `('task', 'work_packet', 'decision', 'output')` — `'blocker'` is NOT a valid subject type. No approval row targets a blocker directly. This is the key architectural distinction: blockers signal impediment; approvals gate action. They interact but do not nest.

### Expiry → Blocker (Approval → Blocker Direction)

`approval-rules.md`: "Expired Approvals create a Blocker on the subject Task if work cannot proceed."

When a pending approval expires (service-role job sets `status → 'expired'`), a new blocker is created on the subject task by the job runner (service-role INSERT, bypasses RLS). This is the primary system-generated blocker path:

- `blocked_entity_type = 'task'`, `blocked_entity_id = approval.subject_id`
- `description`: references the expired approval id and the blocked action
- `severity = 'high'`
- `department_id` from `approval.department_id`
- `reported_by_user_id`: the approval requester or a designated service account user id

### `won_t_fix` Override → Category B Decision (Blocker → Decision → Approval Direction)

As documented in §12: overriding a `won_t_fix` blocker requires a Category B Decision that goes through the Decision API and Approval API. The blocker is not the subject of the approval; the decision is. The interaction is:

```
won_t_fix blocker
  → department_lead decides to override
    → decisions (status='pending_approval', task_id=blocker's task)
      → approvals (subject_type='decision', category='b')
        → approved
          → decision status='approved'
            → blocker.reopen (won_t_fix → open)
```

### Approval-Notification Job (Runtime Path)

When a new critical-severity blocker is raised, the application may enqueue an `approval_notification` background job (using `job_type='approval_notification'`, `related_task_id=blocked_entity_id`) to notify the department lead. No blocking is required — this is a notification, not a gate.

---

## 16. Runtime Relationship

### `background_jobs`

There is no `related_blocker_id` FK on `background_jobs` (the table has `related_task_id`, `related_request_id`, `related_work_packet_id`). Background jobs related to blocker events link to the blocked entity, not the blocker itself:

| Job scenario | `job_type` | `related_*_id` set |
|-------------|-----------|-------------------|
| Critical blocker raised → notify lead | `approval_notification` | `related_task_id` (if task-type blocker) |
| Approval expired → create blocker | `approval_notification` | `related_task_id` |
| Won't-fix override → route for lead decision | `other` | `related_task_id` |

**Visibility of related jobs:** A dept lead/member can see background jobs where `related_task_id` resolves to their department's task (via the `020` `background_jobs_select_org_and_department_scope` policy). This means they can observe the job state for blocker-related notifications without needing a direct blocker → job FK.

### `dead_letter_queue`

If a blocker-notification job fails after exhausting all retries, it enters `dead_letter_queue`. The department lead can read and resolve the DLQ entry (per the `dead_letter_queue_select_org_and_department_scope` + `dead_letter_queue_update_org_and_department_lead` policies in `020`). This is the failure-handling surface for missed blocker notifications.

### `agent_activity`

Agents cannot INSERT or UPDATE blockers. They may observe blockers on their assigned task/WP. If an agent session is blocked by an impediment it cannot resolve, the canonical signaling path is:
1. Agent emits `agent_activity` with `activity_type = 'error_raised'` or `'other'`, summarizing the impediment.
2. Agent emits `agent_activity` with `activity_type = 'approval_requested'` to signal that human attention is needed.
3. A human (dept_lead or dept_member) creates the blocker via `blocker.raise`.

The agent cannot skip step 3 and create the blocker itself.

### `execution_logs`

Blockers are not `context_type` values in `execution_logs` (`context_type` is `'request'`, `'task'`, or `'workflow'`). Blocker-related execution log entries use the blocked entity as the context:
- `context_type = 'task'`, `context_id = <task_id>` for task blockers
- `context_type = 'task'` for work-packet blockers (the task associated with the work packet)
- `event_type = 'state_change'` for all lifecycle events (raise, advance, resolve, won_t_fix, reopen)

---

## 17. Realtime Relationship

### Documented Intent

`blockers` is named in the MVP realtime publication set in three places:
- `docs/supabase-runtime-data-model.md` §1: "Realtime — Pushes status changes for Tasks, Approvals, and Blockers to active sessions."
- `docs/supabase-runtime-data-model.md` §7 build-order step 28: "Realtime publication for `tasks`, `approvals`, `blockers`."
- `docs/phase-g1-auth-context-spine.md` §14: "MVP publication: `tasks`, `approvals`, `blockers`."

### Live State

Per `docs/phase-g-realtime-publication-plan.md` (verified 2026-06-24): the `supabase_realtime` publication exists (`puballtables = false`) but has **zero member tables**. `blockers` is not currently in any publication.

| Fact | Live value |
|------|-----------|
| `supabase_realtime` publication exists? | Yes |
| `blockers` in `pg_publication_tables`? | **No** |
| RLS enabled on `blockers`? | Yes (`rls_enabled = true`) |
| Replica identity | `default` (PK only) |

### When Enabled

When realtime is enabled (per the realtime plan — deferred until a frontend subscriber exists), blockers will stream change events under the existing SELECT RLS policy:
- A dept lead/member subscriber receives INSERT and UPDATE events for blockers in their department only.
- An agent subscriber receives INSERT and UPDATE events for blockers on their assigned task/WP only (via the two-hop EXISTS join).
- The dominant event is UPDATE (status transitions). INSERT matters (new blocker appearing). DELETE events are not meaningful (authenticated path uses soft-delete, which is an UPDATE).

**No new policy is needed** when realtime is enabled — `blockers_select_department_scope` is the realtime authorization model.

**Realtime is not live.** Any frontend or agent code that assumes a live blocker subscription channel is subscribing to a dead channel until `ALTER PUBLICATION supabase_realtime ADD TABLE public.blockers` is executed and the §9 verification plan of the realtime plan is run.

---

## 18. API Operation Catalog

Each operation: Purpose / Inputs / Outputs / Auth / RLS expectations / Failure modes / Audit / Approval.

---

### 18.1 `blocker.raise`

- **Purpose:** Create a new blocker signaling an impediment.
- **Inputs:** `department_id`, `description`, `blocked_entity_type`, `blocked_entity_id`, `severity` (opt.), `assigned_to_user_id` (opt.)
- **Outputs:** Created blocker row (`status = 'open'`).
- **Auth:** `org_admin`, `dept_lead`, `dept_member`. Agents → 42501.
- **RLS:** `blockers_insert_department_scope` WITH CHECK enforces status='open', self-pin, entity dept alignment.
- **Failure modes:** entity cross-dept → 42501; unknown entity → 42501; entity type 'project' → CHECK violation; agent/read_only caller → 42501.
- **Side effects:** task.status → 'blocked' (Layer 4); optional notification job enqueue.
- **Audit:** execution_log `state_change` on the blocked entity.
- **Approval:** None (Category C).

---

### 18.2 `blocker.get`

- **Purpose:** Retrieve a single blocker by id.
- **Inputs:** `id`.
- **Outputs:** Blocker row or `not_found`.
- **Auth:** All roles (RLS scoped).
- **RLS:** `blockers_select_department_scope`.
- **Failure modes:** not visible → `not_found` (no existence leak).
- **Audit:** None required.
- **Approval:** None.

---

### 18.3 `blocker.list`

- **Purpose:** List blockers, optionally filtered by entity, status, severity, or assignee.
- **Inputs:** Filters (all optional): `blocked_entity_type`, `blocked_entity_id`, `status[]`, `severity[]`, `assigned_to_user_id`.
- **Outputs:** Array of blocker rows visible to caller; ordered by `created_at DESC`.
- **Auth:** All roles (RLS scoped).
- **RLS:** `blockers_select_department_scope`.
- **Failure modes:** No results for out-of-scope entity → empty array (not error).
- **Audit:** None.
- **Approval:** None.

---

### 18.4 `blocker.investigate`

- **Purpose:** Advance status from `open` (or `pending_external`) to `investigating`.
- **Inputs:** `id`.
- **Outputs:** Updated blocker row.
- **Auth:** `org_admin`, `dept_lead`, `dept_member`. Agents/read_only → 42501.
- **RLS:** `blockers_update_department_scope`.
- **Failure modes:** invalid source status → `conflict`; agent caller → 42501; already investigating → `conflict`.
- **Audit:** execution_log `state_change`.
- **Approval:** None (Category C).

---

### 18.5 `blocker.await_external`

- **Purpose:** Advance status to `pending_external` (blocked on outside party).
- **Inputs:** `id`; `description` update optional (to note external party).
- **Outputs:** Updated blocker row.
- **Auth:** `org_admin`, `dept_lead`. `dept_member` → `forbidden` (Layer 4 narrowing — declaring external dependency is a lead decision).
- **RLS:** `blockers_update_department_scope` (DB permits dept_member; Layer 4 restricts further).
- **Failure modes:** already `pending_external` → `conflict`; terminal status → `conflict`.
- **Audit:** execution_log `state_change`.
- **Approval:** None.

---

### 18.6 `blocker.assign`

- **Purpose:** Set or change `assigned_to_user_id`.
- **Inputs:** `id`; `assigned_to_user_id` (uuid or null to unassign).
- **Outputs:** Updated blocker row.
- **Auth:** `org_admin`, `dept_lead`, `dept_member`.
- **RLS:** `blockers_update_department_scope` WITH CHECK verifies assignee is active if set.
- **Failure modes:** assignee not active or not in org → 42501; terminal/soft-deleted blocker → not_found.
- **Audit:** execution_log `note` on the blocked entity.
- **Approval:** None.

---

### 18.7 `blocker.escalate_severity`

- **Purpose:** Update severity (e.g., `medium → critical`).
- **Inputs:** `id`; `severity`.
- **Outputs:** Updated blocker row.
- **Auth:** `org_admin`, `dept_lead`. `dept_member` permitted by DB but escalating to `critical` should be restricted to lead/admin at Layer 4.
- **RLS:** `blockers_update_department_scope`.
- **Failure modes:** invalid severity value → DB CHECK violation; terminal blocker → `conflict`.
- **Audit:** execution_log `note`.
- **Approval:** None.

---

### 18.8 `blocker.resolve`

- **Purpose:** Mark the blocker resolved; signal that the impediment is cleared.
- **Inputs:** `id`; `resolution_note` (required by application).
- **Outputs:** Updated blocker row with `status = 'resolved'`.
- **Auth:** `org_admin`, `dept_lead`, `dept_member`. Application may restrict `critical`-severity resolution to lead/admin.
- **RLS:** `blockers_update_department_scope`.
- **Side effects:** if last active blocker on task → task.status returns from 'blocked' (Layer 4).
- **Failure modes:** already terminal → `conflict`; empty `resolution_note` → `validation`; agent caller → 42501.
- **Audit:** execution_log `state_change` on entity; note resolution.
- **Approval:** None (Category C).

---

### 18.9 `blocker.accept`

- **Purpose:** Mark the blocker `won_t_fix` — accepted as permanent; work must reroute/cancel.
- **Inputs:** `id`; `resolution_note` (required).
- **Outputs:** Updated blocker row with `status = 'won_t_fix'`.
- **Auth:** `org_admin`, `dept_lead` only (Layer 4 restriction; DB permits `dept_member`).
- **RLS:** `blockers_update_department_scope`.
- **Failure modes:** already `won_t_fix` or `resolved` → `conflict`; `dept_member` caller → `forbidden` (Layer 4); empty `resolution_note` → `validation`.
- **Audit:** execution_log `state_change` on entity; note the accepted constraint.
- **Approval:** None for setting `won_t_fix` itself. Override (proceeding despite it) requires Category B Decision (§12).

---

### 18.10 `blocker.reopen`

- **Purpose:** Return a terminal blocker (`resolved` or `won_t_fix`) to `open` with updated context.
- **Inputs:** `id`; `description` update (required — must document why the blocker has recurred or the `won_t_fix` is being overridden).
- **Outputs:** Updated blocker row with `status = 'open'`.
- **Auth:** `org_admin`, `dept_lead`.
- **RLS:** `blockers_update_department_scope`.
- **Application gate for `won_t_fix → open`:** verify an approved Category B Decision exists for this blocker's task (Layer 5 check against `approvals` and `decisions`). Reopen without approved decision → `approval_required`.
- **Failure modes:** caller not lead/admin → `forbidden`; `won_t_fix → open` without approved override decision → `approval_required`; non-terminal status → `conflict`.
- **Side effects:** task.status → 'blocked' if it had been advanced after the blocker was resolved.
- **Audit:** execution_log `state_change`; reference prior resolution and reason for reopen.
- **Approval:** Implicit — Category B Decision + Approval must exist before `won_t_fix` reopen.

---

### 18.11 `blocker.soft_delete`

- **Purpose:** Remove a blocker from all authenticated views by setting `deleted_at`.
- **Inputs:** `id`.
- **Outputs:** Updated row (now invisible to authenticated roles).
- **Auth:** `org_admin`, `dept_lead` (application restriction; DB permits `dept_member` UPDATE).
- **RLS:** `blockers_update_department_scope` (`deleted_at IS NULL` in USING means soft-deleted rows are already invisible — this operation must be performed while the blocker is still visible).
- **Failure modes:** already soft-deleted → `not_found` (invisible); caller is dept_member → `forbidden` (Layer 4).
- **Audit:** execution_log `state_change` on entity noting blocker removal.
- **Approval:** None.
- **Caution:** If task had `status = 'blocked'` due to this blocker, soft-deleting it without resolving requires the application to re-evaluate remaining blockers and advance the task if appropriate.

---

## 19. Validation Rules

### DB-Enforced (Always Checked)

| Rule | Mechanism |
|------|-----------|
| `description` not empty | `blockers_description_not_empty` CHECK |
| `blocked_entity_type ∈ {task, work_packet}` | `blockers_blocked_entity_type_check` CHECK |
| `severity ∈ {low, medium, high, critical}` | `blockers_severity_check` CHECK |
| `status ∈ {open, investigating, pending_external, resolved, won_t_fix}` | `blockers_status_check` CHECK |
| `status = 'open'` at INSERT | `blockers_insert_department_scope` WITH CHECK |
| `reported_by_user_id = current_user_id()` at INSERT | `blockers_insert_department_scope` WITH CHECK |
| Entity belongs to same `department_id` | RLS EXISTS clause (INSERT + UPDATE) |
| `organization_id` from context, not client | `private.current_organization_id()` in all policies |
| Reporter not deleted (soft-delete safe) | `reported_by_user_id` RESTRICT FK |

### Application-Enforced (Layer 4, Not DB-Checked)

| Rule | When enforced |
|------|--------------|
| Status transition validity (per §5) | All UPDATE operations |
| `resolution_note` required at `resolved` / `won_t_fix` | `blocker.resolve`, `blocker.accept` |
| `won_t_fix` only by lead/admin | `blocker.accept` |
| `won_t_fix → open` requires approved Category B Decision | `blocker.reopen` (Layer 5) |
| `pending_external` only by lead/admin | `blocker.await_external` |
| `critical` severity change only by lead/admin | `blocker.escalate_severity` |
| Task `status → 'blocked'` on raise | `blocker.raise` |
| Task `status` restored on last-blocker resolve | `blocker.resolve`, `blocker.soft_delete` |
| `assigned_to_user_id` must be in same org | Validated before UPDATE |
| `blocked_entity_type = 'project'` → rejected | Layer 4 guard (before DB write, for clear error message) |

---

## 20. Error Model

Per G1 §19 (invisibility rule applies — unauthorized reads resolve to `not_found`).

| Error | HTTP | Trigger |
|-------|------|---------|
| `unauthenticated` | 401 | Missing/invalid JWT; null `current_user_id` |
| `not_found` | 404 | Blocker not visible under RLS (default for unauthorized reads) |
| `forbidden` | 403 | Caller can see the blocker (e.g., read_only) but lacks mutation rights; OR dept_member attempting `won_t_fix` / `pending_external` |
| `conflict` | 409 | Illegal status transition; attempt to mutate terminal/soft-deleted blocker |
| `approval_required` | 409 | `won_t_fix → open` without approved Category B Decision |
| `validation` | 422 | Empty `resolution_note`; invalid severity value; empty description; `blocked_entity_type = 'project'` |
| `internal` | 500 | Unexpected DB error |

**Invisibility rule applied:**
- An agent requesting a blocker on a non-assigned task → `not_found` (not `forbidden`).
- A `dept_member` requesting a blocker in another department → `not_found`.
- A soft-deleted blocker → `not_found` for all authenticated roles.

---

## 21. Audit Requirements

All blocker lifecycle events produce `execution_logs` entries on the **blocked entity** (not the blocker itself, since `execution_logs.context_type` does not include `'blocker'`).

### Required `execution_logs` Events

| Blocker event | `event_type` | `context_type` | Required fields |
|---------------|-------------|---------------|----------------|
| Blocker raised | `state_change` | task or task (for WP) | actor, blocker id, description, severity |
| Status advanced (investigate, external) | `state_change` | same | actor, new status |
| Blocker assigned / reassigned | `note` | same | actor, assignee user id |
| Severity changed | `note` | same | actor, old → new severity |
| Blocker resolved | `state_change` | same | actor, resolution_note |
| Blocker `won_t_fix` | `state_change` | same | actor, resolution_note |
| Blocker reopened | `state_change` | same | actor, reason for reopen; reference approved override decision id if applicable |
| Blocker soft-deleted | `state_change` | same | actor |

### Service-Role Audit

Service-role-created blockers (approval expiry path) must populate `execution_logs.actor` with a non-null value identifying the system process (e.g., `"system:approval_expiry_job"` or the original requester's user id). Anonymous service-role writes are prohibited per G1 §10.

### `audit_events`

Platform-level audit events (org-admin-visible only, service-role INSERT) should be emitted for:
- Blocker transitions that override significant gates (`won_t_fix` accept, `won_t_fix` reopen).
- Service-role-created blockers (approval expiry).
- `event_category = 'admin'`, `entity_type = 'blocker'`, `entity_id = <blocker.id>`.

---

## 22. Security Model

### Threats and Controls

| # | Threat | Control |
|---|--------|---------|
| 1 | **Agent self-creates blocker** — agent tries to signal impediment by inserting a blocker row. | `blockers_insert_department_scope` WITH CHECK excludes `agent` role → RLS 42501. Agent must use `agent_activity(activity_type='error_raised')` instead. |
| 2 | **`dept_member` accepts won_t_fix without authority** | Layer 4 check: reject `won_t_fix` transition from `dept_member`; DB permits it but API must not. |
| 3 | **`won_t_fix` override without approval gate** | Layer 5 check in `blocker.reopen`: verify approved Category B Decision before accepting `won_t_fix → open`. DB does NOT enforce this. |
| 4 | **Reporter mismatch** — caller sets `reported_by_user_id` to another user's id. | RLS WITH CHECK: `reported_by_user_id = private.current_user_id()` enforced at DB level. |
| 5 | **Cross-department blocker** — caller targets an entity in another department. | RLS EXISTS clause: entity must belong to `blockers.department_id`; cross-dept → 42501. |
| 6 | **Blocker on project entity** — `blocked_entity_type = 'project'` submitted. | DB CHECK constraint rejects it. Layer 4 should surface a clear error before the DB write. |
| 7 | **Service-role blocker without reporter** | `reported_by_user_id` is NOT NULL; service-role code must carry a valid user id. |
| 8 | **Scope injection** — `department_id` or `organization_id` supplied in request body to widen access. | `organization_id` is never trusted from client; `department_id` is validated by RLS EXISTS + dept pin. |
| 9 | **Soft-deleted blocker re-mutation** | `USING: deleted_at IS NULL` in UPDATE policy makes soft-deleted rows invisible before any mutation attempt → `not_found`. |

---

## 23. Verification Matrix

All tests use `BEGIN … ROLLBACK`. System of record is never mutated. JWT harness: `set local role authenticated; set local "request.jwt.claim.sub" = '<auth_user_id>';` where sub = `users.auth_user_id`.

| # | Area | Assertion |
|---|------|-----------|
| 1 | **SELECT — dept scope** | dept_lead A sees dept-A blockers; dept_lead B sees no dept-A blockers → empty |
| 2 | **SELECT — member scope** | dept_member sees own-dept blockers; read_only sees own-dept blockers |
| 3 | **SELECT — agent task** | agent sees blocker on assigned task; agent does NOT see blocker on unassigned task in same dept |
| 4 | **SELECT — agent WP** | agent sees blocker on work_packet linked to their assigned task (two-hop join); no assigned task → no WP blockers visible |
| 5 | **SELECT — soft-delete invisible** | blocker with `deleted_at IS NOT NULL` → returns zero rows for all authenticated roles |
| 6 | **INSERT — dept_member can raise** | dept_member inserts blocker on dept task → succeeds; status='open', reported_by = caller |
| 7 | **INSERT — agent excluded** | agent INSERT → RLS 42501 |
| 8 | **INSERT — read_only excluded** | read_only INSERT → RLS 42501 |
| 9 | **INSERT — status != 'open'** | INSERT with `status='investigating'` → RLS 42501 (WITH CHECK fails) |
| 10 | **INSERT — reporter mismatch** | INSERT with `reported_by_user_id` set to another user → RLS 42501 |
| 11 | **INSERT — cross-dept entity** | Dept-A caller raises blocker on dept-B task → RLS 42501 (entity EXISTS fails) |
| 12 | **INSERT — blocked_entity_type='project'** | INSERT → DB CHECK violation |
| 13 | **INSERT — inactive assignee** | `assigned_to_user_id` pointing to suspended user → RLS 42501 |
| 14 | **UPDATE — dept_member can advance** | dept_member updates `status = 'investigating'` → succeeds |
| 15 | **UPDATE — agent excluded** | agent UPDATE → RLS 42501 |
| 16 | **UPDATE — read_only excluded** | read_only UPDATE → 0 rows (USING fails) |
| 17 | **UPDATE — cross-dept** | dept_lead in dept A updating dept-B blocker → 0 rows |
| 18 | **`won_t_fix` without approved decision (gate test)** | `blocker.reopen` on a `won_t_fix` blocker without an approved Category B Decision on the task → `approval_required` (Layer 5 application check — the DB itself permits the update) |
| 19 | **`won_t_fix` by dept_member** | Layer 4 rejects; DB would permit → `forbidden` from API |
| 20 | **Resolution requires note** | `blocker.resolve` with empty or null `resolution_note` → `validation` (Layer 4) |
| 21 | **Invalid transition** | `resolved → investigating` → `conflict` (Layer 4) |
| 22 | **Task.status coordination** | raise blocker on task → task.status = 'blocked'; resolve last blocker → task.status returns from 'blocked' (Layer 4 application behavior, separate API call) |
| 23 | **Service-role creation** | Service-role INSERT of blocker without RLS → succeeds; `reported_by_user_id` must be valid user → verified by RESTRICT FK |
| 24 | **Soft-delete then re-mutate** | soft-delete blocker; attempt UPDATE → `not_found` (deleted_at IS NULL check in USING) |
| 25 | **Realtime** | `SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime'` → zero rows including `blockers` (publication empty; realtime deferred) |

---

## 24. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **`won_t_fix` override without gate** — DB allows the reopen; an implementer who skips the Layer 5 approval check can proceed without an approved override decision, making high-risk constraint overrides invisible. | High | `blocker.reopen` must always perform the Layer 5 check (test #18). The gap is explicit by design: the DB records; the API enforces. |
| 2 | **Task stays `blocked` after last blocker resolved** — if the Layer 4 task-status coordination is omitted, tasks remain in `blocked` state indefinitely even when all blockers are cleared. | High | `blocker.resolve` and `blocker.soft_delete` must query remaining open blockers before advancing task status. |
| 3 | **`dept_member` setting `won_t_fix`** — RLS permits it; Layer 4 must explicitly reject it. If Layer 4 is omitted, members can accept permanent constraints without lead authority. | Medium | Explicit Layer 4 check in `blocker.accept`; covered by test #19. |
| 4 | **Service-role blocker without valid reporter** — `reported_by_user_id` is NOT NULL + RESTRICT; if the service-role code carries a stale or non-existent user id, the INSERT will fail the FK constraint, silently dropping the blocker creation. | Medium | Service-role code must validate the reporter user id before insert; monitor for FK failures in DLQ entries. |
| 5 | **`blocked_entity_type = 'project'` confusion** — system-entities.md §13 includes `project` as a valid blocked entity type, but the deployed DB CHECK excludes it. Implementers reading the conceptual doc may attempt project blockers. | Medium | Layer 4 must check and return a clear `validation` error before the DB write. Document the deferral explicitly (§2 Out of Scope). |
| 6 | **`blocker_research_assets` referenced in code** — the runtime data model lists this junction table; it is not deployed. Any code trying to JOIN or INSERT to it will fail. | Low | Document the deviation (§2). No code should reference this table until the migration is authored. |
| 7 | **Stale `won_t_fix` blockers blocking future work** — a `won_t_fix` blocker from a cancelled task may remain and make a re-created or re-routed task appear blocked. | Low | Service-role or admin tooling should soft-delete `won_t_fix` and `resolved` blockers when parent tasks are cancelled. |
| 8 | **Realtime client assuming live channel** — a frontend subscribing to `blockers` changes before the publication is enabled will receive no events and may silently stale. | Low | Per realtime plan: publication is deferred; clients must not assume the channel is live until the `ALTER PUBLICATION` migration runs. |

---

## 25. Dependencies

| Dependency | Relationship | Note |
|------------|-------------|------|
| **Task API (G3)** | Task.status ↔ blocker lifecycle coordination; `tasks.blocked_entity_id` cross-check | Task `status = 'blocked'` is driven by Blocker API (Layer 4). G3 §12 completion gate queries blockers. G3 §16 Decision flow references the `won_t_fix` override Category B path. |
| **Work Packet API (G4)** | WP blockers surfaced on in_execution work packets | G4 must surface open blockers before permitting work-packet execution; no status auto-coordination (WP has no 'blocked' status). |
| **Approval API (G5)** | Expired approval → blocker (service-role); won_t_fix override → Category B Decision → Approval | The Approval API's expiry path writes blockers. The Blocker API's reopen path validates an approval exists. |
| **Decision API (G7)** | `won_t_fix` override requires Category B Decision on the task | `blocker.reopen` performs a Layer 5 check for an approved `decisions` row with `task_id = blocked_entity_id` and `status = 'approved'` tracing through a resolved Category B approval. |
| **Auth spine (G1)** | All `private.*` helper functions; five-layer auth model; error model | Blocker API inherits invisibility rule (not_found default), service-role boundary, and audit contract from G1. |
| **Realtime plan** | Realtime is deferred; blockers are in documented set | Enable mechanics documented in `phase-g-realtime-publication-plan.md`. Do not enable until a frontend subscriber exists. |
| **`018_runtime_hardening.sql`** | `background_jobs` for notification and approval-expiry paths | `related_task_id` FK; no `related_blocker_id`. Blocker-related jobs link to the blocked task. |
| **`013_phase_d_rls_policies.sql`** | All three blocker RLS policies (verified live, unchanged by any later migration) | No later migration modified these policies. They are the live contract. |

---

## 26. MVP Build Order

1. **Read surface** — `blocker.get` and `blocker.list` under `blockers_select_department_scope`. Proves dept-scope and agent-assigned visibility (including the WP two-hop join). Lowest risk.
2. **Raise** — `blocker.raise` (INSERT) with entity-dept cross-check, self-pin, status='open' enforcement. Confirms `blockers_insert_department_scope`.
3. **Task.status coordination** — wire `tasks.status → 'blocked'` on raise and task restoration on resolve. This is the primary user-visible effect; verify atomicity.
4. **Status machine** — `blocker.investigate`, `blocker.await_external`, `blocker.resolve`. Confirms `blockers_update_department_scope` and Layer 4 transition validity.
5. **`won_t_fix` path** — `blocker.accept` with lead-only Layer 4 enforcement; confirm `dept_member` → `forbidden`.
6. **`won_t_fix` override gate** — `blocker.reopen` from `won_t_fix` with Layer 5 check for approved Category B Decision. This is the highest-risk gate (test #18).
7. **Assignment and severity** — `blocker.assign`, `blocker.escalate_severity`. Lower risk; confirm active-assignee check.
8. **Soft-delete** — `blocker.soft_delete` with lead/admin restriction; verify invisibility after deletion.
9. **Service-role creation** — approval-expiry → blocker (service-role INSERT). Verify `reported_by_user_id` is set and RESTRICT FK validates.
10. **Audit wiring** — `execution_logs` for all lifecycle events; `audit_events` for high-risk transitions.
11. **Realtime** — deferred; enable per the realtime plan when a frontend subscriber exists.

Steps 1–3 establish the core contract and the primary user-visible behavior (task blocking). Steps 4–6 complete the lifecycle governance. Steps 7–11 finish the operational, security, and async surfaces.

---

## 27. Definition of Done

The Blocker API is complete when **all** hold:

- [ ] `blocker.raise` succeeds for `dept_member`, `dept_lead`, `org_admin` on own-department entities; agent and `read_only` callers → RLS 42501.
- [ ] INSERT is rejected by DB for `status != 'open'`; `blocked_entity_type = 'project'` → CHECK violation with clear Layer 4 error surfaced before DB write.
- [ ] `blocker.raise` atomically advances `tasks.status → 'blocked'` when the blocked entity is a task.
- [ ] `blocker.resolve` restores task status from `'blocked'` when the resolved blocker is the last active one.
- [ ] Status machine transitions are validated at Layer 4; illegal transitions → `conflict`.
- [ ] `won_t_fix` is restricted to `org_admin` and `dept_lead` at Layer 4; `dept_member` attempt → `forbidden`.
- [ ] `blocker.reopen` from `won_t_fix` performs the Layer 5 check for an approved Category B Decision on the task; absent decision → `approval_required`.
- [ ] `resolution_note` is required (non-empty) at `resolved` and `won_t_fix` transitions; absent → `validation`.
- [ ] Agent attempts to INSERT or UPDATE → RLS 42501.
- [ ] Soft-deleted blocker is invisible to all authenticated roles; mutation attempt → `not_found`.
- [ ] Service-role blocker creation (approval-expiry path) succeeds with a valid `reported_by_user_id` and emits an `execution_logs` entry.
- [ ] Every lifecycle event emits an `execution_logs` entry on the blocked entity.
- [ ] `audit_events` records `won_t_fix` accept, `won_t_fix` reopen, and service-role blocker creation.
- [ ] The verification matrix (§23, 25 tests) passes in `BEGIN … ROLLBACK` harness.
- [ ] No code references `blocker_research_assets` (table not deployed).
- [ ] Realtime is documented as deferred; no publication-enable step is performed.
- [ ] No new roles, schema changes, or migrations were introduced; `013_phase_d_rls_policies.sql` remains the authoritative source for all three blocker policies.
