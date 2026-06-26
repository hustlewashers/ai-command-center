# Phase G2 — Request Intake API Plan

Architecture for the **Request Intake API** — the entry point through which all inbound intent enters the AI Command Center and becomes governed work.

> **Auth/context contract:** [phase-g1-auth-context-spine.md](phase-g1-auth-context-spine.md)
> **API layer plan:** [phase-g-api-application-layer-plan.md](phase-g-api-application-layer-plan.md)
> **Canonical entity:** [system-entities.md](system-entities.md) §1 Request
> **Approval gates:** [approval-rules.md](approval-rules.md)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)
> **Schema origin:** `supabase/migrations/007_execution_layer.sql` (table), `009_phase_c_rls_policies.sql` (RLS)

This document is **architecture only**. No code, routes, Edge Functions, migrations, schema changes, or frontend. It describes how the API exposes the already-deployed `requests` substrate (migrations `001`–`020`) under the verified auth/context spine.

## Grounding Facts (from the deployed schema)

- **Table:** `public.requests` — `id`, `organization_id`, `source`, `intent`, `submitted_at`, `submitted_by_user_id`, `routed_department_id`, `project_id`, `metadata`, `status`, `created_at`, `updated_at`, `deleted_at`.
- **`source` ∈** `{human, automation, webhook, scheduled_job}`.
- **`status` ∈** `{received, triaged, in_progress, completed, rejected, cancelled}`; default `received`.
- **RLS (009):** SELECT is **org-wide** for any authenticated org member (not department-scoped — intake may begin unrouted). INSERT requires `status='received'`, `submitted_by_user_id` null-or-self, role ∈ `{org_admin, department_lead, department_member, agent}` (**`read_only` excluded**). UPDATE allowed for org_admin, routed-department lead/member, or the original submitter while status ∈ `{received, triaged, in_progress}`.
- **No authenticated DELETE.** Soft-delete only, via `deleted_at`.
- Requests **spawn** `tasks` (via `tasks.request_id`), may anchor a `project_id`, and may be the subject of `knowledge_records` (`subject_type='request'`).

---

## 1. Purpose

The Request Intake API turns raw inbound intent — from humans, automations, inbound webhooks, and scheduled jobs — into a governed `requests` row that can be triaged, routed, and decomposed into work. It is the single front door: every downstream Task, Work Packet, Decision, Output, and Knowledge Record traces back to a Request.

Its discipline is the spine's discipline: authenticate the caller, derive organization/department/role from the JWT via `private.*`, and let RLS enforce. The API adds intake validation, triage/routing orchestration, and the bridge to Task creation — never a second authorization system.

---

## 2. Scope

**In scope:** create/read/update/route/assign/triage/close requests; the orchestration bridges from a request to Task, Work Packet, Decision, Output, and Knowledge Record; inbound intake from non-user sources (webhook/scheduled) via the service-role boundary.

**Out of scope:** the internals of Task/Work Packet/Approval/Output/Knowledge APIs (defined in their own Phase G sub-plans); schema changes; new roles; any RLS modification. This plan consumes the existing `requests` RLS exactly as deployed.

---

## 3. Design Principles

| # | Principle | Consequence |
|---|---|---|
| 1 | **Requests are org-wide intake** | Unlike most entities, request SELECT is organization-scoped, not department-scoped — intake exists before routing. Visibility logic honors this exactly (§7). |
| 2 | **Intake is low-friction, triage is governed** | Creation is permissive (any non-`read_only` member, agents included); routing and closure carry the authorization weight. |
| 3 | **Scope derived, never asserted** | `organization_id` is always `private.current_organization_id()`; never client-supplied. `submitted_by_user_id` is self-or-null. |
| 4 | **Status starts at `received`** | The DB enforces `status='received'` on INSERT; the API never accepts a different initial state. |
| 5 | **Non-user intake is sealed** | Webhook/scheduled intake runs service-role (no JWT), pins the tenant explicitly, and records `source` truthfully (§24). |
| 6 | **Intake itself is Category C** | Creating a request requires no approval; gates attach downstream at task/output actions (§13). |
| 7 | **Soft-delete only** | No hard delete on the authenticated path; cancellation/rejection are status transitions, not deletions. |

