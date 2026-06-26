# Phase G1 — Auth & Context Spine

The authoritative contract for **authentication, authorization, context resolution, and request identity** in the AI Command Center.

> **API layer plan:** [phase-g-api-application-layer-plan.md](phase-g-api-application-layer-plan.md)
> **Canonical entities:** [system-entities.md](system-entities.md)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)
> **Approval gates:** [approval-rules.md](approval-rules.md)
> **Helper functions & RLS origin:** `supabase/migrations/005_rls_policies.sql`
> **Agent identity pin:** `supabase/migrations/020_phase_f_rls_policies.sql`

This document is **architecture only**. It contains no code, migrations, schema changes, frontend components, or API implementations. It describes the existing, deployed mechanism (migrations `001`–`020`) and the contract every consumer must honor.

**This contract is binding for:** frontend applications, API services, Edge Functions, agents, realtime subscriptions, and all future integrations.

## Confirmed State

- Phases A–F complete; migrations `001`–`020` deployed; Phase F verification passed.
- Phase G API plan completed.
- **Supabase Auth is the authoritative identity provider.**
- **RLS is the authoritative authorization layer.**
- The `private.*` helper functions exist and are in use by every policy from `005` onward.

---

## 1. Purpose

This spine defines how an incoming actor becomes a **trusted, scoped identity** that the database can enforce against. It fixes one resolution path — identity → context → authorization — so that every consumer (browser, API, Edge Function, agent, realtime) resolves organization, department, and role **the same way**, and so that no consumer can substitute its own weaker check for RLS.

The spine answers four questions for every request:

1. **Who is calling?** (identity — Supabase Auth)
2. **What is their scope?** (context — `private.*` helpers)
3. **What may they do?** (authorization — RLS, then app rules, then approval gates)
4. **What did they do?** (audit — `execution_logs`, `audit_events`, `agent_activity`)

---

## 2. Design Principles

| # | Principle | Consequence |
|---|---|---|
| 1 | **One identity provider** | Supabase Auth issues all JWTs. No parallel auth system. |
| 2 | **One authorization layer of record** | RLS is authoritative. App logic may narrow, never widen. |
| 3 | **Context is derived, never asserted** | Organization/department/role come from the database via `private.*`, not from client input or JWT app-claims. |
| 4 | **Deny by default** | A null context (non-active/unknown user) fails every RLS predicate → denied. |
| 5 | **Tenant isolation is absolute** | `organization_id` is the hard boundary on every policy; cross-org is impossible for `authenticated`. |
| 6 | **Least privilege** | Department scope by default; `org_admin` is the only org-wide role; agents are confined to assigned scope and Tool Profile. |
| 7 | **Service-role is a sealed exception** | RLS-bypassing access is server-only, enumerated, and never reaches a client. |
| 8 | **Everything material is audited** | Identity and role are captured at the moment of action. |

---

## 3. Identity Model

### `auth.users` (Supabase Auth)

- Managed by Supabase Auth. Holds the authentication credential and the canonical authentication identifier `auth.uid()` (the JWT `sub`).
- **Source of truth for *authentication*** — "is this a valid, signed-in principal?"
- The application does not write business attributes here.

### `public.users` (platform membership)

- The platform's user record. Key fields: `id`, `organization_id`, `auth_user_id`, `email`, `display_name`, `role`, `department_id`, `status`, `created_at`, `deleted_at`.
- **Source of truth for *authorization context*** — organization, department, role, active status.
- `role ∈ {org_admin, department_lead, department_member, read_only, agent}` (the only five roles).

### Relationship

```text
auth.users.id  ───────────►  public.users.auth_user_id   (1:1 bridge)
   (auth.uid())                     │
                                    ├── organization_id   → tenant scope
                                    ├── department_id      → default scope
                                    ├── role               → capability class
                                    └── status / deleted_at → liveness gate
```

`public.users.auth_user_id` is the **only** link between the authentication identity and the platform identity. All context flows from resolving `auth.uid()` to exactly one active `public.users` row.

### Source of Truth Summary

| Question | Authority |
|---|---|
| Is the caller authenticated? | `auth.users` / Supabase Auth (JWT signature + `sub`) |
| Who is the caller in the platform? | `public.users` (via `auth_user_id`) |
| What org/department/role? | `public.users` columns, read through `private.*` |
| May they touch this row? | RLS policies (`005`–`020`) |

