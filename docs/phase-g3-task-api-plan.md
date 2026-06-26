# Phase G3 — Task API Plan

Architecture for the **Task API** — the execution engine of the AI Command Center, where governed intake becomes tracked, department-owned, actionable work.

> **Auth/context contract:** [phase-g1-auth-context-spine.md](phase-g1-auth-context-spine.md)
> **Request Intake contract:** [phase-g2-request-intake-api-plan.md](phase-g2-request-intake-api-plan.md)
> **API layer plan:** [phase-g-api-application-layer-plan.md](phase-g-api-application-layer-plan.md)
> **Canonical entity:** [system-entities.md](system-entities.md) §4 Task
> **Approval gates:** [approval-rules.md](approval-rules.md)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)
> **Schema origin:** `supabase/migrations/007_execution_layer.sql` (table), `009_phase_c_rls_policies.sql` (RLS), `010_phase_c_rls_adjustments.sql` (request policy tightening)
> **Governance layer:** `supabase/migrations/011_governance_layer.sql`
> **Knowledge/output layer:** `supabase/migrations/014_knowledge_output_layer.sql`
> **Runtime layer:** `supabase/migrations/018_runtime_hardening.sql`, `020_phase_f_rls_policies.sql`

This document is **architecture only**. No code, routes, Edge Functions, migrations, schema changes, or frontend. It describes how the API exposes the deployed `tasks` substrate (migrations `001`–`020`) under the verified auth/context spine.

---

## Grounding Facts (from the deployed schema)

**Table:** `public.tasks` — columns:

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| `id` | uuid | NO | gen_random_uuid() |
| `organization_id` | uuid | NO | — |
| `title` | text | NO | — |
| `project_id` | uuid | NO | — |
| `department_id` | uuid | NO | — |
| `request_id` | uuid | YES | null |
| `work_packet_id` | uuid | YES | null |
| `workflow_id` | uuid | YES | null |
| `tool_profile_id` | uuid | YES | null |
| `priority` | text | NO | `'normal'` |
| `assigned_to_user_id` | uuid | YES | null |
| `created_by` | uuid | NO | — |
| `status` | text | NO | `'backlog'` |
| `created_at` | timestamptz | NO | now() |
| `updated_at` | timestamptz | NO | now() |
| `deleted_at` | timestamptz | YES | null |

**`status` ∈** `{backlog, ready, in_progress, blocked, in_review, done, cancelled}`; default `backlog`.
**`priority` ∈** `{low, normal, high, critical}`; default `normal`.
**No `description`, `body`, or `metadata` column.** Extended specification detail lives in the linked Work Packet.

**Required FKs (NOT NULL):** `organization_id → organizations`, `project_id → projects` (on delete restrict), `department_id → departments` (on delete restrict), `created_by → users` (on delete restrict).

**Optional FKs (nullable):** `request_id → requests` (on delete set null), `work_packet_id → work_packets` (on delete set null), `workflow_id → workflows` (on delete set null), `tool_profile_id → tool_profiles` (on delete set null), `assigned_to_user_id → users` (on delete set null).

**RLS (`009`):** Two SELECT policies (dept-scope + agent-assigned), one INSERT policy (excludes agent and read_only), one UPDATE policy (excludes agent and read_only). No authenticated DELETE policy.

**No authenticated hard DELETE.** Retirement via `deleted_at` (soft-delete, org_admin only).

**Realtime:** `tasks` is in the MVP realtime publication (confirmed in `supabase-runtime-data-model.md` §7, migration phase F step 28).

---

## 1. Purpose

The Task API converts governed intake and project scope into **department-owned, status-tracked units of executable work**. Tasks are the primary subject for decisions, outputs, blockers, approvals, agent activity, execution logs, and knowledge records. Every material downstream artifact in the AI Command Center traces to a task.

The Task API's discipline is the spine's discipline: authenticate the caller, derive organization/department/role through `private.*`, and let RLS enforce visibility and mutation rights. The API adds status-machine governance, assignment orchestration, approval-gate integration, and the bridges to work packets, outputs, decisions, and runtime — never a second authorization system.

---

## 2. Scope

**In scope:** create/read/update tasks; the full status machine from `backlog` through `done`/`cancelled`; assignment to users and agents; department routing; work packet, decision, output, knowledge, runtime, and agent-activity bridges; approval gate integration for Category A/B task-scoped actions; realtime subscription for status/assignment changes.

**Out of scope:** the internals of the Work Packet, Decision, Approval, Output, Knowledge Record, and Agent Activity APIs (each defined in their own Phase G sub-plans); schema changes; new roles; any RLS modification. This plan consumes the existing `tasks` RLS exactly as deployed.

---

## 3. Design Principles

| # | Principle | Consequence |
|---|-----------|-------------|
| 1 | **Tasks are department-scoped** | Unlike requests, task SELECT is department-bound — a member in dept A cannot see dept B's tasks. The API must never widen visibility beyond what RLS enforces (§7). |
| 2 | **Every task requires a project and department at creation** | `project_id` and `department_id` are NOT NULL. No floating or unowned tasks exist. |
| 3 | **Agents execute tasks; they do not create or update them** | The INSERT and UPDATE policies exclude the `agent` role. Agents signal completion through execution logs and outputs; human roles advance task status. |
| 4 | **Agent task visibility is assignment-gated** | Agents see only tasks where `assigned_to_user_id = private.current_user_id()`. An unassigned agent sees zero tasks. |
| 5 | **Status machine is application-enforced; RLS governs who may write** | RLS does not encode which transitions are legal. The API (Layer 4) rejects illegal transitions; RLS (Layer 3) confirms the caller may write the row. |
| 6 | **Approval gates activate at high-risk transitions, not routine status changes** | Creating a task, advancing backlog→ready→in_progress, and assignment changes are Category C (log-only). Specific tool actions, external delivery, and infrastructure operations are Category A/B. |
| 7 | **Tasks are in the MVP realtime publication** | Status and assignment changes stream to subscribers in real time. Realtime scope is RLS-filtered: department-scoped for human roles, assignment-filtered for agents. |
| 8 | **Soft-delete only** | No authenticated hard DELETE. Retirement is `deleted_at` (org_admin only). |

---

## 4. Task Lifecycle

```text
   inbound scope (from request, work packet, or direct creation)
            │
            ▼
   create  ──►  status = 'backlog'           (department-owned; unstarted)
            │
   scope confirmed ──►  status = 'ready'     (acceptance criteria clear; unblocked)
            │
   work begins ──►  status = 'in_progress'   (active execution)
            │                │
            │                ▼
            │             blocked             (impediment raised; links a Blocker)
            │                │
            │       blocker resolved
            │                │
            └────────────────┘
            │
   work complete ──►  status = 'in_review'   (awaiting verification or approval)
            │
   accepted ──►  status = 'done'             (terminal; fulfilled)
            
   (from any non-terminal)
   cancelled ──►  status = 'cancelled'       (terminal; withdrawn)
```

A task's status represents *execution state*, not the state of its child outputs or approvals. A task may be `in_review` while its output approval is still `pending`. The API must not conflate task status with the status of its artifacts.

---

## 5. Task State Machine

