# Phase G9 — Application Service Architecture

The authoritative definition of how the application and API layer is organized above the verified Supabase runtime (migrations `001`–`020`).

> **Auth spine:** [phase-g1-auth-context-spine.md](phase-g1-auth-context-spine.md)
> **API layer plan:** [phase-g-api-application-layer-plan.md](phase-g-api-application-layer-plan.md)
> **Realtime plan:** [phase-g-realtime-publication-plan.md](phase-g-realtime-publication-plan.md)
> **G2 Request Intake:** [phase-g2-request-intake-api-plan.md](phase-g2-request-intake-api-plan.md)
> **G3 Task API:** [phase-g3-task-api-plan.md](phase-g3-task-api-plan.md)
> **G4 Work Packet API:** [phase-g4-work-packet-api-plan.md](phase-g4-work-packet-api-plan.md)
> **G5 Approval API:** [phase-g5-approval-api-plan.md](phase-g5-approval-api-plan.md)
> **G6 Output API:** [phase-g6-output-api-plan.md](phase-g6-output-api-plan.md)
> **G7 Decision API:** [phase-g7-decision-api-plan.md](phase-g7-decision-api-plan.md)
> **G8 Blocker API:** [phase-g8-blocker-api-plan.md](phase-g8-blocker-api-plan.md)
> **Canonical entities:** [system-entities.md](system-entities.md)
> **Approval gates:** [approval-rules.md](approval-rules.md)
> **Tool stack:** [tool-stack.md](tool-stack.md)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)

This document is **architecture only**. It introduces no code, migrations, schema changes, or implementations. It does not redesign any existing contract established in G1–G8 or migrations `001`–`020`.

---

## 1. Purpose

This document synthesizes the complete G-phase API and application layer into a unified service architecture. Where G1–G8 define individual API contracts for specific entities, this document defines how those services are organized, how they relate to each other, where enforcement boundaries sit, and who owns what.

The document answers five questions the individual API plans do not answer in one place:

1. **Service map** — what are the services, what layer do they operate at, and which entities do they own?
2. **Trust boundaries** — who operates at the client-safe tier and who at the service-role tier, and why?
3. **Enforcement boundaries** — which rules are enforced by the DB, which by the application, and which remain human-enforced?
4. **Orchestration patterns** — how do services call each other, and which cross-service flows are prescribed?
5. **Agent model** — how do agents interact with every service, and what signals substitute for actions they cannot perform?

This document is the single reference for implementation teams building above the `020` migration baseline.

---

## 2. Scope and Non-Goals

### In scope
- How the application layer is organized above migrations `001`–`020`
- Trust tier classification of every service
- Service-to-service dependency and orchestration patterns
- DB-enforced vs application-enforced vs human-enforced boundary tables for every significant rule
- The agent signaling model across all governance entities
- Realtime deployment state and what it means for implementation
- Error model and observability contract

### Non-goals
- No new authorization model (RLS `005`–`020` is authoritative and unchanged)
- No new database entities or schema changes
- No code, routes, or frontend components
- No GovCon or other domain-specific implementation — core platform only
- No microservice decomposition decisions (MVP is a single API service + agent runtime + Edge Functions, per the API layer plan)

---

## 3. Design Principles

These principles are inherited from G1 and the API layer plan and are restated here as the binding foundation for all service decisions:

| # | Principle | Consequence |
|---|---|---|
| 1 | **Supabase is the system of record** | No service holds authoritative state; services are stateless between requests except for caches that can be rebuilt from the DB. |
| 2 | **RLS is the primary authorization layer** | Every client-facing read and write runs as `authenticated`; services never substitute their own row filter for an RLS policy. |
| 3 | **Application may only narrow, never widen** | Layer 4 (application rules) and Layer 5 (approval gates) add restrictions on top of Layers 1–3 (Auth + context + RLS); they cannot grant access that RLS denies. |
| 4 | **Two trust tiers, no implicit third** | Every endpoint is Client-Safe (RLS-bound) or Service-Role (RLS-bypassing). Mixed-tier paths are forbidden. |
| 5 | **Service-role is sealed and minimized** | The service key lives only in server-side Edge Functions and the job runner; it is never reachable by browsers, agents, or any client path. |
| 6 | **Context is derived, never asserted** | Organization, department, and role come from `private.*` helpers resolving `auth.uid()` → `public.users`. Client-supplied scope is a filter hint within the permitted set, never an authorization input. |
| 7 | **Approval gates are application-enforced** | The DB does not block every forbidden transition; the application must perform the Layer 5 check before executing privileged transitions. Gate checks are centralized, not scattered. |
| 8 | **Agents signal — they do not create governance** | Agents cannot INSERT approvals, decisions, or blockers. They signal intent through `agent_activity` and `execution_logs`; authorized humans create actual governance rows. |
| 9 | **Everything material is logged** | Mutations produce `execution_logs` (entity scope), `audit_events` (platform scope), and/or `agent_activity` (agent session). No privileged action is anonymous. |
| 10 | **Realtime reflects actual state** | The `supabase_realtime` publication exists but has zero member tables as of 2026-06-24. Realtime is documented intent, not live capability, until the frontend subscription work begins. |

---

## 4. Relationship to Completed G-Phase Plans

| Plan | What it defines | This document's relationship |
|---|---|---|
| **G1 — Auth & Context Spine** | Auth flow, `private.*` helpers, five-layer model, JWT contract, role model, agent identity, error model, audit context | G9 inherits G1 as the binding foundation; all service contracts must honor G1 §§1–25 without exception |
| **G2 — Request Intake API** | `requests` table API: create, triage, status transitions; webhook service-role intake; cross-dept read scope | G9 positions this as the Entry Point Service; notes its unusual org-wide SELECT scope |
| **G3 — Task API** | `tasks` table API: full lifecycle, agent assignment scope, cross-department isolation, approval interaction | G9 positions this as the Core Execution Hub; tasks are the pivot entity for agents and governance |
| **G4 — Work Packet API** | `work_packets` table API: authoring, decomposition, `approval_required_before_start` gate | G9 positions this as the Scoping Service; the `in_execution` gate is the canonical Category B work-item gate |
| **G5 — Approval API** | `approvals` table API: request/resolve/expire/withdraw; Category A/B/C; expiry sweep; Phase E `017` policies | G9 positions this as the Gate Service; every other service calls into it for pre-transition checks |
| **G6 — Output API** | `outputs` table API: draft→delivered lifecycle; Category A external delivery gate; direct `department_id` | G9 positions this as the Delivery Service; output delivery is the highest-stakes external action |
| **G7 — Decision API** | `decisions` table API: proposed→approved path; dept-derived (no direct `department_id`); agent exclusion from INSERT | G9 notes the department derivation contrast with outputs/blockers; reinforces agent-exclusion from decision INSERT |
| **G8 — Blocker API** | `blockers` table API: raise→resolve lifecycle; direct `department_id`; `won_t_fix` override gate; agent exclusion | G9 positions this as the Impediment Service; `won_t_fix→open` is the keystone application-only gate |
| **Realtime Plan** | Publication state, replica identity, scope-exit model, deferral recommendation | G9 adopts the plan's conclusion: realtime is documented intent, deferred until frontend subscription work begins |

---

## 5. System Architecture Overview

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  CLIENTS                                                                  │
│  Human frontend (browser)    Agent runtime    External systems            │
└──────────┬────────────────────────┬───────────────────┬──────────────────┘
           │ user JWT                │ agent JWT          │ signed/secret
           ▼                         ▼                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  G9 APPLICATION SERVICE LAYER                                             │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  CLIENT-SAFE TIER  (runs as authenticated; RLS in force)          │    │
│  │                                                                   │    │
│  │  Entry Point │ Core Execution │ Governance │ Delivery │ Runtime   │    │
│  │  Service     │ Hub            │ Services   │ Services │ Read      │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  SERVICE-ROLE TIER  (RLS bypassed; server-only; enumerated)       │    │
│  │                                                                   │    │
│  │  Job Runner │ Schedule Firer │ DLQ Writer │ Metrics │ Audit       │    │
│  │  Intake Bot │ Delivery Edge  │ Expiry Sweep                       │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │  AGENT RUNTIME BOUNDARY                                           │    │
│  │  Tool-profile gated; agent JWT only; self-pinned writes;          │    │
│  │  no service key; Category A/B actions blocked pending approval     │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ Postgres protocol / PostgREST / Edge
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  SUPABASE RUNTIME — system of record — migrations 001–020                 │
│  Auth · Postgres · RLS · Realtime (publication exists, zero tables)       │
│  Storage · Edge Functions · `private.*` helpers                           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Boundary rules:**
- Browsers use the publishable/anon key plus a user Supabase Auth JWT. They never see the service key.
- Agents hold an `agent`-role JWT (or are brokered by the API server); they never see the service key.
- Service-role code is physically isolated to Edge Functions and the job runner. No code path in the API service or agent runtime imports or derives the service key.
- External callers (webhooks in) authenticate by signature/secret, not a user JWT; the receiving Edge Function resolves the tenant and runs service-role to insert.