### Lifecycle

1. **Provision** — an `org_admin` creates a `public.users` row bound to an `auth.users` identity (`auth_user_id` set, `status='active'`).
2. **Active** — `status='active'`, `deleted_at is null`: helpers resolve full context; RLS applies.
3. **Role/department change** — `org_admin` updates `role`/`department_id`; context changes on the **next** request (helpers re-resolve every call).
4. **Non-active** — a non-active user is denied platform-wide, even with a still-valid JWT: all helpers return null → every RLS predicate fails. **Non-active means `status in ('invited','suspended','archived')` or `deleted_at is not null`** (the helpers admit only `status='active' and deleted_at is null`).
5. **Auth identity removal** — handled in Supabase Auth; the platform row is soft-deleted, never relied upon after.

---

## 4. User Context Model

Four derived context values, mapping **directly** to the existing helper functions in `005`. All are `SECURITY DEFINER`, `STABLE`, with `search_path = ''`, and all filter `status = 'active' and deleted_at is null`. All are executable only by `authenticated`.

| Context value | Helper function | Returns | Derived from |
|---|---|---|---|
| Current user id | `private.current_user_id()` | `uuid` | `public.users.id` where `auth_user_id = auth.uid()` |
| Current organization | `private.current_organization_id()` | `uuid` | `public.users.organization_id` |
| Current department | `private.current_department_id()` | `uuid` | `public.users.department_id` |
| Current role | `private.current_role()` | `text` | `public.users.role` |

Supporting helpers (also from `005`): `private.current_email()` and `private.is_org_admin()` (returns `current_role() = 'org_admin'`).

**Contract:** these functions are the *only* sanctioned source of caller context. No consumer may derive organization, department, or role by any other means (not from JWT app-metadata, not from request bodies, not from headers). A null return from any of them means "no valid active identity" and must be treated as unauthenticated/forbidden.

---

## 5. Authentication Flow

```text
User Login
   │  credentials → Supabase Auth
   ▼
Supabase Auth
   │  issues signed JWT (sub = auth.uid())
   ▼
JWT
   │  attached to every request (Authorization: Bearer / Supabase client)
   ▼
Request
   │  Postgres session role = authenticated; auth.uid() available
   ▼
Context Resolution
   │  private.current_user_id() / _organization_id() / _department_id() / _role()
   │  resolve auth.uid() → active public.users row
   ▼
RLS
   │  policies evaluate using the resolved context
   ▼
Allowed rows / actions only
```

If context resolution yields null (no active membership), RLS predicates fail and the request is denied — the JWT being validly signed is necessary but not sufficient.

---

## 6. JWT Contract

### Required Claims (trusted)

| Claim | Meaning | Trust |
|---|---|---|
| `sub` (`auth.uid()`) | Authentication identity | **Trusted** — signed by Supabase Auth; the sole input to context resolution |
| `role` (Postgres role: `authenticated`) | Database role for the session | **Trusted** — set by Supabase, gates which policies/grants apply |
| `exp` / `iat` | Token validity window | **Trusted** — signature-protected |

### Required Derived Values (not in the JWT — resolved server/DB-side)

| Value | Source |
|---|---|
| `current_user_id` | `private.current_user_id()` |
| `current_organization_id` | `private.current_organization_id()` |
| `current_department_id` | `private.current_department_id()` |
| `current_role` (application role) | `private.current_role()` |

### Trusted vs Not Trusted

| Trusted | Not trusted |
|---|---|
| JWT signature and `sub` | Any `organization_id` / `department_id` / `role` in the request body, query, or headers |
| Postgres `authenticated` role | Any app-metadata role claim embedded in the JWT (advisory only; **never** used for authorization) |
| Context resolved from `public.users` via `auth.uid()` | Client assertions about who they are or what they can see |

**Rule:** the application **role** used for authorization is always `private.current_role()`, never a claim the client could influence. If a future need arises to carry agent task scope in the JWT, it is treated as a *hint* and re-validated against the database — never as an authorization grant.

---

## 7. Context Resolution Contract

Resolution is **single-path and server-authoritative**:

```text
auth.uid()  ──►  public.users (status='active', deleted_at is null)
                      │
   organization  ◄────┤  current_organization_id()
   department    ◄────┤  current_department_id()
   role          ◄────┤  current_role()
   identity      ◄────┘  current_user_id()
```

