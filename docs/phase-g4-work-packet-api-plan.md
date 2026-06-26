# Phase G4 — Work Packet API Plan

Architecture for the **Work Packet API** — the specification layer of the AI Command Center, where intent and project scope become a structured, governed handoff artifact that tasks and agents execute against.

> **Auth/context contract:** [phase-g1-auth-context-spine.md](phase-g1-auth-context-spine.md)
> **Task API contract:** [phase-g3-task-api-plan.md](phase-g3-task-api-plan.md)
> **Canonical entity:** [system-entities.md](system-entities.md) §5 Work Packet
> **Approval gates:** [approval-rules.md](approval-rules.md)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)
> **Schema origin:** `supabase/migrations/007_execution_layer.sql` (table), `009_phase_c_rls_policies.sql` (RLS)
> **Governance layer:** `supabase/migrations/011_governance_layer.sql`, `013_phase_d_rls_policies.sql` (approvals/blockers RLS)
> **Knowledge/output layer:** `supabase/migrations/014_knowledge_output_layer.sql`
> **Runtime layer:** `supabase/migrations/018_runtime_hardening.sql`, `020_phase_f_rls_policies.sql`

This document is **architecture only**. No code, migrations, schema changes, or future-schema design. Every statement is grounded in the deployed schema and RLS as verified against the live database `wbtvrzivthuqqntnorsw`.

---

## Grounding Facts (from the deployed schema)

**Table:** `public.work_packets` — columns (authoritative, verified live):

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| `id` | uuid | NO | gen_random_uuid() |
| `organization_id` | uuid | NO | — |
| `title` | text | NO | — |
| `objective` | text | NO | — |
| `scope` | jsonb | NO | `'{"in":[],"out":[]}'` |
| `acceptance_criteria` | jsonb | NO | `'[]'` |
| `department_id` | uuid | NO | — |
| `parent_type` | text | NO | — |
| `parent_id` | uuid | NO | — |
| `priority` | text | NO | `'normal'` |
| `constraints` | jsonb | NO | `'{}'` |
| `approval_required_before_start` | boolean | NO | `false` |
| `author_user_id` | uuid | NO | — |
| `status` | text | NO | `'draft'` |
| `created_at` | timestamptz | NO | now() |
| `updated_at` | timestamptz | NO | now() |
| `deleted_at` | timestamptz | YES | null |

**Check constraints (verified live):**
- `status ∈ {draft, ready, pending_approval, in_execution, accepted, superseded, cancelled}`; default `draft`
- `priority ∈ {low, normal, high, critical}`; default `normal`
- `parent_type ∈ {task, project}`
- `title` length(trim) > 0; `objective` length(trim) > 0
- `scope` must be a JSON **object**; `acceptance_criteria` must be a JSON **array**; `constraints` must be a JSON **object**

**Foreign keys (all `on delete restrict`):** `organization_id → organizations`, `department_id → departments`, `author_user_id → users`.

**`parent_id` has NO foreign key constraint** — it is the polymorphic side of `parent_type` + `parent_id`. Referential integrity for the parent is enforced by **RLS EXISTS subqueries**, not by the database FK layer.

**No `request_id`, no `assigned_to_user_id`, no `workflow_id`, no `project_id` column.** A work packet's project linkage flows through `parent_type='project'` + `parent_id`, or transitively through a parent task's `project_id`. There is no direct executor assignment on the packet — execution assignment lives on the **task** (`tasks.assigned_to_user_id`).

**RLS (009):** one SELECT policy (dept-scope, **no agent access**), one INSERT policy (org_admin/dept_lead/dept_member, self-pinned author, parent-validated), one UPDATE policy (**org_admin + dept_lead only** — members excluded). **No DELETE policy** → no authenticated hard delete.

**Realtime:** `work_packets` is **NOT** in the MVP realtime publication. The published set is `tasks`, `approvals`, `blockers` (runtime data model §F step 28).

---

## 1. Purpose

The Work Packet API governs the **structured specification artifact** that sits between governed intake and atomic execution. A work packet answers *what must be done, what is in and out of scope, what "done" means, and under what constraints* — the detail that a task (which carries only a `title`) deliberately omits.

Work packets are the **primary handoff artifact** between requesters and executors, human or agent. The API's job is to let authorized department members author, refine, gate, and finalize that specification under the spine's identity model, while delegating execution tracking to the Task API and authorization enforcement to RLS.

The Work Packet API is the natural home for the **Category B start gate** (`approval_required_before_start`): the single most important governance hook in the execution layer, because it is the point where a specification becomes licensed to run.

---

## 2. Scope

**In scope:** create/read/update work packets; the full status machine from `draft` through `accepted`/`superseded`/`cancelled`; the `approval_required_before_start` gate and its interaction with the Approval API; parent attachment to a task or project; research-asset linkage via `work_packet_research_assets`; blocker and knowledge-record associations; the packet→task decomposition bridge; soft-delete.

**Out of scope:** task lifecycle and assignment (Task API, G3); the internals of the Approval, Decision, Blocker, Output, and Knowledge Record APIs (each its own sub-plan); agent execution mechanics (G5); schema changes; new roles; any RLS modification. This plan consumes the deployed `work_packets` RLS exactly as written.

---

## 3. Entity Definition

A work packet is a **department-owned specification** with a polymorphic parent. Mapping the deployed columns to their roles:

| Field | Role |
|-------|------|
| `title` | Human-readable packet name (required, non-empty) |
| `objective` | The intended outcome in prose (required, non-empty) |
| `scope` | JSON object — in/out boundaries; default shape `{"in":[],"out":[]}` |
| `acceptance_criteria` | JSON array — the conditions that define "done" |
| `constraints` | JSON object — budget/time/tool/policy limits; default `{}` |
| `parent_type` + `parent_id` | Polymorphic attachment to a `task` or a `project` |
| `priority` | `low` / `normal` / `high` / `critical` |
| `approval_required_before_start` | Boolean gate — when true, packet must clear a Category B approval before `in_execution` |
| `author_user_id` | The authoring user, **self-pinned** on INSERT (`= private.current_user_id()`) |
| `department_id` | Owning department; the axis of all RLS visibility and write authority |
| `status` | Lifecycle state (see §4–§5) |

**The three JSON fields are typed by check constraint, not just convention:** `scope` and `constraints` must be objects; `acceptance_criteria` must be an array. The API must validate JSON shape before write or the DB rejects it.

**Project linkage is indirect.** A packet has no `project_id`. If `parent_type='project'`, the project is `parent_id`. If `parent_type='task'`, the project is the parent task's `project_id`. The API resolves project context by following the parent.

---

## 4. Lifecycle

```text
   author begins  ──►  status = 'draft'            (being written; not runnable)
            │
   spec complete ──►  status = 'ready'             (complete enough to start)
            │
   (if approval_required_before_start = true)
            │
   gate opened ──►  status = 'pending_approval'    (awaiting Category B approval)
            │
   approval granted ──►  status = 'in_execution'   (licensed; work underway)
            │                    │
            │          (no gate) │ ready → in_execution directly
            │                    │
   criteria met ──►  status = 'accepted'           (terminal; verified against acceptance_criteria)

   (from any non-terminal)
   replaced ──►  status = 'superseded'             (terminal; newer packet takes over)
   abandoned ──►  status = 'cancelled'             (terminal; no longer valid)
```