---

## 6. Trust Tier Model

Every operation in the application layer belongs to exactly one trust tier. There is no implicit middle tier.

| Tier | Postgres role | RLS | Who can invoke | Scope enforcement |
|---|---|---|---|---|
| **Client-Safe** | `authenticated` | **In force** | Human users (any role), agents (agent role), API service on user session | RLS policies `005`–`020` govern every read and write |
| **Service-Role** | `service_role` | **Bypassed** | API service server-side paths, Edge Functions, job runner; never browsers or agents | Application logic must explicitly carry and enforce `organization_id`; no DB backstop |

**Why two tiers and not one?** Some operations structurally cannot run as `authenticated`:
- INSERT into `dead_letter_queue` (no authenticated INSERT grant — `019` revoked it)
- INSERT into `audit_events` and `runtime_metrics` (no authenticated INSERT)
- `background_jobs` lifecycle transitions (no authenticated session exists; driven by job runner)
- External I/O (webhook emit, email delivery) — no user session is present
- Schedule firing and `last_run_at`/`next_run_at` updates — scheduler-owned

These are the only reasons to use service-role. Any operation that could run as `authenticated` must do so.

---

## 7. Client-Safe Service Map

Services that run exclusively in the Client-Safe tier. All reads and writes execute under the caller's JWT as the Postgres `authenticated` role; RLS is always in force.

| Service | G-phase plan | Primary tables | Notes |
|---|---|---|---|
| **Auth Context Service** | G1 | `users`, `organizations`, `departments` (read) | Context derivation only; exposes `private.*`-resolved values for UI display |
| **Request Intake Service** | G2 | `requests` | Unusual: SELECT is org-wide (not dept-scoped); INSERT available to all roles except `read_only`; webhook intake is service-role |
| **Task Service** | G3 | `tasks`, `execution_logs` | Core Execution Hub; pivot for agents and governance; department-scoped read/write |
| **Work Packet Service** | G4 | `work_packets`, `work_packet_research_assets` | Scoping service; `in_execution` gate requires approved approval if `approval_required_before_start` |
| **Approval Service** | G5 | `approvals` | Gate service; all other services call here pre-transition; no DELETE; no Category C INSERT |
| **Output Service** | G6 | `outputs`, `output_research_assets` | Delivery service; direct `department_id`; external delivery is Category A gated |
| **Decision Service** | G7 | `decisions` | dept_member/dept_lead/org_admin INSERT only; agents excluded; dept derived through `task_id → tasks.department_id` |
| **Blocker Service** | G8 | `blockers` | dept_member/dept_lead/org_admin INSERT and UPDATE; agents excluded; direct `department_id` |
| **Research & Knowledge Service** | G-API §15, §17 | `research_assets`, `knowledge_records`, `knowledge_record_links`, `task_research_assets` | Agents may read context scoped to assigned tasks |
| **Runtime Read Service** | G-API §18, §20 | `scheduled_tasks` (S/I/U), `background_jobs` (SELECT, dept-scoped), `dead_letter_queue` (S/U), `runtime_metrics` (SELECT), `audit_events` (admin SELECT) | Read surface for ops dashboards; no write grants for non-job-runner roles except `org_admin` on `background_jobs` |
| **Agent Execution Service** | G-API §19 | `agent_activity` (agent self-INSERT), `execution_logs` (agent INSERT on assigned scope) | Self-pin enforced by DB (`020`); Tool Profile ceiling enforced by broker |

---

## 8. Service-Role Service Map

Services and server-side functions that must run with the `service_role` key. None of these is reachable by a browser or agent. All must carry `organization_id` explicitly and record the acting identity for audit.

| Service / Function | Tables written | Trigger | Why service-role |
|---|---|---|---|
| **Job runner** | `background_jobs` (status lifecycle), `dead_letter_queue` (INSERT on failure), `runtime_metrics` (INSERT), `audit_events` | Job scheduler / queue event | No authenticated user session; DLQ has no authenticated INSERT |
| **Schedule firer** | `scheduled_tasks` (`last_run_at`, `next_run_at`), enqueues `background_jobs` | Cron expression or `run_at` | Scheduler-owned fields; no user session |
| **Approval expiry sweep** | `approvals` (`status → 'expired'`), optionally `blockers` (INSERT raised blocker), `audit_events` | Scheduled 48h check | Authenticated UPDATE cannot set `expired` (restricted by Phase E `017` WITH CHECK); blocker INSERT requires valid reporter |
| **Webhook intake bot** | `requests` (`source='webhook'`) | Inbound signed webhook | No user JWT; tenant resolved from signing key |
| **Output delivery edge** | `outputs` (`delivered_at` set), external call (email/HTTP emit), `execution_logs`, `background_jobs` | Approved delivery trigger | External I/O; no user session; post-delivery marking |
| **Automation intake bot** | `requests` (`source='automation'` or `'scheduled_job'`) | Scheduled trigger | No user session |
| **Knowledge sync job** | `knowledge_records` (synthesized from `execution_logs`) | Scheduled job | Bulk synthesis; no user session |
| **Metrics ingestion** | `runtime_metrics` | Pipeline | No authenticated INSERT grant |
| **Audit emission hook** | `audit_events` | Auth events, admin mutations, migration markers | No authenticated INSERT grant; system/auth-hook origin |

---

## 9. Service-Role Boundary Enforcement

Because `service_role` bypasses RLS, the application must supply the controls that RLS normally provides for `authenticated`:

| RLS invariant | How service-role paths replace it |
|---|---|
| `organization_id = private.current_organization_id()` | Every service-role write carries `organization_id` explicitly, derived from the triggering authenticated context or webhook integration record |
| Department scoping | Not applicable — service-role writes target specific rows by known PK; no cross-department row access occurs |
| Actor attribution | `audit_events.actor_user_id` or `execution_logs.actor` must capture the human/agent who triggered the action; no anonymous privileged action |
| Tenant isolation | Application code asserts co-tenancy before acting (e.g., expiry sweep only processes approvals from one org per invocation) |
| No bloat | Service-role operations are enumerated (§8 above); any new service-role path requires explicit justification and addition to this catalog |

**Hard rule:** a service-role function that writes on behalf of a user must record `actor_user_id`/`actor_role` in `audit_events` or `actor` in `execution_logs`. Silent privileged mutation is forbidden.

---

## 10. Five Authorization Layers

Every request passes through all applicable layers. Later layers can only narrow what earlier layers permit.

| Layer | Name | Enforced by | Cannot be overridden by |
|---|---|---|---|
| **1** | **Authentication** | Supabase Auth (JWT signature; `sub` = `auth.uid()`; Postgres `authenticated` role) | Application logic; client claims |
| **2** | **Context Resolution** | `private.*` SECURITY DEFINER helpers in `005`: `current_user_id()`, `current_organization_id()`, `current_department_id()`, `current_role()`, `current_email()`, `is_org_admin()` | Client-supplied `organization_id`/`department_id`/`role`; JWT app-claims |
| **3** | **RLS** | Policies in `005`–`020`; deny-by-default; `authenticated` role only | Application logic; the API may only narrow |
| **4** | **Application Rules** | API service endpoints; Edge Function checks; transition validators; approver-role correctness; typed error envelope | DB; Layers 1–3 |
| **5** | **Approval Gates** | Centralized gate check against `approvals.status` before privileged transitions; orchestrated by the application, backed by the `approvals` table | No DB backstop for most gates; must be application-enforced (see §37) |

A null result from any `private.*` helper (non-active user, unprovisioned user, deleted user) causes all RLS predicates to fail → the request is denied at Layer 2, even if the JWT is valid.

---

## 11. Layer 1 — Authentication

**Mechanism:** Supabase Auth signs JWTs with `sub = auth.uid()`. The Postgres session role is set to `authenticated`.

**Trusted claims:** `sub` (authentication identity), Postgres `authenticated` role, `exp`/`iat`.

**Not trusted:** any `organization_id`, `department_id`, `role`, or other business claim in the JWT payload or request body. App-metadata in the JWT is advisory display data only; it is never used as an authorization input.

**Session lifecycle:** tokens are short-lived with Supabase refresh. There is no server-side session state; every request re-derives context. Suspension or deletion of a `public.users` row takes effect on the next request regardless of token validity.

---

## 12. Layer 2 — Context Resolution

**Mechanism:** `private.*` helper functions (from `005_rls_policies.sql`), executed within the Postgres session.

```
auth.uid()  ──►  public.users (status='active', deleted_at is null)
                      │
  organization  ◄─────┤  private.current_organization_id()
  department    ◄─────┤  private.current_department_id()
  role          ◄─────┤  private.current_role()
  identity      ◄─────┘  private.current_user_id()
```

All helpers are `SECURITY DEFINER`, `STABLE`, `search_path = ''`. They filter for `status = 'active' AND deleted_at IS NULL`. A null return from any helper means "no valid active identity" → all RLS predicates fail.

