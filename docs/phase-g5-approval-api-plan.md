# Phase G5 — Approval API Plan

Architecture for the **Approval API** — the authorization-gate layer of the AI Command Center, where high-risk actions are held for human authorization before they proceed.

> **Auth/context contract:** [phase-g1-auth-context-spine.md](phase-g1-auth-context-spine.md)
> **Approval categories & gates:** [approval-rules.md](approval-rules.md)
> **Work Packet API (start gate consumer):** [phase-g4-work-packet-api-plan.md](phase-g4-work-packet-api-plan.md)
> **Canonical entity:** [system-entities.md](system-entities.md) §7 Approval
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)
> **Schema origin:** `supabase/migrations/011_governance_layer.sql` (table)
> **RLS (Phase D baseline):** `supabase/migrations/013_phase_d_rls_policies.sql`
> **RLS (Phase E output adjustment — LIVE):** `supabase/migrations/017_phase_e_approvals_adjustment.sql`
> **Knowledge/output layer:** `supabase/migrations/014_knowledge_output_layer.sql`, `016_phase_e_rls_policies.sql`
> **Runtime layer:** `supabase/migrations/018_runtime_hardening.sql`, `020_phase_f_rls_policies.sql`

This document is **architecture only**. No code, migrations, or schema proposals. Every statement is grounded in the deployed schema and the **live, post-`017`** RLS state, verified against database `wbtvrzivthuqqntnorsw`.

---

## Grounding Facts (from the deployed schema)

**Table:** `public.approvals` — columns (authoritative, verified live):

| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| `id` | uuid | NO | gen_random_uuid() |
| `organization_id` | uuid | NO | — |
| `department_id` | uuid | NO | — |
| `subject_type` | text | NO | — |
| `subject_id` | uuid | NO | — |
| `category` | text | NO | — |
| `trigger_reason` | text | NO | — |
| `requested_by_user_id` | uuid | YES | null |
| `approver_user_id` | uuid | YES | null |
| `approver_role` | text | NO | — |
| `status` | text | NO | `'pending'` |
| `decided_at` | timestamptz | YES | null |
| `decision_note` | text | YES | null |
| `expires_at` | timestamptz | YES | null |
| `created_at` | timestamptz | NO | now() |
| `updated_at` | timestamptz | NO | now() |

**Check constraints (verified live):**
- `subject_type ∈ {task, work_packet, decision, output}`
- `category ∈ {a, b, c}`
- `status ∈ {pending, approved, rejected, expired, withdrawn}`; default `pending`
- **`decided_at`/`status` paired invariant:** `(status='pending' AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL)` — a resolved approval must carry a decision timestamp; a pending one must not.
- `trigger_reason` length(trim) > 0; `approver_role` length(trim) > 0.

**Foreign keys:** `organization_id → organizations` (restrict), `department_id → departments` (restrict), `approver_user_id → users` (**set null**), `requested_by_user_id → users` (**set null**). **`subject_id` has NO foreign key** — polymorphic, integrity enforced by RLS EXISTS.

**No `deleted_at` column. No DELETE policy. Exactly three policies live:** `approvals_insert_department_scope`, `approvals_select_department_scope`, `approvals_update_approver_scope` (all from `017`, which dropped and replaced the Phase D `013` versions). Approvals are **append-once, resolve-once, never deleted**.

**Migration `017` is the live authority.** It replaced all three Phase D approval policies for the sole purpose of letting authenticated users safely use `subject_type='output'`. The DB check constraint already accepted `output`; `017` extended RLS to scope it. Task/work_packet/decision logic was preserved.

---

## 1. Purpose

The Approval API governs the **authorization gates** that protect the Command Center from unauthorized high-risk actions. Per [approval-rules.md](approval-rules.md), agents and automations operate autonomously within Tool Profile boundaries; actions that exceed those boundaries, affect external parties, or produce irreversible results require a human **Approval** before proceeding.

An approval is a **typed, department-scoped authorization request** against a subject (`task`, `work_packet`, `decision`, or `output`). The API lets authorized roles *request* an approval, lets the correct authority *resolve* it, and exposes its state to the subject-owning APIs that enforce the gate.

The decisive architectural truth of this layer: **an approval row records authorization; it does not mechanically block anything.** The DB will not stop a work packet from entering `in_execution`, an output from being `delivered`, or a task from reaching `done`. The *gating* — refusing the subject's forbidden transition until an approval is `approved` — lives in the subject APIs (Layer 4/5). The Approval API owns the authorization record and its lifecycle; the subject APIs own the enforcement. §13 and the gate inventory make this separation explicit.

---

## 2. Scope

**In scope:** request (create) approvals for the four subject types; read approvals within scope; resolve (`approve`/`reject`/`withdraw`) pending approvals; the department-scoped visibility model including the agent and output specifics introduced by `017`; the `expires_at` field and the system-only `expired` transition; the relationship of approval state to each subject API's gate.

**Out of scope:** the subject APIs themselves (Task G3, Work Packet G4, Output and Decision sub-plans) and their gate-enforcement logic; Category C "actions" (which never produce an approval row — see §4); `agent_activity` request signaling internals; schema changes; new roles; any RLS modification. This plan consumes the live `017` RLS exactly as deployed.

---

## 3. Approval Entity Definition