| Scope | Resolved by | Hard rule |
|---|---|---|
| **Organization** | `private.current_organization_id()` | The tenant boundary. Never accepted from client input. Every RLS policy pins `organization_id = private.current_organization_id()`. |
| **Department** | `private.current_department_id()` | Default scope for non-admin roles. A client may *request* a department view, but it is validated against the caller's actual scope; org_admin may span departments within the org. |
| **Role** | `private.current_role()` | Capability class. Never read from a client-supplied value or a JWT app-claim. |

> **Never trust client-supplied scope.** Organization, department, and role are derived exclusively from the authenticated identity through the `private.*` helpers. Any scope value present in a request payload is, at most, a filter *within* the caller's permitted set — never a means to widen it.

---

## 8. Authorization Layers

Authorization is enforced in five ordered layers. Each is necessary; none replaces another.

| Layer | Name | What it does | Authority |
|---|---|---|---|
| **1** | **Authentication** | Validate the JWT; establish `auth.uid()` and the `authenticated` Postgres role | Supabase Auth |
| **2** | **Context Resolution** | Resolve `auth.uid()` → active `public.users`; derive org/department/role via `private.*` | `005` helper functions |
| **3** | **RLS** | Enforce row visibility and mutation rights using the resolved context | Policies `005`–`020` (authoritative) |
| **4** | **Application Rules** | Sequence multi-step operations; validate transitions, approver-role correctness, enum/shape; produce typed errors | API service / Edge Functions (may narrow, never widen) |
| **5** | **Approval Gates** | Block privileged transitions (external delivery, deploys, schedule creation, high-risk decisions) until an `approved` approval exists | [approval-rules.md](approval-rules.md), orchestrated by the app, checked against `approvals` |

A request must pass **all** applicable layers. Layer 4 and 5 can only *further restrict* what Layers 1–3 already permit.

---

## 9. Role Model

The five authoritative roles (`public.users.role`). **No new roles are introduced by this spine.**

### `org_admin`
- **Capabilities:** the only org-wide role; reads/writes all rows in its organization across all departments; resolves approvals per role mapping; full runtime-ops control (`background_jobs`, `scheduled_tasks`, DLQ); sole reader of `audit_events`; manages `public.users` membership (provisioning, role/department changes, suspension).
- **Restrictions:** confined to its own `organization_id` — never cross-organization. Does not bypass RLS (that is service-role only).
- **Escalation paths:** terminal human authority within the org. Cross-org actions do not exist for any authenticated role.

### `department_lead`
- **Capabilities:** read/write within owning department(s); approve department-scoped subjects (work packets, decisions, tasks); create/update schedules owned by their department; resolve DLQ entries for their department's jobs; read department + org-wide metrics.
- **Restrictions:** no cross-department write; cannot read `audit_events`; cannot mutate `background_jobs` (org_admin only); cannot act in another department.
- **Escalation paths:** request `org_admin` for cross-department or org-wide actions; route high-risk items through approval gates.

### `department_member`
- **Capabilities:** read/write core entities within own department (tasks, work packets, decisions, blockers, outputs, research, knowledge); read department schedules and metrics.
- **Restrictions:** no approval authority; no schedule/job mutation; no DLQ resolution; no audit access; department-bound.
- **Escalation paths:** request `department_lead` for approvals and schedule changes.

### `read_only`
- **Capabilities:** department-scoped read of core entities, `scheduled_tasks`, and `runtime_metrics` (dept + org-wide).
- **Restrictions:** no writes anywhere; **explicitly excluded** from `background_jobs` and `agent_activity` reads (per the verified Phase F `020` policies); no audit access.
- **Escalation paths:** request a write-capable role from `org_admin`.

### `agent`
- **Capabilities:** operate on **assigned** tasks; insert `proposed` decisions, `execution_logs`, outputs for assigned work; read knowledge/research scoped to assigned context; insert its **own** `agent_activity`; request approvals.
- **Restrictions:** confined to assigned task scope ∩ Tool Profile; cannot approve; cannot self-insert another agent's identity; cannot perform Category A/B actions autonomously; no audit access.
- **Escalation paths:** route any gated action through the Approval API; out-of-profile tool calls are flagged and blocked.
- **Visibility note (table-specific):** Agent visibility is table-specific. On Phase F runtime tables, agents are constrained to assigned-task or own-activity scope. On earlier core Registry/Governance tables, agent visibility follows the existing Phases A–D RLS policies, which may include department-scoped project or approval visibility. API implementations must not assume a single universal agent visibility rule; they must defer to each table's RLS policy and may only narrow access at the application layer.