| From | To | Who may trigger | Approval required | Notes |
|------|-----|-----------------|-------------------|-------|
| `backlog` | `ready` | dept_lead, dept_member, org_admin | No (Category C) | Scope and acceptance criteria confirmed |
| `backlog` | `in_progress` | dept_lead, dept_member, org_admin | No (Category C) | Skip-ready when criteria already clear |
| `ready` | `in_progress` | dept_lead, dept_member, org_admin | No (Category C) | Work begins |
| `in_progress` | `blocked` | dept_lead, dept_member, org_admin | No (Category C) | Must link an active Blocker row |
| `blocked` | `in_progress` | dept_lead, dept_member, org_admin | No (Category C) | Blocker must be resolved first |
| `in_progress` | `in_review` | dept_lead, dept_member, org_admin | No (Category C); upstream actions may have gated approvals | Work submitted; awaiting review |
| `in_review` | `in_progress` | dept_lead, dept_member, org_admin | No (Category C) | Review returned for rework |
| `in_review` | `done` | dept_lead, org_admin | **Category A/B** if required output/decision gate is open | All required approvals must be resolved |
| `any non-terminal` | `cancelled` | dept_lead, org_admin | No | Cancellation is terminal; requires lead or admin |

**Agents are absent from this table:** the `tasks` UPDATE policy (`009`) does not include the `agent` role. Agents advance work by producing outputs and execution logs; human roles or org_admin drive task status forward.

Transition legality is enforced by the API (Layer 4). The API must reject:
- Any terminal → non-terminal transition
- Any transition not in the table above
- `blocked → done` (must unblock before review/completion)
- `in_review → done` with outstanding required approvals (Category A/B check)

---

## 6. Task Ownership Model

- **`created_by`:** the creating user's `id`, self-pinned on INSERT (`created_by = private.current_user_id()`). Permanently recorded; never changes. The creator is not an "owner" in the update-authority sense — ownership is department-level.
- **`department_id`:** the accountable department. Required (NOT NULL). All RLS SELECT/UPDATE scope flows from this column. Changing it re-routes the task to a new department (§11).
- **`project_id`:** the containing project. Required (NOT NULL). Provides the organizational context for outputs, work packets, and billing/reporting. Must be org-local.
- **`assigned_to_user_id`:** the current assignee — the human or agent executing the task. Nullable; changes over time. **Agent visibility is gated entirely on this column** — an agent has no task visibility until this is set to their user id.
- **No submitter edit-rights:** unlike `requests`, tasks have no submitter-retention branch in the UPDATE policy. Only `org_admin` or the task's department lead/member may update task fields.

---

## 7. Task Visibility Model

> **CRITICAL DIFFERENCE FROM REQUESTS:** Task SELECT is **department-scoped**, not org-wide. A member in department A cannot see department B's tasks. An agent sees only tasks explicitly assigned to them. This is the fundamental design difference between the `requests` and `tasks` entities, and it must be honored in every read operation, filter, list endpoint, and realtime subscription.

**Authoritative policies (from `009`):**

`tasks_select_dept_scope` (applies to org_admin, department_lead, department_member, read_only):
```text
organization_id = private.current_organization_id()
and deleted_at is null
and (
  private.current_role() = 'org_admin'
  or (
    private.current_role() in ('department_lead', 'department_member', 'read_only')
    and department_id = private.current_department_id()
  )
)
```

`tasks_select_agent_assigned` (applies to agent role only — separate policy):
```text
private.current_role() = 'agent'
and organization_id = private.current_organization_id()
and assigned_to_user_id = private.current_user_id()
and deleted_at is null
```

**Visibility matrix:**

| Role | Sees | Policy |
|------|------|--------|
| `org_admin` | All non-deleted tasks in the organization | `tasks_select_dept_scope` |
| `department_lead` | All non-deleted tasks in **own department only** | `tasks_select_dept_scope` |
| `department_member` | All non-deleted tasks in **own department only** | `tasks_select_dept_scope` |
| `read_only` | All non-deleted tasks in **own department only** (read only) | `tasks_select_dept_scope` |
| `agent` | **Only tasks where `assigned_to_user_id = own user id`** | `tasks_select_agent_assigned` |
| null context | None | — |

**Contrast with requests:**

| | `requests` | `tasks` |
|---|------------|---------|
| SELECT scope | **Org-wide** — any member sees all org requests | **Dept-scoped** — each role sees own dept only |
| Agent SELECT | All org requests | **Only assigned tasks** |
| read_only SELECT | All org requests | Own dept tasks |
| Initial state rationale | Requests may exist before routing → must be visible for triage | Tasks always have a department from creation → no triage discovery needed |

**API rule:** the Task API must not add application-level filters that narrow task reads below what RLS already enforces — and it must not add any filter that widens them. `task.list` reflects exactly what RLS surfaces.

**Visibility after re-routing:** if a task's `department_id` is changed (§11), the old department's lead/member/read_only immediately lose visibility; the new department's lead/member immediately gain it. The org_admin and the assigned agent (if any) see it throughout.

---

## 8. Task Creation Contract

- **Purpose:** create a new task at `backlog` (or `ready` if scope is already clear).
- **Inputs:** `title` (non-empty), `project_id`, `department_id`, `priority` (default `normal`), `status` (`backlog` or `ready` only); optional `request_id`, `work_packet_id`, `workflow_id`, `tool_profile_id`, `assigned_to_user_id`. `organization_id` is JWT-derived; `created_by` is self-pinned.
- **Outputs:** created task `id`, `status`, `created_by`, timestamps.
- **Auth requirements:** authenticated; role ∈ `{org_admin, department_lead, department_member}`. **Agents cannot create tasks.** `read_only` cannot create tasks.
- **RLS expectations:** `tasks_insert_dept_scope` — org pin; `created_by = current_user_id()`; role check; for non-admin, `department_id = current_department_id()`; all FKs org-local and live.
- **Failure modes:** agent attempt → `forbidden` (role excluded from INSERT policy); read_only attempt → `forbidden`; missing `project_id`/`department_id` → `validation`; non-admin providing cross-dept `department_id` → RLS reject; foreign refs → RLS reject; non-`{backlog,ready}` initial status → `validation` (Layer 4).
- **Audit requirements:** `execution_logs` (`context_type='task'`, `event_type='state_change'`, `actor=created_by`, summary "task created at {status}"); `request_id` and `work_packet_id` captured in metadata if set.
- **Approval requirements:** none (Category C).

---

## 9. Task Update Contract

- **Purpose:** amend a task's `title`, `priority`, or link fields (`tool_profile_id`, `work_packet_id`, `workflow_id`) within permitted bounds. Status changes go through dedicated operations (§10–§12).
- **Inputs:** task `id`; mutable fields.
- **Outputs:** updated task row.
- **Auth requirements:** authenticated; role ∈ `{org_admin, department_lead, department_member}` in the task's department.
- **RLS expectations:** `tasks_update_dept_scope` USING (org pin; role check; `department_id = current_department_id()` for non-admin) + WITH CHECK (same). Agents are not in the USING clause → invisible row → 0 rows affected.
- **Failure modes:** agent attempt → `not_found` (invisible to UPDATE); read_only attempt → `not_found`; cross-dept non-admin → `not_found`; status change via update (not via dedicated op) → `conflict` (Layer 4); foreign FK refs → RLS reject; `organization_id` change attempt → rejected by WITH CHECK.
- **Audit requirements:** `execution_logs` `state_change` with changed fields.
- **Approval requirements:** none for field-level updates. Status-advancing operations (§10–§12) may carry gates.

---

## 10. Task Assignment Contract