A packet's status is the state of the **specification and its license to run** — distinct from the execution status of the tasks that consume it. A packet may be `accepted` while a task it spawned is still `in_progress`; conversely a packet may be `in_execution` while no task has started. The API must not conflate packet status with task status.

---

## 5. State Machine

| From | To | Who may trigger | Approval | Notes |
|------|-----|-----------------|----------|-------|
| `draft` | `ready` | org_admin, dept_lead | No (Category C) | Spec is complete; scope and acceptance_criteria populated |
| `draft` | `cancelled` | org_admin, dept_lead | No | Abandon before completion |
| `ready` | `pending_approval` | org_admin, dept_lead | — | Only when `approval_required_before_start = true`; opens the Category B gate |
| `ready` | `in_execution` | org_admin, dept_lead | No gate (Category C) | Permitted **only when `approval_required_before_start = false`** — Layer 4 rule |
| `pending_approval` | `in_execution` | org_admin, dept_lead | **Category B** | Requires an `approved` work_packet approval; Layer 5 check |
| `pending_approval` | `ready` | org_admin, dept_lead | — | Approval withdrawn/rejected; returns for revision |
| `in_execution` | `accepted` | org_admin, dept_lead | No | Work verified against `acceptance_criteria` |
| `ready` / `in_execution` | `superseded` | org_admin, dept_lead | No | A newer packet replaces this one |
| `any non-terminal` | `cancelled` | org_admin, dept_lead | No | Terminal abandonment |

**`department_member` is absent from every write transition.** The `work_packets_update_dept_scope` USING clause admits only `org_admin` and `department_lead` (`009`). A member may **author** a packet (INSERT) but cannot advance, gate, accept, supersede, or cancel it. This is the decisive authority difference from tasks.

**Agents are absent entirely.** Agents have no SELECT, INSERT, or UPDATE on `work_packets`. They consume the specification through their assigned task and record activity against the packet via `agent_activity.work_packet_id`, but never mutate the packet itself.

Transition legality and the `approval_required_before_start` gate are enforced by the API (Layer 4/5). RLS governs only *who may write the row*, not *which transition is legal* — the `status` check constraint permits any enum value, so the application owns the state machine.

---

## 6. Visibility Model

**Authoritative policy (`009`, `work_packets_select_dept_scope`):**

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

**Visibility matrix:**

| Role | Sees | Mechanism |
|------|------|-----------|
| `org_admin` | All non-deleted packets in the org | role branch |
| `department_lead` | Non-deleted packets in **own department only** | dept pin |
| `department_member` | Non-deleted packets in **own department only** | dept pin |
| `read_only` | Non-deleted packets in **own department only** | dept pin |
| `agent` | **Nothing — no SELECT path exists** | not in policy |
| null context | Nothing | — |

> **CRITICAL DIFFERENCE FROM TASKS:** the `tasks` table has a second SELECT policy (`tasks_select_agent_assigned`) granting agents a view of their assigned tasks. **`work_packets` has no agent SELECT policy at all.** An agent — even one assigned to a task whose `work_packet_id` points at a packet — cannot read that packet row directly through the authenticated path. The specification must be surfaced to the agent by the application/execution layer (e.g., projected into the task payload or an execution context), not fetched by the agent from `work_packets`.

**Department isolation is strict:** a lead/member/read_only in department A sees zero packets owned by department B, regardless of any cross-department task or project relationship.

---

## 7. Auth Contract

The Work Packet API resolves identity and scope exclusively through the spine's `private.*` helpers (`current_user_id`, `current_organization_id`, `current_department_id`, `current_role`). No client-supplied `organization_id`, `department_id`, `author_user_id`, or `role` is ever trusted.

| Capability | org_admin | dept_lead | dept_member | read_only | agent |
|------------|:---------:|:---------:|:-----------:|:---------:|:-----:|
| SELECT (own dept) | all org | ✓ | ✓ | ✓ | ✗ |
| INSERT (author) | ✓ | ✓ | ✓ | ✗ | ✗ |
| UPDATE / status change | ✓ | ✓ | ✗ | ✗ | ✗ |
| Soft-delete | ✓ | ✓ (own dept) | ✗ | ✗ | ✗ |
| Approve start gate | ✓ | ✓ (own dept) | ✗ | ✗ | ✗ |

- **`author_user_id` is self-pinned** on INSERT — the WITH CHECK requires `author_user_id = private.current_user_id()`. No caller can author a packet under another user's identity.
- **INSERT role set** = `{org_admin, department_lead, department_member}`; non-admin callers are dept-pinned (`department_id = current_department_id()`).
- **UPDATE role set** = `{org_admin, department_lead}` only; dept_lead is dept-pinned. `department_member` and `read_only` are excluded by the USING clause → their UPDATE matches zero rows.

---

## 8. Create Contract

- **Purpose:** author a new work packet at `draft` (or `ready` if the spec is already complete).
- **Inputs:** `title` (non-empty), `objective` (non-empty), `parent_type` (`task`|`project`), `parent_id`, `department_id`; optional `scope` (object), `acceptance_criteria` (array), `constraints` (object), `priority` (default `normal`), `approval_required_before_start` (default `false`), `status` (`draft` or `ready` only). `organization_id` is JWT-derived; `author_user_id` is self-pinned.
- **Outputs:** packet `id`, `status`, `author_user_id`, `department_id`, timestamps.
- **Auth:** authenticated; role ∈ `{org_admin, department_lead, department_member}`. Agents and read_only cannot create.
- **RLS expectations (`work_packets_insert_dept_scope`):** org pin; `author_user_id = current_user_id()`; role check; dept pin for non-admin; `department_id` resolves to a live org department; **parent validation** —
  - `parent_type='project'` → project must exist, be org-local, not deleted.
  - `parent_type='task'` → task must exist, be org-local, not deleted, **and its `department_id` must equal the packet's `department_id`**. A packet cannot attach to a task in a different department.
- **Failure modes:** agent/read_only attempt → `forbidden`; missing `title`/`objective`/`parent_type`/`parent_id`/`department_id` → `validation`; `scope`/`constraints` not an object or `acceptance_criteria` not an array → `validation` (DB check); cross-dept `department_id` for non-admin → RLS reject; `parent_type='task'` with a parent task in another department → RLS reject; nonexistent/foreign/deleted `parent_id` → RLS reject; initial status not in `{draft, ready}` → `validation` (Layer 4).
- **Audit:** `execution_logs` (`state_change`, "work packet created at {status}", `parent_type`/`parent_id` in metadata).
- **Approval:** none to author (Category C). Setting `approval_required_before_start = true` arms — but does not fire — the Category B gate; the gate fires only on the `pending_approval → in_execution` transition.

---

## 9. Read Contract