---

## 10. Service Role Model

`service_role` is the Postgres role that **bypasses RLS**. It is infrastructure, not a user.

### Responsibilities (allowed)
- Drive `background_jobs` lifecycle (status transitions, retries, backoff).
- Insert `dead_letter_queue` entries on permanent failure (no authenticated INSERT exists — revoked in `019`).
- Ingest/upsert `runtime_metrics` (pipeline-only).
- Write `audit_events` (auth hooks, admin-action records, migration markers) — no authenticated INSERT.
- Update `scheduled_tasks` execution timestamps (`last_run_at`, `next_run_at`).
- Agent-activity system/bypass ingestion path (recording the true `agent_user_id`).
- External I/O: webhook intake/emit, output delivery, scheduled trigger firing.

### Forbidden responsibilities
- **Never** reachable from a browser, agent sandbox, or any client.
- **Never** used as a shortcut to skip RLS for ordinary user operations.
- **Never** allowed to drop tenant isolation: because the DB will not enforce `organization_id` for service-role, every service-role write must carry and respect `organization_id` in application logic.
- **Never** acts anonymously: service-role actions taken on behalf of a human/agent must record that actor in `audit_events.actor_user_id` / `execution_logs.actor`.

The service key lives only in server-side Edge Functions and the job runner (see [phase-g-api-application-layer-plan.md](phase-g-api-application-layer-plan.md) §6, §25).

---

## 11. Agent Identity Model

### Agent users
An agent is a first-class `public.users` row with `role='agent'`, bound to a Supabase Auth identity via `auth_user_id`. It resolves context through the same `private.*` helpers as any user.

### Agent sessions
A logical agent invocation is grouped by an application-generated `session_id` on `agent_activity`. Sessions bound a sequence of activity rows (`session_start` … `session_end`) for one assigned unit of work.

### Agent activity ownership
Each `agent_activity` row is owned by exactly one agent. Ownership is the `agent_user_id` column, and it is **self-pinned** at insert.

### Agent execution identity
The agent acts under its own `agent`-role JWT. Its effective authority is the intersection of: (a) `agent` RLS policies, (b) assigned task scope, (c) Tool Profile boundaries. It holds **no** service-role key.

### Verified Phase F requirement (binding)

```text
agent_user_id = private.current_user_id()
```

The `020` INSERT policy on `agent_activity` enforces, in `WITH CHECK`, both:
- `private.current_role() = 'agent'`, and
- `agent_user_id = private.current_user_id()`.

This was **verified at the database** during Phase F runtime testing: an agent inserting its own id succeeds; an agent attempting to insert any other user's id is rejected by RLS (`new row violates row-level security policy`). No agent can record activity under another identity. This invariant is authoritative and must not be weakened by any application layer.

---

## 12. Request Context Lifecycle

```text
Incoming Request
   │  carries JWT (sub = auth.uid()); session role = authenticated
   ▼
Identity
   │  auth.uid() established; no business attributes trusted from the token
   ▼
Context
   │  private.current_user_id / _organization_id / _department_id / _role
   │  (null context ⇒ deny)
   ▼
Authorization
   │  Layer 3 RLS → Layer 4 app rules → Layer 5 approval gates
   ▼
Execution
   │  permitted reads/writes only; privileged transitions gated
   ▼
Audit
   │  execution_logs (entity), audit_events (platform), agent_activity (agent)
   │  capturing actor identity + role at action time
```

The context is re-resolved on **every** request; there is no cached authorization state that could outlive a role/department/status change.

---

## 13. Multi-Tenant Boundary

### Organization boundary
The hard outer boundary. Every RLS policy pins `organization_id = private.current_organization_id()`. No authenticated role — including `org_admin` — can read or write across organizations. Cross-org access exists only conceptually for `service_role`, and even there it is application-pinned per operation.

### Department boundary
The default inner boundary for non-admin roles, driven by `private.current_department_id()`. Crossed only through explicit, RLS-encoded relationships (e.g., a job related to the caller's department's task), never by client request.