| Field | Role |
|-------|------|
| `subject_type` + `subject_id` | Polymorphic pointer to what is being authorized (`task` / `work_packet` / `decision` / `output`); no DB FK — RLS validates existence and department co-tenancy |
| `category` | `a` / `b` / `c` — but **only `a` and `b` are insertable** (see §4) |
| `trigger_reason` | Required non-empty text describing the action being gated |
| `department_id` | The approval's owning department; **must equal the subject's department** (RLS-enforced co-tenancy) |
| `requested_by_user_id` | The requester; nullable, **self-pinned if set** (`= current_user_id()` on INSERT) |
| `approver_user_id` | Optional designated approver; **advisory only** — does not restrict who may resolve (§12) |
| `approver_role` | Required non-empty text naming the authority expected to resolve (e.g., "Department lead", "Platform lead") — a routing label, not an enforced identity |
| `status` | `pending` → one of `approved` / `rejected` / `withdrawn` (authenticated) or `expired` (system) |
| `decided_at` | Resolution timestamp; null iff pending (paired invariant) |
| `decision_note` | Optional resolution rationale |
| `expires_at` | Optional deadline; drives the system `expired` transition |
| `created_at` | Serves as the request timestamp (there is no separate `requested_at` column) |

**No `deleted_at`.** An approval is immutable except for its single pending→resolved transition. It is never soft-deleted or hard-deleted on the authenticated path.

---

## 4. Approval Categories (A / B / C)

Grounded in [approval-rules.md](approval-rules.md):

### Category A — Always Required
Irreversible or externally-visible actions. An approval row is **mandatory** before the action proceeds.

| Action | Typical subject | Approver role |
|--------|-----------------|---------------|
| Send external email | `output` / `task` | Operations lead |
| Emit webhook to production | `task` | Engineering lead |
| Execute destructive shell command | `task` | Engineering lead |
| Commit to protected branch | `task` | Engineering lead |
| Create scheduled automation | `task` | Operations lead |
| **Deliver Output externally** | `output` | Operations lead |
| Domain submission | `output` | Operations lead |

### Category B — Required When Specified
Conditional gates flagged by a Work Packet or Tool Profile.

| Trigger | Condition | Subject | Approver |
|---------|-----------|---------|----------|
| Start Work Packet execution | WP `approval_required_before_start = true` | `work_packet` | Department lead |
| Confirm Decision | decision `status → pending_approval` | `decision` | Department lead |
| Invoke restricted tool | tool not in assigned Tool Profile | `task` | Platform lead |
| Exceed cost/budget constraint | WP `constraints` breached | `task` / `decision` | Department lead |

### Category C — Never Required (log-only)
Read, draft, internal state changes, `proposed` decisions, raising blockers, internal task status updates.

> **DB-enforced consequence:** the live INSERT and UPDATE policies (`017`) both require `category in ('a','b')`. **A Category C approval row cannot be created — ever.** Category C actions are recorded only as `execution_logs` entries; they never enter the `approvals` table. This is the cleanest DB-level expression of "gate vs. record": the table physically holds only gates (A/B), never log-only (C) actions. Any attempt to INSERT `category='c'` is rejected by RLS.

---

## 5. Approval Lifecycle

```text
   gated action detected (Category A or B)
            │
   request ──►  status = 'pending'        (decided_at NULL; subject frozen at its gate)
            │
       ┌────┴───────────────┬───────────────────┬─────────────────────┐
       ▼                    ▼                   ▼                     ▼
   approved             rejected            withdrawn             expired
 (authority OKs)    (authority denies)   (requester/authority   (deadline passed;
 subject proceeds   subject revises       cancels the gate)      SYSTEM only)
```

- **Request** sets `status='pending'`, `decided_at IS NULL` (paired invariant), and pins the subject + department co-tenancy.
- **Resolution** (authenticated) moves `pending → {approved, rejected, withdrawn}` and **must set `decided_at`**.
- **Expiry** (`pending → expired`) is reachable **only outside the authenticated path** — the authenticated UPDATE WITH CHECK restricts targets to `{approved, rejected, withdrawn}`. A scheduled/service-role process drives `expired` when `expires_at` passes.
- **Terminal once resolved:** the UPDATE USING clause requires `status='pending'`, so a resolved approval can never be re-resolved or reverted. A superseding decision requires a **new** approval row.

**Effect on the subject** (per approval-rules.md, enforced by the *subject* APIs, not the DB):

| Approval status | Subject effect |
|-----------------|----------------|
| `pending` | Subject frozen at its gate (Task → `in_review`, Work Packet → `pending_approval`, Output → `in_review`) |
| `approved` | Subject may proceed to its next lifecycle state |
| `rejected` | Subject returns for revision (Task → `blocked`/`backlog`; WP → `ready`/`draft`; Output → `rejected`/`in_review`) |
| `withdrawn` | Gate removed; subject returns to pre-gate state |
| `expired` | Treated as a re-gate; a fresh approval is required before the action |

---

## 6. State Machine

| From | To | Who | Enforcement |
|------|-----|-----|-------------|
| (none) | `pending` | org_admin, dept_lead, dept_member (INSERT) | RLS: category a/b, status pending, decided_at null, subject+dept validated |
| `pending` | `approved` | org_admin, dept_lead-in-dept (UPDATE) | RLS: status target ∈ {approved,rejected,withdrawn}, decided_at set |
| `pending` | `rejected` | org_admin, dept_lead-in-dept | RLS (same) |
| `pending` | `withdrawn` | org_admin, dept_lead-in-dept | RLS (same) |
| `pending` | `expired` | **system / service_role only** | NOT reachable via authenticated UPDATE |
| `approved`/`rejected`/`withdrawn`/`expired` | (any) | nobody | UPDATE USING requires `status='pending'` → terminal |

**Role facts (live `017`):**
- **INSERT** (request): `org_admin`, `department_lead`, `department_member`. **Agents and read_only are excluded.**
- **UPDATE** (resolve): `org_admin`, or `department_lead` whose `department_id` matches the approval. **dept_member, read_only, and agents cannot resolve.**
- The paired invariant (`decided_at`) and the category/status enums are DB check constraints — they hold even against a service-role write that bypasses RLS.

---

## 7. Visibility Model

**Live policy `approvals_select_department_scope` (`017`).** Three role branches:

**Branch 1 — org_admin:** sees all approvals in the org (any subject_type).