- **Purpose:** read a packet by id / list packets in the caller's visible scope.
- **Inputs:** `id` (get); filter params: `status`, `priority`, `parent_type`, `parent_id`, `department_id` (org_admin only), `approval_required_before_start`, `author_user_id`, date range (list).
- **Outputs:** packet row(s) with full schema.
- **Auth:** any authenticated active org member except agent. `org_admin` sees all org packets; dept roles see own-department packets only; **agent receives nothing** (no SELECT policy).
- **RLS expectations:** `work_packets_select_dept_scope`. The API must not add filters narrowing below RLS, nor widen beyond it.
- **Failure modes:** out-of-scope, cross-dept, or deleted packet → `not_found` (RLS-invisible); agent caller → `not_found` (empty set); null context → `not_found`.
- **Audit:** read-only; no log required.
- **Approval:** none.

---

## 10. Update Contract

- **Purpose:** amend specification fields (`title`, `objective`, `scope`, `acceptance_criteria`, `constraints`, `priority`, `approval_required_before_start`) and drive status transitions (§5).
- **Inputs:** `id`; mutable fields and/or target `status`.
- **Outputs:** updated packet row.
- **Auth:** org_admin or the packet's department lead. **`department_member` cannot update** — the USING clause excludes the member role.
- **RLS expectations (`work_packets_update_dept_scope`):** USING (org pin; not deleted; org_admin or dept_lead-in-dept) + WITH CHECK (same role gate; `department_id` live; `author_user_id` live; parent re-validated exactly as INSERT — including the task-department-match rule).
- **Failure modes:** dept_member attempt → `not_found`/0 rows (invisible to UPDATE); read_only/agent attempt → `not_found`/0 rows; cross-dept dept_lead → `not_found`/0 rows; illegal status transition → `conflict` (Layer 4); `ready → in_execution` while `approval_required_before_start = true` → `approval_required` (Layer 5); changing `author_user_id` to a non-live user → RLS reject; `organization_id` change → WITH CHECK reject; re-pointing `parent_id` to a cross-department task → RLS reject.
- **Audit:** `execution_logs` `state_change` with changed fields / old→new status.
- **Approval:** the `pending_approval → in_execution` transition requires an `approved` Category B approval (§11).

---

## 11. Approval Interactions

Per [approval-rules.md](approval-rules.md), the work packet is the anchor of the **Category B "Start Work Packet execution"** gate, and may also carry Category A/B approvals for actions performed during execution.

**The start gate (`approval_required_before_start`):**

- The boolean is set at authoring time. When `true`, the packet may not enter `in_execution` until an approval with `subject_type='work_packet'`, `subject_id=packet.id`, `category='b'`, `status='approved'` exists.
- **This gate is application-enforced (Layer 4/5), not DB-enforced.** The `status` check constraint permits `in_execution` unconditionally; the runtime data model (§6) explicitly assigns this prevention to the application layer: *"prevent `work_packets.status → in_execution` when `approval_required_before_start = true` and no approved Approval exists."* The Work Packet API owns this check.

**Approval subject linkage (`013`):** for an approval whose `subject_type='work_packet'`, the deployed RLS requires the packet to be **org-local, not deleted, and `work_packets.department_id = approvals.department_id`**. The approval's department must match the packet's department — they are co-tenant by department, not merely by org.

**Approval lifecycle effect on the packet** (per approval-rules.md):

| Approval status | Packet effect |
|-----------------|---------------|
| `pending` | Packet frozen at `pending_approval`; cannot enter `in_execution` |
| `approved` | Packet may transition `pending_approval → in_execution` |
| `rejected` | Packet returns to `ready` (or `draft`) for revision |
| `withdrawn` | Gate removed; packet returns to pre-gate state |
| `expired` | Treat as a re-gate; a new approval is required before start |

**Who may resolve (`013`, `approvals_update_approver_scope`):** only `org_admin` or a `department_lead` whose department matches the approval's `department_id`, and only from `status='pending'` to one of `{approved, rejected, withdrawn}`. Members, read_only, and agents cannot resolve. Agents cannot INSERT approval rows — they signal via `agent_activity(activity_type='approval_requested')`. An authorized human (org_admin, dept_lead, dept_member) or service-role path creates the actual approval row via the Approval API (`017`, `approvals_insert_department_scope`).

---

## 12. Decision Interactions

Decisions are **task-scoped** (`decisions.task_id` NOT NULL → tasks). There is **no direct `work_packet_id` on `decisions`.** A decision relates to a work packet only transitively: a decision belongs to a task, and that task may carry a `work_packet_id` pointing at the packet.

- **Flow:** during execution against a packet, actors record decisions on the consuming **task**, not on the packet. The packet's specification (`scope`, `constraints`, `acceptance_criteria`) is the *context* a decision is made against; the decision row lives on the task.
- **Implication for the API:** the Work Packet API does not create or own decisions. To assemble "decisions made against this packet," the API joins `decisions` → `tasks` where `tasks.work_packet_id = packet.id`. This is a read-side aggregation, dept-scoped by the underlying task and decision RLS.
- **Constraint coupling:** a decision that would breach a packet `constraints` value (e.g., a cost ceiling) is a **Category B** trigger ("Exceed cost/budget constraint" per approval-rules.md) — but the approval subject in that case is typically the task or decision, evaluated against the packet's `constraints` payload. The packet supplies the limit; the gate fires on the consuming entity.

---

## 13. Task Relationships

The packet↔task relationship is **bidirectional and polymorphic on the packet side**:

- **Packet → task (parent attachment):** a packet with `parent_type='task'` attaches to exactly one task via `parent_id`. RLS requires the parent task's `department_id` to equal the packet's `department_id` (§8). This is the packet *authored against* a task.
- **Task → packet (specification pointer):** a task may point to its governing packet via `tasks.work_packet_id` (nullable FK → work_packets, `on delete set null`). The Task API's INSERT/UPDATE RLS (`009`) requires that referenced packet to be org-local and **in the task's own department** (`wp.department_id = tasks.department_id`). Verified in the G3 §26 matrix (test 6b): a cross-department `work_packet_id` is RLS-denied transitively.
- **Packet → spawned tasks (decomposition):** a packet may "spawn" one or more tasks during decomposition (system-entities §5: *"May spawn one or more Tasks when decomposed"*). Mechanically this is the Task API creating tasks whose `work_packet_id` references the packet — there is no separate spawn column on the packet. The Work Packet API exposes a decomposition bridge (§19) that calls Task creation with the packet's department and `work_packet_id` pre-bound.

**Two distinct linkages exist and must not be confused:** the polymorphic *parent* (`work_packets.parent_type='task'` + `parent_id`) records what the packet was authored *for*; the task's *pointer* (`tasks.work_packet_id`) records which packet *governs* that task. A packet authored with `parent_type='project'` can still govern tasks via their `work_packet_id` without being any task's parent.

---

## 14. Agent Relationships

Agents have **no direct relationship to `work_packets`** — no SELECT, INSERT, or UPDATE. Every agent touchpoint is indirect:

| Path | Direction | Mechanism / RLS |
|------|-----------|-----------------|
| Read the spec | packet → agent | **Not via `work_packets`.** Application/execution layer projects the spec into the agent's task context. The agent never queries the packet table. |
| Record activity against a packet | agent → `agent_activity` | `agent_activity.work_packet_id` (FK, `on delete set null`). INSERT policy (`020`) requires only that the packet be **org-local and not deleted** — notably **no department or assignment check on the packet** (weaker than the `task_id` check, which requires the task be assigned to the agent). |
| See a packet-linked blocker | blocker → agent | `013` blockers SELECT: an agent sees a `blocked_entity_type='work_packet'` blocker only when the packet is linked to a task assigned to the agent (`tasks.work_packet_id = blocked_entity_id AND tasks.assigned_to_user_id = current_user_id()`). |
| See a packet-related background job | job → agent | `020` background_jobs SELECT: agents see jobs via `related_task_id` (assigned task) **only**. The `related_work_packet_id` path is available to dept_lead/member, **not** to agents. |

> **Security note on `agent_activity.work_packet_id`:** because the `020` INSERT WITH CHECK validates the packet only as org-local (not assigned, not dept-matched), an agent could in principle stamp activity with any org-local packet id. This is acceptable because `agent_activity` is append-only telemetry with `agent_user_id` self-pinned — the agent cannot read the packet, mutate it, or impersonate another agent. The packet reference is provenance metadata, not an access grant. Documented here so the API does not mistake it for a visibility path.

---

## 15. Output Relationships

`outputs` (deployed in `014`) carry `task_id` (NOT NULL), `project_id` (NOT NULL), and `department_id` (direct FK) — **there is no `work_packet_id` on `outputs`.** A work packet relates to an output only transitively, through the task that produced it:

```text
work_packet  ◄──work_packet_id── task ──task_id──►  output
```

- **Flow:** a packet governs a task (`tasks.work_packet_id`); that task produces outputs (`outputs.task_id`). To assemble "outputs produced under this packet," the API joins `outputs` → `tasks` where `tasks.work_packet_id = packet.id`.
- **Acceptance coupling:** a packet's `acceptance_criteria` is the rubric against which its outputs are judged before the packet moves to `accepted`. The API's `accept` operation (§19) should verify that the governed task's outputs satisfy the criteria — but this is an application/human judgment, not a DB constraint. The packet does not aggregate output status; outputs belong to tasks.
- **Category A delivery gate:** external output delivery (`outputs.status → delivered`) is a Category A approval owned by the Output API. A packet may declare in its `scope`/`constraints` that external delivery is required, which informs whether `approval_required_before_start` or downstream Category A gates apply — but the delivery approval subject is the **output**, not the packet.

---

## 16. Knowledge Relationships

Work packets are first-class knowledge subjects and research anchors:

- **Knowledge records (`014`):** `knowledge_records.subject_type` includes `'work_packet'`. A knowledge record may be scoped directly to a packet (`subject_type='work_packet'`, `subject_id=packet.id`) — capturing spec rationale, lessons, or synthesis tied to the specification itself. `knowledge_record_links.linked_entity_type` also includes `'work_packet'`, allowing a record primarily about another entity to reference a packet as a secondary link.
- **Research assets (`014`, `work_packet_research_assets`):** a dedicated junction links packets ↔ research assets. Columns: `organization_id`, `work_packet_id` (FK → work_packets, **`on delete cascade`**), `research_asset_id` (FK → research_assets, `on delete cascade`), `linked_at`, `notes`; unique on `(work_packet_id, research_asset_id)`. RLS is enabled on the junction.
  - **Cascade note:** because `work_packet_research_assets.work_packet_id` is `on delete cascade`, a hard delete of a packet would cascade-remove its research links. This is moot for the authenticated path (no hard DELETE policy exists), but matters for any service-role hard delete — and is a reason to prefer soft-delete (§23).
- **Agent knowledge access:** per the runtime data model agent-boundary note, agents may read `knowledge_records` scoped to their assigned `task_id`, parent `project_id`, **or linked `work_packet_id`**. This is the one sanctioned channel by which an agent obtains packet-derived context — through curated knowledge records, never through the `work_packets` table.

---

## 17. Runtime Relationships

| Surface | Column | RLS behavior |
|---------|--------|--------------|
| `background_jobs` | `related_work_packet_id` (FK → work_packets, `on delete set null`) | `020` SELECT: dept_lead/dept_member see a job when `related_work_packet_id` resolves to a packet in their department; org_admin sees all; **agents do not get packet-job visibility** (their only job path is `related_task_id` → assigned task). INSERT is org_admin-only (authenticated) or service_role; the org_admin INSERT WITH CHECK validates `related_work_packet_id` is org-local and live. |
| `agent_activity` | `work_packet_id` (FK → work_packets, `on delete set null`) | `020` INSERT: agent self-pinned; packet must be org-local + live (no dept/assignment check). SELECT: org_admin all; dept_lead/member by **`task_id`** department (not `work_packet_id`); agent own rows. Append-only. |

