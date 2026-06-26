# Phase G6 — Output API Plan

> **Architecture document. No code, routes, Edge Functions, migrations, schema, or frontend are produced here.** Every schema, enum, constraint, and policy claim below is grounded in the deployed database (`014_knowledge_output_layer.sql`, `016_phase_e_rls_policies.sql`, `017_phase_e_approvals_adjustment.sql`) verified live against project `wbtvrzivthuqqntnorsw` on 2026-06-24, and in `docs/approval-rules.md`.

---

## 1. Purpose

The Output API governs the **deliverable artifact** an executing task produces — the report, message, artifact, data export, or other work product that is the *point* of the task. Where the Task API tracks the unit of work and the Work Packet API holds the specification, the Output API owns the lifecycle of the *result*: drafting it, reviewing it, gating its release behind a Category A approval, and recording its delivery.

The Output entity is also the layer where the system meets the outside world. Delivery — sending, publishing, releasing to an external requester — is the canonical **Category A "always required" approval** in `approval-rules.md`. The Output API is therefore the consumer of the `approvals.subject_type='output'` gate that migration `017` activated, and the place where the **gate-vs-record** discipline from the Approval API (G5) is enforced: the DB records the approval; the Output API refuses delivery without it.

The API adds no authorization system. It authenticates the caller, derives org/department/role through the `private.*` spine, lets RLS decide visibility and mutation rights on `outputs`, and layers the status machine and the delivery gate on top.

---

## 2. Scope

**In scope:** create/read/update outputs; the review path `draft → in_review → approved → delivered` plus `superseded` and `rejected`; the Category A delivery approval gate (application-enforced, backed by `approvals.subject_type='output'`); research-asset citation links via `output_research_assets`; knowledge-record emission with `subject_type='output'`; soft-delete; the task/project/department relationships; the external-delivery boundary.

**Out of scope:** the internals of the Approval, Task, Work Packet, Research Asset, and Knowledge Record APIs (each its own plan); the actual transport that performs external delivery (email/webhook/storage egress — that is runtime/Edge-Function territory, described only as a boundary here, §22); schema changes; new roles; any RLS modification. This plan consumes the deployed `outputs` RLS exactly as shipped in `016`.

---

## 3. Output Entity Definition

`public.outputs` — verified live. Columns:

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| `id` | uuid | NO | `gen_random_uuid()` | PK |
| `organization_id` | uuid | NO | — | FK → organizations, **restrict**; JWT-derived |
| `department_id` | uuid | NO | — | FK → departments, **restrict**; **direct, not derived via task** |
| `task_id` | uuid | NO | — | FK → tasks, **restrict** |
| `project_id` | uuid | NO | — | FK → projects, **restrict** |
| `title` | text | NO | — | `length(trim(title)) > 0` |
| `output_type` | text | NO | — | enum (below) |
| `content` | text | YES | — | inline body (nullable) |
| `storage_path` | text | YES | — | pointer to Storage payload (nullable) |
| `created_by_user_id` | uuid | YES | — | FK → users, **set null**; self-pinned on write |
| `status` | text | NO | `'draft'` | enum (below) |
| `produced_at` | timestamptz | NO | `now()` | when the artifact was produced |
| `delivered_at` | timestamptz | YES | — | **must be set when `status='delivered'` (DB check)** |
| `created_at` | timestamptz | NO | `now()` | |
| `updated_at` | timestamptz | NO | `now()` | maintained by `set_updated_at` trigger |
| `deleted_at` | timestamptz | YES | — | soft-delete tombstone |

**Enums (DB check constraints):**
- `output_type ∈ {report, artifact, message, data, other}`
- `status ∈ {draft, in_review, approved, delivered, superseded, rejected}`

**Key constraints (verified):**
- `outputs_delivered_at_status_check`: `(status='delivered' AND delivered_at IS NOT NULL) OR status<>'delivered'`. **DB-enforced delivered⇒delivered_at.**
- `outputs_title_not_empty`, `outputs_output_type_check`, `outputs_status_check` as above.
- All four parent FKs (`organization_id`, `department_id`, `task_id`, `project_id`) are **ON DELETE RESTRICT** — an output pins its parents alive. `created_by_user_id` is **ON DELETE SET NULL** (a departed author does not orphan or delete the output).

**Design note (from `014`):** `department_id` is intentionally **direct** rather than derived through `task_id`, for RLS performance, routing, audit, and delivery accountability. The application — and, as it happens, RLS — must keep it aligned with the parent task's department. There is **no DB FK** asserting `outputs.department_id = task.department_id`; alignment is enforced by the RLS EXISTS clause (§17) and by application validation, not by a foreign key.

---

## 4. Output Lifecycle

1. **Produce.** During or after task execution, an authorized human (org_admin / dept_lead / dept_member) creates the output in `draft`, pinned to its task, project, and department. Agents **cannot** create outputs (no agent INSERT path); an agent's produced content is materialized into an output row by a human or service-role path.
2. **Review.** The output moves `draft → in_review`. This is the review checkpoint from `approval-rules.md` ("Outputs follow a review path before delivery").
3. **Approve (content).** Reviewer accepts: `in_review → approved`. The output is now *content-approved* — fit to exist — but not yet licensed to leave the system.
4. **Gate (delivery).** If the output is to be **delivered externally**, that delivery is a **Category A** action and requires a separate, resolved `approvals` row with `subject_type='output'`, `category='a'`, `status='approved'` (§12). Internal-only reports need no delivery approval (review only).
5. **Deliver.** With the delivery gate satisfied, the API transitions `approved → delivered` and sets `delivered_at`. The actual egress (email/webhook/storage handoff) is a runtime concern (§22); the `outputs` row records that delivery occurred.
6. **Supersede / reject.** A superior version supersedes a prior output (`→ superseded`); an unacceptable output is rejected (`→ rejected`).
7. **Retire.** Soft-delete sets `deleted_at`; the row becomes invisible to all authenticated consumers.