### Cross-tenant denial model
- **Mechanism:** organization-pinned predicates + the deny-by-default posture (RLS enabled, no permissive cross-org policy anywhere).
- **Behavior:** a foreign-tenant row is *invisible*, not "forbidden with a hint" — SELECT returns nothing; an RLS-filtered UPDATE affects zero rows (the verified DLQ member-deny behavior). The application maps this to consistent errors (§19) without leaking existence across tenants.
- **Verified:** cross-department isolation was confirmed in Phase F (Dept A member cannot see Dept B's row; org_admin sees both within the org).

---

## 14. Realtime Context Model

- Realtime subscriptions run under the subscriber's **user JWT** (`authenticated`), so the change feed is **RLS-filtered**: a subscriber receives only changes to rows they could already read.
- Subscriptions inherit organization/department/role scope automatically through the same `private.*` resolution — no separate scope is passed or trusted.
- MVP publication: `tasks`, `approvals`, `blockers` (the data model's designated realtime set).
- **Rule:** a table may be published to realtime only after its RLS SELECT policy is confirmed correct — a realtime channel is exactly as safe as the policy behind it. No service-role realtime is ever exposed to clients; agent-activity oversight is via admin reads, not cross-agent realtime.

---

## 15. API Context Contract

Every API endpoint receives exactly one trusted input about identity: **the authenticated JWT.**

- The API derives **everything else** — user id, organization, department, role — via the `private.*` helpers (executed under the caller's session).
- The API **must not** accept `organization_id`, `department_id`, or `role` as authorization inputs. Such values, if present, are filters within the caller's permitted scope only.
- The API runs client-facing operations as `authenticated` so RLS is always in force; it never substitutes its own row filter for a policy.
- The API may add Layer 4/5 checks (transition validity, approver correctness, approval gates) that *narrow* access and produce typed errors, never widen it.

---

## 16. Edge Function Context Contract

Edge Functions operate in one of two explicit modes; the mode is declared per function and never mixed ambiguously:

| Mode | Identity | RLS | Use |
|---|---|---|---|
| **Authenticated** | Caller's JWT forwarded; `private.*` resolves context | In force | User-initiated server logic that should stay RLS-bound |
| **Service-role** | Service key (server-only) | Bypassed | Enumerated system operations (§10): jobs, DLQ insert, metrics, audit, delivery, schedule firing |

**Rules:** service-role Edge Functions are never invokable directly by a browser or agent; they are triggered by the API service, schedulers, or verified Supabase/webhook events. Inbound external calls (webhooks) authenticate by **signature/secret**, not a user JWT, and resolve the tenant explicitly before any write. Every service-role function carries `organization_id` and records the acting identity for audit.

---

## 17. Agent Runtime Context Contract

- The agent runtime authenticates as an `agent`-role identity and resolves context via `private.*` like any user.
- All agent writes self-pin `agent_user_id = private.current_user_id()` (binding, §11).
- Effective capability = `agent` RLS ∩ assigned task scope ∩ Tool Profile (`command-center-brain` / `execution-worker` / `build-workshop` / `operations-external`).
- The runtime holds **no service key.** A server-side broker may use the service-role bypass path for ingestion, but capability decisions are always made against the agent identity, never the service role.
- Category A/B actions are never autonomous: the runtime requests approval and waits for `approved`. Out-of-profile tool calls are flagged (`execution_logs.status='flagged'`) and blocked.

---

## 18. Audit Context Contract

Every material action records its identity context at the time it occurred.

### `audit_events` (platform security/admin envelope)
- **Actor identity:** `actor_user_id` — the human/agent responsible (nullable for pure system/auth events).
- **Actor role:** `actor_role` — the role snapshotted at event time (so later role changes do not rewrite history).
- **Entity linkage:** optional polymorphic `entity_type` + `entity_id` for the affected entity; `event_category ∈ {auth, security, admin, system, migration}`; `severity ∈ {info, warn, error, critical}`.
- **Write ownership:** `service_role` INSERT only (no authenticated INSERT — `019`); SELECT restricted to `org_admin` (`020`). `ip_address` is PII-adjacent and confined to `org_admin`.

### Complementary audit surfaces
- **`execution_logs`** — entity-scoped action trail (`actor` text: user/agent/system); authoritative for governance.
- **`agent_activity`** — per-agent session trace, owner-pinned (§11).

**Rule:** service-role actions taken on behalf of an actor must populate `actor_user_id`/`actor_role` (or `execution_logs.actor`) so that no privileged action is anonymous.

---

## 19. Error Model

Standard auth/authz errors, aligned with the layered model and the RLS-as-invisibility behavior:

| Class | HTTP | Trigger | Layer |
|---|---|---|---|
| `unauthenticated` | 401 | Missing/invalid JWT, or null `current_user_id` (non-active/unprovisioned) | 1–2 |
| `forbidden` | 403 | User is allowed to know the resource exists but lacks permission for the attempted action (e.g., role/approver mismatch on a visible row) | 3–4 |
| `not_found` | 404 | Row not visible under RLS — the **default for unauthorized reads**, to prevent existence leaks | 3 |
| `approval_required` | 409 | Privileged transition without an `approved` approval | 5 |
| `conflict` | 409 | Illegal transition / terminal-state mutation | 4 |
| `validation` | 422 | Bad enum/shape/constraint | 4 |
| `rate_limited` | 429 | Throttle | 4 |
| `internal` | 500 | Unexpected | — |

**Invisibility rule (locked decision):** unauthorized reads resolve to `not_found` **by default** to prevent existence leaks — because cross-tenant/cross-department rows are invisible under RLS (SELECT empty; UPDATE affects 0 rows), the API must not confirm the existence of out-of-scope data. `forbidden` is used **only** when the user is allowed to know the resource exists but lacks permission for the attempted action (e.g., a visible row they may read but not approve/mutate). This choice is binding and applied consistently across every API group.

---

## 20. Security Threats

| # | Threat | Description |
|---|---|---|
| T1 | **JWT spoofing** | Forged/tampered token attempting to assert an identity. |
| T2 | **Scope injection** | Client supplies `organization_id`/`department_id`/`role` to widen access. |
| T3 | **Service-role leakage** | Service key reaches a browser/agent/log → total RLS bypass. |
| T4 | **Agent impersonation** | An agent inserts/acts under another agent's `agent_user_id`. |
| T5 | **Cross-org access** | A user reads/writes another organization's data. |
| T6 | **Stale role assignments** | A revoked/changed role still grants access via a cached or long-lived session. |

---

## 21. Security Controls

| Threat | Controls |
|---|---|
| **T1 JWT spoofing** | Supabase Auth signature verification; only `sub` + Postgres `authenticated` role trusted; context derived from DB, so a forged app-claim grants nothing. |
| **T2 Scope injection** | Context resolved exclusively via `private.*`; client scope treated as a filter within permitted set, never an authorization input (§7, §15); RLS pins `organization_id`/department independently. |
| **T3 Service-role leakage** | Service key server-only, physically isolated to Edge Functions/job runner; never in client bundles; CI secret scanning; no service-role path callable by clients (§10, §16). |
| **T4 Agent impersonation** | `020` `WITH CHECK`: `current_role()='agent'` AND `agent_user_id = private.current_user_id()` — **DB-verified** (§11); negative test enforced in CI. |
| **T5 Cross-org access** | Every policy pins `organization_id = private.current_organization_id()`; deny-by-default; no cross-org policy exists; even `org_admin` is org-bound; verified isolation tests. |
| **T6 Stale roles** | Context re-resolved every request from live `public.users`; suspension (`status`/`deleted_at`) nulls all helpers → immediate platform-wide denial; no cached authorization; short token lifetimes + refresh. |

---

## 22. Testing Requirements

The verified Phase F harness pattern is the standard: `begin; set local role authenticated; set local "request.jwt.claim.sub" = '<auth_user_id>'; … rollback;`.

| Area | Required tests |
|---|---|
| **Context resolution** | Active user resolves correct org/dept/role; non-active user → all helpers null → denied. |
| **Org isolation** | Two-org fixture: no cross-org read/write on any table; org_admin bound to own org. |
| **Department scoping** | Dept A cannot see Dept B (re-confirm); lead/member/read_only scope correctness. |
| **Role matrix** | Each of the five roles against representative tables matches §9 capabilities/restrictions. |
| **read_only exclusions** | `read_only` denied on `background_jobs` and `agent_activity` (Phase F-specific). |
| **Agent identity pin** | Positive (own id inserts) + negative (other id rejected) on `agent_activity` — both already verified, kept as regression. |
| **Scope injection** | Requests carrying foreign `organization_id`/`department_id`/`role` gain nothing. |
| **Service-role boundary** | Service key absent from any client bundle; service-role functions unreachable by clients. |
| **Stale role** | Role/department change reflects on next request; suspension denies immediately. |
| **Error model** | Correct class/HTTP per failure; reads default to `not_found` (no existence leak). |
| **Realtime scope** | Subscribe-as-role: only authorized rows stream. |

All verification uses `BEGIN … ROLLBACK` so the system of record is never mutated.

---

## 23. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Service-role key exposure → full bypass | High | Physical isolation, server-only, CI scanning (T3 controls). |
| 2 | A consumer reading role/scope from JWT app-claims instead of `private.*` | High | This contract mandates `private.*` as the only source; code review + tests for scope injection. |
| 3 | App-layer gate (e.g., output delivery) diverges from RLS | High | Centralize Layer-5 checks; consider DB triggers for the highest-risk gates in a later hardening phase. |
| 4 | Long-lived tokens delaying role-revocation effect | Medium | Short token lifetime + refresh; suspension nulls context immediately regardless of token validity. |
| 5 | Inconsistent 403/404 leaking existence | Medium | Standardize the invisibility rule (§19) across all groups. |
| 6 | Realtime published ahead of RLS review | Medium | Gate every published table behind a confirmed SELECT policy (§14). |
| 7 | Agent task-scope hints in JWT treated as grants | Medium | Hints are always re-validated against the DB; never authoritative. |

---

## 24. Recommended Implementation Order

1. **Identity bridge & liveness** — confirm `auth.uid()` → active `public.users` resolution and the null-context denial path end-to-end (Layers 1–2).
2. **Context contract surface** — expose `private.*`-derived context to the API/Edge/agent consumers as the single sanctioned source (no client scope).
3. **Authorization passthrough** — wire client-facing operations as `authenticated` so RLS (Layer 3) governs every read/write; add the typed error envelope (§19).
4. **Role-matrix conformance suite** — implement the §22 tests, including the verified agent pin and `read_only` exclusions, as CI regression.
5. **Service-role isolation** — stand up the sealed service-role boundary (Edge Functions/job runner) with carried `organization_id` and actor recording (Layer 4 system paths).
6. **Approval-gate hook** — integrate Layer-5 checks against `approvals` for privileged transitions.
7. **Realtime scope** — enable `tasks`/`approvals`/`blockers` subscriptions under user JWT after policy confirmation.
8. **Audit context wiring** — ensure `audit_events`/`execution_logs`/`agent_activity` capture actor identity + role at action time.

Steps 1–4 establish the enforceable spine; 5–8 complete the contract for async, agents, realtime, and audit.

---

## 25. Definition of Done

The spine is complete when **all** hold:

- [ ] Every consumer (frontend, API, Edge Function, agent, realtime) resolves identity and scope **only** through Supabase Auth + the `private.*` helpers — no client-supplied scope is ever trusted.
- [ ] A null context (non-active/unprovisioned user) is denied platform-wide, with a valid JWT being insufficient.
- [ ] Organization isolation and department scoping pass the §22 tests on every table; cross-org access is impossible for `authenticated`.
- [ ] The agent identity pin (`agent_user_id = private.current_user_id()` with `role='agent'`) is enforced and covered by positive + negative regression tests.
- [ ] `read_only` exclusions on `background_jobs` and `agent_activity` are verified.
- [ ] The service-role boundary is sealed: key is server-only, unreachable by clients, carries `organization_id`, and records the acting actor.
- [ ] The five-layer authorization order is honored; Layers 4–5 only narrow, never widen, Layers 1–3.
- [ ] The error model (§19) is applied consistently, with reads defaulting to `not_found` to prevent existence leakage.
- [ ] Audit surfaces capture actor identity and role at action time.
- [ ] No new roles, no new auth providers, no schema changes were introduced; migrations `001`–`020` remain the substrate.

---

## Document Boundaries

This is Phase G1 **architecture output** — the authoritative auth/context contract. It introduces no code, migrations, schema changes, or implementations and preserves the deployed architecture (Supabase Auth as identity provider, RLS as authorization layer, the `005` `private.*` helpers as context source). Implementation proceeds against §24 with RLS remaining authoritative and Supabase remaining the system of record.
