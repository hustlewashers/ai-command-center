# Phase G7 — Decision API Plan

> **Architecture document. No code, routes, Edge Functions, migrations, schema, or frontend are produced here.** Every schema, enum, constraint, and policy claim is grounded in the deployed database (`011_governance_layer.sql`, `013_phase_d_rls_policies.sql`, `017_phase_e_approvals_adjustment.sql`) verified live against project `wbtvrzivthuqqntnorsw` on 2026-06-24, and in `docs/approval-rules.md`.

---

## 1. Purpose

The Decision API governs the **recorded choice** — the durable statement that a task committed to a particular path, with a rationale, made by an accountable party. Where outputs are the deliverable and tasks are the work, decisions are the *governance memory*: why a course was taken, who took it, and (when the stakes warrant) whether it was approved before taking effect.

Decisions are **always task-scoped** — every decision belongs to exactly one task, and a decision derives its department, its visibility, and its mutation authority entirely through that parent task. The Decision entity has no department column of its own; it borrows the task's. This makes the Decision API the clearest example in the system of *derived* department scoping, in contrast to outputs (G6), which carry a direct `department_id`.

Decisions are also the third polymorphic approval subject. A high-risk decision must transition to `pending_approval` and be cleared through an `approvals` row (`subject_type='decision'`, `017`) before it takes effect. As with every subject API, the Decision API adds no authorization system: it authenticates the caller, derives org/role/department through the `private.*` spine, lets RLS enforce visibility and mutation on `decisions`, and layers the status machine and the conditional approval gate on top.

---

## 2. Scope

**In scope:** create/read/update decisions; the status machine `proposed → confirmed` (low-risk) and `proposed → pending_approval → approved/rejected` (high-risk, Category B); the conditional approval gate backed by `approvals.subject_type='decision'`; supersession; soft-delete; knowledge emission with `subject_type='decision'`; the relationships to task, approval, output, knowledge, and runtime.

**Out of scope:** the internals of the Approval, Task, Output, and Knowledge Record APIs (each its own plan); schema changes; new roles; any RLS modification. This plan consumes the deployed `decisions` RLS exactly as shipped in `013` (unchanged by later migrations — verified live).

---

## 3. Decision Entity Definition

`public.decisions` — verified live. Columns:

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `organization_id` | uuid | NO | — | FK → organizations, **restrict**; JWT-derived |
| `task_id` | uuid | NO | — | FK → tasks, **restrict**; the *only* parent — department/visibility derive from here |
| `summary` | text | NO | — | `length(trim(summary)) > 0` — the choice |
| `rationale` | text | NO | — | `length(trim(rationale)) > 0` — the why |
| `decided_by_user_id` | uuid | YES | — | FK → users, **set null**; self-pinned on write |
| `decided_at` | timestamptz | NO | `now()` | **always set** (NOT NULL, defaulted) |
| `status` | text | NO | `'proposed'` | enum (below) |
| `created_at` | timestamptz | NO | `now()` | |
| `updated_at` | timestamptz | NO | `now()` | maintained by `set_updated_at` trigger |
| `deleted_at` | timestamptz | YES | — | soft-delete tombstone |

**Enum (DB check constraint `decisions_status_check`):**
`status ∈ {proposed, confirmed, pending_approval, approved, rejected, superseded}`

**Key constraints (verified):**
- `decisions_summary_not_empty`, `decisions_rationale_not_empty` — both core text fields must be non-blank. A decision without a stated choice *and* a rationale cannot exist.
- `organization_id` and `task_id` are **ON DELETE RESTRICT** — a decision pins its task and org alive. `decided_by_user_id` is **ON DELETE SET NULL** (a departed decider does not orphan or delete the decision; the record of the choice survives the person).
- **No `department_id` column** (see §3 note and §12). **No paired `decided_at`/`status` invariant** — unlike `approvals` and `outputs`, `decisions.decided_at` is simply always populated (NOT NULL, defaulted `now()`); there is no DB constraint coupling it to a particular status. The "when was this decided" timestamp exists from row birth.

**No direct department.** This is the defining structural fact. `decisions` has `organization_id` and `task_id` but **no `department_id`**. Every department-scoped behavior — who can see it, who can edit it, which approval department it maps to — is computed by joining to the parent task and reading `tasks.department_id`. There is no denormalized department on the decision, and therefore no possibility of decision/task department drift (the task *is* the source of truth).

---

## 4. Decision Lifecycle