---

## 4. Request Lifecycle

```text
   inbound intent (human / automation / webhook / scheduled_job)
            │
            ▼
   create  ──►  status = 'received'        (org-wide visible; unrouted)
            │
   triage   ──►  status = 'triaged'        (routed_department_id / project_id set)
            │
   work starts ─►  status = 'in_progress'  (spawns tasks; tasks.request_id set)
            │
     ┌──────┼─────────────┐
     ▼      ▼             ▼
 completed  rejected   cancelled           (terminal)
```

The lifecycle is intake → triage → execution → closure. Tasks, work packets, and outputs are produced *during* `in_progress`; the request status reflects the intake's own state, not the child work's state.

---

## 5. Request States

| Status | Meaning | Entry condition | Typical actor |
|---|---|---|---|
| `received` | Logged, not yet triaged | INSERT default (enforced) | any non-`read_only` member, agent, or service-role intake |
| `triaged` | Routed to department/project | routing applied | triage role / routed-dept lead / org_admin |
| `in_progress` | Active work started | first task spawned / work begun | routed dept / org_admin |
| `completed` | Fulfilled or closed | work done | routed dept / org_admin |
| `rejected` | Declined (out of scope/invalid/duplicate) | triage decision | triage role / org_admin |
| `cancelled` | Withdrawn before completion | requester or admin cancels | submitter (early states) / org_admin |

Transition legality is application-enforced (Layer 4); RLS governs *who may write the row*, not *which transition is valid*. The API rejects illegal transitions with `conflict` (§21).

---

## 6. Request Ownership Model

- **Submitter:** `submitted_by_user_id` — the actor who created the request (self-pinned on INSERT, or null for system/service-role intake). The submitter retains update rights while status ∈ `{received, triaged, in_progress}` (e.g., to add context or cancel).
- **Routing owner:** once `routed_department_id` is set, the routed department (its lead/members) owns triage-forward progression.
- **Organization:** the hard boundary; every request belongs to exactly one `organization_id`, never cross-org.
- **Admin:** `org_admin` owns all requests org-wide.
- **No department ownership before routing:** an unrouted request has no department owner — only the submitter and org_admin may act on it until it is routed.

---

## 7. Request Visibility Model

**Authoritative rule (from `009`):** request SELECT is **organization-wide** — any authenticated, active org member sees all non-deleted requests in their organization, regardless of department or routing.

| Role | Sees |
|---|---|
| org_admin | all org requests |
| department_lead | all org requests (org-wide SELECT) |
| department_member | all org requests (org-wide SELECT) |
| read_only | all org requests (org-wide SELECT; read only) |
| agent | all org requests (org-wide SELECT) |
| null context | none |

> **Design note:** this is intentionally broader than the department-scoped visibility of `tasks`/`work_packets`. Intake must be visible org-wide so unrouted requests can be triaged by whoever is responsible. The API must **not** narrow request reads to department scope — doing so would hide unrouted intake. Any future need to restrict request visibility is an RLS change, not an application filter. (Per the spine, the API may only narrow where RLS already narrows; here RLS is deliberately org-wide and the API mirrors it.)

---

## 8. Request Creation Contract

- **Purpose:** create a new intake record at `status='received'`.
- **Inputs:** `source` (∈ enum), `intent` (non-empty), optional `project_id`, optional `routed_department_id` (pre-routed intake), optional `metadata`. `organization_id` derived from JWT; `submitted_by_user_id` self-or-null; `status` forced to `received`.
- **Outputs:** created request `id`, status `received`, timestamps.
- **Auth requirements:** authenticated, role ∈ `{org_admin, department_lead, department_member, agent}`. **`read_only` cannot create.** Non-user intake (webhook/scheduled) uses the service-role path (§24).
- **RLS expectations:** `requests_insert_org_members` — org pin, role check, `status='received'`, submitter self-or-null, routed department (if set) org-local and live, project (if set) org-local.
- **Failure modes:** `read_only` attempt → `forbidden`; non-`received` status → `validation`/RLS reject; empty `intent` → `validation` (DB check); foreign `project_id`/`routed_department_id` → RLS reject; cross-org `organization_id` → impossible (derived).
- **Audit requirements:** `execution_logs` (`context_type='request'`, `event_type='state_change'`, summary "request received"); `source` recorded; for service-role intake, the resolved tenant and `source` captured.
- **Approval requirements:** none (Category C).