**Branch 2 — dept_lead / dept_member / read_only (dept-scoped):**
```text
department_id = current_department_id()
AND (subject_type != 'output'
     OR EXISTS output o WHERE o.id = subject_id
        AND o.department_id = current_department_id() AND o.deleted_at is null)
```
For non-output subjects, department match suffices. **For `output` subjects, an additional check confirms the output itself is in the caller's department and live** — the `017` refinement that keeps output approvals correctly dept-scoped via the output's own `department_id`.

**Branch 3 — agent (assigned-task-derived):** an agent sees an approval only when its subject ties to a task assigned to that agent:
- `subject_type='task'` → the task is assigned to the agent;
- `subject_type='decision'` → the decision's parent task is assigned to the agent;
- `subject_type='output'` → the output's parent task is assigned to the agent (and `o.department_id = approvals.department_id`).

> **Agents never see `work_packet` approvals.** Branch 3 omits `work_packet` entirely — consistent with G4 (agents have no work-packet visibility at all). An agent can observe the gate state of approvals on its assigned task, that task's decisions, and that task's outputs, but not work-packet start-gate approvals.

**Visibility matrix:**

| Role | task | work_packet | decision | output |
|------|:----:|:-----------:|:--------:|:------:|
| org_admin | all org | all org | all org | all org |
| dept_lead / member / read_only | own dept | own dept | own dept | own dept **and output in dept** |
| agent | assigned task | **none** | assigned task's decisions | assigned task's outputs |
| null context | none | none | none | none |

---

## 8. Auth Contract

Identity and scope resolve exclusively through the spine's `private.*` helpers. No client-supplied `organization_id`, `department_id`, `requested_by_user_id`, `category`, or `status` is trusted.

| Capability | org_admin | dept_lead | dept_member | read_only | agent |
|------------|:---------:|:---------:|:-----------:|:---------:|:-----:|
| Request (INSERT, a/b) | ✓ | ✓ | ✓ | ✗ | ✗ |
| Read (scope per §7) | all org | own dept | own dept | own dept | assigned-task-derived (no WP) |
| Resolve (approve/reject/withdraw) | ✓ | ✓ (own dept) | ✗ | ✗ | ✗ |
| Drive `expired` | ✗ (system) | ✗ (system) | ✗ | ✗ | ✗ |

- **Requester self-pin:** if `requested_by_user_id` is set on INSERT it must equal `current_user_id()`; it may also be null.
- **Non-admin requesters are department-pinned:** `department_id = current_department_id()` unless org_admin.
- **Resolver authority is org_admin or dept_lead-in-department only**, regardless of `approver_user_id` (§12).
- **Agents cannot request approvals through this API.** They signal the need via `agent_activity` (`activity_type='approval_requested'`); an authorized human role or service-role then creates the approval row (§19 Relationships).

---

## 9. Create Contract (Request)

- **Purpose:** open a Category A or B gate by requesting an approval for a subject.
- **Inputs:** `subject_type` (`task`|`work_packet`|`decision`|`output`), `subject_id`, `category` (`a`|`b`), `trigger_reason` (non-empty), `department_id`, `approver_role` (non-empty); optional `requested_by_user_id` (self or null), `approver_user_id` (active org member), `expires_at`. `organization_id` is JWT-derived; `status` is forced `pending`; `decided_at` must be null.
- **Outputs:** approval `id`, `status='pending'`, `created_at`.
- **Auth:** authenticated; role ∈ `{org_admin, department_lead, department_member}`; non-admin dept-pinned. Agents and read_only cannot request.
- **RLS expectations (`approvals_insert_department_scope`):** org pin; role check; `category in (a,b)`; `status='pending'`; `decided_at IS NULL`; requester self-pin if set; `approver_user_id` active org member if set; department live; dept pin for non-admin; **subject existence + department co-tenancy** —
  - `task` → task org-local, `t.department_id = approvals.department_id`, live;
  - `work_packet` → WP org-local, `wp.department_id = approvals.department_id`, live;
  - `decision` → decision org-local + parent task `t.department_id = approvals.department_id`, live;
  - `output` → output org-local, `o.department_id = approvals.department_id`, live.
- **Failure modes:** agent/read_only → `forbidden`; `category='c'` → RLS reject (`validation`); `status≠pending` or `decided_at` set → RLS reject; empty `trigger_reason`/`approver_role` → `validation` (DB check); subject in another department → RLS reject; nonexistent/deleted subject → RLS reject; `approver_user_id` non-active → RLS reject; cross-dept non-admin → RLS reject.
- **Audit:** `execution_logs` `approval_action` "approval requested: {trigger_reason}" on the subject's context.
- **Approval:** none (requesting an approval is itself Category C-equivalent — the request is not gated).

---

## 10. Read Contract

- **Purpose:** read an approval by id / list approvals in scope.
- **Inputs:** `id` (get); filters: `subject_type`, `subject_id`, `category`, `status`, `department_id` (org_admin), `approver_role`, `requested_by_user_id`, `expires_at` range, date range (list).
- **Outputs:** approval row(s).
- **Auth:** any authenticated active member; visibility per §7. Agents are limited to assigned-task-derived task/decision/output approvals (no work_packet).
- **RLS expectations:** `approvals_select_department_scope`. The API must not widen or narrow below RLS. Output-subject reads for dept roles additionally require the output be in the caller's department (live `017` clause).
- **Failure modes:** out-of-scope/cross-dept → `not_found`; agent requesting a work_packet approval or a non-assigned-task approval → `not_found`; null context → `not_found`.
- **Audit:** read-only; none required.
- **Approval:** none.

---

## 11. Update Contract