**Packet-driven async work** (e.g., a workflow step executing against a packet, an approval notification for a packet's start gate) is enqueued as `background_jobs` with `related_work_packet_id` set. The Work Packet API does not drive job state — that is service-role territory — but surfaces job links read-only to dept-scoped roles.

**Service-role discipline:** any service-role process that updates packet status (e.g., a workflow runner moving `ready → in_execution` after an approval clears) must carry `organization_id`, record the acting context in `execution_logs`, and honor the `approval_required_before_start` gate before transitioning. Service-role bypasses RLS but must not bypass the start-gate business rule.

---

## 18. Realtime Requirements

> **`work_packets` is NOT in the MVP realtime publication.** The published set is `tasks`, `approvals`, `blockers` (runtime data model §F step 28). Subscribers do **not** receive live work-packet row changes.

Consequences for the API design:

- **Packet status changes are not streamed.** Clients observe packet progress by polling the Read API, or — preferably — by subscribing to the **realtime-eligible proxies**:
  - **`approvals`** (published): the `pending → approved/rejected` transition on a `subject_type='work_packet'` approval signals the start gate clearing or failing. This is the live signal that a packet is about to enter (or be blocked from) `in_execution`.
  - **`blockers`** (published): a `blocked_entity_type='work_packet'` blocker opening/resolving streams in real time.
  - **`tasks`** (published): tasks spawned from or governed by a packet stream their own status; packet decomposition progress is observable through child task changes.
- **No RLS review is required to "enable" packet realtime** because it is deliberately *not* published. If a future phase adds `work_packets` to the publication, the SELECT policy (dept-scoped, no agent path) would make the channel safe by construction — but that is out of scope here (no future-schema design).
- **API guidance:** the Work Packet API should expose packet state primarily through request/response reads, and lean on the approval/blocker/task realtime channels for push-style updates rather than promising a packet subscription that the deployed publication does not provide.

---

## 19. API Operation Catalog

Each operation uses the 8-field template: Purpose · Inputs · Outputs · Auth · RLS expectations · Failure modes · Audit · Approval. `organization_id` is JWT-derived and omitted from inputs.

### 19.1 `work_packet.create`
- **Purpose:** author a packet at `draft` (or `ready`).
- **Inputs:** `title`, `objective`, `parent_type`, `parent_id`, `department_id`; optional `scope`, `acceptance_criteria`, `constraints`, `priority`, `approval_required_before_start`, `status` (`draft`|`ready`).
- **Outputs:** packet `id`, `status`, `author_user_id`, timestamps.
- **Auth:** org_admin / dept_lead / dept_member; non-admin dept-pinned.
- **RLS:** `work_packets_insert_dept_scope` — author self-pin; role/dept check; dept live; parent validated (project org-local; task org-local + dept-match + live).
- **Failure modes:** agent/read_only → `forbidden`; bad JSON shape → `validation`; cross-dept dept → RLS reject; task parent in other dept → RLS reject; bad `parent_id` → RLS reject; initial status ∉ {draft, ready} → `validation`.
- **Audit:** `execution_logs` `state_change` "created at {status}".
- **Approval:** none (Category C).

### 19.2 `work_packet.get` / `work_packet.list`
- **Purpose:** read by id / list in visible scope.
- **Inputs:** `id`; filters (`status`, `priority`, `parent_type`, `parent_id`, `author_user_id`, `approval_required_before_start`, `department_id` for admin, date range).
- **Outputs:** packet row(s).
- **Auth:** all roles **except agent**; visibility RLS-determined.
- **RLS:** `work_packets_select_dept_scope`.
- **Failure modes:** out-of-scope/deleted/agent/null → `not_found`/empty.
- **Audit:** none.
- **Approval:** none.

### 19.3 `work_packet.update`
- **Purpose:** amend spec fields (`title`, `objective`, `scope`, `acceptance_criteria`, `constraints`, `priority`, `approval_required_before_start`).
- **Inputs:** `id`; mutable fields (status excluded — use dedicated transition ops).
- **Outputs:** updated packet.
- **Auth:** org_admin or packet's dept_lead. **Members excluded.**
- **RLS:** `work_packets_update_dept_scope` USING + WITH CHECK (parent re-validated).
- **Failure modes:** member/read_only/agent → `not_found`/0 rows; cross-dept lead → `not_found`/0 rows; status field in payload → `conflict` (redirect to transition op); bad JSON shape → `validation`; cross-dept parent re-point → RLS reject.
- **Audit:** `execution_logs` `state_change` with changed fields.
- **Approval:** none for field edits.

### 19.4 `work_packet.mark_ready`  (`draft → ready`)
- **Purpose:** declare the spec complete enough to start.
- **Inputs:** `id`.
- **Outputs:** packet at `ready`.
- **Auth:** org_admin / dept_lead.
- **RLS:** UPDATE policy as §19.3.
- **Failure modes:** not in `draft` → `conflict`; member/read_only/agent → `not_found`/0 rows; empty `acceptance_criteria` → `validation` (Layer 4 readiness rule).
- **Audit:** `execution_logs` `state_change` "draft→ready".
- **Approval:** none.

### 19.5 `work_packet.request_start_approval`  (`ready → pending_approval`)
- **Purpose:** open the Category B start gate when `approval_required_before_start = true`.
- **Inputs:** `id`; `approver_role` (default Department lead), optional `approver_user_id`, optional `expires_at`.
- **Outputs:** packet at `pending_approval`; approval `id` with `subject_type='work_packet'`, `category='b'`, `status='pending'`.
- **Auth:** org_admin / dept_lead (packet update) + Approval INSERT (org_admin/dept_lead/dept_member per `013`).
- **RLS:** packet UPDATE + `approvals` INSERT (subject must be org-local, dept-matched, pending, category a/b).
- **Failure modes:** `approval_required_before_start = false` → `conflict` (no gate to open); not in `ready` → `conflict`; member attempt on packet transition → `not_found`/0 rows.
- **Audit:** `execution_logs` `approval_action` "start approval requested" + `state_change` "ready→pending_approval".
- **Approval:** this creates the gate.

### 19.6 `work_packet.start`  (`ready → in_execution` or `pending_approval → in_execution`)
- **Purpose:** license the packet to run.
- **Inputs:** `id`.
- **Outputs:** packet at `in_execution`.
- **Auth:** org_admin / dept_lead.
- **RLS:** packet UPDATE policy.
- **Failure modes (Layer 4/5):**
  - `approval_required_before_start = true` AND no `approved` work_packet approval → `approval_required`.
  - From `ready` while gate is armed (approval required but not yet `pending_approval`/`approved`) → `approval_required`.
  - Not in `ready`/`pending_approval` → `conflict`.
  - member/read_only/agent → `not_found`/0 rows.
- **Audit:** `execution_logs` `state_change` "→in_execution" with approval id in metadata when gated.
- **Approval:** Category B when `approval_required_before_start = true`.

### 19.7 `work_packet.accept`  (`in_execution → accepted`)
- **Purpose:** finalize the packet as verified against `acceptance_criteria`.
- **Inputs:** `id`; optional verification note.
- **Outputs:** packet at `accepted`.
- **Auth:** org_admin / dept_lead.
- **RLS:** packet UPDATE policy.
- **Failure modes:** not in `in_execution` → `conflict`; member/read_only/agent → `not_found`/0 rows; (Layer 4 advisory) governed tasks' outputs not satisfying criteria → surface warning, not a hard DB block.
- **Audit:** `execution_logs` `state_change` "→accepted".
- **Approval:** none.

### 19.8 `work_packet.supersede`  (`ready`/`in_execution → superseded`)
- **Purpose:** retire a packet replaced by a newer one.
- **Inputs:** `id`; optional `superseded_by` packet id (recorded in audit metadata — no DB column for it).
- **Outputs:** packet at `superseded`.
- **Auth:** org_admin / dept_lead.
- **RLS:** packet UPDATE policy.
- **Failure modes:** terminal-state packet → `conflict`; member/read_only/agent → `not_found`/0 rows.
- **Audit:** `execution_logs` `state_change` "→superseded" with replacement id in metadata.
- **Approval:** none.

### 19.9 `work_packet.cancel`  (`any non-terminal → cancelled`)
- **Purpose:** abandon a packet.
- **Inputs:** `id`; optional reason.
- **Outputs:** packet at `cancelled`.
- **Auth:** org_admin / dept_lead.
- **RLS:** packet UPDATE policy.
- **Failure modes:** already terminal → `conflict`; member/read_only/agent → `not_found`/0 rows.
- **Audit:** `execution_logs` `state_change` "→cancelled" with reason.
- **Approval:** none.

### 19.10 `work_packet.link_research_asset`
- **Purpose:** attach a research asset to the packet's specification.
- **Inputs:** `id` (packet), `research_asset_id`, optional `notes`.
- **Outputs:** `work_packet_research_assets` row.
- **Auth:** org_admin / dept_lead / dept_member with packet visibility (junction RLS, `014`/Phase E policies, dept-scoped).
- **RLS:** junction INSERT under the caller's dept scope; unique `(work_packet_id, research_asset_id)`.
- **Failure modes:** duplicate link → `conflict` (unique violation); packet not visible → `not_found`; foreign research asset → RLS reject.
- **Audit:** `execution_logs` note "research asset linked".
- **Approval:** none.

### 19.11 `work_packet.decompose_to_task`  (bridge)
- **Purpose:** spawn a task governed by this packet (sets the new task's `work_packet_id = packet.id`).
- **Inputs:** `id` (packet); task fields (`title`, `project_id`, `priority`, optional `assigned_to_user_id`); `department_id` defaults to the packet's department.
- **Outputs:** task `id` with `work_packet_id` bound.
- **Auth:** task INSERT authority — org_admin / dept_lead / dept_member in the packet's department (Task API `tasks_insert_dept_scope`).
- **RLS:** Task INSERT validates `work_packet_id` org-local + same department as the task (`009`). Because the new task's department equals the packet's department, the pointer validates.
- **Failure modes:** agent attempt → `forbidden` (task INSERT excludes agents); packet not visible → `not_found`; cross-dept mismatch → RLS reject.
- **Audit:** `execution_logs` on packet ("decomposed → task {id}") and on the task ("created from work packet {id}").
- **Approval:** none to spawn; the task and packet carry their own gates.

### 19.12 `work_packet.soft_delete`
- **Purpose:** retire an erroneous/duplicate packet; set `deleted_at`.
- **Inputs:** `id`.
- **Outputs:** packet hidden.
- **Auth:** org_admin, or the packet's dept_lead (both are in the UPDATE policy).
- **RLS:** modeled as UPDATE setting `deleted_at`; org_admin or dept_lead-in-dept. No hard DELETE policy exists.
- **Failure modes:** member/read_only/agent → `not_found`/0 rows; cross-dept lead → `not_found`/0 rows.
- **Audit:** `execution_logs` note + (admin path) `audit_events` (`event_category='admin'`, `entity_type='work_packet'`).
- **Approval:** none.

---

## 20. Validation Rules

| Rule | Enforced by |
|------|-------------|
| `title` non-empty (trimmed) | DB check (`work_packets_title_not_empty`) + app |
| `objective` non-empty (trimmed) | DB check (`work_packets_objective_not_empty`) + app |
| `scope` is a JSON object | DB check (`work_packets_scope_is_object`) + app |
| `acceptance_criteria` is a JSON array | DB check (`work_packets_acceptance_criteria_is_array`) + app |
| `constraints` is a JSON object | DB check (`work_packets_constraints_is_object`) + app |
| `parent_type ∈ {task, project}` | DB check (`work_packets_parent_type_check`) + app |
| `priority ∈ {low, normal, high, critical}` | DB check (`work_packets_priority_check`) + app |
| `status ∈ {draft, ready, pending_approval, in_execution, accepted, superseded, cancelled}` | DB check (`work_packets_status_check`) |
| `author_user_id = current_user_id()` | RLS WITH CHECK (INSERT) |
| `department_id` org-local and live; for non-admin, equals `current_department_id()` | RLS WITH CHECK + app |
| `parent_type='project'` → project org-local and live | RLS WITH CHECK (EXISTS) |
| `parent_type='task'` → task org-local, live, **and same department as packet** | RLS WITH CHECK (EXISTS) |
| `approval_required_before_start` default `false` | DB default |
| Start gate: no `ready/pending_approval → in_execution` when gate true and no approved approval | **App (Layer 4/5)** — DB permits any valid status |
| Initial `status` must be `draft` or `ready` | App (Layer 4) |
| Legal status transition | App (Layer 4) |
| No transition from terminal (`accepted`, `superseded`, `cancelled`) | App (Layer 4) |
| `organization_id = current_organization_id()` | DB + app (never client-supplied) |

---

## 21. Error Model

Per the spine — unauthorized reads default to `not_found` (RLS makes non-visible rows invisible); `forbidden` only when the actor is known to have visibility/role but lacks the specific permission.

| Class | HTTP | Work-packet trigger |
|-------|------|---------------------|
| `unauthenticated` | 401 | No JWT / null `current_user_id` |
| `forbidden` | 403 | Agent/read_only attempting `create`; known-visible packet but disallowed action by role at app layer |
| `not_found` | 404 | Packet not in caller's scope (cross-dept, deleted, **agent caller — no SELECT path**); member/read_only/agent UPDATE → 0 rows |
| `conflict` | 409 | Illegal status transition; terminal-state mutation; opening start gate when `approval_required_before_start = false`; duplicate research-asset link |
| `approval_required` | 409 | `→ in_execution` while gate armed and no approved Category B approval |
| `validation` | 422 | Empty `title`/`objective`; `scope`/`constraints` not object; `acceptance_criteria` not array; bad `parent_type`/`priority`/`status` enum; initial status ∉ {draft, ready} |
| `rate_limited` | 429 | Authoring/transition burst throttle |
| `internal` | 500 | Unexpected; async failures surface in background_jobs/DLQ |

**Agent-specific clarity:** an agent calling `work_packet.get` receives `not_found` (empty), never `forbidden` — there is no SELECT policy, so the row is simply invisible. An agent calling `work_packet.create`/`update` receives `forbidden` only if the app detects the role pre-write; at the DB layer the INSERT raises `42501` and UPDATE matches 0 rows.

---

## 22. Audit Requirements

| Event | Surface | Required fields |
|-------|---------|----------------|
| Packet created | `execution_logs` | `state_change`, `actor=author_user_id`, "created at {status}", `parent_type`/`parent_id` in metadata |
| Spec field update | `execution_logs` | `state_change`, changed fields |
| `draft→ready` | `execution_logs` | `state_change` "draft→ready" |
| Start approval requested | `execution_logs` | `approval_action`, approval `id`, `category='b'` |
| `→pending_approval` / `→in_execution` | `execution_logs` | `state_change`, approval id in metadata when gated |
| `→accepted` | `execution_logs` | `state_change` "→accepted", verification note |
| `→superseded` | `execution_logs` | `state_change`, replacement packet id in metadata |
| `→cancelled` | `execution_logs` | `state_change`, reason |
| Research asset linked | `execution_logs` | note, `research_asset_id` |
| Decompose → task | `execution_logs` (packet + task) | "decomposed → task {id}" / "created from work packet {id}" |
| Soft-delete | `execution_logs` (+ `audit_events` for admin) | note; `audit_events` `event_category='admin'`, `entity_type='work_packet'` |

All audit surfaces are append-only. No log row is updated or deleted.

---

## 23. Security Model

- **Department isolation:** `work_packets_select_dept_scope` pins `department_id = private.current_department_id()` for all non-admin roles. Cross-department packet reads are impossible for authenticated non-admin callers.
- **No agent surface:** the absence of any agent SELECT/INSERT/UPDATE policy is a deliberate containment boundary. Agents cannot enumerate, read, author, or mutate specifications. The specification reaches the agent only through curated channels (task context projection, knowledge records scoped to the packet) — never raw table access.
- **Author pin:** `author_user_id = private.current_user_id()` (INSERT WITH CHECK) prevents authoring under a borrowed identity.
- **Member write-fence:** `department_member` can author a packet but cannot advance, gate, accept, supersede, cancel, or delete it — the UPDATE policy admits only org_admin and dept_lead. Lifecycle authority is concentrated in leads.
- **Polymorphic-parent integrity without a DB FK:** `parent_id` has no foreign key; integrity is enforced by RLS EXISTS subqueries on INSERT/UPDATE. The task-parent branch additionally enforces **department co-tenancy** (`task.department_id = packet.department_id`), preventing a packet from binding to another department's task. Verified analogous behavior in the G3 §26 matrix (transitive RLS denial).
- **Start-gate enforcement is application-owned:** the DB will happily set `status='in_execution'`; only the Work Packet API (Layer 4/5) blocks it when `approval_required_before_start = true` without an approved approval. This places the most important governance gate in application code — it must be implemented and tested as a first-class invariant (see §26), not assumed from RLS.
- **No hard delete:** the absence of a DELETE policy means retirement is soft-delete only on the authenticated path. The `work_packet_research_assets` `on delete cascade` would only fire under a service-role hard delete — another reason to standardize on soft-delete.
- **Scope-injection defense:** `department_id` in a non-admin request body is validated against `current_department_id()` in WITH CHECK; `organization_id` is always JWT-derived.

---

## 24. Performance Considerations

The deployed indexes (from `007`) shape efficient access patterns:

| Index | Supports |
|-------|----------|
| `work_packets_organization_status_idx (organization_id, status)` | org-wide status filters (org_admin list views, status dashboards) |
| `work_packets_organization_department_status_idx (organization_id, department_id, status)` | the dominant dept-scoped list query — matches the SELECT RLS shape exactly |
| `work_packets_organization_parent_idx (organization_id, parent_type, parent_id)` | "packets for this task/project" lookups (parent resolution) |
| `work_packets_author_user_id_idx (author_user_id)` | "my authored packets" |
| `work_packets_approval_required_idx (organization_id, department_id, approval_required_before_start) WHERE …` | partial index for gate-armed packets — fast "which packets need approval" scans |
| `work_packets_organization_created_at_idx (organization_id, created_at desc)` | recency-ordered listings |
| `tasks_work_packet_id_idx (work_packet_id) WHERE work_packet_id is not null` | reverse lookup: tasks governed by a packet |

**Guidance:**
- The default `list` query should filter on `(organization_id, department_id, status)` to ride `work_packets_organization_department_status_idx` and align with RLS — avoid full-table scans that RLS then filters.
- Parent resolution (`work_packet.get` joining a parent task/project) should query through `work_packets_organization_parent_idx`.
- Aggregations across packet→task→output/decision are **multi-hop joins**; for read-heavy dashboards, prefer narrow projections and the `tasks_work_packet_id_idx` reverse index rather than wide cross-entity scans.
- The partial gate index makes "packets awaiting approval" a cheap operational query — use it for the approver work queue rather than scanning all packets.

---

## 25. Failure Modes

| Scenario | Behavior | Surfaced as |
|----------|----------|-------------|
| Agent reads a packet | RLS returns nothing | `not_found` / empty |
| Member tries to advance status | UPDATE matches 0 rows | `not_found` / 0 rows |
| Start packet with armed gate, no approval | App blocks the transition | `approval_required` |
| Attach packet to a task in another department | INSERT WITH CHECK fails | RLS `42501` → `validation`/`forbidden` |
| `parent_id` points at a deleted/foreign task or project | EXISTS subquery false | RLS reject |
| `scope` supplied as an array, not object | DB check fails | `validation` |
| Cross-dept lead edits another dept's packet | USING excludes the row | `not_found` / 0 rows |
| Illegal transition (`accepted → in_execution`) | App rejects | `conflict` |
| Duplicate research-asset link | unique violation | `conflict` |
| Service-role moves packet to `in_execution` ignoring the gate | **Not blocked by DB** | latent governance breach — must be prevented in service-role code (§17) |
| Hard delete of a packet (service-role) | Cascades `work_packet_research_assets`; blocked by `on delete restrict` on FKs into the packet | avoided by soft-delete policy |

**The highest-consequence failure mode is the start-gate bypass:** because enforcement is application-side, any code path that writes `status='in_execution'` without checking `approval_required_before_start` and the approval state silently defeats the Category B control. This includes service-role and any future Edge Function. It must be centralized in one guarded transition function.

---

## 26. Verification Matrix

To be executed under the established `BEGIN…ROLLBACK` JWT harness (same method as the G3 §26 matrix), against the live DB, no persistence.

| # | Area | Test | Expected |
|---|------|------|----------|
| 1 | Visibility | org_admin SELECT both depts' packets | sees all org packets |
| 2 | Visibility | dept_lead/member/read_only SELECT | own-dept packets only |
| 3 | Visibility | **agent SELECT** | **0 rows (no policy)** |
| 4 | Visibility | null context SELECT | 0 rows |
| 5 | Visibility | deleted packet | invisible to all authenticated |
| 6 | Create | dept_member INSERT own-dept packet | success |
| 7 | Create | dept_lead INSERT own-dept packet | success |
| 8 | Create | read_only INSERT | `42501` |
| 9 | Create | agent INSERT | `42501` |
| 10 | Create | non-admin INSERT into other dept | `42501` |
| 11 | Create | author_user_id ≠ self | `42501` (self-pin) |
| 12 | Create | `parent_type='task'` with cross-dept parent task | `42501` (dept-match) |
| 13 | Create | `parent_type='project'` with foreign project | `42501` |
| 14 | Create | `scope` as array / `acceptance_criteria` as object | check-constraint violation |
| 15 | Update | dept_lead UPDATE own-dept packet | 1 row |
| 16 | Update | **dept_member UPDATE** | **0 rows (excluded)** |
| 17 | Update | read_only / agent UPDATE | 0 rows |
| 18 | Update | dept_lead UPDATE other-dept packet | 0 rows |
| 19 | Gate | `→in_execution` with gate true, no approval | app blocks (`approval_required`) |
| 20 | Gate | `→in_execution` with gate true, approval `approved` | succeeds |
| 21 | Gate | `→in_execution` with gate false | succeeds (Category C) |
| 22 | Approval | create `subject_type='work_packet'` approval, dept-matched | success |
| 23 | Approval | resolve by non-dept lead | denied/0 rows |
| 24 | Soft-delete | dept_lead soft-delete own-dept packet | 1 row; packet then invisible |
| 25 | Soft-delete | dept_member soft-delete | 0 rows |
| 26 | Task pointer | task INSERT with this packet's id, same dept | success |
| 27 | Task pointer | task INSERT with cross-dept packet id | `42501` |
| 28 | Realtime | confirm `work_packets` absent from publication | not present (tasks/approvals/blockers only) |

Tests 3, 16, 19, and 28 are the distinguishing assertions versus the Task API and must pass to confirm the contract.

---

## 27. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | **Start-gate bypass** — enforcement is application-side; any direct `status='in_execution'` write defeats the Category B control | **High** | Centralize the transition in one guarded function; cover with verification tests 19–21; forbid raw status writes in `update`; audit every `→in_execution` with the approval id |
| 2 | **Member write-fence surprise** — `department_member` can author but silently gets 0 rows on any status change | Medium | API returns a clear `forbidden`/`not_found` with guidance; document that lifecycle changes require a lead; UI hides transition actions for members |
| 3 | **Agent has no packet read path** — execution code may wrongly assume agents can fetch the packet | Medium | Project the spec into the agent's task context at dispatch; route packet-derived context through knowledge records (the sanctioned channel); never have the agent query `work_packets` |
| 4 | **No realtime on packets** — clients expecting live packet updates get none | Medium | Subscribe to `approvals`/`blockers`/`tasks` proxies; document that packet state is poll/proxy, not push |
| 5 | **Polymorphic parent without FK** — `parent_id` integrity rests entirely on RLS EXISTS; a service-role write bypassing RLS could create a dangling parent | Medium | Service-role packet writes must replicate the parent/dept-match validation; never insert packets via service-role without it |
| 6 | **Cascade on research-asset junction** — a service-role hard delete cascades `work_packet_research_assets` | Low | Standardize on soft-delete; reserve hard delete for deliberate, audited service-role cleanup |
| 7 | **Department co-tenancy coupling** — moving a packet's `department_id` (admin) without re-checking the parent task's department could violate the task-match rule | Medium | UPDATE WITH CHECK re-validates the parent on every write; the API must reject dept changes that break parent co-tenancy (RLS already does — surface it as `validation`) |
| 8 | **`accepted` without verified outputs** — packet can be accepted while governed tasks' outputs do not meet `acceptance_criteria` (no DB linkage) | Low | `accept` operation surfaces a Layer 4 advisory check joining packet→tasks→outputs; human confirmation required |

---

## 28. Dependencies

| Depends on | For |
|------------|-----|
| **G1 Auth/Context Spine** | `private.*` identity resolution; error model; role definitions |
| **G3 Task API** | the packet↔task pointer (`tasks.work_packet_id`), the dept-co-tenancy rule (verified in G3 §26), and the decomposition target |
| **Approval API** (G-governance) | the Category B start gate: `approvals` INSERT/resolve for `subject_type='work_packet'` (`013`) |
| **Blocker API** | `blocked_entity_type='work_packet'` associations (`011`/`013`) |
| **Knowledge/Research APIs** | `work_packet_research_assets` junction; `knowledge_records subject_type='work_packet'` (`014`) |
| **Runtime Ops** | `background_jobs.related_work_packet_id`, `agent_activity.work_packet_id` (`018`/`020`) — read-side surfacing only |
| **Deployed migrations** | `007` (table), `009` (RLS), `011`/`013` (governance), `014` (knowledge), `018`/`020` (runtime) — all consumed as-is, unmodified |

The Work Packet API is **downstream of** the Task API for the pointer/co-tenancy contract, and **upstream of** the Approval API for the start gate. It must not be built before G3's task RLS is verified (it is) and before the Approval API's `subject_type='work_packet'` path is available.

---

## 29. MVP Build Order

1. **Read surface** — `work_packet.get`/`list` under dept-scoped RLS. Proves the SELECT policy and the **no-agent-access** property (verification tests 1–4). Lowest risk.
2. **Create** — `work_packet.create` with JSON-shape validation, author self-pin, and parent validation (project + task-dept-match). Confirms tests 6–14.
3. **Spec update** — `work_packet.update` for field edits; establishes the member write-fence (tests 15–18).
4. **Status machine (ungated)** — `mark_ready`, `start` (gate-false path), `accept`, `supersede`, `cancel`. Establishes transition legality without approvals (test 21).
5. **Start gate** — `request_start_approval` + `start` (gated path); wire the Layer 5 Category B check against `approvals`. The single most important step (tests 19–20, 22–23).
6. **Soft-delete** — `work_packet.soft_delete` with lead/admin authority (tests 24–25).
7. **Task bridge** — `decompose_to_task` binding `tasks.work_packet_id`; verify co-tenancy (tests 26–27).
8. **Research linkage** — `link_research_asset` over the junction.
9. **Runtime/realtime surfacing** — read-only exposure of `background_jobs.related_work_packet_id` to dept roles; document the no-packet-realtime posture and wire approval/blocker/task proxies (test 28).
10. **Audit wiring** — ensure every transition emits the required `execution_logs`/`audit_events`.

Steps 1–3 deliver authoring. Steps 4–5 deliver the governed lifecycle and the Category B gate — the core value of the Work Packet layer. Steps 6–10 complete decomposition, linkage, runtime, and audit.

---

## 30. Definition of Done

- [ ] All operations resolve identity and scope only through the spine's `private.*` helpers; no client-supplied `organization_id`, `department_id`, `author_user_id`, or `role` is trusted.
- [ ] Packet SELECT is department-scoped for org_admin/lead/member/read_only; **agents receive nothing** (verified: test 3 returns 0 rows).
- [ ] INSERT is limited to org_admin/dept_lead/dept_member with `author_user_id` self-pinned; agents and read_only are denied (`42501`).
- [ ] UPDATE is limited to org_admin and dept_lead; **dept_member changes match 0 rows** (verified: test 16).
- [ ] Parent validation holds on INSERT and UPDATE: `parent_type='project'` requires a live org project; `parent_type='task'` requires a live org task **in the same department** as the packet.
- [ ] The three JSON fields are shape-validated (`scope`/`constraints` objects, `acceptance_criteria` array) before write.
- [ ] The **`approval_required_before_start` gate is enforced in one centralized transition guard**: no `→ in_execution` occurs while the gate is true without an `approved` `subject_type='work_packet'` approval (verified: tests 19–21).
- [ ] Work-packet approvals are created and resolved only by authorized roles with packet/approval department co-tenancy (`approvals.department_id = work_packets.department_id`).
- [ ] The packet↔task pointer respects department co-tenancy in both directions (verified: tests 26–27, consistent with G3 §26).
- [ ] No authenticated hard DELETE exists; retirement is soft-delete by org_admin or the packet's dept_lead.
- [ ] The API does not promise packet realtime; packet state is exposed via reads and the published `approvals`/`blockers`/`tasks` proxies (verified: test 28 — `work_packets` absent from publication).
- [ ] All transitions, links, and admin actions emit the required `execution_logs`/`audit_events`.
- [ ] No migrations, schema changes, or new roles were introduced; the deployed `007`/`009`/`011`/`013`/`014`/`018`/`020` artifacts are consumed exactly as verified.

---

## Document Boundaries

This is Phase G4 **architecture output** — the Work Packet API contract. It introduces no code, migrations, schema changes, or future-schema design, and modifies no prior plan. It consumes the deployed `work_packets` table (`007`), its RLS (`009`), the governance approval/blocker surfaces (`011`/`013`), the knowledge/research junction (`014`), and the runtime references (`018`/`020`) exactly as verified against the live database. RLS remains the primary authorization layer; the `approval_required_before_start` start gate is the one first-class invariant the application layer must own. Supabase remains the system of record. Implementation proceeds against §29.