---

## 9. Request Update Contract

- **Purpose:** amend a request's `intent`, `metadata`, `project_id`, or status within permitted bounds.
- **Inputs:** request `id`; mutable fields; new `status` (legal transition only).
- **Outputs:** updated request row.
- **Auth requirements:** authenticated; one of: org_admin (any), routed-department lead/member (`routed_department_id = current_department_id()`), or the original submitter while status ∈ `{received, triaged, in_progress}`.
- **RLS expectations:** `requests_update_triage_and_admin` USING + WITH CHECK — org pin; the three permitted-actor branches; `read_only` excluded; agents only via the submitter branch (if they submitted).
- **Failure modes:** non-permitted actor → row invisible to UPDATE → `not_found`/0 rows; submitter editing after `in_progress` terminal-ward → blocked by USING; illegal status transition → `conflict` (app); changing `organization_id` → rejected by WITH CHECK.
- **Audit requirements:** `execution_logs` `state_change` with old/new status in metadata.
- **Approval requirements:** none for the request row itself; downstream gated actions are separate.

---

## 10. Request Assignment Contract

- **Purpose:** associate a request with an owning department and/or project (the "who will handle this" step), distinct from status triage.
- **Inputs:** request `id`, `routed_department_id` (target dept) and/or `project_id`.
- **Outputs:** updated request with routing fields set.
- **Auth requirements:** triage authority — org_admin, or a department_lead/member acting within the routed department; submitter may set an initial routing suggestion while early-state.
- **RLS expectations:** same UPDATE policy as §9; the target `routed_department_id` must be org-local and live (mirrors INSERT validation; enforced in app + WITH CHECK).
- **Failure modes:** routing to a foreign-org department → reject; non-triage actor → `not_found`/0 rows; routing a closed request → `conflict`.
- **Audit requirements:** `execution_logs` `state_change` noting routing target; optionally an `audit_events` `admin` entry when org_admin re-routes.
- **Approval requirements:** none.

---

## 11. Request Routing Contract

- **Purpose:** the triage transition `received → triaged`, binding the request to its handling department/project and making it actionable.
- **Inputs:** request `id`, `routed_department_id` (required to triage), optional `project_id`, status → `triaged`.
- **Outputs:** request at `triaged` with routing set.
- **Auth requirements:** org_admin or routed-department lead/member; per [department-map.md] Operations typically owns first-line triage, but RLS authorizes by routed-department match + org_admin.
- **RLS expectations:** UPDATE policy (§9). Because SELECT is org-wide, any member can *see* an unrouted request, but only org_admin or the (about-to-be) routed department's members — or the submitter — can write the routing. The API resolves the routing actor and lets RLS confirm.
- **Failure modes:** triaging without a valid `routed_department_id` → `validation`; non-authorized actor → `not_found`/0 rows; re-routing a terminal request → `conflict`.
- **Audit requirements:** `execution_logs` `state_change` `received→triaged` + routing target.
- **Approval requirements:** none for routing; if routing implies a Category A action downstream (e.g., a scheduled-automation request), that gate attaches at task creation (§13).

---

## 12. Request Closure Contract

- **Purpose:** move a request to a terminal state — `completed`, `rejected`, or `cancelled`.
- **Inputs:** request `id`, terminal status, optional `metadata` (reason).
- **Outputs:** request at terminal status.
- **Auth requirements:** `completed`/`rejected` — org_admin or routed-department lead/member; `cancelled` — the submitter (early states) or org_admin.
- **RLS expectations:** UPDATE policy (§9); submitter's cancel right is bounded to status ∈ `{received, triaged, in_progress}` by the USING clause.
- **Failure modes:** closing an already-terminal request → `conflict`; submitter cancelling post-terminal → blocked by USING; non-owner completing → `not_found`/0 rows.
- **Audit requirements:** `execution_logs` `state_change` with terminal status and reason; no hard delete.
- **Approval requirements:** none to close the request; outstanding child approvals are resolved on their own subjects.