The only mutable transition is **pending → resolved**. There is no field-level "edit" of an approval: the UPDATE WITH CHECK forces `status in {approved, rejected, withdrawn}`, `category in {a,b}`, and `decided_at IS NOT NULL`. An approval's `subject`, `category`, `trigger_reason`, and `department` are effectively immutable after creation (any UPDATE must satisfy the resolution WITH CHECK, which re-validates them unchanged against the subject).

- **Purpose:** resolve a pending approval (the substance is the Resolution Contract, §12).
- **Auth:** org_admin or dept_lead-in-dept.
- **RLS expectations:** USING requires `status='pending'`; WITH CHECK requires the resolution shape. No partial edits, no re-opening.
- **Failure modes:** any update to an already-resolved approval → 0 rows (USING fails); dept_member/read_only/agent → 0 rows; target status `pending` or `expired` → WITH CHECK reject; `decided_at` left null → reject.
- **Approval:** none.

---

## 12. Resolution Contract

- **Purpose:** an authority approves, rejects, or withdraws a pending gate.
- **Inputs:** `id`; `status` ∈ `{approved, rejected, withdrawn}`; `decided_at` (set to now); optional `decision_note`.
- **Outputs:** resolved approval with `decided_at` set.
- **Auth:** **org_admin, or department_lead whose `department_id` matches the approval.** No other role — including the named `approver_user_id` if that user is a member — can resolve.
- **RLS expectations (`approvals_update_approver_scope`):** USING (org pin; `status='pending'`; role = org_admin or dept_lead-in-dept) + WITH CHECK (org pin; `category in a,b`; `status in approved/rejected/withdrawn`; `decided_at not null`; role gate repeated; requester live if set; approver active if set; department live; subject existence + dept co-tenancy re-validated for all four types).
- **Failure modes:** resolve by member/read_only/agent → 0 rows; resolve cross-dept lead → 0 rows; resolve already-resolved → 0 rows; target `expired` → reject (system-only); missing `decided_at` → reject; subject deleted between request and resolve → WITH CHECK reject.
- **Audit:** `execution_logs` `approval_action` with the resolution and `decision_note`.

> **`approver_user_id` is advisory, not enforced.** The RLS resolver gate is purely role+department (`org_admin` OR `department_lead` in dept). Designating `approver_user_id` routes/notifies but does **not** restrict resolution to that person — any qualifying lead or admin may resolve. If a deployment needs "only the named approver may resolve," that is an **application-layer** rule the API must add; the DB does not enforce it (Risk §27).

---

## 13. Subject Relationships (Gate vs. Record)

`approvals` is polymorphic over four subject types via `subject_type` + `subject_id` (no FK; RLS validates existence and `subject.department_id = approvals.department_id`). For each, the approval is a **gate enforced by the subject API**, never by the approvals table itself:

| Subject | Gate point (enforced by the subject API, Layer 4/5) | Category |
|---------|------------------------------------------------------|----------|
| `work_packet` | `pending_approval → in_execution` blocked until `approved` | B (start gate) |
| `output` | `status → delivered` blocked until `approved` | A (external delivery) |
| `decision` | `pending_approval → approved`/effect blocked until `approved` | B (confirm decision) |
| `task` | `in_review → done` (and gated external actions: email/webhook/shell/commit/schedule) | A/B |

**The single most important separation in this layer:** the DB neither blocks nor permits the subject's transition based on approval state. The `approvals` table only records that authorization was requested and how it resolved. The **Work Packet, Output, Decision, and Task APIs** are responsible for consulting approval state and refusing the forbidden transition. An approval is therefore a *gate* in effect but a *record* in mechanism — and a missing enforcement check in any subject API silently defeats the gate (§27 Risk 1).

---

## 14. Request Relationships

`requests` are **not** an approval subject (`subject_type ∉ {request}`). A request never carries a direct approval. Approval gating enters only after a request is converted to downstream subjects:

```text
request ──spawns──► task ──► (work_packet | decision | output) ──► approval
```

A request's own lifecycle (received → triaged → in_progress → cancelled) is governed by the Request API's RLS (org-wide visibility, submitter/triage update authority), with **no approval gate** — consistent with intake being Category C. The Approval API has no request-facing operation.

---

## 15. Task Relationships

- **Subject:** `subject_type='task'`, `subject_id=task.id`, with `t.department_id = approvals.department_id` (RLS co-tenancy).
- **Gate points:** Category A task actions (external email, webhook emit, destructive shell, protected-branch commit, scheduled automation) and the Category B restricted-tool invocation. The Task API also consults open task/output/decision approvals before allowing `in_review → done` (G3 §12, §22.8).
- **Agent visibility:** an agent assigned to the task sees its task approvals (Branch 3, §7) — read-only. The agent cannot request or resolve.
- **Requesters:** dept_member/lead/org_admin in the task's department. **Resolvers:** org_admin or the task department's lead.
- **Reject effect:** per approval-rules.md, a rejected task approval typically moves the task to `blocked` or `backlog` — enforced by the Task API.

---

## 16. Work Packet Relationships

- **Subject:** `subject_type='work_packet'`, `subject_id=wp.id`, with `wp.department_id = approvals.department_id`.
- **The Category B start gate:** this is the headline work-packet gate. When a WP has `approval_required_before_start = true`, the Work Packet API (G4 §11, §19.5–19.6) requires an `approved` work-packet approval before `pending_approval → in_execution`. The Approval API supplies that authorization record; **the WP API enforces the block.** The DB permits `in_execution` regardless.
- **Department co-tenancy:** the approval's department must equal the WP's department — the requesting lead/member and the resolving lead are co-tenant with the packet.
- **Agents are blind to work-packet approvals** (§7 Branch 3 omits `work_packet`). An agent executing an assigned task whose work packet is gated cannot see that gate's approval; the orchestration layer must surface start-authorization to the agent out-of-band, not via the agent's own approval reads.

---

## 17. Output Relationships