**Contract (binding for all services):** `private.*` helpers are the **only** sanctioned source of caller context. No service may derive organization, department, or role by any other means.

---

## 13. Layer 3 — RLS (Authoritative)

**Mechanism:** Row-level security policies in migrations `005`–`020`, applied to the `authenticated` role. `service_role` bypasses RLS by design.

**Policy origin by migration:**

| Migration | Scope | Key additions |
|---|---|---|
| `005` | Registry (organizations, users, departments, projects, tool_profiles, workflow_templates) | `private.*` helpers defined; foundational registry policies |
| `006` | Grants — authenticated SELECT/INSERT/UPDATE/DELETE on Registry tables | — |
| `008` | Grants — Phase C tables | — |
| `009` | Phase C RLS — `requests`, `work_packets`, `tasks`, `execution_logs` | Initial execution layer policies |
| `010` | Phase C RLS adjustments | — |
| `012` | Grants — Phase D governance tables | — |
| `013` | Phase D RLS — `decisions`, `approvals` (initial), `blockers` | Governance layer policies; all three blocker policies live here and are unchanged by later migrations |
| `015` | Grants — Phase E tables; revokes UPDATE on junction tables | — |
| `016` | Phase E RLS — `research_assets`, `outputs`, `knowledge_records`, junctions | Knowledge/output layer policies |
| `017` | Phase E approvals adjustment — drops and replaces `013` approval policies | Adds `subject_type='output'` branch; restricts `expired` to service-role UPDATE; `category IN ('a','b')` WITH CHECK |
| `019` | Grants — Phase F; revokes DLQ INSERT for authenticated; no audit/metrics INSERT | — |
| `020` | Phase F RLS — `scheduled_tasks`, `background_jobs`, `dead_letter_queue`, `audit_events`, `runtime_metrics`, `agent_activity` | `read_only` excluded from `background_jobs` and `agent_activity`; agent self-insert pin |

**Deny-by-default:** RLS is enabled on every table. No authenticated query succeeds without a matching permissive policy.

**The application may only narrow.** If RLS allows a read, the API may further filter (e.g., by task assignment status) but must not present rows to a caller that RLS would deny.

---

## 14. Layer 4 — Application Rules

Layer 4 adds correctness checks that the DB cannot or should not enforce:

| Rule type | Examples |
|---|---|
| **State machine transitions** | `tasks` status: `backlog→ready→in_progress→blocked→in_review→done/cancelled`; the DB allows the UPDATE if RLS permits, but only the API validates the transition is legal |
| **Approver-role correctness** | `dept_lead` may resolve department-scoped approvals; `dept_member` may NOT resolve approvals — the `017` UPDATE policy allows `org_admin` or `dept_lead` only; Layer 4 maps the subject's role requirement |
| **Enum and shape validation** | `source ∈ {human, automation, webhook, scheduled_job}`; cron expression syntax; `value_int xor value_float` on `runtime_metrics` |
| **Polymorphic co-tenancy** | `subject_type` + `subject_id` on approvals has no DB FK; Layer 4 must verify the subject exists in the caller's org and scope |
| **Cross-entity consistency** | `outputs.department_id` must match the parent `tasks.department_id` — the DB has a direct FK on outputs but not a FK assertion against tasks; Layer 4 enforces the alignment |
| **Agent scope hints** | Optional `task_id` on `agent_activity` is validated to be an assigned task; the DB WITH CHECK performs this too, but Layer 4 can surface a better error |
| **Visibility model normalization** | `not_found` vs `forbidden` distinction per the error model (§38) |

---

## 15. Layer 5 — Approval Gates

Layer 5 gates block privileged transitions until an `approved` approval exists for the subject. The gate is checked by the **orchestrating service** immediately before the privileged write.

**Gate mechanics:**
1. Before the privileged write, the service calls the Approval Service with `subject_type` + `subject_id`.
2. The Approval Service queries `approvals` for a row where `subject_type/id` match, `status='approved'`, and `category IN ('a','b')`.
3. If no such row exists, the orchestrating service returns `approval_required` (HTTP 409) and does not proceed.
4. If an approved row exists, the privileged write executes.

**Critical note:** The DB does not block most forbidden transitions at the SQL level. The application-enforced gate is the only backstop for most Category A/B cases. The centralized gate module is the highest-risk piece of application logic and must be covered by contract tests per §40.

**Gate catalog (from approval-rules.md):**

| Subject | Gate category | Privileged transition blocked |
|---|---|---|
| External email / webhook emit | **A** (always required) | Output delivery; integration emit |
| Code deploy to protected branch | **A** | Task/output delivery |
| Scheduled automation creation | **A** | `scheduled_tasks` INSERT |
| Work packet execution start (when flagged) | **B** (conditional) | `work_packets.status → in_execution` when `approval_required_before_start = true` |
| High-risk decision | **B** | `decisions.status → approved` (vendor/spend, data retention, GovCon) |
| `won_t_fix` blocker reopen | **B** | `blockers.status: won_t_fix → open` |
| Internal knowledge capture | **C** | No gate — log only; `approvals` row is NOT created |

Category C actions must **never** create an `approvals` row — the `017` WITH CHECK enforces `category IN ('a','b')` and any Category C insert attempt fails with a DB constraint violation.

---

## 16. Auth Context Service (G1 Contract)

**G1** is not a runtime service with endpoints — it is the **binding contract** that all other services must honor. Implementation surfaces:

- **JWT validation** — handled by Supabase Auth middleware; the API never validates JWT signatures manually.
- **Context exposure** — the API may expose `current_user_id`, `current_organization_id`, `current_department_id`, `current_role` (derived from `private.*`) as display data for the frontend. This exposure is advisory; the client cannot use it as an authorization input.
- **Null context handling** — if any helper returns null, the request returns `unauthenticated` (401) before reaching any business logic. This is a hard invariant across all services.
- **Role constants** — `{org_admin, department_lead, department_member, read_only, agent}`. No other values are permitted.
- **Agent identity** — a dedicated `public.users` row with `role='agent'` bound to a Supabase Auth identity. Agent sessions are grouped by `session_id` on `agent_activity`.

All six helpers (`current_user_id`, `current_organization_id`, `current_department_id`, `current_role`, `current_email`, `is_org_admin`) are from `005_rls_policies.sql` and are the only sanctioned context source.

---

## 17. Request Intake Service (G2)

**Trust tier:** Client-Safe for human/agent intake; Service-Role for webhook/automation intake (no user session).

**Entity:** `requests` (from `007_execution_layer.sql`)

**Key architecture fact — org-wide SELECT scope:** The `requests` SELECT policy is **org-wide**, not department-scoped. This is intentional and unusual: requests may exist before routing is complete, so any org member can see them. The application may apply additional filters but must not artificially restrict what RLS already allows.

**Role permissions (from Phase C RLS):**
- INSERT: all roles except `read_only` (agents may submit requests; this is the one entity where agents can INSERT without being on an assigned task)
- UPDATE: `org_admin`, the `routed_department_id` department's lead/member, or the original submitter while in early status
- No authenticated DELETE; soft-delete via `deleted_at`

**Service-role paths:**
- Webhook intake: Edge Function verifies signature, resolves `organization_id` from signing identity, inserts `source='webhook'` with service-role.
- Automation intake: scheduled job inserts `source='scheduled_job'` or `'automation'` with service-role.
- Both require idempotency keys to prevent duplicate intake.

**Status values:** `received → triaged → in_progress → completed / rejected / cancelled`. Default: `received` (DB enforced at INSERT).

**Approval gate interactions:** None at intake. Gates apply downstream on tasks and outputs.

---

## 18. Task Service (G3)

**Trust tier:** Client-Safe.

**Entity:** `tasks` (from `007_execution_layer.sql`)

**Role in architecture:** The Task entity is the **pivot** — every other governance entity (decisions, blockers, approvals, outputs, execution logs, agent activity) references a task. The task's `department_id` is the department authority for most governance entities.

**Key architecture facts:**
- Department-scoped read/write for lead/member/read_only; org-wide for admin.
- Agents access only tasks where `assigned_to_user_id = private.current_user_id()`.
- Status transitions are application-enforced (Layer 4); RLS governs row access, not transition legality.
- Entering `blocked` status should reflect an open blocker; entering `in_review` should accompany an output or decision submitted for review — these relationships are application-checked, not DB-enforced.

**Cross-department isolation:** verified in Phase F. Department A member cannot see Department B tasks. The API must not implement any workaround that circumvents this.

**Service-role paths:** The job runner may update task-linked state (e.g., linking a completed background job result) via service-role, carrying `organization_id` explicitly.

**Approval gate interaction:** Category B — a task moving into a state that requires an external/irreversible action (external email, deploy) must have an approved approval before the privileged transition. The Task Service calls the Approval Service to verify.

**Agent-specific contract:**
- Agents may: update status/assignment details on assigned tasks; insert `execution_logs`; read knowledge/research scoped to assigned tasks.
- Agents may NOT: INSERT decision rows; INSERT blocker rows; INSERT approval rows; act on unassigned tasks (RLS `WITH CHECK` blocks this).