---

## 13. Approval Gate Interactions

Per [approval-rules.md](approval-rules.md), **request intake and triage are Category C (autonomous, log-only)** — creating, routing, and closing a request never requires approval. Approval gates attach to the **work the request spawns**, not the request:

| Downstream action | Category | Where the gate lives |
|---|---|---|
| Start a work packet that requires approval-before-start | B | Work Packet API |
| External output delivery / email send the request asks for | A | Output API |
| Create scheduled automation a request requests | A | Runtime Ops / Schedule API |
| Commit/deploy/destructive action implied by the request | A | Task / Agent runtime |

The Request Intake API's responsibility is to **carry context** (the request's `intent`/`metadata`) into the spawned Task/Work Packet so the correct gate is evaluated there — it does not itself evaluate Category A/B gates.

---

## 14. Request ↔ Task Creation Flow

- **Relationship:** a request spawns zero or more tasks; each task references its origin via `tasks.request_id` (FK, on delete set null).
- **Flow:** on `triaged`/`in_progress`, the API (or an authorized user) creates tasks in the routed department, stamping `request_id` and inheriting `project_id`. Task creation runs under the **Task API** and its RLS — the Request API supplies context, the Task policy authorizes the write.
- **Auth/RLS:** task INSERT is department-scoped (Phase C); the creating actor must have task-write rights in the routed department. The request being org-wide-visible does not grant task-write rights — those are department-scoped.
- **Audit:** `execution_logs` on both the request (`state_change` → `in_progress`) and the task (`state_change` "task created from request").
- **Approval:** none to spawn the task; the task's first privileged transition carries any Category A/B gate.

---

## 15. Request ↔ Work Packet Flow

- **Relationship:** a request's intent is specified into one or more `work_packets` (attached to a task or project via polymorphic `parent_type`+`parent_id`).
- **Flow:** during `in_progress`, a work packet is authored in the routed department to specify the request's deliverable; it links to the spawned task (`parent_type='task'`) or the anchoring project.
- **Auth/RLS:** work packet authoring is department-scoped (Phase C) and runs under the Work Packet API; the Request API only passes intent/context.
- **Audit:** `execution_logs` linking the work packet to the originating request via metadata.
- **Approval:** Category B if `approval_required_before_start=true` — evaluated by the Work Packet API, not here.

---

## 16. Request ↔ Decision Flow

- **Relationship:** decisions are recorded against tasks (`decisions.task_id`), not directly against requests; a request's triage rationale or scope decision is captured on the spawned task's decision trail.
- **Flow:** when triage involves a material choice (route here vs there, reject as duplicate, accept partial scope), the rationale is recorded as a `decision` on the request's task once spawned, or noted in the request `metadata` + `execution_logs` if pre-task.
- **Auth/RLS:** decision INSERT is department-scoped via the parent task (Phase D); agents may insert `proposed` decisions on assigned tasks.
- **Audit:** `execution_logs` `state_change`/`note`; high-risk decisions route to `pending_approval`.
- **Approval:** a triage decision that commits to a high-risk path (e.g., overriding a `won_t_fix`, external vendor commitment) follows the Decision↔Approval rules — handled by the Decision API.

---

## 17. Request ↔ Output Flow

- **Relationship:** outputs are produced by tasks (`outputs.task_id`) spawned from the request; the request is fulfilled when its outputs are delivered/accepted.
- **Flow:** the request reaches `completed` when the deliverable Output(s) reach `delivered`/`approved` per the request's intent.
- **Auth/RLS:** output create/deliver is department-scoped via direct `outputs.department_id` (Phase E `016`); delivery approval is app-enforced.
- **Audit:** `execution_logs` linking output delivery back to the request; request closure references the fulfilling output.
- **Approval:** **Category A** for external delivery — enforced by the Output API before `delivered`; the request cannot be marked `completed` on the basis of an undelivered/ungated output.