---

## 5. State Machine

States are exactly the six DB-enum values. The API enforces transition legality (Layer 4); the DB enforces only the value set and the `delivered⇒delivered_at` pairing.

```text
        ┌──────────────── reject ───────────────┐
        v                                        │
   ┌─────────┐  submit   ┌───────────┐  approve  ┌──────────┐  deliver*  ┌───────────┐
   │  draft  │──────────>│ in_review │──────────>│ approved │──────────>│ delivered │
   └─────────┘           └───────────┘           └──────────┘           └───────────┘
        ^                      │ reject                │                       │
        │ revise               v                       │ supersede             │ supersede
        └──────────────── ┌──────────┐                 v                       v
                          │ rejected │            ┌────────────┐         ┌────────────┐
                          └──────────┘            │ superseded │<────────│ superseded │
                                                  └────────────┘         └────────────┘
* deliver requires an approved Category A output-approval (application-enforced, §12)
```

| From | To | Operation | Gate |
|------|-----|-----------|------|
| `draft` | `in_review` | `output.submit_for_review` | none |
| `draft` | `rejected` | `output.reject` | none (author/reviewer abandon) |
| `in_review` | `approved` | `output.approve_content` | reviewer authority |
| `in_review` | `rejected` | `output.reject` | reviewer authority |
| `in_review` | `draft` | `output.revise` (return for edits) | reviewer authority |
| `approved` | `delivered` | `output.deliver` | **Category A approval (§12)** + `delivered_at` set |
| `approved` | `superseded` | `output.supersede` | new version exists |
| `delivered` | `superseded` | `output.supersede` | new version exists |
| `approved` / `rejected` | `draft` | `output.revise` | reopen for rework |

**Terminal-ish:** `delivered` (external action taken; only `superseded` follows), `superseded`, `rejected`. **DB does not enforce these transitions** — any role permitted by the UPDATE policy can write any enum value to `status` as far as the database is concerned (subject only to `delivered⇒delivered_at`). Transition legality and the delivery gate are **application-enforced**; this separation is the central security claim of §27.

---

## 6. Visibility Model

From `outputs_select_department_scope` (`016`), verified live. `outputs` SELECT, `authenticated`, `USING`:

- `organization_id = current_organization_id()` AND `deleted_at IS NULL`, AND one of:
  - **org_admin** — every non-deleted output in the org.
  - **department_lead / department_member / read_only** — `department_id = current_department_id()` (department-scoped, via the **direct** `department_id`).
  - **agent** — only where the parent task is assigned to them: `EXISTS task t WHERE t.id = outputs.task_id AND t.assigned_to_user_id = current_user_id() AND t.deleted_at IS NULL`.

| Role | Sees |
|------|------|
| org_admin | all org outputs |
| department_lead | dept outputs |
| department_member | dept outputs |
| read_only | dept outputs (read only) |
| agent | outputs of tasks assigned to it, only |
| unauthenticated / null context | nothing |

Notes: agent visibility is **task-assignment-derived**, not department-derived — consistent with `tasks` and the rest of the agent model. `read_only` sees the department's outputs but has no write path (§7). Soft-deleted outputs are invisible to all authenticated roles.

---

## 7. Auth Contract

Derived from the three deployed `outputs` policies. Roles are JWT-derived via `private.current_role()`; the API never trusts a role/department/org asserted in a request body.

| Capability | org_admin | dept_lead | dept_member | read_only | agent |
|-----------|:--------:|:---------:|:-----------:|:---------:|:-----:|
| SELECT (visibility §6) | all org | dept | dept | dept | assigned task only |
| INSERT (create) | ✅ | ✅ (own dept) | ✅ (own dept) | ❌ | ❌ |
| UPDATE (status/edit/soft-delete) | ✅ | ✅ (own dept) | ✅ (own dept) | ❌ | ❌ |
| DELETE (hard) | ❌ (no policy) | ❌ | ❌ | ❌ | ❌ |

**Notable contrasts:**
- **`department_member` *can* UPDATE outputs.** This differs from Work Packets (G4), where members are excluded from UPDATE. The `outputs` UPDATE policy admits `{org_admin, department_lead, department_member}`. Reviewer/approver *authority* within that set (who may move `in_review → approved`) is an **application-layer** narrowing, not an RLS one (§11).
- **Agents are excluded from INSERT and UPDATE entirely.** They only read outputs of their assigned tasks. Any "agent produced this" content reaches `outputs` through a human/service path.
- **No hard DELETE** for any authenticated role (no DELETE policy exists). Removal is soft-delete via UPDATE.

---

## 8. Create Contract

**`output.create`** — `draft` row pinned to a task, project, department.

- **Purpose:** materialize a task's deliverable as a governed row.
- **Inputs:** `task_id` (required), `project_id` (required), `department_id` (required), `title` (non-empty), `output_type ∈ {report,artifact,message,data,other}`, optional `content`, optional `storage_path`. `organization_id` is JWT-derived; `created_by_user_id` self-pinned; `status` defaults `draft`; `produced_at` defaults `now()`.
- **Outputs:** the created output row (`status='draft'`).
- **Auth requirements:** org_admin / dept_lead / dept_member. Non-admins implicitly write their own department.
- **RLS expectations (`outputs_insert_department_scope`):** org pin; `deleted_at IS NULL`; role in the three writers; `org_admin OR department_id = current_department_id()`; `created_by_user_id` null-or-self; department live; **task EXISTS with `t.department_id = outputs.department_id` AND `t.project_id = outputs.project_id` AND not deleted**; project EXISTS and live. The task clause is the alignment enforcer: the output's `(department_id, project_id)` must equal the parent task's.
- **Failure modes:** agent/read_only caller → RLS 42501 (`forbidden`); `department_id` ≠ caller's dept (non-admin) → 42501; `task_id` whose `department_id`/`project_id` doesn't match the supplied values → 42501 (`validation`/`not_found`); empty title or bad `output_type` → 23514 (`validation`); cross-org task/project → 42501.
- **Audit requirements:** `execution_logs` `state_change` "output created at draft", actor = `created_by_user_id`, `task_id`/`output_type` in metadata.
- **Approval requirements:** none to create.