- **Subject:** `subject_type='output'`, `subject_id=output.id`, with `o.department_id = approvals.department_id`.
- **This is the `017` addition.** Before `017`, the Phase D policies (`013`) did not scope output approvals; `017` dropped and replaced all three policies so authenticated users can safely create, read, and resolve `output` approvals. The DB check constraint already accepted `output`; `017` made RLS behavior correct.
- **The Category A external-delivery gate:** `outputs.status → delivered` (which the DB pairs with a non-null `delivered_at`) requires an `approved` output approval. The **Output API** enforces this; the Approval API records the authorization.
- **Output-specific SELECT refinement:** for dept_lead/member/read_only, an output approval is visible only if the output itself is in the caller's department and live — a tighter check than other subject types, ensuring an approval cannot leak an out-of-department output's existence (`017` SELECT Branch 2).
- **Agent visibility:** an agent sees an output approval only when the output's parent task is assigned to the agent and the output is dept-co-tenant (§7 Branch 3).

---

## 18. Decision Relationships

- **Subject:** `subject_type='decision'`, `subject_id=decision.id`. RLS validates via `decisions JOIN tasks` that the decision's parent task is `t.department_id = approvals.department_id` and live (decisions have no own `department_id`; they inherit department through their NOT-NULL `task_id`).
- **Decision status enum (live):** `{proposed, confirmed, pending_approval, approved, rejected, superseded}`.
- **The Category B confirm gate:** moving a decision to `pending_approval` opens a decision approval; the **Decision API** blocks the decision's effect/confirmation until the approval is `approved`. The Approval API records the authorization.
- **Cost-constraint coupling:** a decision that breaches a work packet `constraints` value is a Category B trigger; the approval subject may be the decision or the task, evaluated against the packet's constraint payload (the packet supplies the limit; the gate fires on the decision/task).
- **Agent visibility:** an agent sees decision approvals for decisions on its assigned task (§7 Branch 3) — read-only.

---

## 19. Runtime Relationships

- **Agent request signaling (not an INSERT):** agents are excluded from the approval INSERT policy. An agent that needs authorization records an `agent_activity` row with `activity_type='approval_requested'` (`018`/`020`; `agent_user_id` self-pinned, append-only). This is a **signal**, not an approval. An authorized human role — or a service-role orchestration step — then creates the actual `approvals` row on the agent's behalf. The API must treat agent "requests" as inbound signals to be triaged into approval rows by an authorized actor.
- **Expiry processing:** the authenticated path cannot set `status='expired'`. A scheduled/service-role job (e.g., a `background_jobs` runner over `scheduled_tasks`) scans `pending` approvals where `expires_at < now()` and transitions them to `expired`, bypassing RLS but honoring the `decided_at` paired invariant (it must set `decided_at` when leaving `pending`).
- **Notification jobs:** approval lifecycle changes (requested, approved, rejected, expired) drive `background_jobs` of type `approval_notification` (runtime data model §F). The Approval API does not own job state; it surfaces approval state, and the runtime layer fans out notifications.
- **No direct runtime FK to approvals:** `background_jobs` references `task`/`request`/`work_packet` via `related_*_id`, not approvals directly. Approval-related jobs carry the subject's id, not the approval's — the job is about the subject; the approval is the gate.

---

## 20. Realtime Requirements

- **Designated intent:** the runtime data model (§F step 28) names `approvals` as one of the three MVP realtime tables (with `tasks` and `blockers`). Its SELECT policy (`017`) is RLS-safe for realtime: department-scoped for human roles, assigned-task-derived for agents, with the output sub-check — a subscriber receives only approval changes they could already read.
- **Deployed-state caveat (verified):** querying `pg_publication_tables` on the live database returns **no publication membership** for `approvals` (nor `tasks`/`blockers`). The realtime publication step appears **not yet materialized** in this database — it is a deployment action (often a dashboard/separate step), not part of migrations `011`–`020`. **The API must not assume a live approval subscription exists; confirm/enable the publication before relying on push delivery.**
- **Why approvals realtime matters:** approval status is the primary *push* signal for subject-gate clearing. A work packet awaiting start, an output awaiting delivery, or a task awaiting completion all unblock when their approval flips to `approved`. Subscribers (approver work queues, subject dashboards) want this live.
- **Guidance:** design the API to expose approval state via request/response reads as the reliable path, and to *light up* realtime when the publication is enabled — but gate that behavior on verified publication membership, not on the documented intent alone.

---

## 21. API Operation Catalog

8-field template: Purpose · Inputs · Outputs · Auth · RLS expectations · Failure modes · Audit · Approval. `organization_id` JWT-derived.

### 21.1 `approval.request`
- **Purpose:** open a Category A/B gate.
- **Inputs:** `subject_type`, `subject_id`, `category` (a|b), `trigger_reason`, `department_id`, `approver_role`; optional `requested_by_user_id` (self|null), `approver_user_id`, `expires_at`.
- **Outputs:** approval `id`, `status='pending'`.
- **Auth:** org_admin / dept_lead / dept_member; non-admin dept-pinned.
- **RLS:** `approvals_insert_department_scope` — category a/b; pending; decided_at null; subject existence + dept co-tenancy (all four types).
- **Failure modes:** agent/read_only → `forbidden`; `category='c'` → `validation`; cross-dept subject → RLS reject; empty `trigger_reason`/`approver_role` → `validation`; deleted/foreign subject → RLS reject.
- **Audit:** `execution_logs` `approval_action` "requested".
- **Approval:** none.

### 21.2 `approval.get` / `approval.list`
- **Purpose:** read by id / list in scope.
- **Inputs:** `id`; filters (`subject_type`, `subject_id`, `category`, `status`, `approver_role`, `department_id` for admin, `expires_at`/date ranges).
- **Outputs:** approval row(s).
- **Auth:** all roles per §7 (agents: assigned-task-derived, no work_packet).
- **RLS:** `approvals_select_department_scope` (output sub-check for dept roles).
- **Failure modes:** out-of-scope/cross-dept/agent-WP → `not_found`.
- **Audit:** none.
- **Approval:** none.