---

## 18. Request ↔ Knowledge Flow

- **Relationship:** a request may be the subject of `knowledge_records` (`subject_type='request'`) — curated context, triage lessons, or synthesis tied to the intake.
- **Flow:** agents/users attach knowledge records scoped to the request for continuity (e.g., "this requester's recurring ask," "standard routing for this intent class").
- **Auth/RLS:** knowledge record subject-scope policies (Phase E `016`); for `subject_type='request'`, visibility follows the routed department (and org_admin), with agents limited to assigned-task context that references the request.
- **Audit:** knowledge creation logged; `source` recorded on the record.
- **Approval:** none (Category C curation).

---

## 19. API Operations Catalog

Each operation uses the 8-field template: Purpose · Inputs · Outputs · Auth · RLS · Failure modes · Audit · Approval. `organization_id` is always JWT-derived and omitted from inputs.

### 19.1 `request.create`
- **Purpose:** intake a new request at `received`.
- **Inputs:** `source`, `intent`, optional `project_id`, `routed_department_id`, `metadata`.
- **Outputs:** request `id`, `status='received'`.
- **Auth:** org_admin / department_lead / department_member / agent (not read_only).
- **RLS:** `requests_insert_org_members` (status=received, submitter self-or-null, refs org-local).
- **Failure modes:** read_only → forbidden; bad enum/empty intent → validation; foreign refs → reject.
- **Audit:** `execution_logs` request `state_change` "received".
- **Approval:** none.

### 19.2 `request.get` / `request.list`
- **Purpose:** read a request / list org requests with filters (status, source, routed dept, submitter, date).
- **Inputs:** `id` (get); filter params (list).
- **Outputs:** request row(s).
- **Auth:** any authenticated active org member (incl. read_only, agent).
- **RLS:** `requests_select_org_members` (org-wide).
- **Failure modes:** out-of-org/deleted → not_found (invisible); null context → not_found.
- **Audit:** read-only; no log required (optional access metric).
- **Approval:** none.

### 19.3 `request.update`
- **Purpose:** amend intent/metadata/project/status within bounds.
- **Inputs:** `id`, mutable fields, legal `status`.
- **Outputs:** updated row.
- **Auth:** org_admin / routed-dept lead+member / submitter (early states).
- **RLS:** `requests_update_triage_and_admin`.
- **Failure modes:** non-permitted → not_found/0 rows; illegal transition → conflict.
- **Audit:** `state_change` with old/new.
- **Approval:** none.

### 19.4 `request.route` (triage)
- **Purpose:** `received → triaged` with `routed_department_id` (+ optional `project_id`).
- **Inputs:** `id`, `routed_department_id`, optional `project_id`.
- **Outputs:** request at `triaged`.
- **Auth:** org_admin / routed-dept lead+member / submitter suggestion.
- **RLS:** update policy; target dept org-local + live.
- **Failure modes:** missing/foreign dept → validation/reject; non-authorized → not_found/0 rows.
- **Audit:** `state_change` `received→triaged` + target.
- **Approval:** none.

### 19.5 `request.assign` (department/project association)
- **Purpose:** set/adjust `routed_department_id`/`project_id` without necessarily changing status.
- **Inputs:** `id`, routing fields.
- **Outputs:** updated routing.
- **Auth:** triage authority (§10).
- **RLS:** update policy.
- **Failure modes:** foreign refs → reject; closed request → conflict.
- **Audit:** `state_change` routing note.
- **Approval:** none.

### 19.6 `request.start` (begin work)
- **Purpose:** `triaged → in_progress`; signals work has begun (typically alongside first task spawn).
- **Inputs:** `id`, status → `in_progress`.
- **Outputs:** request at `in_progress`.
- **Auth:** org_admin / routed-dept lead+member.
- **RLS:** update policy.
- **Failure modes:** starting an unrouted/terminal request → conflict.
- **Audit:** `state_change` `triaged→in_progress`.
- **Approval:** none (downstream task actions gated separately).