---

## 9. Read Contract

**`output.get` / `output.list`**

- **Purpose:** retrieve one output or a filtered list within the caller's visible set.
- **Inputs:** `get`: `id`. `list`: optional filters — `status`, `output_type`, `task_id`, `project_id`, pagination. No `department_id` filter is applied on behalf of non-admins; RLS already scopes.
- **Outputs:** output row(s) the caller may SELECT.
- **Auth requirements:** any authenticated active member; visibility per §6.
- **RLS expectations:** `outputs_select_department_scope`. Application filters operate *within* the visible set, never as a substitute for it.
- **Failure modes:** out-of-scope/deleted/cross-dept output → `not_found` (RLS invisible); agent requesting an output of an unassigned task → `not_found`; null context → `not_found`.
- **Audit requirements:** read-only; no log required (optional access metric).
- **Approval requirements:** none.

---

## 10. Update Contract

**`output.update`** — edit mutable spec fields (`title`, `content`, `storage_path`, `output_type`) without a status change.

- **Purpose:** refine the deliverable's contents before/within review.
- **Inputs:** `id` + changed fields. `organization_id`, `task_id`, `project_id`, `department_id` are not re-pointed by this op (re-parenting is out of scope; the RLS WITH CHECK re-validates them regardless).
- **Outputs:** updated row.
- **Auth requirements:** org_admin / dept_lead / dept_member, in the output's department.
- **RLS expectations (`outputs_update_department_scope`):** USING (org pin; not deleted; role in three writers; `org_admin OR department_id = current_department_id()`) + WITH CHECK (same role gate; department live; **task EXISTS with dept+project match**; project live; `created_by_user_id` null-or-live-user). The task/project re-validation in WITH CHECK means an update cannot drift the output out of alignment with its parent task.
- **Failure modes:** read_only/agent → 42501; cross-dept → USING fails → 0 rows (`not_found`); bad enum/empty title → 23514; mutated `department_id`/`project_id`/`task_id` that breaks the alignment EXISTS → 42501.
- **Audit requirements:** `execution_logs` `state_change` with changed fields (old→new).
- **Approval requirements:** none for content edits. (Editing `content` after delivery is discouraged; see §14 supersession — prefer a new version.)

---

## 11. Review Contract

The review path `draft → in_review → approved` from `approval-rules.md`. **This is content review, distinct from the delivery approval gate (§12).** Passing review makes an output *fit to exist*; it does not license external delivery.

- **`output.submit_for_review`** (`draft → in_review`): author submits. Auth: any of the three writers in the dept. No approval row involved.
- **`output.approve_content`** (`in_review → approved`): the reviewer accepts the content. **Reviewer authority is application-enforced.** RLS permits any of `{org_admin, dept_lead, dept_member}` in the department to perform the UPDATE; the API should narrow "who may approve content" to the reviewer role named in `approval-rules.md` (Department lead for internal reports; Operations/Engineering/Domain leads per output type). This narrowing is **Layer 4**, not RLS — the DB will not stop a department_member from writing `status='approved'`.
- **`output.revise`** (`in_review → draft`, or reopen `approved/rejected → draft`): return for edits.
- **`output.reject`** (`in_review → rejected`, or `draft → rejected`): abandon this output.

- **RLS expectations:** all are `outputs` UPDATE; the policy does not distinguish *which* status value is being written, so transition legality and reviewer-role narrowing are entirely application responsibilities.
- **Failure modes:** member performing a content-approval the API reserves for a lead → `forbidden` (Layer 4); illegal transition (e.g., `delivered → in_review`) → `conflict`; cross-dept → `not_found`.
- **Audit requirements:** `execution_logs` `state_change` per transition; the content-approval logs the reviewer identity.
- **Approval requirements:** review is **not** an `approvals` row. (Category C — "review only, no gate" — for internal reports per `approval-rules.md` line 161.) The `approvals` table is involved **only** for delivery (§12).

---

## 12. Approval Gate Contract

This is the defining section. **Delivering an output externally is a Category A "always required" action** (`approval-rules.md` §"Category A": *"Deliver Output to external requester → subject `output` → Operations lead → approved"*). The gate is **application-enforced, backed by a DB-recorded `approvals` row**. The DB does **not** enforce "no delivery without approval" — the `outputs` UPDATE policy will happily write `status='delivered'` with no approval anywhere. The Output API is the enforcement point.

**Mechanics (grounded in `017`):**
- The gate row lives in `public.approvals`: `subject_type='output'`, `subject_id = output.id`, `category='a'`, `department_id = output.department_id`, `trigger_reason` describing the delivery, `approver_role` = Operations lead (or Domain owner + Operations for GovCon, per `approval-rules.md`).
- **Creating the gate** (`approval.request` from G5, or `output.request_delivery_approval` as a thin wrapper): `approvals_insert_department_scope` (`017`) requires role ∈ {org_admin, dept_lead, dept_member}, `category ∈ {a,b}`, `status='pending'`, and the **output subject EXISTS with `o.department_id = approvals.department_id` and not deleted**. Agents cannot create it (they signal via `agent_activity(activity_type='approval_requested')`; a human/service creates the row — consistent with G3/G4/G5).
- **Resolving the gate**: `approvals_update_approver_scope` (`017`) — only org_admin or a dept_lead in the approval's department may move it `pending → approved` (with `decided_at` set). department_member **cannot** resolve, even though a member can edit the output. This is the real authority boundary on delivery.
- **Visibility of the gate**: `approvals_select_department_scope` (`017`) gives org_admin/dept-scoped humans the output approval (with the output dept sub-check); an **agent** sees an output approval only via its assigned task — and never a `work_packet` approval. Matches G5.

