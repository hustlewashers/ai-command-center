# Phase G — API & Application Layer Plan

Design for the **AI Command Center** application/API layer that sits above the verified Supabase runtime (Phases A–F, migrations `001`–`020`).

> **Canonical entities:** [system-entities.md](system-entities.md)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)
> **Approval gates:** [approval-rules.md](approval-rules.md)
> **Tool boundaries:** [tool-stack.md](tool-stack.md)
> **Execution layer:** [phase-c-execution-layer-migration-plan.md](phase-c-execution-layer-migration-plan.md)
> **Governance layer:** [phase-d-governance-layer-migration-plan.md](phase-d-governance-layer-migration-plan.md)
> **Knowledge/output layer:** [phase-e-knowledge-output-layer-migration-plan.md](phase-e-knowledge-output-layer-migration-plan.md)
> **Runtime operations:** [phase-f-runtime-hardening-plan.md](phase-f-runtime-hardening-plan.md)

This document is **planning only**. It contains no code, routes, frontend scaffolding, migrations, or implementation. It does not modify the database or any previous plan.

## Confirmed Pre-Conditions

- Phases A–F complete; migrations `001`–`020` applied to project `wbtvrzivthuqqntnorsw`.
- `supabase db lint` clean; runtime verification passed.
- Cross-department isolation verified; agent self-insert identity pin (Risk #11) verified at the database.
- The core platform database is the **system of record** and is complete and operational.

Phase G builds the access surface above this database. It does **not** re-implement the rules already enforced by RLS — it exposes them.

---

## 1. Phase G Purpose

Phase G defines the **application and API layer** that turns the verified database into a usable platform for three consumer classes:

1. **Human operators** (org_admin, department_lead, department_member, read_only) via a frontend.
2. **Agents** executing scoped work under Tool Profile boundaries.
3. **External systems** (webhooks in, deliveries out, scheduled triggers).

The layer's job is narrow and disciplined: **authenticate the caller, attach organization/department context, and let RLS do the enforcement.** It adds orchestration, validation, approval-gate sequencing, and external I/O that the database deliberately leaves to the application layer — without ever becoming a second, weaker authorization system.

### Non-Goals

- No new authorization model. RLS (migrations `005`–`020`) remains authoritative.
- No database redesign, no new core entities.
- GovCon and other domains remain implementation domains layered on top, not core platform changes.
- No premature microservice decomposition. MVP is a single API service plus the agent runtime.

---

## 2. Application Architecture Principles

| # | Principle | Consequence |
|---|---|---|
| 1 | **Supabase is the system of record** | The API holds no authoritative state; it is stateless between requests except for caches that can be rebuilt. |
| 2 | **RLS is the primary data-access guard** | Client-facing reads/writes always run as the `authenticated` role under the caller's JWT. The API never substitutes its own row filter for an RLS policy. |
| 3 | **Two explicit trust tiers** | Every endpoint is classified Client-Safe (RLS-bound) or Service-Role (RLS-bypassing). There is no implicit third tier. |
| 4 | **Service-role is server-only and minimized** | The service key never reaches a browser, agent sandbox, or log. Service-role paths are enumerated (§6) and justified per call. |
| 5 | **Approval gates are sequenced in the app, enforced in the DB where possible** | The API orchestrates the Category A/B/C flow; status-effect invariants are checked against `approvals` before privileged transitions. |
| 6 | **Least privilege for agents** | Agent capability is the intersection of its JWT role (`agent`), its assigned task scope, and its Tool Profile. |
| 7 | **Everything material is logged** | Mutations that matter produce `execution_logs` (entity scope) and/or `audit_events` (platform scope) and/or `agent_activity` (agent session). |
| 8 | **Additive, versioned, upgrade-safe** | MVP ships the fastest correct path; every surface has a documented forward path that does not require breaking changes. |

---

## 3. System Boundary

```text
┌─────────────────────────────────────────────────────────────────────┐
│  CLIENTS                                                             │
│  Human frontend (browser)   Agent runtime   External systems        │
└───────────────┬───────────────────┬────────────────────┬───────────┘
                │ user JWT           │ agent JWT          │ signed/secret
                ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE G APPLICATION / API LAYER                                     │
│                                                                     │
│  Client-Safe API  ──────── runs as `authenticated` (RLS enforced)   │
│  Service-Role API ──────── runs as `service_role` (RLS bypassed)    │
│  Agent Runtime Boundary ── tool-profile gated, self-pinned writes   │
│  External Integration ──── webhook intake, delivery, scheduling     │
└───────────────────────────────┬─────────────────────────────────────┘
                                 │ Postgres protocol / PostgREST / Edge
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SUPABASE RUNTIME (system of record) — migrations 001–020           │
│  Auth · Postgres · RLS · Realtime · Storage · Edge Functions        │
└─────────────────────────────────────────────────────────────────────┘
```

**Boundary rules:**
- Clients never connect to Postgres directly with a privileged key. Browsers use the publishable/anon key + the user's Supabase Auth JWT.
- The service-role key lives only inside the server-side API and Edge Functions.
- The agent runtime is a server-mediated client: it holds an `agent`-role JWT (or is brokered by the API), never the service key.

---

## 4. API Strategy

**MVP transport:** A thin server-side API service in front of Supabase, complemented by **PostgREST** (Supabase's auto-generated REST) for straightforward RLS-bound CRUD, and **Edge Functions** for service-role and external-facing logic.

| Surface | Mechanism (MVP) | Trust tier | Rationale |
|---|---|---|---|
| Simple entity reads/writes | PostgREST via Supabase client, user JWT | Client-Safe | RLS already encodes the rules; least code. |
| Multi-step orchestration, approval sequencing | API service endpoints | Client-Safe (user JWT) | Needs server logic but must stay RLS-bound. |
| Service-role operations (jobs, metrics, audit, DLQ insert) | Edge Functions / API workers | Service-Role | Must bypass RLS by design; server-only. |
| Webhook intake, output delivery, scheduling | Edge Functions | Service-Role | External I/O + signing/secret handling. |
| Realtime subscriptions | Supabase Realtime, user JWT | Client-Safe | RLS-filtered change feed. |

**Upgrade path:** The API service can absorb PostgREST routes later (or front them) without changing the contract; Edge Functions can migrate to dedicated workers if volume demands. Versioning (§28) keeps both stable.

---

## 5. Client-Safe API Layer

**Definition:** Every call executes under the caller's Supabase Auth JWT, resolving to the Postgres `authenticated` role. All six `private.*` helpers (`current_user_id`, `current_organization_id`, `current_department_id`, `current_role`, `current_email`, `is_org_admin`) derive context from `auth.uid()` → `public.users`. **RLS is in force on every statement.**

**Invariants:**
- The API may **narrow** access (extra validation, friendlier errors) but may never **widen** it beyond what RLS allows.
- The API must not hold or use the service key on any client-safe path.
- Organization and department scoping are **never** passed as trusted client input — they are derived server-side from the JWT via the helper functions. Client-supplied `organization_id`/`department_id` are validated against the caller's context, not trusted.
- A client-safe write that RLS rejects surfaces as a typed permission error (§23), never a silent escalation.

**Covered tables (authenticated, per grants `006`/`008`/`012`/`015`/`019`):** all Registry, Execution, Governance, Knowledge tables, plus Phase F `scheduled_tasks` (S/I/U), `background_jobs` (S/I/U), `dead_letter_queue` (S/U), `audit_events` (S), `runtime_metrics` (S), `agent_activity` (S, + agent self-INSERT).

---

## 6. Service-Role API Layer

**Definition:** Server-only calls that connect with the `service_role` key and **bypass RLS entirely.** Each is a deliberate, enumerated exception used where RLS cannot or should not apply (system writes, cross-tenant pipelines, append-only system tables with no authenticated INSERT).

**Enumerated service-role responsibilities (from Phase F write-ownership matrix):**

| Operation | Table(s) | Why service-role |
|---|---|---|
| Enqueue/transition background jobs | `background_jobs` | Job runner drives status lifecycle (`queued→processing→…`) outside any user session. |
| Insert dead-letter entries on permanent failure | `dead_letter_queue` | No authenticated INSERT exists (revoked in `019`). |
| Ingest/upsert metrics | `runtime_metrics` | Pipeline-only; no authenticated write. |
| Write platform audit + migration markers | `audit_events` | System/auth-hook origin; no authenticated INSERT. |
| Agent activity system/bypass path | `agent_activity` | Normal path is agent self-insert; bypass path is service-role. |
| Update schedule execution timestamps | `scheduled_tasks` (`last_run_at`, `next_run_at`) | Scheduler-owned fields. |
| Output delivery side-effects, webhook emit | external + `outputs`, `execution_logs` | External I/O and post-approval delivery marking. |

**Hard rules:**
- Service-role endpoints are **never** reachable by a browser or agent directly. They are internal, triggered by the API service, schedulers, or Supabase webhooks.
- Every service-role mutation must still respect **organization isolation in application logic** (it carries `organization_id` explicitly) even though the DB will not enforce it.
- Service-role calls that act "on behalf of" a user must record the acting human/agent in `audit_events.actor_user_id` / `execution_logs.actor` for traceability.

---

## 7. Auth and Session Flow

```text
1. User signs in via Supabase Auth  →  receives JWT (sub = auth.uid())
2. Frontend attaches JWT to every request (Supabase client / Authorization header)
3. Postgres sets role = authenticated; private.* helpers resolve:
     auth.uid() → public.users row (status='active', not deleted)
       → current_user_id / organization_id / department_id / current_role / email
4. RLS policies evaluate using those helpers
5. Agent sessions: agent holds an `agent`-role user mapped to auth_user_id;
   same helper resolution; writes pinned to agent_user_id = current_user_id()
```

| Concern | Decision |
|---|---|
| Identity provider | Supabase Auth (`auth.users`); `public.users.auth_user_id` is the bridge. |
| Inactive/deleted users | Helpers return null (filtered by `status='active' and deleted_at is null`) → all RLS predicates fail → deny. The API treats a null `current_user_id` as 401/403. |
| Role source | `public.users.role` is authoritative; never read role from client claims. |
| Agent identity | A dedicated `users` row with `role='agent'`, mapped to an auth identity; the runtime authenticates as that identity. |
| Session lifetime / refresh | Supabase token refresh; API is stateless and re-derives context each call. |
| Service accounts | Service-role key is not a "user"; it bypasses helpers and RLS. Used only per §6. |

---

## 8. Organization / Department Context Flow

- **Organization** is the hard tenant boundary. Every RLS policy opens with `organization_id = private.current_organization_id()`. The API never accepts an organization override from the client.
- **Department** is the default scoping unit for non-admin roles. `private.current_department_id()` drives department-scoped reads/writes.
- **org_admin** is the only org-wide role and sees/acts across all departments in its organization (never across organizations).
- **Cross-department visibility** for non-admins occurs only through explicit, RLS-encoded relationships (e.g., a job related to the caller's department's task). The API mirrors this in its read models but relies on RLS for enforcement.
- **Context derivation order:** JWT → `private.*` helpers → RLS. The API may surface the resolved context (org, dept, role) to the client for UI shaping, but treats it as advisory display data, not an authorization input.

---

## API Group Template

Sections 9–21 each define an API group using a fixed template:
**Purpose · Main operations · Required inputs · Returned outputs · Auth requirements · RLS expectations · Service-role requirements · Approval gate interactions · Failure modes · Testing requirements.**

Inputs exclude `organization_id`/`department_id` where these are derived from the JWT; they are listed only when the caller legitimately selects among permitted values (e.g., org_admin targeting a department).

---

## 9. Request Intake APIs

- **Purpose:** Capture inbound intent (`requests`, entity §1) from humans, automations, and webhooks; triage and route to a department/project.
- **Main operations:** create request; list/read requests; triage (set `routed_department_id`, `project_id`, status `received→triaged→in_progress→completed/rejected/cancelled`); link spawned tasks.
- **Required inputs:** `source` (human/automation/webhook/scheduled_job), `intent`, optional `project_id`; triage adds target department/project and new status.
- **Returned outputs:** request row(s) with status and routing; on create, the new `id`; triage returns updated row + any spawned task references.
- **Auth requirements:** authenticated. Human intake: any org member per RLS; triage: Operations/triage roles and department leads per policy. Webhook-sourced intake: §21 (service-role intake that records `source='webhook'`).
- **RLS expectations:** `requests` policies (Phase C) scope visibility to routed department + org_admin; org isolation enforced. The API never sets `organization_id` from client input.
- **Service-role requirements:** Only for webhook/automation intake where there is no authenticated user (§21). Such inserts carry explicit `organization_id` and `source`.
- **Approval gate interactions:** None at intake. Downstream actions on spawned tasks/outputs carry the gates.
- **Failure modes:** invalid source enum; routing to a foreign-org department (rejected by FK/RLS); triage by an unauthorized role (RLS deny → 403); duplicate webhook intake (idempotency key needed, §21).
- **Testing requirements:** member can create; cross-org request invisible; non-triage role cannot re-route; webhook intake lands in correct org with `source='webhook'`; status transition validity.

---

## 10. Project APIs

- **Purpose:** Manage durable work containers (`projects`, §2).
- **Main operations:** create; list/read (department-scoped); update objective/status (`draft→active→on_hold→completed→archived/cancelled`); assign `workflow_template_id`.
- **Required inputs:** `name`, `objective`, `owning_department_id` (admin may choose; lead pinned to own dept); optional `workflow_template_id`; status on update.
- **Returned outputs:** project row(s); created `id`; updated row.
- **Auth requirements:** authenticated; create/update limited to org_admin or department_lead of the owning department (per `005` projects policies pattern).
- **RLS expectations:** read where `owning_department_id = current_department_id()` or org_admin; writes validate department ownership and that referenced workflow template is org-local and `kind='template'`.
- **Service-role requirements:** None for normal use.
- **Approval gate interactions:** None directly; project-level work inherits gates at task/output level.
- **Failure modes:** lead creating for another department (deny); referencing a foreign or non-template workflow (check fails); illegal status transition.
- **Testing requirements:** lead limited to own department; admin cross-department within org; cross-org denial; workflow-template validation.

---

## 11. Task APIs

- **Purpose:** Manage the atomic unit of work (`tasks`, §4) — the hub entity most agents and members operate on.
- **Main operations:** create; list/read; update (assignment, priority, status `backlog→ready→in_progress→blocked→in_review→done/cancelled`); attach work packet/workflow/tool profile; link request.
- **Required inputs:** `title`, `project_id`, `department_id` (pinned for non-admins), `priority`; optional `request_id`, `work_packet_id`, `workflow_id`, `tool_profile_id`, `assigned_to_user_id`.
- **Returned outputs:** task row(s); created `id`; updated row; related counts (outputs, blockers) for UI.
- **Auth requirements:** authenticated. Create/update within department for lead/member; org_admin org-wide; agents update only assigned tasks (status/decisions/logs) per Phase C agent policies.
- **RLS expectations:** department-scoped read/write; agent access keyed to `assigned_to_user_id = current_user_id()`. The status transition into `in_review`/`blocked` interacts with approvals/blockers but RLS governs row access, not transition legality (app-enforced).
- **Service-role requirements:** None for human/agent flows; the job runner may update task-linked state via service-role during background execution (carries org explicitly).
- **Approval gate interactions:** Category B — moving a task whose work packet requires approval-before-start, or whose action is Category A (external comms, deploys), must verify an `approved` approval before the privileged transition. The Task API orchestrates this check against the Approval API (§13).
- **Failure modes:** assigning across departments (deny); agent acting on unassigned task (deny); illegal transition; privileged transition without an approved approval (app gate → 409/403).
- **Testing requirements:** Dept A member cannot see Dept B task (re-confirm cross-department isolation); agent confined to assigned tasks; approval-gated transition blocked without approval; cross-org denial.

---

## 12. Work Packet APIs

- **Purpose:** Author and manage structured work specs (`work_packets`, §5), the handoff artifact between requester and executor.
- **Main operations:** create/update (`draft→ready→pending_approval→in_execution→accepted/superseded/cancelled`); attach to task/project (polymorphic `parent_type`+`parent_id`); link research assets; decompose into tasks.
- **Required inputs:** `title`, `objective`, `scope`, `acceptance_criteria`, `parent_type`, `parent_id`, `priority`, `approval_required_before_start` flag, optional `constraints`.
- **Returned outputs:** work packet row(s); created `id`; updated row; linked research-asset list.
- **Auth requirements:** authenticated; department-scoped create/update for lead/member; org_admin org-wide.
- **RLS expectations:** `work_packets` department-scoped policies (Phase C); polymorphic parent must be org-local and visible to caller.
- **Service-role requirements:** None.
- **Approval gate interactions:** Category B — when `approval_required_before_start = true`, the API must block transition to `in_execution` until an `approved` approval exists (mirrors approval-rules Work Packet gates). Status `pending_approval` is set when a gate is active.
- **Failure modes:** parent in another department/org (deny); moving to `in_execution` while gate unmet (app gate → 409); attaching a foreign research asset (check fails).
- **Testing requirements:** gate blocks execution without approval; department scoping; polymorphic parent co-tenancy; superseded packets read-only to writers.

---

## 13. Approval APIs

- **Purpose:** Manage authorization gates (`approvals`, §7) per [approval-rules.md](approval-rules.md) Categories A/B/C.
- **Main operations:** request approval (create `pending` for a `decision`/`task`/`work_packet`/`output`); approve; reject; withdraw; expire (timeout); list pending-for-me.
- **Required inputs:** `subject_type`, `subject_id`, `requested_by` (self), target `approver_role`; resolution adds `status`, `resolution_note`, `approver_user_id`.
- **Returned outputs:** approval row(s); created `id`; resolution result with new status and effect on subject.
- **Auth requirements:** authenticated. Requester: actor linked to the subject. Approver: the designated role (department_lead / platform/engineering/operations lead mapped to roles) per approval-rules; only the approver transitions `pending→approved/rejected`. (Phase E `017` adjusted approvals for the `output` subject branch.)
- **RLS expectations:** subject visibility governs approval visibility; org isolation; approver-scoped update. The API enforces approver-role correctness on top of RLS row access.
- **Service-role requirements:** Timeout/expiry sweep (`pending→expired` after 48h) is a scheduled service-role job; it also emits the escalation `audit_events` row and may raise a `blocker`.
- **Approval gate interactions:** This is the gate. Other API groups call here to verify an `approved` status before privileged transitions. Status effects (subject frozen/proceed/return) per approval-rules table are applied by the orchestrating group, not mutated here.
- **Failure modes:** non-approver attempting resolution (deny); resolving an already-terminal approval (409); approving across org (deny); expiry race with manual approval (idempotent resolution).
- **Testing requirements:** only designated approver can approve; Category A subject cannot proceed without `approved`; expiry sweep transitions and escalates; withdrawn restores subject; cross-org denial.

---

## 14. Decision / Blocker APIs

- **Purpose:** Record reasoning (`decisions`, §6) and impediments (`blockers`, §13).
- **Main operations:** Decisions — record (`proposed`), confirm, route to `pending_approval`, mark `approved/rejected/superseded`. Blockers — raise (`open`), investigate, mark `pending_external`, resolve, `won_t_fix`; link supporting research assets; attach to task/work_packet/project.
- **Required inputs:** Decision — `task_id`, `summary`, `rationale`, `decided_by` (self/agent), status. Blocker — `blocked_entity_type`+`blocked_entity_id`, `description`, `severity`, `reported_by`, status.
- **Returned outputs:** decision/blocker row(s); created `id`; updated row; on resolve, the unblocked entity reference.
- **Auth requirements:** authenticated; department-scoped for `dept_lead`/`dept_member`/`org_admin`. **Agents cannot INSERT decisions or blockers** — the `agent` role is excluded from both `decisions_insert_task_scope` (`013`) and `blockers_insert_department_scope` (`013`) by RLS; any agent INSERT attempt returns RLS error 42501. Agents signal governance needs through `agent_activity` (e.g., `activity_type='approval_requested'` or `'decision_made'`) and `execution_logs`; authorized human roles or service-role workflows create the actual decision and blocker rows.
- **RLS expectations:** `decisions` scoped via parent task department (no direct `department_id` column — derived through `task_id → tasks.department_id`); `blockers` scoped via direct `department_id` column (NOT NULL FK RESTRICT); org isolation throughout. `dept_member` may INSERT decisions (`proposed`) but NOT UPDATE them; `dept_lead`/`org_admin` confirm and route decisions.
- **Service-role requirements:** Expiry/escalation jobs may auto-raise blockers (service-role, §13/§18); `reported_by_user_id` must reference a valid active user in these cases.
- **Approval gate interactions:** Decisions that commit to high-risk paths (vendor/spend, data retention/deletion, GovCon submission, overriding `won_t_fix`) transition to `pending_approval` and require approval before `approved` (approval-rules Decision↔Approval table). The `won_t_fix → open` (reopen) transition on a blocker requires an approved Category B decision — this gate is application-enforced with no DB backstop.
- **Failure modes:** agent attempting to INSERT a decision or blocker (RLS 42501 — DB-enforced deny, not a Layer 4 check); confirming a decision without authority (deny); blocking an entity in another department (deny); illegal transition.
- **Testing requirements:** agent INSERT decision → RLS 42501; agent INSERT blocker → RLS 42501; `dept_member` confirm path (denied); `dept_lead` confirm path (allowed); high-risk decision forced through approval; `won_t_fix → open` without approved Category B decision → `approval_required`; blocker scope by blocked entity department; cross-org denial.

---

## 15. Research Asset APIs

- **Purpose:** Capture and reuse knowledge inputs (`research_assets`, §8) and their junctions (`task_research_assets`, `work_packet_research_assets`, `output_research_assets`).
- **Main operations:** create/ingest; list/read; update status (`draft→active→stale→archived/rejected`); link/unlink to task/work_packet/output; upload binary to Storage and reference via `storage_path`.
- **Required inputs:** `title`, `asset_type`, `source`, optional `project_id`, `content_preview`/`storage_path`; junction ops require both ids.
- **Returned outputs:** asset row(s); created `id`; junction confirmation; signed Storage URL for binary access (scoped).
- **Auth requirements:** authenticated; department-scoped via project/junction; agents access assets linked to their assigned tasks (Phase E `016` patterns). Research department manages quality.
- **RLS expectations:** `research_assets` SELECT/INSERT/UPDATE department-scope policies (`016`); junctions are append-style (SELECT/INSERT only, UPDATE revoked in `015`). Storage access governed by Storage policies aligned to the same org/department scope.
- **Service-role requirements:** Bulk ingestion pipelines (e.g., `knowledge_sync` jobs) may write via service-role; Storage signed-URL minting is server-side.
- **Approval gate interactions:** None for capture (Category C — log only). External sourcing tools log `tool_call`.
- **Failure modes:** linking a foreign asset (check fails); mutating an append-only junction (no UPDATE grant); oversized/unsafe upload; stale signed URL.
- **Testing requirements:** department scope on read; junction insert co-tenancy; agent task-linked access; junction immutability; Storage scope matches row scope.

---

## 16. Output APIs

- **Purpose:** Produce and deliver deliverables (`outputs`, §9) with a review-before-delivery path.
- **Main operations:** create (`draft`); update; submit for review (`in_review`); approve (`approved`); deliver (`delivered`); supersede/reject; link research assets.
- **Required inputs:** `title`, `output_type`, `task_id`, `project_id`, `department_id` (direct FK, must match parent task's department), `content`/`storage_path`; status transitions.
- **Returned outputs:** output row(s); created `id`; delivery confirmation (`delivered_at` set) and external delivery receipt where applicable.
- **Auth requirements:** authenticated; department-scoped via direct `department_id` (`016`); agents produce outputs for assigned tasks; delivery initiated by Operations roles.
- **RLS expectations:** `outputs` department-scoped policies with direct `department_id` (no join through tasks for read). Delivery approval is **application-enforced**, not RLS-enforced (per `016`/`017` rationale).
- **Service-role requirements:** External delivery (email/webhook) executes server-side (Edge Function); `output_delivery` background job; marking `delivered_at` post-delivery may run service-role.
- **Approval gate interactions:** **Category A** — external delivery (external message/email, data export, client/GovCon submission) requires an `approved` approval before status → `delivered`. The Output API blocks delivery until the gate is satisfied (approval-rules Output gates). Internal reports are review-only (no delivery approval).
- **Failure modes:** delivering without approval (app gate → 409); `department_id` mismatch with parent task (check fails); delivering an already-superseded output; external send failure → DLQ.
- **Testing requirements:** external delivery blocked without Category A approval; department_id integrity; internal report bypasses delivery gate but logs review; delivery failure routes to dead-letter; cross-org denial.

---

## 17. Knowledge Record APIs

- **Purpose:** Curate reusable memory (`knowledge_records`, §14) and secondary links (`knowledge_record_links`) for agent continuity and org memory.
- **Main operations:** create/update (`draft→active→superseded→archived`); read by subject (`project`/`request`/`task`/`work_packet`/`decision`/`research_asset`/`output`); add secondary links; retrieve context for an agent's assigned scope.
- **Required inputs:** `subject_type`, `subject_id`, `record_type`, `title`, `summary`, `content`, `source`, `confidence`, optional `project_id`; links require `linked_entity_type`+`linked_entity_id`+`link_type`.
- **Returned outputs:** knowledge row(s); created `id`; link confirmation; agent context bundle (records scoped to assigned task/project/work_packet).
- **Auth requirements:** authenticated; access follows the referenced subject's department; agents limited to assigned-task context (`016` subject-scope policies); links must pass both parent-record and linked-target visibility.
- **RLS expectations:** polymorphic subject-scope SELECT/INSERT/UPDATE; `knowledge_record_links` SELECT/INSERT only (append-style, UPDATE revoked `015`), visibility requires both sides in scope.
- **Service-role requirements:** `knowledge_sync` jobs that synthesize records from `execution_logs` run service-role; they carry org/subject explicitly.
- **Approval gate interactions:** None (internal curation, Category C). Records that inform high-risk decisions remain advisory.
- **Failure modes:** subject in another department/org (deny); link exposing an out-of-scope target (deny); mutating a link (no UPDATE grant); agent reading records outside assigned scope.
- **Testing requirements:** subject-scope reads per role; agent confined to assigned context; link dual-side visibility; cross-org and cross-department denial.

---

## 18. Runtime Operations APIs

- **Purpose:** Operate the job/queue/schedule/failure surface (`background_jobs`, `scheduled_tasks`, `dead_letter_queue`) from Phase F.
- **Main operations:** Jobs — enqueue (admin/manual), list, cancel/retry. Schedules — create/update/pause/archive (lead/admin), list. DLQ — review, resolve (`pending_review→requeued/discarded/escalated`).
- **Required inputs:** Job — `job_type`, `payload`, optional related ids/`parent_schedule_id`, `priority`. Schedule — `name`, `job_type`, `payload_template`, exactly one of `cron_expression`/`run_at`, optional `owner_department_id`. DLQ resolution — `resolution_status`, `resolution_note`, `resolved_by_user_id` (self).
- **Returned outputs:** job/schedule/DLQ row(s); created `id`; queue position/state; resolution result.
- **Auth requirements:** authenticated. Jobs: org_admin INSERT/UPDATE only (Phase F `020`); dept roles SELECT via related-entity co-tenancy; agents SELECT jobs for their assigned task. Schedules: org_admin + department_lead (owning dept) write; member/read_only read own dept. DLQ: org_admin + department_lead resolve (dept-scoped via job chain).
- **RLS expectations:** exactly the Phase F `020` policies verified in runtime testing — including `read_only` excluded from `background_jobs`. The API does not re-grant what `020` withholds.
- **Service-role requirements:** **Primary owner.** Job runner does all lifecycle status transitions; DLQ INSERT on permanent failure; schedule `last_run_at`/`next_run_at` updates; exponential-backoff retry computation. These are service-role per §6.
- **Approval gate interactions:** Creating a scheduled automation is **Category A** (approval-rules) — the schedule-create API requires an `approved` approval. `webhook_emit`/`output_delivery` jobs targeting external systems require their own Category A approval on the subject.
- **Failure modes:** dept user attempting job INSERT (deny); invalid cron (app/DB validation); DLQ resolution by member (deny); retry storm (backoff + max_retries); schedule with both/neither cron and run_at (DB check `018`).
- **Testing requirements:** dept_lead cannot mutate jobs; DLQ resolve by lead within dept passes, member denied (re-confirm verified behavior); schedule-create gated by approval; service-role lifecycle transitions; org isolation on all three tables.

---

## 19. Agent Execution APIs

- **Purpose:** Provide the controlled surface through which agents execute scoped work and record session activity (`agent_activity`, §F), bounded by Tool Profiles ([tool-stack.md](tool-stack.md)).
- **Main operations:** start/end session; record activity (`tool_call`, `decision_made`, `knowledge_record_created`, `output_produced`, `approval_requested`, `error_raised`, `session_start/end`); request approval; read assigned context (tasks, knowledge records, research assets).
- **Required inputs:** `session_id` (app-generated), `activity_type`, `summary`, optional `task_id`/`work_packet_id`, `tool_name`, `metadata`, `status`; `agent_user_id` is **pinned to self**.
- **Returned outputs:** activity row(s); created `id`; assigned-scope context bundles; approval request handles.
- **Auth requirements:** `agent`-role JWT only. INSERT pinned by `020` policy: `current_role()='agent'` AND `agent_user_id = private.current_user_id()` (verified Risk #11). SELECT: own activity only (plus org_admin/dept oversight read).
- **RLS expectations:** `agent_activity_insert_agent_self` and `agent_activity_select_org_and_department_scope` (post-fix: `read_only` excluded). Optional `task_id`/`work_packet_id` co-tenancy/assignment validated in WITH CHECK.
- **Service-role requirements:** Bypass/system path for activity ingestion when the agent runtime is brokered server-side; still records the true `agent_user_id`. Tool-profile resolution and agent JWT minting are server-side.
- **Approval gate interactions:** The agent's capability ceiling is its Tool Profile (`command-center-brain` / `execution-worker` / `build-workshop` / `operations-external`). Any Category A/B action (external send, deploy, schedule-create, restricted tool) must route through the Approval API and block until `approved`. Tool calls outside the profile are flagged (`execution_logs.status='flagged'`).
- **Failure modes:** agent spoofing another `agent_user_id` (RLS deny — verified); activity on unassigned task (WITH CHECK deny); tool call outside profile (flagged + blocked); approval-gated action attempted autonomously (blocked).
- **Testing requirements:** self-insert pin (positive + negative, already verified); unassigned-task activity denied; tool-profile ceiling enforced; Category A action blocked without approval; org isolation.

---

## 20. Audit / Metrics APIs

- **Purpose:** Surface platform security/admin audit (`audit_events`) and observability aggregates (`runtime_metrics`) for admins and dashboards.
- **Main operations:** read audit timeline (filter by category/severity/actor/entity); read metrics time-series (by name/category/department/window). **Read-only for clients.**
- **Required inputs:** filter/window parameters; no client write inputs.
- **Returned outputs:** audit event rows (admin); metric series (admin org-wide, dept users dept-scoped + org-wide aggregates).
- **Auth requirements:** authenticated. `audit_events`: **org_admin SELECT only** (`020`). `runtime_metrics`: org_admin all; dept_lead/member/read_only dept-scoped + `department_id IS NULL` org-wide (`020`, `read_only` retained here).
- **RLS expectations:** exactly the `020` SELECT policies. No authenticated INSERT/UPDATE/DELETE exists for either table (grants `019`); the API exposes no write path.
- **Service-role requirements:** All writes. Audit emission (auth hooks, admin actions, migration markers); metrics ingestion pipeline; retention/pruning jobs. Per §6.
- **Approval gate interactions:** None (read surface). Audit captures approval decisions as records.
- **Failure modes:** non-admin reading audit (deny → 403); dept user requesting another department's metrics (filtered out); attempting a write (no policy/grant → 403); PII exposure of `ip_address` to non-admin (must remain admin-only).
- **Testing requirements:** non-admin cannot read audit; metrics dept-scope + org-wide visibility; no write path reachable; `ip_address` confined to org_admin; cross-org denial.

---

## 21. External Integration APIs

- **Purpose:** Connect the platform to the outside world — inbound webhooks/automation intake, outbound delivery (email/webhook), and scheduled triggers — mapped to `requests`, `outputs`, `background_jobs`, `scheduled_tasks`.
- **Main operations:** receive inbound webhook → create request (`source='webhook'`); emit outbound webhook/email on approved delivery; fire scheduled triggers → enqueue jobs; manage integration credentials/secrets.
- **Required inputs:** inbound — signed payload + integration identity → resolved `organization_id`, idempotency key. Outbound — subject reference, target, approved-approval reference. Scheduled — `scheduled_tasks` definition.
- **Returned outputs:** intake acknowledgement (idempotent); delivery receipt/status; job-enqueue confirmation.
- **Auth requirements:** **Not authenticated-user paths.** Inbound uses signature/secret verification, not a user JWT; runs service-role to insert intake. Outbound runs service-role (Edge Function) triggered by an approved delivery.
- **RLS expectations:** RLS does not apply (service-role). Therefore organization isolation is **application-enforced**: every inbound row is pinned to the resolved tenant; every outbound action is validated against an org-local, `approved` approval.
- **Service-role requirements:** All external I/O is service-role and server-only. Secrets/keys never leave the server. Webhook signature verification precedes any DB write.
- **Approval gate interactions:** **Category A throughout** — external email/webhook emit and external delivery require `approved` approval before the integration fires. Schedule creation is Category A. The integration layer refuses to emit without a verified approval reference.
- **Failure modes:** forged/replayed webhook (signature + idempotency reject); delivery without approval (refused); external 4xx (permanent → DLQ) vs 5xx (retryable → backoff); secret leakage (must be impossible by construction); tenant mis-resolution on intake.
- **Testing requirements:** signature verification; idempotent intake; delivery refused without Category A approval; 4xx→DLQ / 5xx→retry classification; tenant pinning on inbound; no secret in logs/responses.

---

## 22. Realtime Strategy

- **MVP scope:** Supabase Realtime on `tasks`, `approvals`, `blockers` (the data model's designated realtime publication, §7 line 688) — the entities whose status changes operators must see live.
- **Enforcement:** Realtime respects RLS — subscribers receive only changes to rows they can read. Subscriptions run under the user JWT (`authenticated`).
- **Channels (conceptual):** per-department task boards, per-user approval inbox, department blocker feed. No service-role realtime to clients.
- **Upgrade path:** Add `outputs` (delivery status) and `background_jobs` (ops dashboards) to the publication later without contract changes. Agent activity streams stay server-side (oversight dashboards via admin reads, not client realtime), to avoid leaking cross-agent data.
- **Failure modes / rules:** never broadcast a table without confirming its RLS SELECT policy is correct first (a realtime publication is only as safe as the policy behind it); no realtime on `audit_events`/`runtime_metrics` (polled admin reads instead).

---

## 23. Error Model

A single typed error envelope across all groups, mapping cleanly to RLS and gate semantics:

| Class | HTTP | Meaning | Source |
|---|---|---|---|
| `unauthenticated` | 401 | No valid JWT / null `current_user_id` | Auth |
| `forbidden` | 403 | RLS denied, or role/approver mismatch | RLS / app role check |
| `not_found` | 404 | Row not visible (RLS) or absent | RLS-as-invisibility (see note) |
| `approval_required` | 409 | Privileged transition blocked by missing `approved` approval | App gate |
| `conflict` | 409 | Illegal state transition / terminal-state mutation | App + DB constraints |
| `validation` | 422 | Bad enum/shape/constraint (e.g., cron, value_int xor value_float) | App + DB checks |
| `rate_limited` | 429 | Throttle | API |
| `internal` | 500 | Unexpected; DLQ if async | API / runtime |

**RLS-as-invisibility rule:** An RLS-filtered UPDATE affects 0 rows (verified in DLQ member-deny test). The API distinguishes "exists but forbidden" from "not visible" carefully and defaults to `not_found` for reads to avoid leaking existence across tenants/departments; writes that match nothing return `forbidden`/`not_found` consistently per group, never a silent success.

---

## 24. Permission Model

Authoritative roles (from `public.users.role`): `org_admin`, `department_lead`, `department_member`, `read_only`, `agent`. There is no other role; `org_admin` is the only org-wide role.

| Capability axis | org_admin | department_lead | department_member | read_only | agent |
|---|---|---|---|---|---|
| Scope | whole org | own department(s) | own department | own department | assigned task scope |
| Read core entities | all org | dept | dept | dept | assigned |
| Write core entities | all org | dept | dept | none | assigned (proposed/logs/outputs) |
| Approve | per role mapping | dept subjects | no | no | no (requests only) |
| Runtime jobs (`background_jobs`) | INSERT/UPDATE/SELECT | SELECT (dept) | SELECT (dept) | none | SELECT (task) |
| Schedules | full | own dept | SELECT | SELECT | none |
| DLQ resolve | yes | dept | no | no | no |
| Audit read | yes | no | no | no | no |
| Metrics read | all | dept + org-wide | dept + org-wide | dept + org-wide | none |
| Agent activity write | (oversight read) | read (dept) | read (dept) | none | self-insert only |

The API derives all of this from RLS — the table is a description of the policies, not a second enforcement point.

---

## 25. Service Boundaries

| Service (MVP) | Responsibility | Trust tier |
|---|---|---|
| **API service** | Client-safe orchestration, approval sequencing, validation, error envelope | `authenticated` (user JWT) |
| **Edge Functions** | Service-role ops, webhook intake/emit, delivery, schedule firing | `service_role` |
| **Job runner / scheduler** | `background_jobs` lifecycle, retries, DLQ insert, metrics emit | `service_role` |
| **Agent runtime broker** | Mint/relay agent JWT, enforce Tool Profile ceiling, record activity | `agent` JWT (+ service-role bypass path) |
| **Supabase** | Auth, Postgres, RLS, Realtime, Storage | system of record |

**Boundary discipline:** the API service and the agent broker must **never** import the service key path; service-role code is physically isolated in Edge Functions / the job runner. This separation is the main defense against an accidental RLS bypass.

---

## 26. Frontend Boundary Map

The frontend is a **pure client of the Client-Safe API** and Supabase publishable key + user JWT. It holds no secrets and performs no privileged action.

| Frontend surface | Backs onto |
|---|---|
| Request inbox / triage | §9 |
| Project & task boards (realtime) | §10, §11, §22 |
| Work packet authoring | §12 |
| Approval inbox (realtime) | §13 |
| Decision/blocker panels | §14 |
| Research library + uploads | §15 (+ Storage signed URLs) |
| Output review/delivery | §16 |
| Knowledge browser | §17 |
| Ops dashboards (jobs/schedules/DLQ) | §18 (admin/lead) |
| Audit & metrics dashboards | §20 (admin / dept) |

**Rules:** the frontend never sees the service key; never sets `organization_id`/`department_id` as trusted input; treats resolved context as display-only; relies on the API's typed errors for UX (e.g., showing "approval required" on a blocked delivery).

---

## 27. Agent Runtime Boundary

- Agents authenticate as a dedicated `agent`-role user; all writes self-pin `agent_user_id = current_user_id()` (DB-verified).
- The agent's effective permission is the **intersection** of: (a) `agent` RLS policies, (b) assigned task scope, (c) Tool Profile `allowed_tools`/`constraints`.
- **Approval-bound actions** (Category A/B) are never executed autonomously; the runtime calls the Approval API and waits for `approved`.
- Every tool call emits `execution_logs` (`tool_call`) and `agent_activity`; profile violations set `execution_logs.status='flagged'` and are blocked.
- The runtime holds **no service key**. A server-side broker may use the service-role bypass path for ingestion, but capability decisions are made against the agent identity, not the service role.
- GovCon and other domain tools register as additional Tool Profile entries; they inherit core approval gates and do not expand the agent's core permissions.

---

## 28. API Versioning

- **Strategy:** URI-prefixed major version (`/v1`) for the API service; Edge Functions versioned by name/route. Additive changes (new fields, new optional inputs, new endpoints) are non-breaking and do not bump the major version.
- **Database compatibility:** the API depends on the canonical entity shapes and the `020` policy behavior. Schema evolution remains additive (the migration convention); the API tolerates added columns.
- **Deprecation:** breaking changes ship behind `/v2` with an overlap window; clients migrate before `/v1` retires. Realtime channel names are versioned alongside.
- **Contract source of truth:** generated types from the database (`generate_typescript_types`) plus an API schema doc keep client and server aligned.

---

## 29. Testing Strategy

| Layer | What | How |
|---|---|---|
| **RLS conformance** | Every policy in `005`–`020` behaves per spec | Role-impersonation SQL (`set local role authenticated` + `request.jwt.claim.sub`), the verified Phase F pattern, extended to all groups |
| **Cross-tenant isolation** | No row crosses `organization_id` | Two-org fixture; assert empty cross-org reads on every table |
| **Cross-department scoping** | Dept A cannot see Dept B (re-confirm) | Dept A/B fixtures per group |
| **Approval gates** | Category A/B block privileged transitions | Attempt transition without approval → expect block; with approval → expect pass |
| **Agent identity pin** | Self-insert only (verified) | Positive + negative `agent_activity` INSERT |
| **Service-role correctness** | Bypass paths carry org explicitly; no leak to clients | Static check that service key is absent from client bundles; integration tests on Edge Functions |
| **Error envelope** | Correct class/HTTP per failure | Contract tests per group |
| **External integration** | Signature, idempotency, delivery gating, retry/DLQ | Simulated webhook + delivery harness |
| **Realtime** | Only authorized rows stream | Subscribe-as-role tests |
| **Regression** | Migrations stay green | `supabase db lint` + policy suite in CI |

Test data uses the established `BEGIN … ROLLBACK` impersonation harness so verification never mutates the system of record.

---

## 30. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Service-role key leakage** into client/agent paths → total RLS bypass | High | Physical service separation (§25); secrets only in Edge Functions/job runner; bundle scanning in CI. |
| 2 | **App-enforced gates diverge from RLS** (e.g., output delivery approval is app-only) | High | Centralize gate checks in one Approval-gate module; contract tests assert blocked transitions; consider future DB triggers for the highest-risk gates. |
| 3 | **Client supplies org/department as trusted input** → scope confusion | High | Never trust client scope; always derive from JWT helpers; validate any client-selected dept against caller context. |
| 4 | **Realtime publication outruns RLS review** → live data leak | Medium | Gate every realtime table behind a confirmed SELECT policy; start with `tasks`/`approvals`/`blockers` only. |
| 5 | **RLS-as-invisibility leaks existence** via inconsistent 403 vs 404 | Medium | Standardize the not_found/forbidden rule (§23) across groups. |
| 6 | **Nested-RLS performance** on `background_jobs`/`dead_letter_queue` reads at scale | Medium | Rely on `018` FK indexes; benchmark; cache ops-dashboard reads. |
| 7 | **Agent over-reach** via tool profile gaps | Medium | Intersection model (§27); flag + block out-of-profile calls; audit `agent_activity`. |
| 8 | **Webhook spoofing/replay** | Medium | Signature verification + idempotency keys before any write (§21). |
| 9 | **PII exposure** (`audit_events.ip_address`) to non-admins | Medium | Admin-only audit reads (`020`); never project `ip_address` to other roles. |
| 10 | **Versioning drift** between generated types and live schema | Low | Regenerate types in CI; fail on drift. |
| 11 | **GovCon creep into core** | Low | Keep domain logic in extension tables/profiles; core API stays domain-agnostic. |

---

## 31. Recommended Build Order

Fastest correct MVP path, each step independently testable, preserving clean upgrade paths:

1. **Auth + context spine** — Supabase Auth wiring, JWT→helper resolution, error envelope (§7, §23). Foundation for everything.
2. **Client-Safe read layer** — PostgREST-backed reads for tasks, projects, requests, approvals, blockers (§9–§14 read paths) + RLS conformance suite. Proves the spine end-to-end.
3. **Core write + approval gates** — task/work-packet/decision writes and the Approval API with Category A/B sequencing (§11–§14, §13). The heart of the platform.
4. **Knowledge & output** — research assets, outputs with delivery gating, knowledge records (§15–§17).
5. **Realtime** — `tasks`/`approvals`/`blockers` channels (§22).
6. **Runtime ops + service-role spine** — job runner, scheduler, DLQ, metrics/audit emission (§18, §20, §6, §25). Enables async + observability.
7. **Agent execution layer** — agent JWT broker, tool-profile ceiling, `agent_activity`, agent context reads (§19, §27).
8. **External integrations** — webhook intake/emit, delivery, scheduled triggers (§21).
9. **Audit/metrics dashboards + hardening** — admin read surfaces, performance benchmarks, CI regression (§20, §29, §30).
10. **Domain enablement (GovCon)** — extension tables/profiles on top, no core changes.

Steps 1–5 constitute a usable human MVP; 6–8 add async + agents; 9–10 harden and extend.

---

## Document Boundaries

This is Phase G **planning output**. It introduces no code, routes, migrations, or schema changes and modifies no prior plan. Implementation is scoped in subsequent phases against the build order in §31, with RLS remaining the primary data-access guard and Supabase remaining the system of record.