### 19.7 `request.complete`
- **Purpose:** `in_progress → completed` upon fulfillment.
- **Inputs:** `id`, status → `completed`, optional fulfilling output ref in metadata.
- **Outputs:** request at `completed`.
- **Auth:** org_admin / routed-dept lead+member.
- **RLS:** update policy.
- **Failure modes:** completing with ungated/undelivered required output → conflict (app); non-owner → not_found/0 rows.
- **Audit:** `state_change` `→completed`.
- **Approval:** none on the request; the fulfilling output's Category A gate is enforced by the Output API.

### 19.8 `request.reject`
- **Purpose:** decline as out-of-scope/invalid/duplicate.
- **Inputs:** `id`, status → `rejected`, reason in metadata.
- **Outputs:** request at `rejected`.
- **Auth:** org_admin / routed-dept lead+member (triage).
- **RLS:** update policy.
- **Failure modes:** rejecting a terminal request → conflict.
- **Audit:** `state_change` `→rejected` + reason.
- **Approval:** none.

### 19.9 `request.cancel`
- **Purpose:** withdraw before completion.
- **Inputs:** `id`, status → `cancelled`, optional reason.
- **Outputs:** request at `cancelled`.
- **Auth:** submitter (status ∈ received/triaged/in_progress) or org_admin.
- **RLS:** update policy (submitter branch bounded by USING).
- **Failure modes:** submitter cancelling post-terminal → blocked (USING) → not_found/0 rows.
- **Audit:** `state_change` `→cancelled` + reason.
- **Approval:** none.

### 19.10 `request.soft_delete` (admin)
- **Purpose:** retire an erroneous/spam request via `deleted_at`.
- **Inputs:** `id`.
- **Outputs:** request hidden (`deleted_at` set).
- **Auth:** org_admin (no authenticated hard DELETE exists anywhere).
- **RLS:** modeled as an UPDATE setting `deleted_at`; admin branch of the update policy. Hard DELETE remains ungranted.
- **Failure modes:** non-admin → not_found/0 rows.
- **Audit:** `audit_events` `admin` + `execution_logs` note.
- **Approval:** none.

### 19.11 `request.spawn_task` (bridge)
- **Purpose:** create a task from a request (context bridge to Task API).
- **Inputs:** `id` (request), task fields (title, department, project).
- **Outputs:** task `id` with `request_id` set.
- **Auth:** task-write rights in the routed department (Task API RLS).
- **RLS:** Task INSERT policy (department-scoped) — **not** the request's org-wide SELECT.
- **Failure modes:** creator lacks task-write in routed dept → forbidden; cross-dept task → reject.
- **Audit:** `execution_logs` on request (`→in_progress`) and task ("created from request").
- **Approval:** none to spawn; task's privileged transitions gated downstream.

---

## 20. Validation Rules

| Rule | Enforced by |
|---|---|
| `source ∈ {human, automation, webhook, scheduled_job}` | DB check + app |
| `intent` non-empty (trimmed) | DB check + app |
| Initial `status = 'received'` | DB (INSERT WITH CHECK) + app |
| `submitted_by_user_id` null or = `current_user_id()` | DB (WITH CHECK) + app |
| `routed_department_id` org-local + live (if set) | DB (WITH CHECK) + app |
| `project_id` org-local (if set) | DB (WITH CHECK) + app |
| `organization_id` = `current_organization_id()` | DB + app (never client-supplied) |
| Legal status transition | App (Layer 4) — RLS does not encode transition legality |
| `metadata` is a JSON object | DB check + app |

---

## 21. Error Model

Per the spine §19 locked decision — unauthorized reads default to `not_found`; `forbidden` only when the actor may know the row exists but lacks permission for the attempted action.