**The application contract for `output.deliver`:**
1. Confirm an `approvals` row exists for this output with `category='a'`, `status='approved'`, `decided_at IS NOT NULL`, matching department.
2. Only then UPDATE `outputs` to `status='delivered'`, `delivered_at = now()`.
3. If no such approved row exists → refuse with `approval_required`. **The DB will not refuse this for you.**

**Internal outputs:** `approval-rules.md` (line 161) marks internal reports as "review only — No" delivery approval. For those, there is no `approvals` row and no `output.deliver` external gate; an internal "delivery" is effectively the `approved` state plus internal distribution. The API decides external-vs-internal from `output_type` + delivery target and only invokes the Category A gate when delivery crosses the external boundary (§22).

---

## 13. Delivery Contract

**`output.deliver`** (`approved → delivered`)

- **Purpose:** record that an approved output has been released, and trigger the external egress.
- **Inputs:** `id`; delivery target/channel metadata (for the runtime egress, not stored on `outputs` beyond audit).
- **Outputs:** output at `status='delivered'` with `delivered_at` set.
- **Auth requirements:** org_admin / dept_lead / dept_member in the department *(RLS)* — **but** the API additionally requires the approved Category A gate (§12) and should reserve the trigger to the role that owns delivery (Operations lead) per `approval-rules.md`. Layer-4 narrowing.
- **RLS expectations:** `outputs_update_department_scope` permits the status write and the `delivered_at` set. **RLS performs no approval check** — that is the application's job.
- **DB-enforced invariant:** `outputs_delivered_at_status_check` guarantees that *if* `status='delivered'` then `delivered_at IS NOT NULL`. The API must set `delivered_at` in the same UPDATE or the write fails with 23514. This is the one delivery-time guarantee the database makes; the approval guarantee it does **not** make.
- **Failure modes:** no approved output-approval → `approval_required` (Layer 4); `status≠'approved'` → `conflict` (illegal transition); setting `delivered` without `delivered_at` → 23514 (DB); cross-dept/out-of-scope → `not_found`; read_only/agent → `forbidden`.
- **Audit requirements:** `execution_logs` `output_delivery` (and/or `approval_action` resolving the gate) with the approval `id`, delivery target, `delivered_at`. A `background_jobs` row of type `output_delivery` (per `020`/runtime model) typically carries the egress.
- **Approval requirements:** **Category A, approved, required** — the only operation in this API with a hard approval precondition.

---

## 14. Supersession Contract

**`output.supersede`** (`approved` or `delivered → superseded`)