- **Purpose:** set or change `assigned_to_user_id` — the user or agent who will execute the task.
- **Inputs:** task `id`, `assigned_to_user_id` (active org member, or `null` to unassign).
- **Outputs:** updated task with `assigned_to_user_id` set.
- **Auth requirements:** org_admin or the task's department lead/member.
- **RLS expectations:** UPDATE policy same as §9. Target `assigned_to_user_id` must be an active org member (enforced in WITH CHECK of the INSERT policy; the API must validate the same for UPDATE). Assigning an agent who is in a different organization → reject.
- **Failure modes:** assigning to a non-active or foreign-org user → `validation`; unauthorized actor → `not_found`/0 rows.
- **Side effects:** when `assigned_to_user_id` is set to an agent's user id, the task immediately becomes visible to that agent via `tasks_select_agent_assigned`. When unassigned or changed to a different user, the previous agent loses visibility immediately.
- **Audit requirements:** `execution_logs` `note` capturing old and new assignee.
- **Approval requirements:** none (Category C).

---

## 11. Task Routing Contract

- **Purpose:** re-route a task to a different department by changing `department_id`. This is a significant action: it transfers ownership, changes all RLS visibility, and may change the tool profile context.
- **Inputs:** task `id`, `department_id` (new owning department, org-local and live).
- **Outputs:** updated task at new `department_id`.
- **Auth requirements:** org_admin only. Department leads and members cannot self-route tasks to other departments. (Only org_admin may perform cross-department updates — the USING clause for non-admin requires `department_id = private.current_department_id()`, which would fail for the new department on the post-update row.)
- **RLS expectations:** org_admin branch of `tasks_update_dept_scope`. The API must validate the target department is org-local and live.
- **Failure modes:** non-admin attempt → `forbidden` (Layer 4 check before write, since the WITH CHECK would reject it); foreign `department_id` → reject; routing to the same department → no-op / `conflict` (Layer 4).
- **Visibility effect:** old dept lead/member/read_only immediately lose SELECT access; new dept lead/member immediately gain it. The assigned agent (if any) retains visibility through `tasks_select_agent_assigned` regardless of department change.
- **Audit requirements:** `audit_events` (`event_category='admin'`, `entity_type='task'`, `entity_id=task.id`) + `execution_logs` `state_change` with old/new department.
- **Approval requirements:** none to re-route. Downstream actions in the new department follow that department's approval policy.

---

## 12. Task Completion Contract

- **Purpose:** drive a task to a terminal state — `done` or `cancelled`.
- **Inputs:** task `id`, terminal status, optional reason (via audit metadata).
- **Outputs:** task at `done` or `cancelled`.
- **Auth requirements:**
  - `done`: org_admin or the task's department lead. `department_member` may advance to `in_review` but the final `done` transition is lead/admin-gated (Layer 4 rule; RLS permits dept_member UPDATE but the app requires at least `department_lead` for terminal acceptance).
  - `cancelled`: org_admin or the task's department lead.
- **RLS expectations:** `tasks_update_dept_scope` — same role/dept check as §9. The `done`/`cancelled` authority distinction is a Layer 4 rule, not a separate RLS policy.
- **Failure modes:** attempting `done` with an open required output approval → `approval_required` (Layer 5); attempting `done` from `backlog`/`ready`/`blocked`/`in_progress` (not `in_review`) → `conflict`; cancelling a terminal task → `conflict`; non-lead dept_member attempting final `done` → `forbidden` (Layer 4).
- **Audit requirements:** `execution_logs` `state_change` with terminal status and, for cancellation, the reason.
- **Approval requirements:** `done` requires all pending Category A/B approvals on the task's outputs and decisions to be resolved (checked at Layer 5). The task itself does not require an approval to move to `done`; the *artifacts it produced* must be cleared.

---

## 13. Approval Gate Interactions

Per [approval-rules.md](approval-rules.md), task **creation and routine status advancement are Category C (autonomous, log-only)**. Approval gates activate at specific high-risk *actions* performed during task execution, or when a child artifact (decision, output) is gated.

### Category A — Always Required (no task status change is autonomous when these actions occur)

| Action | `subject_type` | `approver_role` | When it occurs |
|--------|---------------|-----------------|----------------|
| Emit webhook to production target | `task` | Engineering lead | Agent/automation attempts webhook emit during task |
| Execute destructive shell command | `task` | Engineering lead | Agent attempts destructive shell during task |
| Commit to protected branch | `task` | Engineering lead | Agent or build automation attempts branch commit during task |
| Create scheduled automation | `task` | Operations lead | Scheduling action requested within task context |
| Send external email (task-scoped) | `task` or `output` | Operations lead | Communication tool invoked in task context |
| Deliver output to external requester | `output` | Operations lead | Output moves to `delivered` (Output API gate, but blocks task `done` if open) |

### Category B — Required When Specified

| Trigger | `subject_type` | `approver_role` | Condition |
|---------|---------------|-----------------|-----------|
| Invoke tool outside assigned Tool Profile | `task` | Platform lead | `tool_profile_id` set; agent invokes unallowed tool |
| Decision moves to `pending_approval` | `decision` | Department lead | Decision requires human confirmation before taking effect |
| Work Packet `approval_required_before_start = true` | `work_packet` | Department lead | Before associated Work Packet enters `in_execution` |

### Category C — Never Required (log-only)

| Action |
|--------|
| Create task (backlog/ready) |
| `backlog → ready`, `ready → in_progress`, `in_progress → in_review` |
| `blocked → in_progress` (blocker resolved) |
| Assign/unassign `assigned_to_user_id` |
| Record execution logs, propose decisions, add knowledge records |
| Link task to research assets, work packets, request |

### `in_review → done` Gate