---

## 19. Work Packet Service (G4)

**Trust tier:** Client-Safe.

**Entity:** `work_packets` (from `007_execution_layer.sql`)

**Role in architecture:** The Scoping Service. Work packets are the handoff artifact from requester to executor. They carry the acceptance criteria and the `approval_required_before_start` flag that triggers a Category B gate.

**Status values:** `draft → ready → pending_approval → in_execution → accepted / superseded / cancelled`

**Key architecture fact — `in_execution` gate:**
When `approval_required_before_start = true`, the transition `ready → in_execution` (or `pending_approval → in_execution`) is blocked by a Layer 5 check. The Work Packet Service must verify an `approved` approval exists for this work packet before allowing the transition. The DB does not enforce this.

**Polymorphic parent:** `parent_type ∈ {project, task}` + `parent_id`. No DB FK on the polymorphic pair; the application must verify the parent exists in the caller's org and scope.

**Agent access:** agents do not have a standalone write path to work packets. They access work packets through their assigned task context for reading. Work packet creation and status transitions are human-initiated.

**Approval gate interaction:** Category B per `approval_required_before_start` flag.

---

## 20. Approval Service (G5)

**Trust tier:** Client-Safe for request/resolve/withdraw; Service-Role for expiry sweep.

**Entity:** `approvals` (from `011_governance_layer.sql`; policies replaced by `017_phase_e_approvals_adjustment.sql`)

**Role in architecture:** The Gate Service. Every other service in the platform calls into the Approval Service (or directly queries `approvals`) before executing a privileged transition.

**Live RLS policies (from `017` — authoritative):**
- `approvals_insert_department_scope` (INSERT): `org_admin`, `dept_lead`, `dept_member`; agents and `read_only` excluded; `category IN ('a','b')` WITH CHECK; `subject_type` validated by EXISTS subquery
- `approvals_select_department_scope` (SELECT): org_admin all; dept roles department-scoped with output branch check; agents see approvals derivable from their assigned tasks only (no `work_packet` branch for agents per `017`)
- `approvals_update_department_scope` (UPDATE): `org_admin` or `dept_lead` only; `dept_member` cannot resolve; WITH CHECK restricts authenticated UPDATE to `{approved, rejected, withdrawn}` — the `expired` status can **only** be set by service-role

**Key invariants (DB-enforced):**
- `category IN ('a','b')` — Category C cannot be inserted (DB CHECK via `017` WITH CHECK)
- `(status='pending' AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL)` — the `decided_at` paired invariant (DB CHECK in `011`)
- `expires_at → 'expired'` transition: authenticated UPDATE cannot set this status; only the service-role expiry sweep can

**No DELETE, no soft-delete.** Approvals are append-once, resolve-once, immutable after terminal state.

**`approver_user_id` is advisory.** It records who resolved the approval but does not restrict which user may resolve; resolution authority is role-based (`dept_lead` or `org_admin`), not person-based.

**Service-role expiry sweep:** when `expires_at` is reached and `status` remains `pending`, the scheduled job:
1. Updates `approvals.status → 'expired'` (service-role only)
2. Emits an `audit_events` row (severity='warn', category='admin')
3. Optionally raises a `blockers` row on the subject task (`reported_by_user_id` must be a valid user with RESTRICT FK — cannot be null)

**Subject types (from `017`):** `task`, `work_packet`, `decision`, `output`. No DB FK on the polymorphic pair.

---

## 21. Output Service (G6)

**Trust tier:** Client-Safe for review/status transitions; Service-Role for external delivery I/O.

**Entity:** `outputs` (from `014_knowledge_output_layer.sql`)

**Role in architecture:** The Delivery Service. Outputs are the deliverables that leave the platform; they carry the highest-stakes external action (email/webhook to external parties) and therefore the most critical Category A gate.

**Key architecture fact — direct `department_id`:** Outputs carry `department_id` NOT NULL with FK RESTRICT (direct column, unlike decisions which derive dept through `task_id`). This must match the parent task's `department_id`. The DB has a direct FK on outputs to departments but does not enforce the cross-reference to tasks.department_id; Layer 4 must verify alignment.

**Status values:** `draft → in_review → approved → delivered / superseded / rejected`

**External delivery gate (Category A, always required):**
External delivery (`output_type` targeting external parties: client reports, GovCon submissions, email/webhook deliverables) requires an `approved` approval before `status → delivered`. The Output Service checks Layer 5 before calling the delivery Edge Function. Internal reports (reviews only) bypass the delivery gate but still require review (`in_review → approved` by the lead).

**Service-role delivery path:**
1. Approved output triggers `output_delivery` background job (service-role enqueue)
2. Edge Function executes the delivery (email/HTTP) carrying the org context
3. On success: `outputs.delivered_at` set, `execution_logs` written
4. On 4xx permanent failure: DLQ INSERT
5. On 5xx transient failure: retry with exponential backoff via `background_jobs`

**Agent access:** agents may INSERT outputs for their assigned tasks (Phase E `016` policies). Agents cannot approve or deliver outputs.

---

## 22. Decision Service (G7)

**Trust tier:** Client-Safe.

**Entity:** `decisions` (from `011_governance_layer.sql`)

**Role in architecture:** records choices made during task execution. Decisions are the reasoning trail; high-risk decisions route through approval gates before becoming authoritative.

**Key architecture fact — department derived, not direct:**
`decisions` has **no** `department_id` column. Department scope is derived through `task_id → tasks.department_id`. The RLS SELECT and INSERT policies perform a JOIN through tasks to enforce department boundaries. This is a fundamental schema difference from outputs and blockers, which carry direct `department_id`.

**Role INSERT restriction (binding):**
`decisions_insert_task_scope` (from `013`): `role IN {org_admin, department_lead, department_member}` only. The `agent` role is **absent** from the INSERT policy. Agents have SELECT-only access to decisions on their assigned tasks (`decisions_select_task_scope`).

**Agent exclusion is absolute:**
An agent attempting to INSERT a `decisions` row receives RLS error `42501` (new row violates row-level security policy). This is not a Layer 4 check — it is a DB-enforced Layer 3 denial. The application should not attempt to INSERT on behalf of an agent; it should ensure the agent uses the signaling model (§33) instead.

**Status values:** `proposed → confirmed → pending_approval → approved / rejected / superseded`

**High-risk decision gate (Category B):**
Decisions in categories `{vendor_selection, spend_commitment, data_retention_deletion, govcon_submission}` (or as configured in `approval-rules.md`) must route through `pending_approval` and require an `approved` approval before advancing to `approved`. The Decision Service orchestrates this gate.

**Member UPDATE asymmetry:**
Dept members can INSERT decisions (`proposed`) but cannot UPDATE decisions to confirmed or pending-approval states. Lead or admin confirmation is required.

---

## 23. Blocker Service (G8)

**Trust tier:** Client-Safe.

**Entity:** `blockers` (from `011_governance_layer.sql`)

**Role in architecture:** The Impediment Service. Blockers record what is preventing progress on a task or work packet. They have the broadest member authority of any governance entity (both INSERT and UPDATE).

**Key architecture facts:**
- **Direct `department_id`** (NOT NULL, FK RESTRICT) — like outputs, unlike decisions.
- `reported_by_user_id` is NOT NULL with FK **RESTRICT** (unlike `decisions.decided_by_user_id` which is nullable with SET NULL). The reporter cannot be deleted while the blocker exists.
- `blocked_entity_type CHECK ('task', 'work_packet')` only — `'project'` is intentionally deferred per `011` migration comment.
- No `resolved_at` column in the deployed schema; `updated_at` serves as the resolution timestamp.
- No `blocker_research_assets` junction table in the deployed schema.

**Status values (live):** `open → investigating → pending_external → resolved / won_t_fix`

**Agent exclusion:**
`blockers_insert_department_scope` and `blockers_update_department_scope` (from `013`) restrict INSERT and UPDATE to `{org_admin, dept_lead, dept_member}`. Agents are excluded from both. An agent attempting to INSERT a blocker receives RLS `42501`.

**`won_t_fix` override gate (keystone, application-enforced only):**
The transition `won_t_fix → open` (reopen) requires an approved Category B Decision. The DB itself permits this UPDATE unconditionally — there is **no DB backstop**. The Blocker Service must perform this Layer 5 check:
1. Query `decisions` for an `approved` decision linked to the blocked task, associated with an `approvals` row where `category='b'` and `status='approved'`
2. If not found → return `approval_required` (HTTP 409)
3. If found → allow `won_t_fix → open`