### 21.3 `approval.approve`
- **Purpose:** authorize the gated action.
- **Inputs:** `id`, `decision_note?`; `status='approved'`, `decided_at=now()`.
- **Outputs:** resolved approval.
- **Auth:** org_admin or dept_lead-in-dept.
- **RLS:** `approvals_update_approver_scope` (USING pending + role; WITH CHECK approved + decided_at + subject re-validated).
- **Failure modes:** member/read_only/agent → 0 rows; cross-dept lead → 0 rows; already resolved → 0 rows; missing `decided_at` → reject.
- **Audit:** `execution_logs` `approval_action` "approved".
- **Approval:** none.

### 21.4 `approval.reject`
- **Purpose:** deny the gated action; subject returns for revision.
- **Inputs:** `id`, `decision_note?`; `status='rejected'`, `decided_at=now()`.
- **Outputs / Auth / RLS / Failure / Audit:** as 21.3 with `status='rejected'`.
- **Approval:** none.

### 21.5 `approval.withdraw`
- **Purpose:** cancel a pending gate (no longer needed).
- **Inputs:** `id`, `decision_note?`; `status='withdrawn'`, `decided_at=now()`.
- **Outputs / Auth / RLS / Failure / Audit:** as 21.3 with `status='withdrawn'`. Authorized resolvers only (org_admin / dept_lead-in-dept) — note the requester (if a member) **cannot** withdraw their own request via this RLS path.
- **Approval:** none.

### 21.6 `approval.list_for_subject` (read helper)
- **Purpose:** list all approvals for a given subject (e.g., all gates on a work packet or task).
- **Inputs:** `subject_type`, `subject_id`.
- **Outputs:** approval rows for that subject within the caller's scope.
- **Auth/RLS:** SELECT policy; agents only for assigned-task-derived subjects (no WP).
- **Failure modes:** subject not in scope → empty.
- **Audit:** none.
- **Approval:** none.

> **No `approval.expire` operation.** Expiry is system/service-role only; the authenticated API surface cannot set `expired`. The orchestration/runtime layer owns it (§19).

> **No delete operation.** Approvals have no `deleted_at` and no DELETE policy; they are immutable once resolved.

---

## 22. Validation Rules

| Rule | Enforced by |
|------|-------------|
| `subject_type ∈ {task, work_packet, decision, output}` | DB check + app |
| `category ∈ {a, b}` on create/resolve | **RLS** (DB check allows c, RLS forbids it) |
| `status ∈ {pending, approved, rejected, expired, withdrawn}` | DB check |
| `decided_at` null ⟺ pending; non-null ⟺ resolved | **DB check (paired invariant)** |
| `trigger_reason` non-empty; `approver_role` non-empty | DB check + app |
| INSERT forces `status='pending'`, `decided_at IS NULL` | RLS WITH CHECK |
| Resolve forces `status ∈ {approved,rejected,withdrawn}`, `decided_at NOT NULL` | RLS WITH CHECK |
| `requested_by_user_id = current_user_id()` if set (INSERT) | RLS WITH CHECK |
| `approver_user_id` active org member if set | RLS WITH CHECK |
| Subject exists, org-local, live, **`subject.department_id = approvals.department_id`** | RLS WITH CHECK (all four types) |
| `department_id` org-local and live; non-admin = `current_department_id()` | RLS WITH CHECK |
| Resolver = org_admin or dept_lead-in-dept | RLS USING + WITH CHECK |
| Resolution only from `pending` | RLS USING |
| `expired` only via system/service-role | **App/runtime** (authenticated RLS forbids it) |
| Category assignment (which action is A vs B vs C) | **App** (policy logic per approval-rules.md) |
| Gate enforcement on the subject (block forbidden transition) | **Subject APIs (Layer 4/5)** — NOT the approvals table |
| "Only named `approver_user_id` may resolve" (if desired) | **App** (RLS does not enforce) |

---

## 23. Error Model

Per the spine — unauthorized reads default to `not_found`; `forbidden` only when role/visibility is known but the action is disallowed.

| Class | HTTP | Approval trigger |
|-------|------|------------------|
| `unauthenticated` | 401 | No JWT / null `current_user_id` |
| `forbidden` | 403 | Agent/read_only attempting `request`; dept_member attempting resolve (known role, disallowed action) |
| `not_found` | 404 | Approval not in scope (cross-dept; agent requesting a work_packet approval or a non-assigned-task approval); resolve target invisible → 0 rows |
| `conflict` | 409 | Resolving an already-resolved approval; attempting a second gate that duplicates an open one (app rule) |
| `validation` | 422 | `category='c'`; empty `trigger_reason`/`approver_role`; bad enum; subject in another department; non-pending insert; `decided_at` mismatch |
| `approval_required` | 409 | (Raised by *subject* APIs, not here) when a gated transition is attempted with no `approved` approval |
| `rate_limited` | 429 | Request/resolve burst throttle |
| `internal` | 500 | Unexpected; expiry/notification async failures surface in background_jobs/DLQ |

**Agent clarity:** an agent calling `approval.request` gets `forbidden` (role excluded from INSERT); calling `approval.get` on a work_packet approval gets `not_found` (no SELECT branch); calling `approval.approve` matches 0 rows → `not_found`/`forbidden`.

---

## 24. Audit Requirements