1. **Propose.** During task execution, an authorized human (org_admin / dept_lead / dept_member) records a choice as `proposed`, pinned to the task, with summary + rationale. **Agents cannot create decisions** (no agent INSERT path — §7); an agent's reasoning is materialized into a decision row by a human/service path.
2. **Triage by risk.** Per `approval-rules.md`: a low-risk, internal, reversible choice (tool/architecture selection) can be **confirmed** directly; a high-risk choice (external/spend commitment, data retention/deletion, GovCon submission, overriding a `won't_fix` blocker) must go through the **approval gate**.
3. **Confirm (low-risk).** A lead confirms: `proposed → confirmed`. The decision takes effect with no `approvals` row. This is Category C-style "no gate" governance for reversible internal choices.
4. **Request approval (high-risk).** `proposed → pending_approval`, accompanied by an `approvals` row (`subject_type='decision'`, `category='b'`). The decision is *frozen* — it must not take effect while pending.
5. **Resolve.** The approver clears or refuses the gate; the API then moves the decision `pending_approval → approved` (takes effect) or `pending_approval → rejected` (does not; the task records rationale in an execution log per `approval-rules.md`).
6. **Supersede.** A later decision overrides an earlier one (`→ superseded`); the historical record is retained, never edited away.
7. **Retire.** Soft-delete sets `deleted_at` (lead/admin only); the row becomes invisible to all authenticated consumers.

---

## 5. State Machine

States are exactly the six DB-enum values. The API enforces transition legality and the risk-triage routing (Layer 4); the DB enforces only the value set (there is **no** paired-status invariant on decisions).

```text
                      confirm (low-risk, reversible)
   ┌──────────┐──────────────────────────────────────────────> ┌───────────┐
   │ proposed │                                                 │ confirmed │
   └──────────┘──────────┐                                      └───────────┘
        ^                │ request approval (high-risk)               │ supersede
        │ revise         v                                            v
        │          ┌──────────────────┐  approve   ┌──────────┐  ┌────────────┐
        └──────────│ pending_approval │──────────> │ approved │─>│ superseded │
                   └──────────────────┘            └──────────┘  └────────────┘
                          │ reject                       │ supersede   ^
                          v                              └─────────────┘
                     ┌──────────┐
                     │ rejected │
                     └──────────┘
```

| From | To | Operation | Gate |
|------|-----|-----------|------|
| `proposed` | `confirmed` | `decision.confirm` | lead authority (low-risk) |
| `proposed` | `pending_approval` | `decision.request_approval` | creates Category B gate |
| `proposed` | `rejected` | `decision.reject` | lead authority (abandon proposal) |
| `pending_approval` | `approved` | `decision.approve` | **resolved Category B approval (§11)** |
| `pending_approval` | `rejected` | `decision.reject` | resolved (rejected) gate |
| `pending_approval` | `proposed` | `decision.withdraw_request` | gate withdrawn |
| `confirmed` / `approved` | `superseded` | `decision.supersede` | newer decision exists |
| `proposed` / `rejected` | `proposed` | `decision.revise` | rework before commitment |

**DB does not enforce these transitions.** The `decisions` UPDATE policy permits any status enum value to be written by an authorized lead/admin (subject only to the not-empty text checks); transition legality, the low-vs-high risk routing, and "approved only after the gate resolves" are **application-enforced**. This is the central separation of §21.

---

## 6. Visibility Model

From `decisions_select_task_scope` (`013`, verified live). `decisions` SELECT, `authenticated`, `USING`:

`organization_id = current_organization_id()` AND `deleted_at IS NULL` AND `EXISTS task t WHERE t.id = decisions.task_id AND t.organization_id = org AND t.deleted_at IS NULL AND (…role branch…)`:

- **org_admin** — every non-deleted decision in the org.
- **department_lead / department_member / read_only** — `t.department_id = current_department_id()` (department-scoped, **via the parent task**).
- **agent** — `t.assigned_to_user_id = current_user_id()` (only decisions on tasks assigned to them).

| Role | Sees |
|------|------|
| org_admin | all org decisions |
| department_lead | decisions on dept tasks |
| department_member | decisions on dept tasks |
| read_only | decisions on dept tasks (read only) |
| agent | decisions on tasks assigned to it, only |
| unauthenticated / null context | nothing |

Every branch reads through the task — there is no direct department predicate on `decisions` because there is no column to predicate on. Visibility is exactly "can you see the parent task" plus the org/soft-delete pins.

---

## 7. Auth Contract

Derived from the three deployed `decisions` policies. Roles are JWT-derived via `private.current_role()`; the API never trusts an asserted role/department/org.

| Capability | org_admin | dept_lead | dept_member | read_only | agent |
|-----------|:--------:|:---------:|:-----------:|:---------:|:-----:|
| SELECT (visibility §6) | all org | dept tasks | dept tasks | dept tasks | assigned task only |
| INSERT (propose) | ✅ | ✅ (own-dept task) | ✅ (own-dept task) | ❌ | ❌ |
| UPDATE (confirm/approve/reject/supersede/soft-delete) | ✅ | ✅ (own-dept task) | ❌ | ❌ | ❌ |
| DELETE (hard) | ❌ (no policy) | ❌ | ❌ | ❌ | ❌ |