| Class | HTTP | Request-intake trigger |
|---|---|---|
| `unauthenticated` | 401 | No JWT / null `current_user_id` (non-active/unprovisioned) |
| `forbidden` | 403 | `read_only` attempting create/update (visible-but-not-permitted action) |
| `not_found` | 404 | Out-of-org/deleted request; non-permitted actor's UPDATE matching 0 rows |
| `conflict` | 409 | Illegal status transition; closing a terminal request |
| `validation` | 422 | Bad `source`/empty `intent`/non-`received` initial status/foreign refs |
| `rate_limited` | 429 | Intake throttle (esp. webhook intake) |
| `internal` | 500 | Unexpected; async intake failures route to DLQ |

---

## 22. Audit Requirements

| Event | Surface | Fields |
|---|---|---|
| Request received | `execution_logs` | `context_type='request'`, `event_type='state_change'`, `actor`, `source` |
| Triage / routing | `execution_logs` | `state_change`, routing target, old/new status |
| Status transitions | `execution_logs` | `state_change`, old/new |
| Admin re-route / soft-delete | `audit_events` | `event_category='admin'`, `actor_user_id`, `actor_role`, `entity_type='request'`, `entity_id` |
| Webhook/scheduled intake | `execution_logs` + `audit_events` | `source`, resolved tenant, signature-verified origin |
| Spawned task linkage | `execution_logs` | task created from request, request `id` in metadata |

Service-role intake records the acting/origin identity so no intake is anonymous (spine §18).

---

## 23. Realtime Requirements

- **MVP:** requests are **not** in the verified realtime publication (`tasks`/`approvals`/`blockers`). Intake dashboards poll `request.list` initially.
- **Upgrade path:** add `requests` to the realtime publication once its org-wide SELECT policy is confirmed correct (it is). A request realtime channel would stream new intake + status changes to triage operators; because SELECT is org-wide, the channel is org-scoped (every member sees intake), which matches the intake design — confirm this is desired before enabling.
- **Rule:** as with all realtime, the channel is exactly as safe as the SELECT policy; the org-wide nature must be an intentional product choice before publishing.

---

## 24. Service Boundaries

| Path | Trust tier | Use |
|---|---|---|
| Human/agent intake & triage | `authenticated` (user/agent JWT) | RLS-bound create/read/update/route/close |
| Webhook intake | `service_role` (Edge Function) | Signature-verified; resolves tenant; inserts `source='webhook'`, `submitted_by_user_id=null` |
| Scheduled-job intake | `service_role` | Scheduler-fired; inserts `source='scheduled_job'` |
| Automation intake | `authenticated` or `service_role` | Depending on whether a mapped service identity exists |

**Rules:** the service key is server-only and never reaches a client (spine §10). Service-role intake bypasses RLS, so it **must** pin `organization_id` explicitly and verify signatures before any write. Idempotency keys prevent duplicate webhook intake.

---

## 25. Security Model

- **Tenant isolation:** every request is org-pinned; org-wide SELECT is *within one organization only* — never cross-org (verified pattern from the spine).
- **Scope injection defense:** `organization_id`/`submitted_by_user_id` are derived/self-pinned; client-supplied values are never trusted (spine §7).
- **Intake abuse:** webhook intake requires signature + idempotency; rate-limiting on the intake surface; `read_only` cannot create.
- **Privilege boundaries:** `read_only` is read-only on requests (verified — excluded from INSERT/UPDATE); agents can submit and read but triage/close is department/admin-gated.
- **Service-role sealing:** non-user intake is the only RLS-bypassing path and is confined to Edge Functions with explicit tenant pinning and origin verification.
- **No existence leakage:** out-of-scope/deleted requests resolve to `not_found` (spine §19).

---

## 26. Testing Requirements

Using the verified `BEGIN…ROLLBACK` JWT harness:

| Area | Test |
|---|---|
| Create authorization | org_admin/lead/member/agent can create; `read_only` denied |
| Initial status | INSERT with status ≠ `received` rejected |
| Submitter pin | INSERT with `submitted_by_user_id` ≠ self (and non-null) rejected |
| Org-wide visibility | every active role sees all org requests; null context sees none |
| Cross-org isolation | Org B request invisible to Org A members |
| Triage authority | routed-dept lead/member + org_admin can route; unrelated dept member cannot |
| Submitter rights | submitter can update/cancel in early states; blocked after terminal |
| Read-only enforcement | `read_only` cannot create/update/route/close |
| Foreign refs | foreign `routed_department_id`/`project_id` rejected |
| Soft-delete | admin soft-delete hides row; no authenticated hard DELETE |
| Webhook intake | signature + idempotency; tenant pinned; `source='webhook'` |
| Transition legality | illegal status transition → conflict |
| Audit emission | each transition emits the required `execution_logs`/`audit_events` |