- **Purpose:** mark an output replaced by a newer version without deleting the historical record. Delivered outputs are immutable facts (an external party received them); correction is a *new* output that supersedes, never an in-place edit.
- **Inputs:** `id` (the output being superseded); `replacement_output_id` (the new version), recorded in audit/metadata. There is **no `superseded_by` column** on `outputs` — the linkage is captured in `execution_logs` and optionally a `knowledge_record_link` (`link_type='supersedes'`).
- **Outputs:** prior output at `status='superseded'`; the replacement proceeds through its own lifecycle.
- **Auth requirements:** org_admin / dept_lead / dept_member in the department (RLS UPDATE). The API may reserve supersession of a *delivered* output to leads.
- **RLS expectations:** `outputs_update_department_scope`. No special DB handling of `superseded`.
- **Failure modes:** superseding a `draft`/`rejected` (nothing to replace) → `conflict`; cross-dept → `not_found`.
- **Audit requirements:** `execution_logs` `state_change` "→superseded" with `replacement_output_id` in metadata.
- **Approval requirements:** none to supersede. (The *replacement's* delivery, if external, hits its own Category A gate.)

---

## 15. Task Relationship

- **Relationship:** `outputs.task_id` NOT NULL, FK → `tasks`, **ON DELETE RESTRICT**. Every output belongs to exactly one task; a task may have many outputs.
- **Alignment (enforced):** RLS INSERT/UPDATE require `EXISTS task t WHERE t.id = outputs.task_id AND t.department_id = outputs.department_id AND t.project_id = outputs.project_id AND t.deleted_at IS NULL`. So an output's `(department_id, project_id)` is structurally tied to its task's — though via an RLS EXISTS, **not** a foreign key.
- **Agent path:** an agent's visibility of an output is *entirely* mediated by the task: agent sees the output only if assigned to `outputs.task_id`. There is no department-derived agent path.
- **Task completion interplay:** the Task API's `in_review → done` completion gate (G3 §13) checks for pending output approvals; an output awaiting delivery approval is a reason a task may not yet complete. Reciprocally, an output cannot exist without a live task (RESTRICT), so a task with outputs cannot be hard-deleted (moot under soft-delete-only authenticated paths; relevant for service-role).

---

## 16. Project Relationship

- **Relationship:** `outputs.project_id` NOT NULL, FK → `projects`, **ON DELETE RESTRICT**. The output is pinned to the same project as its task (the RLS task-clause requires `t.project_id = outputs.project_id`).
- **Why both `task_id` and `project_id`:** redundant-but-pinned. `project_id` enables project-level rollups and the `outputs_organization_project_id_idx` without a task join, while the RLS clause keeps it consistent with the task. The API must set `project_id` to the parent task's project; supplying a different project is rejected by the alignment EXISTS.
- **No project-level approval gate:** projects do not introduce their own output gate; the gate is per-output (§12).

---

## 17. Department Relationship

- **Relationship:** `outputs.department_id` NOT NULL, FK → `departments`, **ON DELETE RESTRICT**, and **direct** (a first-class column, not derived through the task at query time). This is the deliberate `014` design choice for RLS scoping, routing, audit, and delivery accountability.
- **Enforcement of correctness:** there is **no FK** asserting `outputs.department_id = task.department_id`. Alignment is enforced two ways, both of which the API must honor:
  1. **RLS** INSERT/UPDATE EXISTS clause: the parent task must share the department (`t.department_id = outputs.department_id`).
  2. **Application validation:** the create/update operations set `department_id` from the parent task and reject mismatches before the write.
- **Visibility consequence:** because `department_id` is direct, human SELECT scoping (`department_id = current_department_id()`) is a single-column check — fast and unambiguous. Cross-department outputs are invisible to non-admin humans.

---

## 18. Approval Relationship

- **Relationship:** polymorphic — `approvals.subject_type='output'`, `approvals.subject_id = output.id`. **No DB FK** on `subject_id`; integrity is enforced by the `017` RLS EXISTS sub-checks, which additionally require `output.department_id = approvals.department_id`.
- **Which approvals attach:** only **delivery** (Category A) produces an output approval row. Content review (§11) does **not**. Category C actions never produce rows. So the `approvals` rows for an output are exactly its delivery gates.
- **Lifecycle parity with G5:** request → pending → approved/rejected/withdrawn (expired is system-only). Resolution authority is org_admin or dept_lead-in-dept; members and agents cannot resolve. The Output API reads gate state but never bypasses it.
- **The enforcement gap is owned here:** because the DB records but does not enforce the gate (§12), the Output API's `output.deliver` is the single chokepoint that must verify the approved row. A missing check here silently defeats the Category A control — the headline risk (§29).

---

## 19. Research Asset Relationship

- **Relationship:** `public.output_research_assets` junction — `(organization_id, output_id, research_asset_id, linked_at, notes)`, UNIQUE `(output_id, research_asset_id)`, both FKs **ON DELETE CASCADE**. Records which research assets were cited or used to produce the output.
- **`output.link_research_asset`** operation:
  - **Purpose:** attach a citation/source to an output.
  - **Inputs:** `output_id`, `research_asset_id`, optional `notes`.
  - **Outputs:** junction row.
  - **Auth/RLS (`output_research_assets_insert_parent_scope`, `016`):** role ∈ {org_admin, dept_lead, dept_member}; the output must be visible/owned (`org_admin OR o.department_id = current_department_id()`, not deleted); the research asset must be org-local and live. **Agents cannot link** (not in the writer set).
  - **Failure modes:** cross-dept output → 42501; foreign-org or deleted asset → 42501; duplicate link → 23505 (unique).
  - **Visibility:** `output_research_assets_select_parent_scope` derives access from the parent output (dept for humans, assigned-task for agents) — so an agent on the assigned task *can read* the citations of that output even though it cannot create them.
- **Reverse use:** research assets gain department visibility partly *through* their output links — `research_assets_select_department_scope` (`016`) includes an `output_research_assets → outputs` branch (an asset is visible to a department if it is cited by one of that department's outputs).

---

## 20. Knowledge Relationship

- **Relationship:** `knowledge_records.subject_type='output'`, `subject_id = output.id` (the `014` check constraint admits `'output'`; **no FK**, polymorphic). An output can be the subject of curated, retrievable knowledge (a summary, synthesis, lesson).
- **`output.emit_knowledge`** (thin wrapper over the Knowledge Record API):
  - **Purpose:** capture durable memory about a delivered/notable output.
  - **Inputs:** `subject_id = output.id`, `record_type ∈ {summary,context,constraint,lesson,index,synthesis,other}`, `title`/`summary`/`content` (all non-empty), `source ∈ {human,agent,…}`, `confidence`.
  - **Auth/RLS (`knowledge_records_insert_subject_scope`, `016`):** for `subject_type='output'`, the writer must be org_admin, or dept_lead/member where `o.department_id = current_department_id()`, **or an agent assigned to the output's task** (`t.assigned_to_user_id = current_user_id()`). Notably, **agents *can* emit knowledge about an output of their assigned task**, even though they cannot create or edit the output itself.
  - **Visibility:** `knowledge_records_select_subject_scope` mirrors this — dept-scoped for humans (via `o.department_id`), assigned-task-derived for agents.
  - **Failure modes:** output not in caller's subject scope → 42501; empty required text → 23514.
- **Links:** `knowledge_record_links` may point at an output (`linked_entity_type='output'`) with `link_type` including `supersedes` — the natural home for the supersession lineage referenced in §14. Link visibility requires *both* the parent knowledge record and the linked output to be visible (the dual-scope rule in `016`).

---

## 21. Runtime Relationship

- **Delivery egress as a job:** external delivery is performed by the runtime, not the API write. Per the runtime data model and `020`, a `background_jobs` row of type `output_delivery` (carrying `related_task_id`, and the output reference in payload) executes the actual send/publish. The API's `output.deliver` records the state change and enqueues/【or signals】 the job; it does not perform egress inline.
- **Agent visibility of delivery jobs:** an agent can SELECT a `background_jobs` row only via `related_task_id` referencing an assigned task (`020`). Agents cannot UPDATE jobs. So an agent may observe that its task's output delivery is running, but cannot drive or alter it.
- **Audit stream:** every output state change emits `execution_logs`; delivery emits `output_delivery` (+ the resolving `approval_action`). Notable outputs may also surface `audit_events` for compliance (external release is an auditable event).
- **Realtime:** `outputs` is **not** in the realtime publication set (only `tasks`, `approvals`, `blockers` were ever designated — and that publication is currently empty per `docs/phase-g-realtime-publication-plan.md`). Output state changes are observed through request/response reads and, indirectly, through the `approvals` channel when realtime is eventually enabled. The Output API must **not** promise an `outputs` subscription.

---

## 22. External Delivery Boundary

This is where the system touches the outside world, and the reason delivery is Category A.

- **Definition of "external delivery":** any egress that leaves the Command Center's trust boundary — sending an email, publishing to a channel, releasing a file to a requester, submitting a domain/GovCon package. `approval-rules.md`: *"Sending, publishing, spending, or deleting externally requires Approval."*
- **Internal vs external:** `approval-rules.md` (line 161) — an *internal* report is review-only (no delivery approval); an *external message/email*, *data export*, or *domain client submission* requires Category A. The API determines which boundary a given `output_type` + target crosses and only invokes the Category A gate for external crossings.
- **The boundary is one-directional and irreversible:** once delivered externally, the act cannot be unsent. This is precisely why the DB records `delivered_at` immutably (a delivered output is corrected by *supersession*, §14, never by editing the delivered row) and why the approval is "always required, before impact."
- **The API's responsibility at the boundary:**
  1. Classify internal vs external.
  2. For external: require the approved Category A gate (§12) **before** any egress is initiated.
  3. Initiate egress via the runtime job (§21), never inline in the request handler.
  4. Record `delivered_at` and emit the audit trail only on confirmed egress.
- **What the API must never do:** treat content-approval (`status='approved'`) as delivery authorization. `approved` means "fit to exist/review passed"; it is **not** the external gate. Conflating the two collapses the Category A control.

---

## 23. API Operation Catalog

| # | Operation | Transition / Effect | Hard approval gate |
|---|-----------|---------------------|:------------------:|
| 1 | `output.create` | → `draft` | — |
| 2 | `output.get` | read one | — |
| 3 | `output.list` | read many (filtered, RLS-scoped) | — |
| 4 | `output.update` | edit fields (no status change) | — |
| 5 | `output.submit_for_review` | `draft → in_review` | — |
| 6 | `output.approve_content` | `in_review → approved` (reviewer authority, Layer 4) | — |
| 7 | `output.revise` | `in_review/approved/rejected → draft` | — |
| 8 | `output.reject` | `draft/in_review → rejected` | — |
| 9 | `output.request_delivery_approval` | create `approvals` (subject=output, cat a, pending) | — (this *creates* the gate) |
| 10 | `output.deliver` | `approved → delivered` (+`delivered_at`) | **Category A approved** |
| 11 | `output.supersede` | `approved/delivered → superseded` | — |
| 12 | `output.link_research_asset` | insert `output_research_assets` | — |
| 13 | `output.emit_knowledge` | insert `knowledge_records` (subject=output) | — |
| 14 | `output.soft_delete` | set `deleted_at` | — |

(Operations 1–14 each carry the full Purpose/Inputs/Outputs/Auth/RLS/Failure/Audit/Approval treatment in §§8–14, 19–20, and below.)

**`output.soft_delete`**
- **Purpose:** retire an erroneous/duplicate output; set `deleted_at`. Becomes invisible to all authenticated consumers.
- **Inputs:** `id`.
- **Outputs:** row with `deleted_at` set.
- **Auth requirements:** org_admin / dept_lead / dept_member in dept (the UPDATE policy USING requires `deleted_at IS NULL` currently, so a soft-delete is the terminal UPDATE).
- **RLS expectations:** `outputs_update_department_scope`. There is no DELETE policy; this is the only removal path on the authenticated client.
- **Failure modes:** already-deleted → 0 rows (USING fails); read_only/agent → `forbidden`; cross-dept → `not_found`. Deleting a *delivered* output is discouraged (the delivery is a historical fact) — the API should warn/forbid soft-deleting `delivered` outputs and prefer `superseded`.
- **Audit requirements:** `execution_logs` `state_change` "soft-deleted".
- **Approval requirements:** none (org-admin-equivalent authority; but note members *can* soft-delete here, unlike tasks where soft-delete is admin-only — a deliberate consequence of the broader `outputs` UPDATE writer set).

---

## 24. Validation Rules

| Rule | Enforced by |
|------|-------------|
| `title` non-empty | **DB** (`outputs_title_not_empty`) |
| `output_type ∈ {report,artifact,message,data,other}` | **DB** (`outputs_output_type_check`) |
| `status ∈ {draft,in_review,approved,delivered,superseded,rejected}` | **DB** (`outputs_status_check`) |
| `status='delivered' ⇒ delivered_at IS NOT NULL` | **DB** (`outputs_delivered_at_status_check`) |
| `organization_id` = caller's org | **DB RLS** (all policies) + JWT-derived by API |
| `department_id` = caller's dept (non-admin) | **DB RLS** (insert/update) + API |
| `department_id`/`project_id` aligned with parent task | **DB RLS** (task EXISTS clause) + **API** validation |
| `created_by_user_id` null-or-self (insert) / null-or-live (update) | **DB RLS** |
| Legal status transition (e.g., `delivered` only from `approved`) | **Application only** (DB allows any enum write) |
| Reviewer authority for content-approval | **Application only** (RLS admits all three writers) |
| Approved Category A gate before `delivered` | **Application only** (DB does not check) |
| External-vs-internal delivery classification | **Application only** |
| No edit of a `delivered` output (prefer supersede) | **Application only** |

The split is the whole point: the DB guarantees *value integrity and tenancy*; the **application guarantees the governance semantics** — transitions, reviewer roles, and the delivery gate.

---

## 25. Error Model

| Code | HTTP | Trigger |
|------|------|---------|
| `unauthenticated` | 401 | No JWT / null `current_user_id` (unprovisioned/inactive) |
| `forbidden` | 403 | Agent or read_only attempting create/update/delete (role excluded); member attempting a lead-reserved content-approval or delivery (Layer-4 narrowing) |
| `not_found` | 404 | Output not in caller's visible scope (cross-dept, deleted, agent-unassigned task) |
| `validation` | 422 | Empty title, bad `output_type`, dept/project not aligned with task, foreign-org parent |
| `conflict` | 409 | Illegal status transition; delivering a non-`approved` output; superseding a `draft` |
| `approval_required` | 409 | `output.deliver` without an approved Category A output-approval |
| `constraint` | 409 | DB 23514 (`delivered` without `delivered_at`), 23505 (duplicate research-asset link) |

RLS denials surface as `not_found` (invisible row) or `forbidden` (visible-but-no-authority), matching the G3/G5 conventions. The distinctive code here is **`approval_required`** on delivery — the application-layer manifestation of the Category A gate.

---

## 26. Audit Requirements

| Event | Sink | Shape |
|-------|------|-------|
| Output created | `execution_logs` | `state_change`, actor=`created_by_user_id`, "created at draft", `task_id`/`output_type` |
| Field update | `execution_logs` | `state_change`, changed fields old→new |
| `draft→in_review` | `execution_logs` | `state_change` |
| `in_review→approved` (content) | `execution_logs` | `state_change`, reviewer identity |
| Delivery approval requested | `execution_logs` | `approval_action`, approval `id`, `category='a'` |
| Delivery approval resolved | `execution_logs` | `approval_action`, decision, `decided_at` |
| `approved→delivered` | `execution_logs` + `audit_events` | `output_delivery`, approval `id`, delivery target, `delivered_at` |
| `→superseded` | `execution_logs` | `state_change`, `replacement_output_id` |
| `→rejected` | `execution_logs` | `state_change`, reason |
| Research-asset link | `execution_logs` | `note`, `research_asset_id` |
| Knowledge emitted | `execution_logs` | `note`, `knowledge_record_id` |
| Soft-delete | `execution_logs` | `state_change` "soft-deleted" |

Per `approval-rules.md`: every approval must produce execution-log entries on request, decision, and resolution. **External delivery is the one event that also warrants an `audit_events` row** (irreversible external impact).

---

## 27. Security Model

- **Department confinement (direct).** `department_id` is a first-class column; human SELECT/INSERT/UPDATE are pinned to `current_department_id()` for non-admins. Cross-department outputs are invisible and unwritable.
- **Agent confinement (task-derived, read-only).** Agents have **no** INSERT/UPDATE on outputs and see only outputs of tasks assigned to them. The one place agents *write* in this layer is `knowledge_records` about an assigned-task output (§20) — not the output itself.
- **Author pin.** `created_by_user_id` is self-pinned on insert and must reference a live org user on update; no caller can attribute authorship to another.
- **No hard delete.** No DELETE policy exists; removal is soft-delete via UPDATE, and the API should forbid soft-deleting a `delivered` output.
- **Tenancy by construction.** All four parents are RESTRICT FKs and org-pinned by RLS; an output cannot reference a foreign-org task/project/department, and cannot outlive its parents.
- **The application-enforced perimeter (the critical part).** Three controls live *only* in the API, not the database:
  1. **Transition legality** — the DB accepts any enum write to `status` (subject to `delivered⇒delivered_at`).
  2. **Reviewer authority** — RLS admits all three writers to `in_review→approved`; the lead-only reviewer rule is Layer 4.
  3. **The Category A delivery gate** — RLS will write `delivered` with no approval; only the API checks for the approved `approvals` row.
  A defect in any of these silently downgrades a governance control to a suggestion. The delivery gate (#3) is the highest-stakes, because its failure mode is **unapproved external release**.

---

## 28. Verification Matrix

`BEGIN…ROLLBACK` JWT harness (`set local role authenticated; set local "request.jwt.claim.sub" = '<auth_user_id>'`). System of record never mutated.

| # | Assertion | Expectation |
|---|-----------|-------------|
| 1 | org_admin SELECT sees all org outputs | rows across departments |
| 2 | dept_lead/member/read_only SELECT scoped to own dept | only dept rows |
| 3 | **agent SELECT sees only outputs of assigned tasks** | assigned-task outputs only; others invisible |
| 4 | agent SELECT of unassigned-task output | 0 rows |
| 5 | dept_member INSERT in own dept, aligned task/project | success (`draft`) |
| 6 | **agent INSERT** | RLS 42501 (no agent insert path) |
| 7 | read_only INSERT | RLS 42501 |
| 8 | INSERT with `department_id` ≠ parent task's dept | 42501 (alignment EXISTS fails) |
| 9 | INSERT with `project_id` ≠ parent task's project | 42501 |
| 10 | INSERT empty title / bad `output_type` | 23514 |
| 11 | INSERT cross-dept (non-admin, other dept) | 42501 |
| 12 | dept_member UPDATE own-dept output | success (members CAN update — contrast G4) |
| 13 | agent/read_only UPDATE | 42501 |
| 14 | cross-dept UPDATE (non-admin) | 0 rows (USING fails) |
| 15 | UPDATE `status='delivered'` **without** `delivered_at` | 23514 (DB) |
| 16 | UPDATE `status='delivered'` **with** `delivered_at` (no approval) | **DB allows** — proves the gate is NOT DB-enforced (app must block) |
| 17 | Create output-approval: subject=output, cat a, pending, dept-matched | success |
| 18 | Create output-approval with `o.department_id ≠ approvals.department_id` | 42501 (017 subject sub-check) |
| 19 | Create output-approval `category='c'` | 42501 (017 restricts to a/b) |
| 20 | **agent INSERT output-approval** | 42501 (agents excluded) |
| 21 | dept_member resolve output-approval (`pending→approved`) | 42501 (only org_admin/dept_lead resolve) |
| 22 | dept_lead-in-dept resolve output-approval | success, `decided_at` set |
| 23 | agent SELECT of a `work_packet` approval | 0 rows (no agent WP branch) — sanity vs output branch |
| 24 | `output_research_assets` insert by dept_member, own-dept output + org asset | success |
| 25 | `output_research_assets` insert by agent | 42501 |
| 26 | duplicate `(output_id, research_asset_id)` link | 23505 |
| 27 | agent SELECT citations of assigned-task output | rows (read via parent output) |
| 28 | `knowledge_records` insert subject=output by agent on assigned task | success (agents CAN emit knowledge) |
| 29 | `knowledge_records` insert subject=output cross-dept (non-admin) | 42501 |
| 30 | research_asset visible to dept via its output link | row appears (016 output branch) |
| 31 | soft-delete output (set `deleted_at`) by dept_member | success; row then invisible to all |
| 32 | confirm `outputs` absent from realtime publication | `pg_publication_tables` has no `outputs` row |

**Distinguishing assertions:** #16 (delivery gate is app-only, not DB), #6/#20 (agent excluded from output and approval insert), #12 vs G4 (members can update outputs), #21 (member cannot resolve delivery), #28 (agent can emit output knowledge), #32 (no realtime).

---

## 29. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **Delivery gate bypass.** The DB writes `status='delivered'` with no approval; a missing/incorrect application check = unapproved external release. | **High** | Single chokepoint in `output.deliver` (§13); mandatory approved-row lookup; integration test #16; audit `output_delivery` always carries the approval `id`. |
| 2 | **Content-approval ≠ delivery authorization.** Treating `approved` as a license to deliver collapses Category A. | High | §22 boundary discipline; `output.deliver` checks the `approvals` row, not the output status alone. |
| 3 | **Reviewer-authority erosion.** RLS lets any of the three writers set `approved`; without Layer-4 narrowing a member self-approves content. | Medium | App-enforce reviewer role per `approval-rules.md` output-type table; log reviewer identity. |
| 4 | **Department drift.** `department_id` is direct with no FK to the task's dept; an app bug could set it inconsistently. | Medium | RLS task-alignment EXSTS blocks the obvious cases; app sets `department_id` from the parent task, never from client input. |
| 5 | **Editing a delivered output.** In-place edits rewrite a historical external fact. | Medium | Forbid edits/soft-delete on `delivered`; require `supersede` + new version (§14). |
| 6 | **Member soft-delete latitude.** Unlike tasks (admin-only delete), members can soft-delete outputs. | Low–Med | App may narrow soft-delete of reviewed/delivered outputs to leads; audit every soft-delete. |
| 7 | **Realtime assumption.** `outputs` is not published; a UI expecting push updates silently polls or stalls. | Low | §21 states no `outputs` subscription; see `docs/phase-g-realtime-publication-plan.md`. |
| 8 | **Agent knowledge write surprise.** Agents *can* write `knowledge_records` about assigned-task outputs (but not the output). | Low | Documented (§20); acceptable by design; validate `source`/content. |

---

## 30. Dependencies

- **Deployed schema:** `014_knowledge_output_layer.sql` (outputs, output_research_assets, knowledge_records), `016_phase_e_rls_policies.sql` (outputs/junction/knowledge policies), `017_phase_e_approvals_adjustment.sql` (approvals output subject support).
- **Spine:** G1 Auth Context Spine — the five `private.*` context functions; this API derives all identity through them.
- **Sibling APIs:** Task API (G3) — outputs pin to tasks; completion gate interplay. Approval API (G5) — the delivery gate's request/resolve mechanics. Work Packet API (G4) — sibling subject; agent-approval clarification consistency. Research Asset API (own plan) and Knowledge Record API (own plan) — link/emit targets.
- **Runtime:** `018_runtime_hardening.sql` / `020_phase_f_rls_policies.sql` — `background_jobs` (`output_delivery` type), agent job visibility via `related_task_id`.
- **Governance source:** `docs/approval-rules.md` — Category A delivery rules, output review path, reviewer roles.
- **Open environmental gap:** realtime publication is empty (`docs/phase-g-realtime-publication-plan.md`); does not block this API.

---

## 31. MVP Build Order

1. **Read path** — `output.get`/`list` over `outputs_select_department_scope`; verify the five-role visibility matrix (tests 1–4).
2. **Create** — `output.create` with task/project/department alignment and author self-pin (tests 5–11).
3. **Edit** — `output.update` field edits with the WITH CHECK re-validation (tests 12–14).
4. **Review machine (ungated)** — `submit_for_review`, `approve_content` (with Layer-4 reviewer narrowing), `revise`, `reject`. Establishes the `draft→in_review→approved` path.
5. **Delivery gate (the keystone)** — wire `request_delivery_approval` + the `output.deliver` Category A check against `approvals`. Tests 15–22 — **the single most important step**; #16 proves the gate is application-owned.
6. **Supersession & soft-delete** — `supersede`, `soft_delete`, with delivered-output protections (tests 31).
7. **Citations** — `link_research_asset` over the junction (tests 24–27, 30).
8. **Knowledge emission** — `emit_knowledge` with `subject_type='output'` (tests 28–29).
9. **Runtime egress** — connect `output.deliver` to the `output_delivery` background job; never egress inline (§21).
10. **Realtime stance** — confirm `outputs` is not published (test 32); expose state via request/response only.

---

## 32. Definition of Done

- All 14 operations (§23) implemented against the deployed `outputs` RLS, with **no** RLS, schema, or migration changes.
- The §28 matrix passes under the `BEGIN…ROLLBACK` harness — including the distinguishing assertions (#16 delivery gate app-only, #6/#20 agent exclusion, #12 member update, #21 member cannot resolve, #28 agent knowledge, #32 no realtime).
- `output.deliver` **provably refuses** to set `delivered` without an approved Category A `approvals` row, and **always** sets `delivered_at` in the same write (DB check never trips in normal flow).
- DB-enforced vs application-enforced controls are documented and tested as separate layers (§24, §27); no governance semantic relies on a constraint the database does not actually make.
- External delivery emits both `execution_logs` (`output_delivery`) and an `audit_events` row, each carrying the resolving approval `id`.
- The plan's claims remain consistent with G3/G4/G5 (agent approval-request model, gate-vs-record discipline) and with `approval-rules.md` (Category A delivery, output review path, reviewer roles).
- Realtime is treated as out-of-scope for `outputs` and cross-referenced to the realtime publication plan.