| Event | Surface | Required fields |
|-------|---------|----------------|
| Approval requested | `execution_logs` | `approval_action`, approval `id`, `subject_type`/`subject_id`, `category`, `trigger_reason`, `requested_by` |
| Approved | `execution_logs` | `approval_action` "approved", `decided_at`, `decision_note`, resolver |
| Rejected | `execution_logs` | `approval_action` "rejected", `decided_at`, `decision_note`, resolver |
| Withdrawn | `execution_logs` | `approval_action` "withdrawn", `decided_at`, resolver |
| Expired (system) | `execution_logs` | `approval_action` "expired", `decided_at`, actor `system` |
| Agent approval signal | `agent_activity` | `activity_type='approval_requested'`, `agent_user_id`, `task_id` |

Per approval-rules.md, every approval must produce execution-log entries on **request, decision, and resolution**. All audit surfaces are append-only.

---

## 25. Security Model

- **Department co-tenancy is mandatory and DB-enforced.** Every INSERT and resolve re-validates `subject.department_id = approvals.department_id`. An approval cannot be created or resolved for a subject in another department — even by an org_admin, the subject must exist and be co-tenant (org_admin bypasses the *requester* dept-pin but not the subject-existence/co-tenancy check).
- **Category-C exclusion is a hard DB boundary.** RLS forbids `category='c'`; the `approvals` table holds only real gates (A/B). Log-only actions can never masquerade as approvals.
- **Resolution authority is narrow:** org_admin or dept_lead-in-dept only. Members request but cannot resolve; read_only and agents do neither. This concentrates authorization power in leads/admins.
- **The paired invariant resists tampering:** the `decided_at`/`status` check constraint holds even against service-role writes — a resolved approval always carries a timestamp, a pending one never does.
- **Immutability:** no `deleted_at`, no DELETE policy, and `status='pending'` required to update means a resolved approval is a permanent, tamper-resistant record. Reversal requires a new approval, not an edit.
- **Polymorphic integrity without FK:** `subject_id` has no FK; integrity rests on the RLS EXISTS+co-tenancy checks. A service-role write bypassing RLS could create a dangling/cross-dept approval — service-role code must replicate the subject validation.
- **Advisory approver is not a control:** `approver_user_id` does not restrict who resolves. Treat it as routing metadata; if single-approver enforcement is required, implement it in the application (Risk §27).
- **Agent containment:** agents can neither request nor resolve, and cannot see work-packet approvals at all. Their only approval surface is read-only visibility of gates on their own assigned task and its decisions/outputs — plus the out-of-band `agent_activity` signal.

---

## 26. Verification Matrix

Under the established `BEGIN…ROLLBACK` JWT harness, live DB, no persistence.

| # | Area | Test | Expected |
|---|------|------|----------|
| 1 | Visibility | org_admin SELECT all subject types | sees all org approvals |
| 2 | Visibility | dept roles SELECT | own-dept approvals only |
| 3 | Visibility | dept role SELECT output approval for out-of-dept output | not visible (output sub-check) |
| 4 | Visibility | **agent SELECT work_packet approval** | **not visible (Branch 3 omits WP)** |
| 5 | Visibility | agent SELECT task approval for assigned task | visible |
| 6 | Visibility | agent SELECT task approval for non-assigned task | not visible |
| 7 | Visibility | null context | 0 rows |
| 8 | Create | dept_member request (category a, task subject) | success |
| 9 | Create | **request with `category='c'`** | **RLS reject** |
| 10 | Create | request with `status='approved'` / decided_at set | RLS reject |
| 11 | Create | **agent request** | RLS reject (`forbidden`) |
| 12 | Create | read_only request | RLS reject |
| 13 | Create | request with subject in another department | RLS reject |
| 14 | Create | request `subject_type='output'` for in-dept output | success (`017`) |
| 15 | Create | `requested_by_user_id` ≠ self | RLS reject (self-pin) |
| 16 | Create | empty `trigger_reason` | check-constraint violation |
| 17 | Resolve | dept_lead approve own-dept pending | 1 row; decided_at set |
| 18 | Resolve | **dept_member resolve** | 0 rows (excluded) |
| 19 | Resolve | read_only / agent resolve | 0 rows |
| 20 | Resolve | dept_lead resolve other-dept approval | 0 rows |
| 21 | Resolve | resolve to `status='pending'` or `'expired'` | WITH CHECK reject |
| 22 | Resolve | resolve already-resolved approval | 0 rows (USING needs pending) |
| 23 | Resolve | approve without setting `decided_at` | reject (paired invariant) |
| 24 | Invariant | insert pending with non-null decided_at | reject |
| 25 | Immutability | confirm no DELETE policy / no `deleted_at` | confirmed (3 policies, no column) |
| 26 | Realtime | confirm `approvals` publication membership | **absent in live DB** (intent only) |

Tests 4, 9, 11, 18, 21, and 26 are the distinguishing assertions for this layer.

---

## 27. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | **Gate-vs-record gap** — the DB records authorization but does not block the subject; a missing enforcement check in any subject API (WP start, output deliver, task done, decision confirm) silently defeats the gate | **High** | Centralize each subject's gate check in one guarded transition; verification suites in G4/Output/Decision plans; never write the gated subject status without consulting approval state |
| 2 | **Advisory approver mis-assumption** — code may assume only `approver_user_id` can resolve, but any org_admin/dept_lead-in-dept can | Medium | Document the advisory nature; if single-approver is required, enforce in app; surface the actual resolver in audit |
| 3 | **Agent cannot see work-packet approvals** — orchestration that expects the agent to read its start gate will get nothing | Medium | Surface start-authorization to the agent out-of-band (task context projection); never rely on agent approval reads for WP gates |
| 4 | **Agents cannot request approvals** — naive design may try to INSERT as the agent | Medium | Route agent need through `agent_activity('approval_requested')`; an authorized human/service creates the approval row |
| 5 | **Expiry is system-only** — if no scheduled job runs, `pending` approvals never expire and gates stall indefinitely | Medium | Implement the service-role expiry sweep over `expires_at`; alert on overdue pending approvals |
| 6 | **Realtime not materialized** — publication absent in live DB despite documented intent | Medium | Verify/enable publication before promising push; default to polling reads |
| 7 | **Polymorphic integrity under service-role** — bypassing RLS can create dangling/cross-dept approvals | Medium | Service-role code must replicate subject existence + dept co-tenancy validation |
| 8 | **No reversal path** — a wrongly-approved gate cannot be un-approved (immutable) | Low | Compensate with a new approval and a subject-level rollback; document that resolution is final |