This transition does not itself require an approval, but the API must verify:
1. No outstanding Category A approval on any child `output` with `subject_type='output'` where `status='pending'`.
2. No `decision` with `status='pending_approval'` linked to this task (those block the work, not the task's final state, but the API should surface them as blockers before allowing `done`).

If either condition fails, return `approval_required` and surface the pending approval/decision id.

---

## 14. Task ↔ Request Flow

- **Relationship:** a task may reference its originating request via `tasks.request_id` (nullable FK, `on delete set null`). One request may spawn zero or more tasks.
- **Direction:** request → task (not reverse). The task carries the request's context; the request does not aggregate task status.
- **Flow:** when a request reaches `triaged` or `in_progress`, an authorized user creates a task with `request_id` set to the originating request's id. The Request API's `request.spawn_task` operation is the canonical bridge (G2 §19.11). The Task API receives the task creation call with `request_id` included.
- **Visibility note:** requests are org-wide visible; tasks are department-scoped. A dept A member who can see all org requests can only see the dept A task spawned from a request routed to dept A — not the dept B task spawned from the same request.
- **Auth/RLS:** task INSERT policy governs the write. The request being visible does not grant task-write rights. The creating user must have INSERT authority in the task's department.
- **Cascades:** if the parent request is soft-deleted (`deleted_at` set), `request_id` is set to null (`on delete set null`). The task is not deleted.
- **Audit:** `execution_logs` on the task ("created from request {request_id}") + execution log on the request (`→in_progress`) per G2 contract.
- **Approval:** none for the spawn. Task's own approval gates activate on task actions.

---

## 15. Task ↔ Work Packet Flow

- **Relationship:** a task may be associated with one Work Packet (`tasks.work_packet_id`, nullable FK, `on delete set null`). A Work Packet attaches to a task via `work_packets.parent_type='task'` and `work_packets.parent_id = task.id` (the polymorphic side of the relationship — multiple work packets may reference one task as a parent).
- **Semantics:** the Work Packet specifies what the task must accomplish, to what acceptance criteria, and with what constraints. Tasks with no linked Work Packet are loosely specified; tasks with a Work Packet are formally handed off.
- **Flow:** a Work Packet authored against the task (`parent_type='task'`, `parent_id=task.id`) is separately managed by the Work Packet API. The task's `work_packet_id` column points back to the *primary* Work Packet for quick lookup; additional work packets may reference the task via the polymorphic FK.
- **Auth/RLS:** Work Packet INSERT is department-scoped (same department as task). Agents cannot author work packets directly.
- **Category B gate:** if `work_packets.approval_required_before_start = true`, the work packet must reach `approved` approval status before `in_execution`. The Task API surfaces this as a gate when it attempts to advance the task to `in_progress` while the work packet is still `pending_approval`.
- **Audit:** `execution_logs` noting work packet linkage; `state_change` when the task's work packet binding changes.
- **Approval:** Category B on Work Packet (not on the task itself).

---

## 16. Task ↔ Decision Flow

- **Relationship:** decisions are **always task-scoped** — `decisions.task_id` is NOT NULL (FK, `on delete restrict`). Every recorded decision belongs to exactly one task.
- **Flow:** during task execution, dept_member/dept_lead/org_admin record decisions as they make choices. A dept lead confirms a proposed decision or routes it through `pending_approval` if the decision is high-risk. Agents cannot INSERT decision rows — they signal the need via `agent_activity` (e.g., `activity_type='decision_made'` in logs, or by requesting a human review) and an authorized human role creates the actual decision row.
- **Auth/RLS:** from `013_phase_d_rls_policies.sql` (`decisions_insert_task_scope`): decisions INSERT is restricted to `{org_admin, department_lead, department_member}` — the `agent` role is absent from the INSERT policy. Agents have SELECT-only access to decisions on their assigned tasks (`decisions_select_task_scope`).
- **Decision statuses that block task progression:** a `pending_approval` decision is a soft-blocker — the task may remain `in_progress` or `in_review`, but the API should surface the unresolved decision before allowing `done` (Category B gate, §13).
- **Cascade:** decisions FK to the task with `on delete restrict` — a task cannot be hard-deleted while decisions reference it (which is moot since hard DELETE is not granted to authenticated roles; but important for service-role paths).
- **Audit:** `execution_logs` on the task for each decision recorded, confirmed, or rejected.
- **Approval:** see §13 Category B.

---

## 17. Task ↔ Approval Flow

- **Relationship:** `approvals.subject_type='task'`, `approvals.subject_id=task.id`. The approval's `department_id` must match the task's `department_id`. Multiple approvals may target the same task for different actions.
- **Flow:** when a task action hits a Category A or B gate (§13), the API creates an approval row with `subject_type='task'`, `category='a'` or `'b'`, `trigger_reason` describing the action, and the `approver_role` from approval-rules.md. The task enters a state that prevents the gated action (e.g., agent action is flagged in execution_logs, job is not spawned) until `approvals.status='approved'`.
- **Approval → task state effects:**
  - `pending`: gated action blocked; task execution may continue on non-gated paths
  - `approved`: gated action may proceed
  - `rejected`: gated action denied; task typically moves to `blocked` with the decision recorded
  - `expired`: creates a Blocker on the task; new approval required
  - `withdrawn`: gate removed; task returns to pre-approval state
- **Auth/RLS:** from `013_phase_d_rls_policies.sql` (superseded for approvals by `017`): dept lead may approve dept-scoped approvals; agents cannot INSERT approval rows — they signal need by writing `agent_activity` with `activity_type='approval_requested'`; an authorized human role or service-role path creates the actual approval row; agents may not resolve approvals.
- **Realtime:** approvals are in the MVP realtime publication — task-approval status changes stream to subscribers automatically.
- **Audit:** `execution_logs` `approval_action` on each approval lifecycle event.

---

## 18. Task ↔ Output Flow

- **Relationship:** outputs are task-produced deliverables: `outputs.task_id` is NOT NULL and `outputs.department_id` is a direct FK (not derived via `task_id`). One task may produce zero or more outputs.
- **Direction:** task → output (not reverse). Outputs belong to tasks; tasks do not aggregate output status.
- **Department alignment:** `outputs.department_id` must be set to match the parent task's `department_id` at creation — application-enforced, not DB-enforced.
- **Flow:** during `in_progress` or `in_review`, actors create outputs under the Output API. The Output API manages its own RLS and approval gates. The Task API's completion check (§12) queries outstanding output approvals before allowing `in_review → done`.
- **Category A gate:** external output delivery (`outputs.status → delivered`) requires an `approved` approval. This is enforced by the Output API. The task remains `in_review` while any output targeting it is in `in_review`/`approved` with a pending delivery approval.
- **Audit:** `execution_logs` on the task noting "output produced" when outputs are submitted.

---

## 19. Task ↔ Knowledge Flow

- **Relationship:** knowledge records may use `subject_type='task'`, `subject_id=task.id`. The optional `project_id` on the knowledge record can scope it to the task's project for cross-entity retrieval.
- **Flow:** during or after task execution, agents and users attach knowledge records to a task — learnings, constraints, synthesis, context for future sessions. Agents creating knowledge records on assigned tasks is a Category C action (`knowledge_record_created` activity type in `agent_activity`).
- **Auth/RLS:** from `016_phase_e_rls_policies.sql` (Phase E): knowledge records scoped to a task follow the task's department scope. Agents may create knowledge records linked to tasks assigned to them.
- **Junction:** `task_research_assets` (deployed in `014`) links tasks ↔ research assets; these inform knowledge records and outputs.
- **Agent continuity:** knowledge records scoped to a task are the primary mechanism for agent memory across sessions — an agent assigned to a task may retrieve knowledge records with `subject_type='task'` and `subject_id=task.id` to reconstruct context.
- **Audit:** knowledge record creation logged; `execution_logs` note.
- **Approval:** none (Category C).

---

## 20. Task ↔ Runtime Flow

- **Relationship:** `background_jobs.related_task_id` (nullable FK, `on delete set null`). A background job carrying a `related_task_id` is visible to dept lead/members whose task's `department_id` matches the caller's department (from `020` SELECT policy).
- **Task-related job types:** `workflow_step` (task-driven workflow execution), `approval_notification` (alert when task-scoped approval changes), `output_delivery` (deliver a task's output), `webhook_emit` (task-triggered webhook), `knowledge_sync`, `other`.
- **Flow:** when the API or an agent action triggers an async operation related to a task (e.g., notify approver, emit a webhook, schedule a delivery), the job runner enqueues a `background_jobs` row with `related_task_id` set. The task API does not manage background job state directly — that is service-role territory.
- **Agent visibility to related jobs:** from `020`, an agent can SELECT `background_jobs` where `related_task_id` references a task assigned to them (`assigned_to_user_id = current_user_id()`). Agents cannot UPDATE background jobs.
- **Scheduled tasks:** `scheduled_tasks` with `owner_department_id` matching the task's dept are visible to dept lead/member/read_only (per `020`); tasks themselves are not directly linked to `scheduled_tasks`, but a scheduled trigger may spawn a task as its downstream action.
- **Audit:** background job lifecycle (queued → processing → completed/failed) is observable through the Runtime Ops API; task API surfaces job-links read-only.

---

## 21. Task ↔ Agent Activity Flow

- **Relationship:** `agent_activity.task_id` (nullable FK, `on delete set null`). When an agent is executing a task, every activity row it inserts should carry `task_id`.
- **Enforcement:** from `020_phase_f_rls_policies.sql` (verified in Phase F testing): the `agent_activity_insert_agent_self` WITH CHECK requires that if `task_id` is set, the referenced task must be assigned to the inserting agent (`tasks.assigned_to_user_id = private.current_user_id()`). An agent cannot log activity against a task that is not assigned to it.
- **Visibility:** dept lead/member can see agent_activity rows where `task_id` is in their department (from `020`). `read_only` cannot see `agent_activity` (per G1 §9 verified exclusion). Agents see only their own rows.
- **Session model:** an agent's execution of a task is grouped by `session_id`. The session begins with `activity_type='session_start'` and ends with `'session_end'`. All tool calls, decisions, knowledge record creations, and outputs during that session carry the same `session_id` and `task_id`.
- **Agent activity types on tasks:** `tool_call`, `decision_made`, `knowledge_record_created`, `output_produced`, `approval_requested`, `error_raised`, `session_start`, `session_end`, `other`.
- **Linkage:** `agent_activity.execution_log_id` is a soft reference (no FK) linking to the corresponding `execution_logs` row for cross-audit traceability.
- **Audit:** agent_activity is append-only; no UPDATE policy exists. The task API references agent_activity for observability but does not write to it.

---

## 22. API Operations Catalog

Each operation uses the 8-field template: Purpose · Inputs · Outputs · Auth requirements · RLS expectations · Failure modes · Audit requirements · Approval requirements. `organization_id` is always JWT-derived and omitted from inputs.

### 22.1 `task.create`

- **Purpose:** create a new task at `backlog` (or `ready` if scope is already confirmed).
- **Inputs:** `title` (non-empty), `project_id`, `department_id`, `priority` (default `normal`); optional `status` (`backlog` or `ready` only), `request_id`, `work_packet_id`, `workflow_id`, `tool_profile_id`, `assigned_to_user_id`.
- **Outputs:** task `id`, `status`, `created_by`, `department_id`, `project_id`, timestamps.
- **Auth requirements:** authenticated; role ∈ `{org_admin, department_lead, department_member}`. Agents cannot create tasks. `read_only` cannot create tasks.
- **RLS expectations:** `tasks_insert_dept_scope` — org pin; `created_by = current_user_id()`; role check; for non-admin, `department_id = current_department_id()`; all FK refs org-local and live; `assigned_to_user_id` (if set) must be active org member.
- **Failure modes:** agent attempt → `forbidden`; read_only attempt → `forbidden`; missing required fields → `validation`; initial status not in `{backlog, ready}` → `validation` (Layer 4); cross-dept non-admin → RLS reject; foreign FK refs → RLS reject; empty `title` → `validation` (DB check constraint).
- **Audit requirements:** `execution_logs` (`context_type='task'`, `event_type='state_change'`, summary "task created at {status}"; `request_id`/`work_packet_id` in metadata if set).
- **Approval requirements:** none (Category C).

---

### 22.2 `task.get` / `task.list`

- **Purpose:** read a task by id / list tasks within the caller's visible scope with filters.
- **Inputs:** `id` (get); filter params: `status`, `priority`, `department_id` (org_admin only), `project_id`, `request_id`, `work_packet_id`, `assigned_to_user_id`, `created_by`, date range (list).
- **Outputs:** task row(s) with full schema fields.
- **Auth requirements:** any authenticated active org member (all 5 roles). Visibility is always RLS-determined; no role-based app-level filter.
- **RLS expectations:** `tasks_select_dept_scope` (org_admin, lead, member, read_only) + `tasks_select_agent_assigned` (agent). The API must not add `department_id` filters on behalf of non-admin callers — RLS already enforces department scope. Application filters are valid *within* the caller's visible set (e.g., filter by status), never substitutes for RLS.
- **Failure modes:** out-of-scope or deleted task → `not_found` (RLS invisible); null context → `not_found`; agent requesting a task not assigned to them → `not_found`.
- **Audit requirements:** read-only; no log required (optional access metric).
- **Approval requirements:** none.

---

### 22.3 `task.update`

- **Purpose:** amend mutable non-status fields — `title`, `priority`, `tool_profile_id`, `work_packet_id`, `workflow_id`.
- **Inputs:** `id`, mutable fields (partial update; status not accepted — use dedicated ops).
- **Outputs:** updated task row.
- **Auth requirements:** org_admin or the task's dept lead/member.
- **RLS expectations:** `tasks_update_dept_scope` USING + WITH CHECK. Agent attempt → row invisible → 0 rows (not an error at DB level; API returns `not_found`). Cross-dept non-admin → same.
- **Failure modes:** agent attempt → `not_found`/0 rows; read_only attempt → `not_found`/0 rows; cross-dept non-admin → `not_found`/0 rows; status field in payload → `conflict` (Layer 4 — redirect to dedicated status op); foreign FK change → RLS reject.
- **Audit requirements:** `execution_logs` `state_change` with changed fields.
- **Approval requirements:** none.

---

### 22.4 `task.assign`

- **Purpose:** set or change `assigned_to_user_id`; controls agent task visibility (setting to an agent's user id grants that agent SELECT access to the task via `tasks_select_agent_assigned`).
- **Inputs:** `id`, `assigned_to_user_id` (active org member uuid, or `null` to unassign).
- **Outputs:** updated task with `assigned_to_user_id`.
- **Auth requirements:** org_admin or the task's dept lead/member.
- **RLS expectations:** UPDATE policy as §22.3. Application must validate `assigned_to_user_id` is an active org member before write (mirrors the INSERT WITH CHECK validation).
- **Failure modes:** assigning to non-active or foreign-org user → `validation`; unauthorized actor → `not_found`/0 rows.
- **Side effects:** agent visibility change is immediate on the next request after assignment; no cache to invalidate (context re-resolved per request, per spine §12).
- **Audit requirements:** `execution_logs` `note` with old and new assignee.
- **Approval requirements:** none (Category C).

---

### 22.5 `task.advance` (backlog → ready → in_progress → in_review)

- **Purpose:** progress a task through non-terminal forward states. Covers `backlog→ready`, `ready→in_progress` (or `backlog→in_progress`), and `in_progress→in_review`.
- **Inputs:** `id`, `status` (target state, must be a legal forward transition).
- **Outputs:** updated task at new `status`.
- **Auth requirements:** org_admin or the task's dept lead/member. Agents cannot advance task status.
- **RLS expectations:** `tasks_update_dept_scope`. Agent invisible to UPDATE.
- **Failure modes:** agent attempt → `not_found`/0 rows; illegal transition (e.g., `backlog→done`) → `conflict`; advancing from `blocked` (must unblock first) → `conflict`; advancing a `cancelled`/`done` task → `conflict`.
- **Audit requirements:** `execution_logs` `state_change` with old/new status for each transition.
- **Approval requirements:** none (Category C for these transitions). Any pending Category A/B action within the task is separately tracked via approvals.

---

### 22.6 `task.block`

- **Purpose:** transition `in_progress → blocked`; creates or links a Blocker indicating what is impeding progress.
- **Inputs:** `id`; blocker payload (description, severity, `reported_by_user_id`) or existing `blocker_id` to link.
- **Outputs:** task at `blocked`; blocker `id`.
- **Auth requirements:** org_admin or the task's dept lead/member.
- **RLS expectations:** task UPDATE policy (§22.3) + Blocker INSERT (dept-scoped in `013` policies).
- **Failure modes:** attempting to block a task not in `in_progress` → `conflict`; invalid blocker severity → `validation`; unauthorized actor → `not_found`/0 rows.
- **Audit requirements:** `execution_logs` `state_change` "in_progress→blocked"; execution log noting blocker raised.
- **Approval requirements:** none (Category C).

---

### 22.7 `task.unblock`

- **Purpose:** resolve the active Blocker and return the task to `in_progress`; transitions `blocked → in_progress`.
- **Inputs:** `id`; `resolution_note` on the linked Blocker; blocker `status → resolved` (via Blocker API).
- **Outputs:** task at `in_progress`; blocker at `resolved`.
- **Auth requirements:** org_admin or the task's dept lead/member.
- **RLS expectations:** task UPDATE + Blocker UPDATE (dept-scoped in `013` policies).
- **Failure modes:** unblocking while task is not `blocked` → `conflict`; unblocking without resolving the linked Blocker → `conflict` (Layer 4); unauthorized actor → `not_found`/0 rows.
- **Audit requirements:** `execution_logs` `state_change` "blocked→in_progress"; blocker resolution note.
- **Approval requirements:** none (Category C).

---

### 22.8 `task.complete`

- **Purpose:** transition `in_review → done`; the final acceptance that the task's work is complete and accepted.
- **Inputs:** `id`; status → `done`.
- **Outputs:** task at `done`.
- **Auth requirements:** org_admin or the task's dept lead. (`department_member` may reach `in_review` but the `done` transition is lead/admin-gated — Layer 4 rule).
- **RLS expectations:** `tasks_update_dept_scope` — dept_member has RLS UPDATE authority but the Layer 4 rule narrows to lead/admin for terminal acceptance.
- **Failure modes:** task not in `in_review` → `conflict`; outstanding required output approval → `approval_required` (Layer 5 check); open `pending_approval` decision on task → surface warning (soft-blocker, not hard block); dept_member attempt → `forbidden` (Layer 4); unauthorized actor → `not_found`/0 rows.
- **Audit requirements:** `execution_logs` `state_change` `→done`.
- **Approval requirements:** see §13. Any output delivery gate (`category='a'`) or decision gate (`category='b'`) must be `approved` or `withdrawn`.

---

### 22.9 `task.cancel`

- **Purpose:** terminate a task that will not be completed; `{any non-terminal} → cancelled`.
- **Inputs:** `id`; optional cancellation reason.
- **Outputs:** task at `cancelled`.
- **Auth requirements:** org_admin or the task's dept lead. Not available to dept_member or agents.
- **RLS expectations:** `tasks_update_dept_scope`.
- **Failure modes:** cancelling an already-terminal task → `conflict`; dept_member or agent attempt → `forbidden` (Layer 4) / `not_found` (for agents, who have no UPDATE visibility).
- **Audit requirements:** `execution_logs` `state_change` `→cancelled` with reason.
- **Approval requirements:** none. Open output/decision approvals on a cancelled task are auto-closed as `withdrawn` (Layer 4 housekeeping, not enforced by RLS).

---

### 22.10 `task.request_approval`

- **Purpose:** open a Category A or B approval gate on the task for a high-risk action.
- **Inputs:** `id` (task), `category` (`'a'` or `'b'`), `trigger_reason` (which action is gated), `approver_role`, optional `approver_user_id`, optional `expires_at`.
- **Outputs:** approval `id` with `status='pending'`; `subject_type='task'`, `subject_id=task.id`.
- **Auth requirements:** dept_member, dept_lead, or org_admin only. Agents are excluded from approval INSERT by RLS (`017`) — an agent signals via `agent_activity(activity_type='approval_requested')`; an authorized human or service-role caller invokes this operation to create the actual approval row.
- **RLS expectations:** Approval INSERT policy (`013`) — org pin, dept pin, subject must be in caller's accessible scope.
- **Failure modes:** task not in caller's visible scope → `not_found`; invalid category or missing trigger_reason → `validation`; agent caller → RLS 42501 (excluded from approval INSERT regardless of assignment).
- **Audit requirements:** `execution_logs` `approval_action` "approval requested for {trigger_reason}".
- **Approval requirements:** none (this IS the approval creation; no meta-approval needed).

---

### 22.11 `task.soft_delete`

- **Purpose:** retire an erroneous or duplicate task; set `deleted_at`. The task becomes invisible to all non-service-role consumers.
- **Inputs:** `id`.
- **Outputs:** task hidden (invisible to subsequent reads).
- **Auth requirements:** org_admin only.
- **RLS expectations:** modeled as an UPDATE setting `deleted_at`; org_admin branch of `tasks_update_dept_scope`. Hard DELETE is not granted to any authenticated role.
- **Failure modes:** non-admin → `not_found`/0 rows (or `forbidden` if the API can detect the role). Active decisions with `on delete restrict` on tasks prevent hard deletion (moot since hard DELETE is not supported, but noted for service-role awareness).
- **Audit requirements:** `audit_events` (`event_category='admin'`, `entity_type='task'`, `entity_id`) + `execution_logs` note.
- **Approval requirements:** none.

---

### 22.12 `task.spawn_work_packet` (bridge)

- **Purpose:** create a Work Packet authored against this task (context bridge to Work Packet API); sets Work Packet `parent_type='task'`, `parent_id=task.id`.
- **Inputs:** `id` (task); work packet fields (title, objective, scope, acceptance_criteria, priority, optional `approval_required_before_start`).
- **Outputs:** work packet `id` with `parent_type='task'`, `parent_id=task.id`.
- **Auth requirements:** dept lead/member/org_admin in the task's department (Work Packet INSERT policy from `009`).
- **RLS expectations:** Work Packet INSERT policy — dept-scoped; `author_user_id = current_user_id()`; parent task must be org-local and in caller's department (or org_admin).
- **Failure modes:** agent attempt → `forbidden` (Work Packet INSERT excludes agents); task not in scope → `not_found`; cross-dept non-admin → RLS reject.
- **Audit requirements:** `execution_logs` on task noting "work packet authored"; `execution_logs` on the work packet (context_type='task').
- **Approval requirements:** none to create the work packet; Category B gate fires when `in_execution` is attempted if `approval_required_before_start=true`.

---

## 23. Validation Rules

| Rule | Enforced by |
|------|-------------|
| `title` non-empty (trimmed) | DB check (`tasks_title_not_empty`) + app |
| `project_id` org-local and live (not deleted) | RLS WITH CHECK + app |
| `department_id` org-local and live; for non-admin, equals `current_department_id()` | RLS WITH CHECK + app |
| `priority ∈ {low, normal, high, critical}` | DB check (`tasks_priority_check`) + app |
| `status ∈ {backlog, ready, in_progress, blocked, in_review, done, cancelled}` | DB check (`tasks_status_check`) |
| Initial `status` must be `backlog` or `ready` | App (Layer 4) — DB allows any valid enum |
| `created_by = current_user_id()` | RLS WITH CHECK (enforced) |
| `assigned_to_user_id` must be active org member (if set) | RLS WITH CHECK on INSERT (active check) + app on UPDATE |
| `tool_profile_id` org-local (if set) | RLS WITH CHECK + app |
| `work_packet_id` org-local (if set) | RLS WITH CHECK + app |
| `request_id` org-local (if set) | RLS WITH CHECK + app |
| `workflow_id` org-local (if set) | RLS WITH CHECK + app |
| `organization_id = current_organization_id()` | DB + app (never client-supplied) |
| Legal status transition | App (Layer 4) |
| No transition from terminal state (`done`, `cancelled`) | App (Layer 4) |
| `blocked → in_progress` only when Blocker is resolved | App (Layer 4) |
| `in_review → done` only when no pending required approvals | App (Layer 5) |
| `metadata` is a JSON object | Not applicable — tasks table has no `metadata` column |

> **Verification correction (G3 §26 matrix, 2026-06-24):** `work_packet_id` department alignment is enforced transitively by RLS (Layer 3) for non-admin callers through the `tasks_insert_dept_scope` WITH CHECK EXISTS clause and the caller's `work_packets` SELECT policy. Application validation remains a secondary safeguard and is primarily relevant for org_admin paths.

---

## 24. Error Model

Per the spine §19 locked decision — unauthorized reads default to `not_found` (RLS makes non-visible rows invisible, not forbidden). `forbidden` only when the actor is known to have visibility but lacks the specific permission.

| Class | HTTP | Task-specific trigger |
|-------|------|-----------------------|
| `unauthenticated` | 401 | No JWT / null `current_user_id` (non-active/unprovisioned) |
| `forbidden` | 403 | Agent attempting `task.create` (known role, excluded action); dept_member attempting `task.complete` (visible row, narrowed authority); read_only attempting any write |
| `not_found` | 404 | Task not in caller's visible scope (cross-dept, deleted, or agent requesting unassigned task) |
| `conflict` | 409 | Illegal status transition; advancing from/to incompatible state; cancelling a terminal task |
| `approval_required` | 409 | `in_review → done` with open required approval; Category A action attempted without approved gate |
| `validation` | 422 | Empty `title`; bad `priority`/`status` enum; initial status not `backlog`/`ready`; foreign refs |
| `rate_limited` | 429 | Throttle (creation bursts, assignment storm) |
| `internal` | 500 | Unexpected; async-related failures surface in background_jobs/DLQ |

---

## 25. Audit Requirements

| Event | Surface | Required fields |
|-------|---------|----------------|
| Task created | `execution_logs` | `context_type='task'`, `event_type='state_change'`, `actor=created_by`, `summary="created at {status}"`, `request_id`/`work_packet_id` in metadata |
| Status transition | `execution_logs` | `state_change`, `actor`, old status in metadata, new status in summary |
| Assignment change | `execution_logs` | `note`, old `assigned_to_user_id`, new `assigned_to_user_id` |
| Department re-route (admin) | `audit_events` + `execution_logs` | `audit_events`: `event_category='admin'`, `entity_type='task'`; `execution_logs`: `state_change` with old/new dept |
| Blocked | `execution_logs` | `state_change` `→blocked`; blocker `id` in metadata |
| Unblocked | `execution_logs` | `state_change` `blocked→in_progress`; blocker resolution note |
| Completion (`done`) | `execution_logs` | `state_change` `→done`; any resolved output/decision gates in metadata |
| Cancellation | `execution_logs` | `state_change` `→cancelled`; reason |
| Approval requested | `execution_logs` | `approval_action`; approval `id`, category, trigger_reason |
| Soft-delete (admin) | `audit_events` + `execution_logs` | `audit_events`: `event_category='admin'`; `execution_logs`: note |
| Agent activity (cross-ref) | `agent_activity` | Task-level activity by agent; linked via `task_id` and soft `execution_log_id` |

All audit is append-only. No log is updated or deleted.

---

## 26. Realtime Requirements

- **MVP publication:** `tasks` is confirmed in the MVP realtime publication (alongside `approvals` and `blockers`). Task API must honor this without additional configuration.
- **Realtime scope is RLS-filtered:** a subscriber receives only changes to tasks they could already read. For human roles, this means their department's tasks. For agents, this means only their assigned tasks. The realtime channel is as safe as the SELECT policy behind it.
- **Key events to stream:** status changes (`backlog→ready`, etc.), assignment changes (`assigned_to_user_id` updated), department changes (for org_admin subscribers).
- **Contrast with requests:** if requests are added to realtime, they would broadcast org-wide (any org member gets changes). Task realtime is narrower — department-scoped per subscriber. This is the correct behavior given the visibility model and should not be "equalized" to org-wide.
- **Agent realtime:** an agent subscriber receives only changes to their currently assigned tasks. When reassigned, they immediately stop receiving updates for the previously assigned task.
- **Rule:** task realtime was confirmed eligible (SELECT policy correct) in the runtime data model. No additional RLS review is needed before enabling the subscription.

---

## 27. Service Boundaries

| Path | Trust tier | Use |
|------|-----------|-----|
| Human/agent task reads | `authenticated` (user/agent JWT) | RLS-bound reads; agent constrained to assigned tasks |
| Human task create/update/assign/advance | `authenticated` | RLS-bound writes; agents excluded from CREATE/UPDATE |
| Workflow automation status transitions | `service_role` (background_jobs driver) | `workflow_step` jobs may update task status as part of automated step execution; bypasses RLS, must pin `organization_id` and record actor |
| Approval notification delivery | `service_role` (background_jobs) | `approval_notification` job enqueued when approval status changes; task reference carried via `related_task_id` |
| Output delivery (task-linked) | `service_role` (background_jobs) | `output_delivery` job for tasks whose output is being delivered externally |
| Admin soft-delete | `authenticated` (org_admin JWT) | RLS-bound UPDATE setting `deleted_at` |

**Agent constraint:** agents hold no service key. An agent cannot use a service-role path to bypass task INSERT/UPDATE restrictions. All agent writes go through the `authenticated` path and are gated by the agent role's policy scope.

**Service-role task writes:** when service-role code (workflow runner, background job) updates a task's status, it must: (1) carry `organization_id`, (2) record the acting actor in `execution_logs` (even if the actor is `system`), and (3) validate the transition is legal before writing. Service-role bypasses RLS but must not bypass business rules.

---

## 28. Security Model

- **Department isolation:** `tasks_select_dept_scope` pins `department_id = private.current_department_id()` for all non-admin roles. Cross-department reads are impossible for authenticated non-admin callers. Verified behavior: dept A member returns 0 rows for dept B tasks.
- **Agent confinement:** `tasks_select_agent_assigned` pins `assigned_to_user_id = private.current_user_id()`. An agent cannot see any task until explicitly assigned. Two-policy structure (dept scope + agent assigned) means agents are isolated from each other even within the same department.
- **Creator pin:** `created_by = private.current_user_id()` is enforced in INSERT WITH CHECK. No caller can record another user as the creator.
- **No agent INSERT or UPDATE:** the INSERT and UPDATE policies exclude the `agent` role. Agents cannot create tasks, modify titles, advance status, or change assignments — regardless of what they assert in a request body.
- **No authenticated hard DELETE:** `deleted_at` via UPDATE is the only authenticated removal path, and it requires the org_admin branch of the UPDATE policy.
- **Scope injection defense:** `department_id` provided in a non-admin request body is validated against `private.current_department_id()` in WITH CHECK; a spoofed department is rejected by RLS. `organization_id` is always JWT-derived.
- **Approval gate enforcement:** Category A/B gates are checked at Layer 5 by the API before any gated action proceeds; out-of-profile tool invocations are flagged in `execution_logs` and blocked before the agent invocation.
- **Service-role discipline:** workflow runners and job drivers that update task status must carry `organization_id`, record the acting context, and never expose the service key to agents or clients.

---

## 29. Testing Requirements

Using the established `BEGIN…ROLLBACK` JWT harness from Phase F/G1/G2 verification:

| Area | Required tests |
|------|---------------|
| **Visibility — dept scope** | org_admin sees all org tasks; dept A lead/member sees dept A tasks but not dept B; read_only sees own dept tasks |
| **Visibility — agent scope** | agent sees only assigned task; agent cannot see unassigned dept-mate tasks; unassigning removes agent visibility |
| **Visibility — deletion** | `deleted_at` set → invisible to all non-service-role |
| **CREATE authorization** | dept lead/member/org_admin can create; agent attempt → forbidden; read_only attempt → forbidden |
| **CREATE required fields** | missing `project_id` or `department_id` → validation; empty `title` → validation |
| **CREATE dept pin** | non-admin providing cross-dept `department_id` → RLS reject |
| **CREATE initial status** | initial status `done`/`in_progress` → conflict (Layer 4) |
| **UPDATE authorization** | dept lead/member/org_admin can update; agent → 0 rows (not_found); read_only → 0 rows |
| **Status machine** | legal transitions pass; illegal transitions → conflict; terminal → non-terminal → conflict |
| **Assignment** | assign to agent → agent gains visibility; unassign → agent loses visibility immediately |
| **Dept routing** | org_admin re-routes dept A→B; old dept loses visibility; new dept gains; agent retains |
| **Completion gate** | `in_review→done` with pending output approval → approval_required |
| **Cancel authority** | dept_member attempt to cancel → forbidden (Layer 4); lead/admin succeed |
| **Approval request** | dept_member creates approval row on dept task; approval created with correct subject/category; agent caller → RLS 42501 |
| **Soft-delete** | org_admin can soft-delete; non-admin → 0 rows; deleted task invisible to all |
| **Realtime** | dept A subscriber receives only dept A task changes; agent subscriber receives only assigned task changes |
| **Agent activity linkage** | agent can insert activity with assigned `task_id`; cannot insert activity against unassigned task; agent attempt to INSERT a decision row → RLS 42501 (excluded from `decisions_insert_task_scope`) |
| **Audit emission** | each operation emits the required execution_logs/audit_events |

All tests use `BEGIN…ROLLBACK`. System of record is never mutated.

---

## 30. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | **Agent cannot advance task status** — creates handoff friction; tasks remain `in_progress` until a human explicitly advances them | Medium | Document the agent→human handoff pattern; surface completion signals through outputs and execution logs; the workflow runner (service-role) may automate advances in a future workflow integration |
| 2 | **`project_id` required at creation** — cannot create a "floating" exploratory task not yet assigned to a project | Low | Tasks require project context by design (reflecting system-entities.md §4); lightweight projects may be created for exploratory work |
| 3 | **Department re-routing destroys visibility for old dept** — immediately on `department_id` update, old dept users lose task access including in-flight work | High | Restrict routing to org_admin; require a review/handoff execution log before re-route; make routing auditable via audit_events |
| 4 | **Assignment-gated agent visibility** — if `assigned_to_user_id` is null, the agent sees zero tasks | Medium | Never deploy an agent session without an explicit assignment; the task API's `task.assign` must be called before any agent invocation |
| 5 | **Background job `related_task_id` mis-set** — wrong task reference causes dept users to see unexpected jobs | Medium | Service-role code that enqueues jobs must validate `related_task_id` is in the target org before writing |
| 6 | **Category A approval mis-configuration** — agent hits a gated action that has no pending approval → execution logged as `flagged` and the action is blocked, stalling the task indefinitely | Medium | Pre-flight approval check at Layer 5 before dispatching agent; surface `flagged` execution logs in the task's UI/observer |
| 7 | **Realtime dept-scope shift on re-route** — subscriber in dept A stops receiving updates after the task moves to dept B; subscriber may not know why their feed went silent | Low | Surface a "task moved to another department" notification to the old-dept subscriber before re-route; or ensure org_admin subscribers see the event |
| 8 | **Task `done` with undelivered outputs** — task marked done but the output delivery gate (Category A) has not resolved | Medium | Layer 5 completion check queries outstanding output approvals; block `done` until cleared; covered by §22.8 failure modes |
| 9 | **Tasks table has no `metadata` or `description` column** — implementers expecting a free-form body field will find none; extended context lives in the linked Work Packet | Low | Document clearly (this plan, §Grounding Facts); guide implementers to use the Work Packet for specification detail; API validation must reject attempts to send metadata to the tasks endpoint |

---

## 31. Recommended Build Order

1. **Read surface** — `task.get`/`task.list` under dept-scoped RLS + agent-assigned filter. Lowest risk. Proves the two-policy SELECT structure end-to-end (dept scope for human roles; assignment-gated for agents).
2. **Create** — `task.create` with required-field validation (`project_id`, `department_id`, `title`), initial-status gate (`backlog`/`ready` only), and creator pin. Confirms non-agent, non-read_only authority.
3. **Assignment** — `task.assign` with agent-visibility side-effect verification. Assign an agent → confirm the agent's SELECT returns the task.
4. **Status machine** — `task.advance` for the forward progression (ready, in_progress, in_review) with transition legality. Include `task.block`/`task.unblock`.
5. **Completion** — `task.complete` (`in_review → done`) with the Layer 5 approval gate check.
6. **Cancellation + soft-delete** — `task.cancel` and `task.soft_delete` with lead/admin authority narrowing.
7. **Approval integration** — `task.request_approval`; wire Layer 5 Category A/B checks for task-scoped actions.
8. **Work packet bridge** — `task.spawn_work_packet` linking into the Work Packet API (G4).
9. **Realtime subscription** — enable task feed; verify dept-scoped streaming; confirm agent receives only assigned task changes.
10. **Audit wiring** — ensure all transitions emit the required `execution_logs`/`audit_events`.
11. **Agent activity linkage** — verify that agent `agent_activity` rows with `task_id` can only reference assigned tasks (Phase F `020` INSERT WITH CHECK, already deployed; regression test).

Steps 1–3 establish the RLS substrate and prove the most unusual property (two-policy SELECT). Steps 4–6 deliver the human-operated task lifecycle MVP. Steps 7–11 complete the approval, agent, realtime, and audit integration.

---

## 32. Definition of Done

- [ ] All operations resolve identity and scope only through the spine's `private.*` helpers; no client-supplied `organization_id`, `department_id`, or `role` is ever trusted.
- [ ] Task SELECT is **department-scoped** for all human roles (not org-wide); org_admin sees all; dept roles see only their dept; cross-dept reads return `not_found`.
- [ ] Agents see **only tasks explicitly assigned to them** via `assigned_to_user_id = current_user_id()`; an unassigned agent sees zero tasks.
- [ ] Agents **cannot INSERT or UPDATE tasks** via any authenticated path; agent attempts return `forbidden`.
- [ ] `project_id` and `department_id` are required at creation; initial status constrained to `backlog` or `ready`; `created_by` is self-pinned.
- [ ] The status machine rejects all illegal transitions with `conflict`; no terminal-state mutation is possible.
- [ ] `task.complete` checks all required output and decision approvals before allowing `done`; outstanding Category A/B gates return `approval_required`.
- [ ] Department re-routing is org_admin only; re-routing changes visibility immediately and is recorded in `audit_events`.
- [ ] Tasks are published to the MVP realtime channel; subscribers receive only changes to tasks within their RLS-visible scope.
- [ ] All status transitions, assignments, approvals, and admin actions emit the required `execution_logs`/`audit_events`.
- [ ] No authenticated hard DELETE exists; retirement is soft-delete (`deleted_at`) by org_admin only.
- [ ] The §29 test suite passes under `BEGIN…ROLLBACK`; no migrations, schema changes, or new roles were introduced.
- [ ] The task/request visibility difference is confirmed by the §29 test matrix: dept B member sees org requests but not dept A tasks.

---

## Document Boundaries

This is Phase G3 **architecture output** — the Task API contract. It introduces no code, routes, Edge Functions, migrations, or schema changes, and modifies no prior plan. It consumes the deployed `tasks` table, `009` and `010` RLS, governance-layer schema from `011`, knowledge/output layer from `014`, and runtime layer from `018`/`020`, exactly as verified. RLS remains the primary authorization layer; Supabase remains the system of record. Implementation proceeds against §31.