**Notable boundaries:**
- **Agents cannot create decisions.** The INSERT policy role set is `{org_admin, department_lead, department_member}` — `agent` is absent. *(This corrects the G3 Task API plan's statement that "an agent may INSERT a proposed decision"; the deployed policy does not permit it. See §23 Risk and Next Step.)* An agent's reasoning enters `decisions` via a human/service path, mirroring the agent-approval model (G5).
- **`department_member` can propose but not update.** INSERT admits members; UPDATE admits only `{org_admin, department_lead-in-dept}`. So a member can *record* a proposed decision but cannot confirm, approve, reject, supersede, or soft-delete it — those are lead/admin acts. This is the same create-but-not-mutate asymmetry seen in Work Packets (G4), and it is governance-meaningful: **committing** a decision is a lead responsibility.
- **Insert status is constrained.** The INSERT policy allows only `status ∈ {proposed, pending_approval}` — a caller cannot create a decision already `confirmed`/`approved`. Reaching a committed state requires an UPDATE by a lead, which is the accountable act.
- **No hard DELETE** for any authenticated role (no DELETE policy). Removal is soft-delete via UPDATE (lead/admin).

---

## 8. Create Contract

**`decision.propose`** — record a `proposed` (or `pending_approval`) decision on a task.

- **Purpose:** capture a choice and its rationale as a governed, task-scoped record.
- **Inputs:** `task_id` (required), `summary` (non-empty), `rationale` (non-empty), optional initial `status ∈ {proposed, pending_approval}` (default `proposed`). `organization_id` is JWT-derived; `decided_by_user_id` self-pinned (or null); `decided_at` defaults `now()`.
- **Outputs:** the created decision row.
- **Auth requirements:** org_admin / dept_lead / dept_member. Non-admins may only attach to a task in their own department.
- **RLS expectations (`decisions_insert_task_scope`):** org pin; `deleted_at IS NULL`; role in the three writers; `status ∈ {proposed, pending_approval}`; `decided_by_user_id` null-or-self; **EXISTS task with `t.deleted_at IS NULL` and (`org_admin` OR `t.department_id = current_department_id()`)**. Department scope is established purely by this task join.
- **Failure modes:** agent/read_only caller → RLS 42501 (`forbidden`); task in another department (non-admin) → 42501 (`not_found`/`validation`); empty summary or rationale → 23514 (`validation`); `status` outside `{proposed, pending_approval}` → 42501 (WITH CHECK); cross-org task → 42501.
- **Audit requirements:** `execution_logs` `state_change` "decision proposed", actor = `decided_by_user_id`, `task_id` + status in metadata. (`approval-rules.md`: recording a `proposed` decision emits a `state_change` entry.)
- **Approval requirements:** none to propose. Creating directly at `pending_approval` is permitted by RLS but the API should pair it with an `approvals` row (§11) so the gate is real, not just a status.

---

## 9. Read Contract

**`decision.get` / `decision.list`**

- **Purpose:** retrieve one decision or a filtered list within the caller's visible set.
- **Inputs:** `get`: `id`. `list`: optional filters — `task_id`, `status`, pagination. No department filter is applied on behalf of non-admins; RLS scopes through the task.
- **Outputs:** decision row(s) the caller may SELECT.
- **Auth requirements:** any authenticated active member; visibility per §6.
- **RLS expectations:** `decisions_select_task_scope`. Application filters operate *within* the visible set, never as a substitute.
- **Failure modes:** out-of-scope/deleted/cross-dept decision → `not_found` (RLS invisible); agent requesting a decision on an unassigned task → `not_found`; null context → `not_found`.
- **Audit requirements:** read-only; no log required (optional access metric).
- **Approval requirements:** none.

---

## 10. Update Contract

All status transitions and edits are UPDATEs governed by `decisions_update_lead_scope`. The DB gate is uniform — **org_admin or dept_lead-in-the-task's-department** — and does not distinguish *which* field or status is being written. The API differentiates the operations below by transition legality and risk routing at Layer 4.

- **`decision.revise`** — edit `summary`/`rationale` (only sensible while `proposed`/`rejected`; the API forbids editing a `confirmed`/`approved` decision's substance — prefer supersede).
- **`decision.confirm`** (`proposed → confirmed`): commit a low-risk, reversible decision. Lead authority.
- **`decision.request_approval`** (`proposed → pending_approval`): open the Category B gate (§11).
- **`decision.approve`** (`pending_approval → approved`): record that the gate cleared and the decision takes effect. **Requires the resolved approval (§11) — application-enforced.**
- **`decision.reject`** (`→ rejected`): refuse the proposal/gate; the task should log rationale.
- **`decision.withdraw_request`** (`pending_approval → proposed`): pull the decision back from the gate.
- **`decision.supersede`** (`confirmed/approved → superseded`): a newer decision overrides this one.
- **`decision.soft_delete`** (set `deleted_at`).

- **RLS expectations (`decisions_update_lead_scope`):** USING (org pin; not deleted; EXISTS task with `org_admin` OR `dept_lead AND t.department_id = current_department_id()`) + WITH CHECK (same task/role gate; `decided_by_user_id` null-or-live-user). **`department_member` and `agent` fail USING → 0 rows.**
- **Failure modes:** member/read_only/agent → 0 rows (`forbidden`/`not_found`); cross-dept lead → 0 rows; illegal transition (e.g., `approved → pending_approval`) → `conflict` (Layer 4); `decided_by_user_id` referencing a non-live user → 42501.
- **Audit requirements:** `execution_logs` `state_change` per transition; approve/reject also emit `approval_action`.
- **Approval requirements:** only `decision.approve` has a hard precondition — a resolved Category B `approvals` row (§11).

---

## 11. Approval Gate Contract

A decision approval is **conditional (Category B)** — required only for high-risk decisions, per `approval-rules.md` §"Decision ↔ Approval Interaction":

| Decision type | Gate |
|---------------|------|
| Tool / architecture selection (internal, reversible) | **No** — `confirmed` directly |
| External vendor or spend commitment | **Yes** |
| Data retention or deletion policy | **Yes** |
| Domain submission to client/agency (GovCon) | **Yes** |
| Override of a blocker marked `won't_fix` | **Yes** |

**The gate is application-enforced, backed by a DB-recorded `approvals` row.** The DB does **not** enforce "a decision may only reach `approved` after an approval clears" — the `decisions` UPDATE policy will write `status='approved'` directly for any authorized lead. The Decision API is the enforcement point: it routes high-risk decisions through `pending_approval`, creates the `approvals` row, and only writes `approved` after that row resolves.

**Mechanics (grounded in `017`):**
- The gate row: `approvals` with `subject_type='decision'`, `subject_id = decision.id`, `category='b'`, `department_id = the decision's task's department`, `approver_role` = Department lead (per `approval-rules.md` "Confirm Decision → Department lead"), `trigger_reason` describing the high-risk commitment.
- **Department mapping is via the task.** `017`'s decision-subject EXISTS check requires the decision to join its task and `t.department_id = approvals.department_id`. Because the decision has no department of its own, the approval's `department_id` must equal the parent task's department. The API must set it from the task, not from any decision field (there is none).
- **Creating the gate:** `approvals_insert_department_scope` (`017`) — role ∈ {org_admin, dept_lead, dept_member}, `category ∈ {a,b}`, `status='pending'`, decision subject EXISTS with the task-department match. Agents cannot create it (they signal via `agent_activity(activity_type='approval_requested')`; a human/service creates the row — consistent with G3/G4/G5/G6).
- **Resolving the gate:** `approvals_update_approver_scope` (`017`) — only org_admin or a dept_lead in the approval's department may move it `pending → approved/rejected`. This aligns exactly with who may UPDATE the decision itself (lead/admin) — so the same authority that resolves the gate writes the decision's `approved` status.
- **Visibility of the gate:** `approvals_select_department_scope` (`017`) — dept-scoped for humans; an agent sees a decision approval only via its assigned task (join through `decisions.task_id`). Matches G5.

**The application contract for `decision.approve`:** confirm a resolved `approvals` row exists (`subject_type='decision'`, `category='b'`, `status='approved'`, department matching the task) *before* writing `decisions.status='approved'`. If absent → refuse with `approval_required`. The DB will not refuse it.

---

## 12. Task Relationship

- **Relationship:** `decisions.task_id` NOT NULL, FK → `tasks`, **ON DELETE RESTRICT**. The task is the *only* parent; a task may carry many decisions.
- **Department derivation (the defining mechanism):** the decision has **no `department_id`**. Visibility (`013` SELECT), mutation authority (`013` UPDATE), and approval department mapping (`017`) are all computed by joining to `tasks` and reading `tasks.department_id`. There is therefore **no decision/task department drift possible** — the task is the single source of department truth.
- **Consequence of RESTRICT:** a task with decisions cannot be hard-deleted while decisions reference it (moot on the authenticated path — no hard DELETE is granted — but relevant for service-role). Soft-deleting a task does not cascade to decisions, but it *does* remove visibility: the SELECT/UPDATE EXISTS clauses require `t.deleted_at IS NULL`, so decisions on a soft-deleted task become invisible and immutable through the authenticated client.
- **Task-progression interplay (G3):** a `pending_approval` decision is a **soft blocker** on task completion — the Task API surfaces unresolved high-risk decisions before allowing `in_review → done`. A `rejected` decision typically pushes the task toward `blocked` with rationale logged.

---

## 13. Approval Relationship

- **Relationship:** polymorphic — `approvals.subject_type='decision'`, `subject_id = decision.id`. **No DB FK** on `subject_id`; integrity enforced by `017`'s EXISTS sub-check, which additionally pins the approval's `department_id` to the decision's *task's* department.
- **Which approvals attach:** only **high-risk** decisions (Category B) produce a row. Low-risk confirmations (§11 table row 1) do **not**. So the `approvals` rows for a decision are exactly its high-risk gates.
- **Authority symmetry:** the role that resolves the decision approval (org_admin / dept_lead-in-dept) is the same role that may UPDATE the decision — a clean alignment, unlike outputs where members can edit but not resolve. There is no member or agent path to either resolving a decision gate or committing a decision.
- **Lifecycle parity with G5:** request → pending → approved/rejected/withdrawn (`expired` is system-only). The Decision API reads gate state but never bypasses it; `decision.approve` is the chokepoint (§11).

---

## 14. Output Relationship

- **Indirect, through the shared task.** Decisions and outputs are **siblings under a task**, not directly linked — there is no `decisions.output_id` or `outputs.decision_id` column. Both reference `task_id`; a decision and an output relate only by belonging to the same task.
- **Governance ordering:** a high-risk *decision* (e.g., "submit this package to the client") often precedes and authorizes the *output*'s external delivery (G6 Category A). The two gates are distinct: the decision's Category B gate authorizes the *choice*; the output's Category A gate authorizes the *external release*. The API layer sequences them (decision approved → output produced → output delivery approved → delivered); neither gate is implied by the other.
- **Knowledge linkage (the explicit join):** where a durable link between a decision and an output is wanted, it is expressed through `knowledge_record_links` (`link_type` e.g. `derived_from`/`supports`), not through a column on either table (§15).

---

## 15. Knowledge Relationship

- **Relationship:** `knowledge_records.subject_type='decision'`, `subject_id = decision.id` (the `014` check constraint admits `'decision'`; **no FK**, polymorphic). A decision can be the subject of curated, retrievable knowledge — a rationale synthesis, a lesson learned, a constraint captured.
- **`decision.emit_knowledge`** (thin wrapper over the Knowledge Record API):
  - **Auth/RLS (`knowledge_records_insert_subject_scope`, `016`):** for `subject_type='decision'`, the writer must be org_admin, or dept_lead/member where the decision's task is in their department, **or an agent assigned to the decision's task** (`t.assigned_to_user_id = current_user_id()`). Notably, **agents *can* emit knowledge about a decision on their assigned task**, even though they cannot create or update the decision itself — the same asymmetry seen for outputs (G6 §20).
  - **Visibility:** `knowledge_records_select_subject_scope` mirrors this (dept-scoped via the decision→task department; agents via assigned task).
  - **Failure modes:** decision's task not in caller's subject scope → 42501; empty required text → 23514.
- **Links:** `knowledge_record_links` may point at a decision (`linked_entity_type='decision'`), with link visibility requiring *both* the parent knowledge record and the linked decision to be visible (the dual-scope rule in `016`). This is the home for decision↔output and decision↔research-asset lineage.

---

## 16. Runtime Relationship

- **No direct background-job linkage.** Unlike tasks (`related_task_id`) and outputs (`output_delivery` jobs), decisions have no dedicated `background_jobs` column. A decision influences runtime only *through its task* — e.g., an approved high-risk decision unblocks a workflow step on the task, which the runtime executes.
- **Agent activity, not agent writes.** An agent reasoning toward a decision records its reasoning via `agent_activity` (and signals approval need via `activity_type='approval_requested'`); the decision row itself is written by a human/service path. Agents never write `decisions`.
- **Audit stream:** every decision state change emits `execution_logs`; high-risk gates emit `approval_action` on request/decision/resolution (`approval-rules.md`). A rejected decision should leave an execution-log rationale on the parent task.
- **Realtime:** `decisions` is **not** in the realtime publication set (only `tasks`, `approvals`, `blockers` were ever designated — and that publication is currently empty per `docs/phase-g-realtime-publication-plan.md`). Decision state changes are observed through request/response reads and, indirectly, through the `approvals`/`tasks` channels once realtime is enabled. The Decision API must **not** promise a `decisions` subscription.

---

## 17. API Operation Catalog

| # | Operation | Transition / Effect | Hard approval gate |
|---|-----------|---------------------|:------------------:|
| 1 | `decision.propose` | → `proposed` (or `pending_approval`) | — |
| 2 | `decision.get` | read one | — |
| 3 | `decision.list` | read many (filtered, RLS-scoped) | — |
| 4 | `decision.revise` | edit summary/rationale (`proposed`/`rejected`) | — |
| 5 | `decision.confirm` | `proposed → confirmed` (low-risk) | — |
| 6 | `decision.request_approval` | `proposed → pending_approval` + create `approvals` (subject=decision, cat b) | — (creates the gate) |
| 7 | `decision.approve` | `pending_approval → approved` | **Category B resolved** |
| 8 | `decision.reject` | `proposed/pending_approval → rejected` | — |
| 9 | `decision.withdraw_request` | `pending_approval → proposed` | — |
| 10 | `decision.supersede` | `confirmed/approved → superseded` | — |
| 11 | `decision.emit_knowledge` | insert `knowledge_records` (subject=decision) | — |
| 12 | `decision.soft_delete` | set `deleted_at` | — |

Each operation carries the full Purpose/Inputs/Outputs/Auth/RLS/Failure/Audit/Approval treatment in §§8–11, 15, and below.

**`decision.soft_delete`**
- **Purpose:** retire an erroneous/duplicate decision; set `deleted_at`. Becomes invisible to all authenticated consumers.
- **Inputs:** `id`.
- **Outputs:** row with `deleted_at` set.
- **Auth requirements:** org_admin / dept_lead-in-the-task's-dept (the UPDATE policy; **members cannot soft-delete decisions**, unlike outputs).
- **RLS expectations:** `decisions_update_lead_scope`. No DELETE policy; this is the only removal path on the authenticated client.
- **Failure modes:** member/read_only/agent → 0 rows (`forbidden`); cross-dept → `not_found`; already-deleted → 0 rows (USING requires `deleted_at IS NULL`). Soft-deleting an `approved` decision that took effect is discouraged — prefer `superseded` to preserve the governance trail.
- **Audit requirements:** `execution_logs` `state_change` "soft-deleted".
- **Approval requirements:** none.

---

## 18. Validation Rules

| Rule | Enforced by |
|------|-------------|
| `summary` non-empty | **DB** (`decisions_summary_not_empty`) |
| `rationale` non-empty | **DB** (`decisions_rationale_not_empty`) |
| `status ∈ {proposed,confirmed,pending_approval,approved,rejected,superseded}` | **DB** (`decisions_status_check`) |
| Insert `status ∈ {proposed, pending_approval}` only | **DB RLS** (insert WITH CHECK) |
| `organization_id` = caller's org | **DB RLS** + JWT-derived |
| Department scope (via parent task) | **DB RLS** (task EXISTS join) |
| `decided_by_user_id` null-or-self (insert) / null-or-live (update) | **DB RLS** |
| `decided_at` present | **DB** (NOT NULL, defaulted — always set) |
| Legal status transition (e.g., `approved` only from `pending_approval`) | **Application only** (DB allows any enum write by a lead) |
| Risk triage (low → confirm; high → gate) | **Application only** |
| Resolved Category B approval before `approved` | **Application only** (DB does not check) |
| No substantive edit of a committed (`confirmed`/`approved`) decision | **Application only** (prefer supersede) |

The split: the DB guarantees *value integrity, tenancy, and the always-present timestamp*; the **application guarantees the governance semantics** — transitions, risk routing, and the conditional gate.

---

## 19. Error Model

| Code | HTTP | Trigger |
|------|------|---------|
| `unauthenticated` | 401 | No JWT / null `current_user_id` (unprovisioned/inactive) |
| `forbidden` | 403 | Agent or read_only attempting create; member attempting any update/confirm/approve/supersede/soft-delete (RLS UPDATE excludes members) |
| `not_found` | 404 | Decision not in caller's visible scope (cross-dept task, deleted, agent-unassigned task); lead acting cross-department (0 rows) |
| `validation` | 422 | Empty summary/rationale; insert status outside `{proposed, pending_approval}`; task not in caller's department |
| `conflict` | 409 | Illegal status transition; approving a non-`pending_approval` decision; superseding a `proposed` |
| `approval_required` | 409 | `decision.approve` without a resolved Category B decision-approval |
| `constraint` | 409 | DB 23514 (empty text), 23503 (task/org FK) |

RLS denials surface as `not_found` (invisible) or `forbidden` (visible-but-no-authority), matching G3/G5/G6. The distinctive code is **`approval_required`** on `decision.approve` — the application-layer manifestation of the Category B gate. Note the broad `forbidden` surface for **members on any update** — members can propose but never commit.

---

## 20. Audit Requirements

| Event | Sink | Shape |
|-------|------|-------|
| Decision proposed | `execution_logs` | `state_change`, actor=`decided_by_user_id`, "proposed", `task_id`/status |
| Summary/rationale revised | `execution_logs` | `state_change`, changed fields old→new |
| `proposed→confirmed` | `execution_logs` | `state_change`, confirming lead |
| Approval requested (`→pending_approval`) | `execution_logs` | `approval_action`, approval `id`, `category='b'` |
| Approval resolved | `execution_logs` | `approval_action`, decision, `decided_at` |
| `pending_approval→approved` | `execution_logs` | `state_change`, approval `id` |
| `→rejected` | `execution_logs` | `state_change` + rationale logged on the **parent task** (per `approval-rules.md`) |
| `→superseded` | `execution_logs` | `state_change`, superseding decision `id` |
| Knowledge emitted | `execution_logs` | `note`, `knowledge_record_id` |
| Soft-delete | `execution_logs` | `state_change` "soft-deleted" |

Per `approval-rules.md`: every approval must produce execution-log entries on request, decision, and resolution; a recorded `proposed` decision emits a `state_change`; a rejected decision records rationale on the related task.

---

## 21. Security Model

- **Task-derived confinement.** With no `department_id` of its own, a decision is exactly as visible/mutable as its parent task permits. Humans are dept-scoped (via `tasks.department_id`); agents are assigned-task-scoped. There is no decision-level scope to spoof or drift.
- **Propose ≠ commit.** Members may record proposals; only org_admin/dept_lead may **commit** (confirm/approve), supersede, or soft-delete. The act of committing a decision is structurally reserved to leadership by the UPDATE policy.
- **Insert-status floor.** RLS restricts inserts to `{proposed, pending_approval}` — no caller can fabricate a `confirmed`/`approved` decision at birth; reaching a committed state always requires a lead UPDATE (the accountable, audited act).
- **Agent exclusion from writes.** Agents cannot INSERT or UPDATE decisions. Their only write touching this entity is `knowledge_records` about a decision on their assigned task (§15) — never the decision itself.
- **Decider pin.** `decided_by_user_id` is self-pinned on insert and must reference a live org user on update; no caller can attribute a decision to another, and a departed decider (`SET NULL`) does not erase the record.
- **No hard delete.** No DELETE policy; removal is soft-delete (lead/admin), and the API should prefer `superseded` over deleting committed decisions.
- **The application-enforced perimeter (critical).** Three controls live *only* in the API:
  1. **Transition legality** — the DB accepts any enum write to `status` from an authorized lead.
  2. **Risk triage** — nothing in the DB forces a high-risk decision through `pending_approval`; the API classifies and routes.
  3. **The Category B gate** — RLS will write `approved` with no approval; only the API checks for the resolved `approvals` row.
  A defect in #2 or #3 means a high-risk decision takes effect without its required human approval — the headline risk (§23).

---

## 22. Verification Matrix

`BEGIN…ROLLBACK` JWT harness (`set local role authenticated; set local "request.jwt.claim.sub" = '<auth_user_id>'`). System of record never mutated.

| # | Assertion | Expectation |
|---|-----------|-------------|
| 1 | org_admin SELECT sees all org decisions | rows across departments |
| 2 | dept_lead/member/read_only SELECT scoped via parent task dept | only own-dept-task decisions |
| 3 | **agent SELECT sees only decisions on assigned tasks** | assigned-task decisions only |
| 4 | agent SELECT of decision on unassigned task | 0 rows |
| 5 | dept_member INSERT `proposed` on own-dept task | success |
| 6 | **agent INSERT decision** | RLS 42501 (no agent insert path — corrects G3 claim) |
| 7 | read_only INSERT | RLS 42501 |
| 8 | INSERT on a task in another department (non-admin) | 42501 |
| 9 | INSERT with empty summary or rationale | 23514 |
| 10 | INSERT with `status='confirmed'` | 42501 (insert restricted to proposed/pending_approval) |
| 11 | INSERT with `status='pending_approval'` | success (allowed insert status) |
| 12 | **dept_member UPDATE / confirm a decision** | 0 rows (members excluded from UPDATE) |
| 13 | dept_lead UPDATE `proposed→confirmed` on own-dept task | success |
| 14 | dept_lead UPDATE on another dept's task | 0 rows (USING fails) |
| 15 | agent/read_only UPDATE | 0 rows |
| 16 | UPDATE `status='approved'` directly (no approval row) | **DB allows** — proves the gate is NOT DB-enforced (app must block) |
| 17 | Create decision-approval: subject=decision, cat b, pending, dept=task's dept | success |
| 18 | Create decision-approval with `department_id` ≠ task's dept | 42501 (017 subject sub-check) |
| 19 | Create decision-approval `category='c'` | 42501 (017 restricts to a/b) |
| 20 | **agent INSERT decision-approval** | 42501 (agents excluded) |
| 21 | dept_member resolve decision-approval | 42501 (only org_admin/dept_lead resolve) |
| 22 | dept_lead-in-dept resolve decision-approval (`pending→approved`) | success, `decided_at` set |
| 23 | agent SELECT decision-approval on assigned task | row visible (017 agent decision branch) |
| 24 | `knowledge_records` insert subject=decision by agent on assigned task | success (agents CAN emit knowledge) |
| 25 | `knowledge_records` insert subject=decision cross-dept (non-admin) | 42501 |
| 26 | soft-delete decision by dept_lead | success; row then invisible to all |
| 27 | soft-delete decision by dept_member | 0 rows (members cannot) |
| 28 | decisions on a soft-deleted task | invisible/immutable (EXISTS requires `t.deleted_at IS NULL`) |
| 29 | confirm `decisions` absent from realtime publication | `pg_publication_tables` has no `decisions` row |

**Distinguishing assertions:** #6 (agent cannot insert — corrects G3), #12/#27 (members propose but cannot commit/delete), #16 (gate is app-only, not DB), #20 (agent excluded from approval insert), #24 (agent can emit decision knowledge), #28 (task soft-delete revokes decision access), #29 (no realtime).

---

## 23. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **High-risk decision takes effect ungated.** The DB writes `status='approved'`/`confirmed` with no approval; a missing risk-triage or gate check = a committing decision without its required human approval. | **High** | App risk-classifies every decision (§11 table); high-risk routed through `pending_approval`; `decision.approve` verifies the resolved `approvals` row (test #16); audit carries the approval `id`. |
| 2 | **Risk misclassification.** Treating an external/spend/retention/GovCon/blocker-override decision as low-risk and confirming it directly. | High | Encode the `approval-rules.md` decision-type table as explicit classification; default to gate-required when uncertain; lead review. |
| 3 | **G3 stale claim.** The Task API plan states agents may INSERT `proposed` decisions; the deployed policy excludes agents. Implementers following G3 would build a path RLS rejects. | Medium | This plan documents the correct model (§7); recommend a one-line G3 correction (Next Step). |
| 4 | **Member over-reach assumption.** Assuming members can confirm/approve decisions (they can for outputs) when the decisions UPDATE policy excludes them. | Medium | §7/§19 make the propose-not-commit boundary explicit; test #12/#27. |
| 5 | **Editing a committed decision.** In-place rewrite of a `confirmed`/`approved` rationale rewrites governance history. | Medium | Forbid substantive edits post-commit; require `supersede` (§10, §17). |
| 6 | **Task soft-delete surprise.** Soft-deleting a task silently revokes all access to its decisions (EXISTS requires live task). | Low–Med | Documented (§12, test #28); acceptable by design; surface in task-deletion UX. |
| 7 | **Realtime assumption.** `decisions` is not published; a UI expecting push updates polls or stalls. | Low | §16 states no `decisions` subscription; see `docs/phase-g-realtime-publication-plan.md`. |
| 8 | **Agent knowledge write surprise.** Agents *can* write `knowledge_records` about an assigned-task decision (but not the decision). | Low | Documented (§15); acceptable by design; validate `source`/content. |

---

## 24. Dependencies

- **Deployed schema:** `011_governance_layer.sql` (decisions, approvals, blockers), `013_phase_d_rls_policies.sql` (decisions/approvals/blockers policies — decisions policies unchanged by later migrations, verified live), `017_phase_e_approvals_adjustment.sql` (approvals decision-subject behavior, output-subject addition), `014`/`016` (knowledge_records `subject_type='decision'`).
- **Spine:** G1 Auth Context Spine — the five `private.*` context functions; all identity derived through them.
- **Sibling APIs:** Task API (G3) — decisions pin to tasks; completion-gate interplay; **G3 carries a stale agent-insert claim to correct**. Approval API (G5) — the Category B gate's request/resolve mechanics. Output API (G6) — sibling subject under the same task; the decision↔output governance ordering. Knowledge Record API (own plan) — emission target.
- **Runtime:** `018_runtime_hardening.sql` / `020_phase_f_rls_policies.sql` — decisions have no direct job linkage; influence runtime only through the task.
- **Governance source:** `docs/approval-rules.md` — the decision risk table, the Confirm-Decision reviewer (Department lead), the proposed/approved/rejected logging rules.
- **Open environmental gap:** realtime publication empty (`docs/phase-g-realtime-publication-plan.md`); does not block this API.

---

## 25. MVP Build Order

1. **Read path** — `decision.get`/`list` over `decisions_select_task_scope`; verify the five-role visibility-via-task matrix (tests 1–4).
2. **Propose** — `decision.propose` with the insert-status floor and decider self-pin (tests 5–11).
3. **Low-risk commit** — `decision.confirm` + `decision.revise`/`reject`, establishing the lead-only UPDATE fence (tests 12–15).
4. **High-risk gate (the keystone)** — `decision.request_approval` + `decision.approve` Category B check against `approvals`; tests 16–23. **The single most important step**; #16 proves the gate is application-owned.
5. **Supersession & soft-delete** — `decision.supersede`, `decision.soft_delete` with lead-only authority and committed-decision protections (tests 26–28).
6. **Knowledge emission** — `decision.emit_knowledge` with `subject_type='decision'` (tests 24–25).
7. **Realtime stance** — confirm `decisions` is not published (test 29); expose state via request/response only.

---

## 26. Definition of Done

- All 12 operations (§17) implemented against the deployed `decisions` RLS, with **no** RLS, schema, or migration changes.
- The §22 matrix passes under the `BEGIN…ROLLBACK` harness — including the distinguishing assertions (#6 agent cannot insert, #12/#27 members propose-not-commit, #16 gate app-only, #20 agent excluded from approval, #24 agent decision-knowledge, #28 task-soft-delete revocation, #29 no realtime).
- `decision.approve` **provably refuses** to set `approved` without a resolved Category B `approvals` row, and high-risk decisions are **provably routed** through `pending_approval` rather than confirmed directly.
- DB-enforced vs application-enforced controls are documented and tested as separate layers (§18, §21); no governance semantic relies on a constraint the database does not make (notably: there is **no** paired `decided_at`/`status` invariant, and **no** DB approval-before-`approved` enforcement).
- The plan's claims remain consistent with G5/G6 (agent approval-request model, gate-vs-record discipline) and with `approval-rules.md` (decision risk table, reviewer role, logging).
- The G3 stale agent-insert claim is flagged for correction (and corrected if approved).
- Realtime is treated as out-of-scope for `decisions` and cross-referenced to the realtime publication plan.