---

## 28. Dependencies

| Depends on | For |
|------------|-----|
| **G1 Auth/Context Spine** | `private.*` identity; error model; roles |
| **G3 Task API** | task subject gates; task-derived agent visibility; reject→blocked effect |
| **G4 Work Packet API** | the Category B start gate (the primary work-packet approval consumer) |
| **Output API** (Phase E) | the Category A external-delivery gate; `017` output-subject scoping |
| **Decision API** | the Category B confirm-decision gate; decision dept inheritance via task |
| **Runtime Ops (`018`/`020`)** | `agent_activity('approval_requested')` signaling; `approval_notification` jobs; service-role expiry sweep |
| **Deployed migrations** | `011` (table), `013` (Phase D baseline, superseded by `017`), `017` (LIVE policies — output support), `014`/`016` (outputs), `018`/`020` (runtime) — consumed as-is |

The Approval API is **upstream of** every subject API's gate (it provides the authorization record) and **downstream of** the subject APIs for enforcement. It must be built against the live `017` policies, not the superseded `013` baseline.

---

## 29. MVP Build Order

1. **Read surface** — `approval.get`/`list`/`list_for_subject` under the `017` SELECT policy. Proves the three-branch visibility (org/dept/agent), the output sub-check, and the agent no-work-packet rule (tests 1–7).
2. **Request** — `approval.request` with category-a/b enforcement, pending+decided_at-null invariant, requester self-pin, and subject existence + dept co-tenancy for all four subject types (tests 8–16). The `category='c'` rejection (test 9) is a core assertion.
3. **Resolve** — `approval.approve`/`reject`/`withdraw` with the org_admin/dept_lead-in-dept gate, pending-precondition, and decided_at requirement (tests 17–24). Establishes resolver narrowing and immutability.
4. **Subject-gate wiring** — coordinate with G4 (WP start), Output (deliver), Decision (confirm), Task (done) so each subject API consults approval state. This is where the gates become real (Risk 1).
5. **Agent signaling** — wire `agent_activity('approval_requested')` → human/service triage → `approval.request`. Confirms agents never INSERT approvals directly (test 11).
6. **Expiry sweep** — service-role job over `expires_at` driving `pending → expired` (test 21 confirms authenticated path cannot).
7. **Notifications** — `approval_notification` background jobs on lifecycle change.
8. **Realtime** — verify/enable `approvals` publication, then light up subscriptions; until then, polling reads (test 26).
9. **Audit wiring** — execution-log entries on request, decision, and resolution per approval-rules.md.

Steps 1–3 deliver the authorization record and its lifecycle. Step 4 makes the gates enforce. Steps 5–9 complete agent signaling, expiry, notification, realtime, and audit.

---

## 30. Definition of Done

- [ ] All operations resolve identity and scope only through `private.*`; no client-supplied `organization_id`, `department_id`, `requested_by_user_id`, `category`, or `status` is trusted.
- [ ] Approvals can be requested only with `category ∈ {a, b}`; `category='c'` is rejected by RLS (verified: test 9). The table holds only real gates.
- [ ] Request is limited to org_admin/dept_lead/dept_member; **agents and read_only cannot request** (verified: tests 11–12).
- [ ] Resolution is limited to org_admin or dept_lead-in-dept; **dept_member, read_only, and agents cannot resolve** (verified: tests 18–19).
- [ ] The `decided_at`/`status` paired invariant holds on every write (verified: tests 23–24).
- [ ] Subject existence and **department co-tenancy** (`subject.department_id = approvals.department_id`) are validated on request and resolve for all four subject types (verified: tests 13–14).
- [ ] Output approvals behave per `017`: dept roles see them only when the output is in-dept and live; agents see them only for assigned-task outputs (verified: tests 3, 14).
- [ ] Agents have **no visibility of work-packet approvals** (verified: test 4).
- [ ] The authenticated path cannot set `expired`; expiry is system/service-role only (verified: test 21).
- [ ] Approvals are immutable: no `deleted_at`, no DELETE policy, resolution only from `pending`, no re-resolution (verified: tests 22, 25).
- [ ] Each subject API (WP start, output deliver, decision confirm, task done) enforces its gate against approval state — the DB does not; the gate-vs-record separation is implemented and tested (Risk 1).
- [ ] `approver_user_id` is treated as advisory; any single-approver requirement is enforced in the application, not assumed from RLS.
- [ ] Realtime is enabled only after verifying `approvals` publication membership; until then, reads are the reliable path (verified: test 26 shows current absence).
- [ ] Audit emits execution-log entries on request, decision, and resolution.
- [ ] No migrations, schema changes, or new roles introduced; the live `011`/`017` (superseding `013`)/`014`/`016`/`018`/`020` artifacts are consumed exactly as verified.

---

## Document Boundaries

This is Phase G5 **architecture output** — the Approval API contract. It introduces no code, migrations, or schema proposals, and modifies no prior plan. It consumes the deployed `approvals` table (`011`) and the **live, post-`017`** RLS (which superseded the Phase D `013` policies to add output support), together with the outputs/decisions schemas (`014`/`016`) and runtime surfaces (`018`/`020`), exactly as verified against the live database. The defining principle of this layer is the **gate-vs-record separation**: the `approvals` table authoritatively records authorization and its lifecycle, while enforcement of the gate lives in each subject API. RLS remains the primary authorization layer; Supabase remains the system of record. Implementation proceeds against §29.