All tests use `BEGIN…ROLLBACK`; the system of record is never mutated.

---

## 27. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Org-wide request visibility surprises implementers** expecting department scope | Medium | Documented explicitly (§7); tests assert org-wide; never narrow to dept in app. |
| 2 | **Webhook intake spoofing/replay** | High | Signature verification + idempotency before any write (§24). |
| 3 | **Service-role intake drops tenant pin** → cross-org write | High | Mandatory explicit `organization_id` + verification in Edge Function; review + tests. |
| 4 | **Transition legality only app-enforced** (RLS governs row, not transition) | Medium | Centralized transition validator; `conflict` on illegal moves; covered by tests. |
| 5 | **Request marked `completed` while required output ungated** | Medium | App rule: completion checks fulfilling output state; Output API owns the Category A gate. |
| 6 | **Submitter retains edit rights too long** | Low | USING bounds submitter writes to `{received,triaged,in_progress}`; verified by test. |
| 7 | **Realtime org-wide channel over-shares** if enabled without product sign-off | Low | Keep requests out of realtime until the org-wide stream is an intentional choice (§23). |

---

## 28. Recommended Build Order

1. **Read surface** — `request.get`/`request.list` under org-wide SELECT + the error envelope. Lowest risk, proves the spine end-to-end for this entity.
2. **Create** — `request.create` with validation (source/intent/status/submitter pins).
3. **Triage & routing** — `request.route`/`request.assign`/`request.start` with the department-authority checks.
4. **Closure** — `request.complete`/`request.reject`/`request.cancel` with transition legality.
5. **Task bridge** — `request.spawn_task` linking into the Task API.
6. **Service-role intake** — webhook/scheduled Edge Functions with signature, idempotency, tenant pinning.
7. **Audit wiring** — `execution_logs`/`audit_events` on every transition and intake.
8. **(Optional) Realtime** — add `requests` to the publication after product sign-off on org-wide streaming.

Steps 1–5 deliver the human/agent intake MVP; 6–7 complete non-user intake and auditability; 8 is an enhancement.

---

## 29. Definition of Done

- [ ] All operations (§19) resolve identity/scope only via the spine's `private.*` helpers; no client-supplied `organization_id`/`submitted_by_user_id` trusted.
- [ ] Create authorization matches RLS exactly: org_admin/lead/member/agent create; `read_only` denied; initial status forced to `received`; submitter self-pinned.
- [ ] Request reads are org-wide (not narrowed to department) and cross-org isolation holds; null context sees zero.
- [ ] Triage/routing/closure honor the routed-department + submitter + org_admin authority model; illegal transitions return `conflict`.
- [ ] No authenticated hard DELETE; retirement is soft-delete by org_admin.
- [ ] Service-role intake (webhook/scheduled) verifies origin, enforces idempotency, and pins the tenant explicitly; `source` recorded truthfully.
- [ ] Approval gates are **not** applied at intake (Category C); downstream task/output gates are deferred to their APIs with request context carried through.
- [ ] Every transition and intake emits the required `execution_logs`/`audit_events`.
- [ ] Error model follows the spine's locked `not_found`-default rule.
- [ ] The §26 test suite passes under `BEGIN…ROLLBACK`; no migrations, schema changes, or new roles introduced.

---

## Document Boundaries

This is Phase G2 **architecture output** — the Request Intake API contract. It introduces no code, routes, Edge Functions, migrations, or schema changes, and modifies no prior plan. It consumes the deployed `requests` table and its `009` RLS exactly as verified, with RLS remaining the primary authorization layer and Supabase remaining the system of record. Implementation proceeds against §28.