This is the highest-risk application-only gate in the blocker contract and is the keystone test in the G8 verification matrix (Test #18).

**`won_t_fix` resolve authority (Layer 4, not DB-enforced):**
Only `dept_lead` or `org_admin` may close a blocker as `won_t_fix`. `dept_member` may update blockers (RLS allows it) but the application must reject `won_t_fix` attempts from members (Layer 4 check).

---

## 24. Agent Runtime Service

**Trust tier:** Client-Safe (agent JWT); Service-Role for the broker bypass ingestion path.

**G-phase reference:** G1 §11, §17; G-API §19, §27; `020_phase_f_rls_policies.sql`

**What the Agent Runtime Service is:**
A server-side broker that authenticates an agent identity, enforces the Tool Profile ceiling, relays the agent JWT to RLS-bound operations, and records all activity. It holds no service key.

**Agent effective capability = intersection of:**
1. `agent` RLS policies (Layers 3 grants)
2. Assigned task scope (`assigned_to_user_id = private.current_user_id()`)
3. Tool Profile `allowed_tools` / `constraints` (four profiles: `command-center-brain`, `execution-worker`, `build-workshop`, `operations-external`)

**What agents CAN do (RLS-permitted):**
- INSERT `agent_activity` (own rows only; self-pinned by `020` WITH CHECK)
- INSERT `execution_logs` for assigned tasks
- INSERT `outputs` for assigned tasks (Phase E `016`)
- SELECT `decisions` on assigned task scope
- SELECT `approvals` derivable from assigned tasks
- SELECT `knowledge_records`, `research_assets` scoped to assigned context
- SELECT `tasks` where assigned
- SELECT `background_jobs` linked to assigned task
- Submit `requests` (`source='automation'`)

**What agents CANNOT do (RLS-blocked, DB-enforced):**
- INSERT `decisions` → RLS 42501 (`decisions_insert_task_scope` excludes `agent`)
- INSERT `approvals` → RLS 42501 (`approvals_insert_department_scope` excludes `agent`)
- INSERT `blockers` → RLS 42501 (`blockers_insert_department_scope` excludes `agent`)
- INSERT `agent_activity` for another agent's `agent_user_id` → RLS 42501 (`020` WITH CHECK: `agent_user_id = private.current_user_id()`)
- Access unassigned tasks (RLS WITH CHECK blocks writes; SELECT returns nothing)
- Access `audit_events` (no SELECT grant for `agent`)
- Access `runtime_metrics`, `dead_letter_queue` (no grants)

**Category A/B actions are never autonomous:**
The runtime calls the Approval Service and waits for `approved` before executing any Category A or B tool call. Out-of-profile tool calls are flagged in `execution_logs.status = 'flagged'` and blocked.

---

## 25. External Integration Service

**Trust tier:** Service-Role exclusively (no user session present).

**G-phase reference:** G-API §21; G1 §16

**Inbound webhook intake:**
1. Edge Function receives the signed payload
2. Signature/HMAC verification precedes any DB write
3. Idempotency key checked against prior `requests.metadata` — if already processed, return 200 and stop
4. Organization resolved from the signing key / integration registration
5. Service-role inserts `requests` with `source='webhook'`, `organization_id` pinned to resolved tenant
6. Acknowledge to sender

**Outbound delivery (email/webhook):**
1. Triggered by an approved `outputs` row (`status='approved'`, `output_type` external)
2. Edge Function reads the delivery target from the approved output
3. Verifies the `approvals` table has an `approved` Category A row for this output's `subject_id` (defense-in-depth even though the delivery was triggered by approval)
4. Executes external call (email send / HTTP POST)
5. On success: marks `outputs.delivered_at`, writes `execution_logs`
6. On 4xx permanent: `dead_letter_queue` INSERT
7. On 5xx transient: `background_jobs` retry with exponential backoff

**Schedule triggers:**
The schedule firer reads `scheduled_tasks` where `next_run_at <= now()`, enqueues a `background_jobs` row for each due schedule, and updates `last_run_at` and `next_run_at` — all service-role.

**Secrets:** API keys, SMTP credentials, webhook signing secrets are server-only. They must never appear in `execution_logs`, `agent_activity` metadata, responses, or any client-reachable path.

---

## 26. Runtime Operations Service

**Trust tier:** Client-Safe for read paths; Service-Role for all lifecycle writes.

**G-phase reference:** G-API §18; `018_runtime_hardening.sql`, `019_phase_f_grants.sql`, `020_phase_f_rls_policies.sql`

**Entity overview (from `018`):**
- `scheduled_tasks` — schedule definitions; `org_admin` + `dept_lead` (own dept) write; `cron_expression` XOR `run_at` DB CHECK
- `background_jobs` — job lifecycle; `org_admin` INSERT/UPDATE authenticated; dept roles SELECT (dept-scoped via related-entity FK chains); `read_only` has **no access** (`020`)
- `dead_letter_queue` — failed job records; `org_admin` + `dept_lead` SELECT + UPDATE (resolve); no authenticated INSERT (revoked `019`)
- `runtime_metrics` — performance counters; no authenticated INSERT; admin all SELECT; dept roles dept-scoped SELECT + `department_id IS NULL` org-wide
- `audit_events` — platform security log; no authenticated INSERT; `org_admin` SELECT only; `ip_address` is PII-adjacent and must never be projected to non-admins
- `agent_activity` — per-agent session trace; agent self-INSERT only (`020` WITH CHECK); `read_only` has **no access** (`020`)

**Service-role ownership:** the job runner owns `background_jobs` status lifecycle (queued → processing → completed/failed → dead_letter), DLQ INSERT, metrics ingestion, audit emission.

**Approval gate for schedule creation:**
Creating a `scheduled_tasks` row is **Category A** per `approval-rules.md`. The Runtime Operations Service must check for an `approved` Category A approval before inserting a schedule. The DB does not block this.

---

## 27. Knowledge and Research Service

**Trust tier:** Client-Safe.

**G-phase reference:** G-API §15, §17; `014_knowledge_output_layer.sql`, `015_phase_e_grants.sql`, `016_phase_e_rls_policies.sql`

**Entities:** `research_assets`, `outputs` (partial), `knowledge_records`, `knowledge_record_links`, `task_research_assets`, `work_packet_research_assets`, `output_research_assets`

**Junction tables are append-only:** The `015` migration revoked UPDATE on all junction tables (`task_research_assets`, `work_packet_research_assets`, `output_research_assets`, `knowledge_record_links`). Junction rows can be inserted but never updated — they are association records. Deletion is handled by soft-delete on the parent.

**Agent context reads:** agents may SELECT `knowledge_records` and `research_assets` scoped to their assigned task/project/work_packet context. This is their primary read surface for task execution.

**Service-role paths:** `knowledge_sync` scheduled jobs synthesize `knowledge_records` from `execution_logs` and other signals. These run service-role with explicit `organization_id` and `subject_type/subject_id` pinning.

**Approval gate interactions:** None for knowledge capture. Recording a `knowledge_record` is always Category C (log only). Records that inform high-risk decisions remain advisory input to the human decision-maker.

---

## 28. Cross-Service Orchestration Patterns

**Pattern 1 — Approval-gated transition (most common):**
```
Client → Service → ApprovalService.check(subject_type, subject_id, category)
                       → SELECT approvals WHERE ... status='approved'
                       → returns approved/not_found
          Service → if not found: return 409 approval_required
          Service → if approved: execute privileged write
                                 → write execution_log
                                 → emit audit_event (if platform-level)
```

**Pattern 2 — Agent signaling a needed governance action:**
```
Agent → agent_activity INSERT (activity_type='approval_requested')
                                → summary describes needed approval
      → execution_logs INSERT (status='pending_approval')
      → Runtime returns 'waiting_for_approval'
      → Human (dept_lead/org_admin) sees the signal in the dashboard
      → Human creates the actual approvals/decisions/blockers row
      → Human resolves it
      → Agent receives realtime update (when realtime is enabled) or polls
```

**Pattern 3 — Background job with DLQ fallback:**
```
Approved output → service-role enqueue background_job (type='output_delivery')
                → Edge Function picks up job → external call
                → on 4xx: DLQ INSERT (service-role, no authenticated INSERT)
                → on 5xx: job status → 'failed', retry_count++, next_attempt_at = now() + backoff
                → on max_retries exceeded: DLQ INSERT
```

**Pattern 4 — Expiry sweep cascade:**
```
Scheduled job → query approvals WHERE expires_at <= now() AND status='pending'
              → for each: UPDATE approvals.status = 'expired' (service-role)
                           INSERT audit_events (severity='warn')
                           (optionally) INSERT blockers on subject task (service-role, must have valid reported_by_user_id)
```

**Pattern 5 — Realtime propagation (future, when enabled):**
```
DB UPDATE (e.g., tasks.status or approvals.status)
→ supabase_realtime publication change event
→ RLS SELECT policy evaluated per subscriber
→ authorized subscribers receive the change
→ unauthorized subscribers receive nothing (RLS-filtered out)
```

---

## 29. Approval Gate Orchestration

The Approval Gate is a centralized module that all services call. Its contract:

**Input:** `subject_type`, `subject_id`, `required_category` (`'a'` or `'b'`)

**Output:** `{approved: true, approval_id: uuid}` or `{approved: false, reason: 'not_found' | 'pending' | 'rejected' | 'expired'}`

**The gate module must NOT:**
- Create an approval on behalf of the caller
- Assume the subject exists — it must validate
- Cache results for longer than the request lifetime (approvals transition; a cached 'pending' could mask a just-approved row)

**The gate module must:**
- Query `approvals` under the caller's JWT (Client-Safe) so RLS filters out-of-scope rows
- Match `subject_type` AND `subject_id` AND `status='approved'` AND `category = required_category`
- Return the first matching `approved` row if any exist
- Return not-found/pending/rejected/expired status so the orchestrating service can surface the correct error to the caller

**Gate call points (definitive list):**

| Service | Gate call | Category |
|---|---|---|
| Output Service | before `status → delivered` (external delivery) | A |
| Work Packet Service | before `status → in_execution` (if `approval_required_before_start`) | B |
| Decision Service | before `status → approved` (high-risk decision types) | B |
| Blocker Service | before `won_t_fix → open` (reopen override) | B |
| Runtime Ops Service | before `scheduled_tasks` INSERT | A |
| External Integration Service | before outbound webhook/email emit (defense-in-depth) | A |
| Task Service | before task transition triggering an external/irreversible action | A or B (per action type) |

---

## 30. Agent Signaling Model

**Core rule (binding across all services):** agents do not create approvals, decisions, or blockers. They signal intent; authorized humans act.

**Signal mechanisms:**

| Signal type | Mechanism | What it communicates |
|---|---|---|
| Approval needed | `agent_activity` INSERT with `activity_type='approval_requested'`, `summary` describes the needed approval | "I cannot proceed without an approved approval for X" |
| Decision needed | `agent_activity` INSERT with `activity_type='decision_made'` (logging the agent's assessment), `execution_logs` with status noting pending human confirmation | "I have assessed; a human decision-maker should confirm" |
| Blocker observed | `agent_activity` INSERT with `activity_type='error_raised'` or a custom signal in summary; `execution_logs.status='blocked'` | "Progress is impeded; a human should raise a blocker" |
| Approval requested via workflow | `execution_logs` INSERT with an `approval_requested` marker and the subject reference | Structured signal for automated dashboard routing |

**Signal-to-action mapping:**
```
Agent signals → Human dashboard receives (via polling or future realtime)
                     │
                     ├── org_admin / dept_lead sees agent_activity signal
                     ├── Human creates approvals / decisions / blockers row
                     ├── Human resolves it
                     └── Agent execution unblocks (polls or receives realtime update)
```

**Why this model and not agent-direct creation?**
The live RLS policies (`013` for decisions/blockers, `017` for approvals) explicitly exclude the `agent` role from INSERT. This is not a documentation convention — it is enforced at the database. Any attempt by the application to INSERT these rows while authenticating as an `agent` JWT will be rejected with RLS `42501`.

---

## 31. DB-Enforced Rules

Rules that the database enforces regardless of application behavior. The application cannot bypass these without switching to service-role.

**Schema-level enforcement (`001`–`018`):**

| Rule | Mechanism | Migration |
|---|---|---|
| `users.role IN ('org_admin','department_lead','department_member','agent','read_only')` | CHECK constraint | `001` |
| `organizations.status IN ('active','suspended','archived')` | CHECK constraint | `001` |
| `blockers.blocked_entity_type IN ('task','work_packet')` | CHECK constraint | `011` |
| `blockers.reported_by_user_id NOT NULL` | NOT NULL + FK RESTRICT | `011` |
| `approvals.category IN ('a','b')` (via WITH CHECK) | RLS WITH CHECK in `017` | `017` |
| `approvals.decided_at paired invariant` | DB CHECK: `(status='pending' AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL)` | `011` |
| `scheduled_tasks`: exactly one of `cron_expression` / `run_at` | DB CHECK | `018` |
| `runtime_metrics.value_int XOR value_float` | DB CHECK | `018` |
| `agent_activity.agent_user_id = private.current_user_id()` | RLS WITH CHECK (`020`) | `020` |
| Agent role exclusion from `decisions` INSERT | RLS policy `decisions_insert_task_scope` | `013` |
| Agent role exclusion from `approvals` INSERT | RLS policy `approvals_insert_department_scope` | `017` |
| Agent role exclusion from `blockers` INSERT and UPDATE | RLS policies `blockers_insert_*` / `blockers_update_*` | `013` |
| `read_only` has no access to `background_jobs` | No SELECT grant (`019`/`020`) | `019`/`020` |
| `read_only` has no INSERT to `agent_activity` | RLS: `current_role()='agent'` required | `020` |
| No authenticated INSERT to `dead_letter_queue` | Grant revoked in `019` | `019` |
| No authenticated INSERT/UPDATE to `audit_events` or `runtime_metrics` | No grant in `019` | `019` |
| `approvals.status → 'expired'` blocked for authenticated UPDATE | `017` WITH CHECK: `status IN ('approved','rejected','withdrawn')` only | `017` |
| Organization FK RESTRICT on all core tables | FK `on delete restrict` throughout `001`–`018` | `001`–`018` |
| Tenant isolation via `organization_id` predicates | All RLS policies `005`–`020` | `005`–`020` |

---

## 32. Application-Enforced Rules

Rules the application must enforce because the DB does not (or cannot). These are the highest-risk items in the architecture — a bug here is not caught at the DB layer.

| Rule | Where enforced | Risk if missed |
|---|---|---|
| External output delivery requires `approved` Category A approval | Output Service Layer 5 gate | External delivery without authorization |
| `scheduled_tasks` INSERT requires `approved` Category A approval | Runtime Ops Service Layer 5 gate | Unauthorized automation creation |
| Work packet `→ in_execution` requires `approved` Category B approval (when flagged) | Work Packet Service Layer 5 gate | Unauthorized execution start |
| High-risk `decisions` require `approved` Category B approval before `→ approved` | Decision Service Layer 5 gate | Unauthorized commitment to high-risk path |
| `blockers won_t_fix → open` requires `approved` Category B decision-backed approval | Blocker Service Layer 5 gate | Unauthorized override of `won_t_fix` |
| `won_t_fix` status may only be set by `dept_lead` or `org_admin` | Blocker Service Layer 4 | `dept_member` inappropriately closing a blocker as `won_t_fix` |
| `outputs.department_id` must match parent `tasks.department_id` | Output Service Layer 4 | Output appears in wrong department scope |
| Approver role validation (who may resolve approvals) | Approval Service Layer 4 | Unauthorized approval resolution |
| `decisions.decided_by_user_id` must be the current user | Decision Service Layer 4 | False attribution |
| Polymorphic subject co-tenancy (`approvals.subject_type/id`) | Approval Service Layer 4 | Cross-tenant approval |
| Idempotency for webhook intake | External Integration Service Layer 4 | Duplicate request records |
| Organization pinning in all service-role writes | Service-role paths | Cross-tenant data pollution |
| Agent Tool Profile ceiling enforcement | Agent Runtime Broker | Agent using disallowed tools |
| Out-of-profile tool calls flagged and blocked | Agent Runtime Broker | Unauthorized agent capability |
| Status machine transition validity for all entities | Each Service Layer 4 | Illegal state jumps |
| `not_found` vs `forbidden` distinction for cross-tenant reads | All services (error model) | Existence leak |
| Expiry sweep `reported_by_user_id` must be a valid user | Approval Expiry Service-role path | RESTRICT FK violation if user was deleted |

---

## 33. Human-Enforced Rules

Rules that require a human decision and cannot be reduced to database or application logic.

| Rule | Who enforces | Mechanism |
|---|---|---|
| Approve a high-risk decision (vendor/spend/data/GovCon) | `dept_lead` or `org_admin` | Review the decision context; resolve the `approvals` row to `approved` or `rejected` |
| Authorize external delivery of a sensitive output | `dept_lead` or `org_admin` | Review the output; resolve the Category A approval |
| Authorize scheduled automation creation | `org_admin` | Review the schedule definition; resolve Category A approval |
| Reopen a `won_t_fix` blocker | `dept_lead` or `org_admin` | Create + approve a Category B Decision linked to the blocker's task; then the Blocker Service allows the transition |
| Provision new users; assign roles and departments | `org_admin` | Direct writes to `public.users` |
| Role/department change for an existing user | `org_admin` | UPDATE `public.users.role` or `department_id`; takes effect on the next request |
| Suspend or archive a user | `org_admin` | UPDATE `public.users.status` → `suspended` or `archived`; immediate platform-wide denial |
| Review and resolve DLQ entries | `org_admin` or `dept_lead` (dept scope) | Dashboard review; `dead_letter_queue.resolution_status → requeued / discarded / escalated` |
| Confirm an agent's proposed activity as a decision | `dept_lead` | Read the `agent_activity` signal; create the `decisions` row |
| Raise a blocker on behalf of an agent that signaled an impediment | `dept_lead` or `dept_member` | Read the `agent_activity` / `execution_logs` signal; INSERT a `blockers` row |

---

## 34. Realtime Deployment State

**Verified live state (2026-06-24, project `wbtvrzivthuqqntnorsw`):**

| Fact | Live value |
|---|---|
| `supabase_realtime` publication exists | **Yes** (Supabase default, created at project init) |
| `puballtables` | **false** (explicit/opt-in membership) |
| DML events enabled on the publication | insert, update, delete, truncate |
| `pg_publication_tables` member count | **Zero — no tables are members** |
| `tasks`, `approvals`, `blockers` in the publication | **No** |
| RLS on `tasks`, `approvals`, `blockers` | Yes (enabled, not forced) |
| Replica identity on all three | `DEFAULT` (primary key only in old image) |

**Interpretation for implementers:**
- Realtime is **documented intent, not live capability**. G3, G5, and G8 plans that mention realtime channels describe the future state after the enable migration.
- Enabling realtime is a single additive `ALTER PUBLICATION supabase_realtime ADD TABLE ...` migration — it does not require new policies, new grants, or new table structures.
- The timing trigger is: **when frontend subscription work begins**.
- The key pre-enable decision is replica identity: `DEFAULT` (PK only in old image) is safe for in-scope change events but will not deliver clean "row left scope" events (e.g., task re-routed, soft-delete). Set `REPLICA IDENTITY FULL` only if the frontend requires scope-exit visibility, decided per table when that requirement is concrete.
- **Implementation rule:** do not build frontend subscription logic against a dead channel. Mark realtime as a feature flag until the migration lands.

**Realtime authorization is not a new policy.** When enabled, the existing RLS SELECT policies govern what each subscriber receives:
- `tasks_select_dept_scope` + `tasks_select_agent_assigned`
- `approvals_select_department_scope` (from `017`)
- `blockers_select_department_scope` (from `013`)

No new realtime-specific policies are needed or permitted.

---

## 35. Event and Audit Ownership

Every material action must be traceable. Three surfaces serve different scopes:

| Surface | Entity | Scope | Write ownership | Read access |
|---|---|---|---|---|
| `execution_logs` | Entity-scoped action trail | Per task/request/output (actor: user/agent/system text) | Authenticated INSERT (by actor) or service-role (system actions) | Task scope holders + org_admin |
| `audit_events` | Platform security/admin envelope | Org-wide; `event_category ∈ {auth,security,admin,system,migration}`; `severity ∈ {info,warn,error,critical}` | Service-role INSERT only (no authenticated path) | `org_admin` SELECT only |
| `agent_activity` | Per-agent session trace | Agent session + assigned task scope | Agent self-INSERT (`020` WITH CHECK) or service-role bypass path | Agent (own activity), dept roles (dept scope), org_admin (all); `read_only` excluded |

**Attribution rule:** service-role actions on behalf of a human/agent must record `audit_events.actor_user_id` / `actor_role` or `execution_logs.actor`. Silent privileged mutation is forbidden.

**`ip_address` on `audit_events` is PII-adjacent.** It must not be projected to any role other than `org_admin`. It must not appear in API responses for non-admin callers.

**Audit capture points:**

| Event | Surface |
|---|---|
| User signs in / signs out | `audit_events` (auth-hook, service-role) |
| Role/department change | `audit_events` (admin category) |
| User suspended/archived | `audit_events` (admin category) |
| Approval resolved (approved/rejected) | `execution_logs` on subject + optionally `audit_events` |
| Approval expired | `audit_events` (warn severity) |
| External delivery executed | `execution_logs` + `audit_events` (delivery category) |
| Background job DLQ entry | `dead_letter_queue` + `audit_events` |
| Migration applied | `audit_events` (migration category) |
| Agent tool call | `agent_activity` (activity_type='tool_call') |
| Agent approval request signal | `agent_activity` (activity_type='approval_requested') |

---

## 36. Service-Role Operation Catalog (Complete)

Definitive list of every service-role operation as of migrations `001`–`020`. Any new service-role path must be added here and justified.

| # | Operation | Table(s) written | Trigger | Why service-role |
|---|---|---|---|---|
| SR-01 | Job lifecycle transitions (queued→processing→completed/failed) | `background_jobs` | Job runner | No user session; lifecycle-only |
| SR-02 | DLQ INSERT on permanent job failure | `dead_letter_queue` | Job runner | No authenticated INSERT (`019`) |
| SR-03 | Metrics ingestion | `runtime_metrics` | Metrics pipeline | No authenticated INSERT |
| SR-04 | Audit event emission (auth, admin, system) | `audit_events` | Auth hook, admin action, migration | No authenticated INSERT |
| SR-05 | Schedule `last_run_at` / `next_run_at` update | `scheduled_tasks` | Schedule firer | Scheduler-owned fields |
| SR-06 | Schedule firing → enqueue job | `background_jobs` | Schedule firer per SR-05 | Same session as SR-05 |
| SR-07 | Approval expiry sweep | `approvals` (`status='expired'`) | Scheduled sweep (48h) | Authenticated cannot set `expired` (`017` WITH CHECK) |
| SR-08 | Expiry-triggered blocker raise | `blockers` | Follows SR-07 | Must INSERT with valid `reported_by_user_id`; no user session |
| SR-09 | Webhook intake `requests` INSERT | `requests` | Inbound signed webhook | No user JWT; tenant resolved from signing key |
| SR-10 | Automation intake `requests` INSERT | `requests` | Scheduled automation trigger | No user JWT |
| SR-11 | Output delivery external call + `delivered_at` mark | `outputs`, `execution_logs` | Approved output delivery job | External I/O; no user session |
| SR-12 | Knowledge sync synthesis | `knowledge_records` | Scheduled knowledge sync job | Bulk synthesis; no user session |
| SR-13 | Agent activity bypass ingestion | `agent_activity` | Agent runtime broker (server-side) | Brokered path when agent JWT unavailable; records true `agent_user_id` |

---

## 37. Permission Matrix by Role

Synthesizing G1–G8 role permissions into a single reference table:

| Capability | org_admin | dept_lead | dept_member | read_only | agent |
|---|---|---|---|---|---|
| Read requests | All org | All org | All org | All org | All org (if submitted) |
| Create request | Yes | Yes | Yes | No | Yes |
| Read tasks | All org | Own dept | Own dept | Own dept | Assigned only |
| Write task (status/assignment) | All org | Own dept | Own dept | No | Assigned only |
| Read decisions | All org | Own dept (via task) | Own dept (via task) | Own dept (via task) | Assigned task only |
| Write decisions | All org | Own dept | Own dept | No | **No** (RLS blocks) |
| Read approvals | All org | Own dept | Own dept | Own dept | Assigned task derivable only |
| Create approval | Yes | Yes | Yes | No | **No** (RLS blocks) |
| Resolve approval | Yes | Yes (dept subjects) | **No** | No | No |
| Read blockers | All org | Own dept | Own dept | Own dept | Assigned task/WP only |
| Write blockers (raise/update) | All org | Own dept | Own dept | No | **No** (RLS blocks) |
| Read outputs | All org | Own dept | Own dept | Own dept | Assigned task |
| Write outputs | All org | Own dept | Own dept | No | Assigned task |
| Approve/deliver outputs | Yes | Yes (dept) | No | No | No |
| Read background_jobs | All org | Own dept (related) | Own dept (related) | **No** | Assigned task related |
| Write background_jobs | Yes (I/U) | **No** | No | No | No |
| Read scheduled_tasks | Yes | Own dept | Own dept | Own dept | No |
| Write scheduled_tasks | Yes | Own dept | No | No | No |
| DLQ resolve | Yes | Own dept | No | No | No |
| Read audit_events | Yes | **No** | No | No | No |
| Read runtime_metrics | All org | Dept + org-wide | Dept + org-wide | Dept + org-wide | **No** |
| Write agent_activity | No (read-only) | No | No | **No** | Self-INSERT only |
| Read agent_activity | Yes | Own dept | Own dept | **No** | Own rows only |

---

## 38. Error Model

Inherited from G1 §19 and the API layer plan §23. Binding for all services.

| Class | HTTP | Trigger | Source layer |
|---|---|---|---|
| `unauthenticated` | 401 | No valid JWT; null `current_user_id` (non-active/unprovisioned user) | Layers 1–2 |
| `forbidden` | 403 | User knows the resource exists but lacks permission for the attempted action (role/approver mismatch on a visible row) | Layers 3–4 |
| `not_found` | 404 | Row not visible under RLS — **default for unauthorized reads**; never confirms cross-tenant existence | Layer 3 (RLS as invisibility) |
| `approval_required` | 409 | Privileged transition attempted without an `approved` approval | Layer 5 |
| `conflict` | 409 | Illegal state transition; terminal-state mutation (e.g., resolving an already-resolved approval) | Layer 4 |
| `validation` | 422 | Bad enum / shape / constraint (cron syntax, check constraint, missing required field) | Layers 3–4 |
| `rate_limited` | 429 | Throttle | API |
| `internal` | 500 | Unexpected; async failures route to DLQ | Runtime |

**RLS-as-invisibility rule (locked):** unauthorized reads return `not_found` — not `forbidden`. RLS filters the row as if it does not exist; the API must not confirm existence. `forbidden` is reserved for rows the caller can see but cannot mutate.

**RLS-filtered UPDATE behavior:** an UPDATE targeting a row the caller cannot see under RLS affects 0 rows — this was verified during Phase F DLQ member-deny testing. The API must map "0 rows affected" to `forbidden` or `not_found` consistently per service, never to silent success.

---

## 39. Testing Strategy

The Phase F `BEGIN … ROLLBACK` impersonation harness is the standard for all service verification.

```sql
begin;
set local role authenticated;
set local "request.jwt.claim.sub" = '<auth_user_id>';
-- test statement(s)
rollback;
```

Tests never mutate the system of record.

| Test area | Required coverage |
|---|---|
| **RLS conformance** | Every policy in `005`–`020` verified against representative operations per role |
| **Cross-org isolation** | Two-org fixture; every table returns empty for cross-org reads; no cross-org write succeeds |
| **Cross-dept scoping** | Dept A member cannot see Dept B entities on any table |
| **Agent identity pin** | Positive: agent self-insert succeeds. Negative: agent other-id insert → RLS 42501 |
| **Agent governance exclusions** | Agent INSERT decisions → 42501; INSERT approvals → 42501; INSERT blockers → 42501 |
| **Approval gates** | For every Layer 5 gate: attempt privileged transition without approval → 409; with approved approval → success |
| **`won_t_fix` reopen** | Without approved Category B decision → `approval_required`. With → success |
| **`expired` status** | Authenticated UPDATE `status='expired'` → RLS 42501; service-role → succeeds |
| **Category C INSERT** | Attempt `approvals` INSERT with `category='c'` → DB check violation |
| **`read_only` exclusions** | `read_only` denied on `background_jobs` SELECT; denied on `agent_activity` SELECT/INSERT |
| **Service-role boundary** | Service key absent from any client bundle (static analysis); service-role paths unreachable by clients |
| **Error model** | Cross-tenant read → `not_found` (not `forbidden`); visible-but-unauthorized write → `forbidden` |
| **Realtime** | After enablement: two-dept subscriptions; dept A update not received by dept B; agent subscription confined to assigned tasks |
| **Expiry sweep** | Approval `expires_at` reached → `status='expired'`; `audit_events` row; optional blocker raised |
| **Delivery gate** | External output delivery refused without Category A `approved` approval; refused after DLQ if delivery fails |
| **Webhook idempotency** | Duplicate webhook payload with same idempotency key → 200, no second request row |

---

## 40. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Service-role key leakage** into client or agent path → total RLS bypass | High | Physical isolation (Edge Functions / job runner only); secrets never in client bundles; CI secret scanning; service-role paths enumerated (§36) |
| R2 | **Application gate divergence** — a Layer 5 check is missing or incorrectly implemented | High | Centralized gate module (§29); contract tests for every gate call point; consider DB triggers for highest-risk gates (output delivery, schedule creation) in a future hardening migration |
| R3 | **Client-supplied scope trusted** — `organization_id`/`department_id` accepted as authorization input | High | All services derive context via `private.*`; client scope treated as filter hint; no service may read org/dept from the request body for authorization; code review enforced |
| R4 | **Agent governance exclusion bypassed** — application inserts decisions/approvals/blockers while relaying an agent request | High | Agent requests must never be proxied to governance INSERT paths; the agent signaling model (§30) is the only agent interaction with these entities |
| R5 | **Realtime published before RLS review** — a table added to `supabase_realtime` without confirming its SELECT policy | Medium | Gate every realtime enable behind a confirmed SELECT policy review; start with `tasks`/`approvals`/`blockers` only |
| R6 | **`won_t_fix` reopen gate missed** — the keystone application-only gate is not implemented or tested | High | Test #18 (G8 matrix) is a required regression test; this transition must always call the gate module |
| R7 | **Expiry sweep reporter ID invalid** — the `reported_by_user_id` for an expiry-triggered blocker references a deleted user | Medium | The RESTRICT FK will reject the INSERT; the sweep must maintain a valid system user account as the reporter or fetch the original approver's id |
| R8 | **Cross-tenant pollution in service-role writes** — organization_id not carried explicitly | High | All SR-0x paths in §36 must document their org pinning; integration tests assert no cross-org row appears |
| R9 | **Polymorphic integrity gap** — `approvals.subject_type/id` points to a deleted or cross-tenant entity | Medium | Layer 4 EXISTS validation before INSERT; check both existence and co-tenancy |
| R10 | **Stale role in service-role audit** — `actor_role` snapshotted incorrectly or omitted | Medium | Audit emission must read the actor's role from `public.users` at action time; never from a prior cached value |
| R11 | **`decided_at` paired invariant violated** — application sets `status='approved'` without setting `decided_at` | Low | The DB CHECK in `011` enforces this; but Layer 4 should set both in the same UPDATE to avoid a brief inconsistency window |
| R12 | **Realtime replica identity mismatch** — frontend depends on scope-exit events but `DEFAULT` identity was shipped | Medium | Decide replica identity from concrete frontend requirements at enable-time; document the chosen value in the migration comment |

---

## 41. Definition of Done

This architecture is complete and implementation-ready when **all** of the following hold:

**Database foundation:**
- [ ] Migrations `001`–`020` remain the unmodified substrate; no schema change has been introduced by this document
- [ ] `supabase db lint` passes clean on the live project

**Authorization:**
- [ ] Every consumer (frontend, API, Edge Function, agent, realtime) resolves identity and scope exclusively through Supabase Auth + `private.*` helpers — no client-supplied scope is ever trusted
- [ ] A null context (non-active user) is denied platform-wide; a valid JWT alone is insufficient
- [ ] Cross-org isolation passes on every table (two-org fixture)
- [ ] Cross-dept scoping passes per the G1 §22 suite and Phase F cross-dept isolation tests
- [ ] Five-layer authorization order is honored; Layers 4–5 only narrow what Layers 1–3 permit

**Service-role boundary:**
- [ ] Service key is absent from all client bundles (verified by static analysis or CI scan)
- [ ] Service-role paths are enumerated in §36 and no undocumented SR path exists
- [ ] Every SR path carries `organization_id` explicitly and records actor identity for audit
- [ ] Service-role Edge Functions are unreachable by browsers, agents, or any client path

**Governance entity exclusions:**
- [ ] Agent INSERT of `decisions` → RLS 42501 (positive + negative tests)
- [ ] Agent INSERT of `approvals` → RLS 42501 (positive + negative tests)
- [ ] Agent INSERT of `blockers` → RLS 42501 (positive + negative tests)
- [ ] Agent `agent_user_id` self-pin enforced (`020` verified, regression maintained)
- [ ] `read_only` denied on `background_jobs` and `agent_activity` (regression tests)

**Approval gates:**
- [ ] Every Layer 5 gate in §29 has a contract test: blocked without approval → 409; unblocked with approved → success
- [ ] `won_t_fix → open` without approved Category B decision → `approval_required` (keystone test)
- [ ] Category A approval required before external output delivery
- [ ] Category A approval required before `scheduled_tasks` INSERT
- [ ] Centralized gate module is used for all gate checks (no inline gate logic scattered across services)

**Realtime:**
- [ ] `pg_publication_tables` returns zero rows until the enable migration is applied
- [ ] No frontend subscription code is shipped against a dead channel; realtime is feature-flagged until the enable migration lands
- [ ] When enabled: two-dept subscription isolation verified; agent subscription confined to assigned tasks

**Error model:**
- [ ] `not_found` returned for unauthorized reads (no existence leakage)
- [ ] `forbidden` used only when the caller knows the resource exists but lacks action permission
- [ ] `approval_required` (409) returned for gated transitions
- [ ] 0-rows-affected UPDATE mapped to `not_found` or `forbidden` consistently (never silent success)

**Audit:**
- [ ] `audit_events` captures auth, admin, system, migration events via service-role
- [ ] `execution_logs` captures all entity-scoped actions with actor identity
- [ ] `agent_activity` captures all agent tool calls, signals, and session boundaries
- [ ] No privileged service-role action is anonymous
- [ ] `ip_address` in `audit_events` is not projected to non-`org_admin` callers

**Documentation:**
- [ ] All service contracts in §17–§27 have been reviewed against the live deployed schema
- [ ] Every rule in §31 (DB-enforced) is confirmed against the live migration history
- [ ] Every rule in §32 (application-enforced) has a corresponding contract test
- [ ] Every rule in §33 (human-enforced) has a corresponding UI workflow documented

---

## Document Boundaries

This is Phase G9 **architecture output**. It introduces no code, migrations, schema changes, or implementations. It does not redesign any contract established in G1–G8 or migrations `001`–`020`. Supabase remains the system of record; RLS (`005`–`020`) remains the primary authorization layer; the `private.*` helpers remain the only sanctioned context source; approval gates remain application-enforced with the DB as the authority for what can be stored. Implementation proceeds against the build order in the API layer plan (§31), with this document as the unified reference for service boundaries, trust tiers, enforcement distinctions, and the agent signaling model.
