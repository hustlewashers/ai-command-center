# Phase G10 — Deployment Architecture

The minimum viable deployment architecture for the **AI Command Center**, defining how the verified Supabase runtime (migrations `001`–`020`) and the G1–G9 application architecture are built, hosted, secured, and shipped before Sprint 1 implementation begins.

> **Auth spine:** [phase-g1-auth-context-spine.md](phase-g1-auth-context-spine.md)
> **API layer plan:** [phase-g-api-application-layer-plan.md](phase-g-api-application-layer-plan.md)
> **Application service architecture:** [phase-g9-application-service-architecture.md](phase-g9-application-service-architecture.md)
> **Realtime plan:** [phase-g-realtime-publication-plan.md](phase-g-realtime-publication-plan.md)
> **Tool boundaries:** [tool-stack.md](tool-stack.md)
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md)

This document is **architecture and decision-record only**. It introduces no code, no migrations, no configuration files, and no schema changes. It locks the deployment decisions needed to unblock Sprint 1 and defers everything that does not yet have a concrete consumer.

## Confirmed Pre-Conditions

- Phases A–F complete; migrations `001`–`020` applied to project `wbtvrzivthuqqntnorsw`.
- G1–G9 architecture documentation complete; the three readiness-review documentation fixes applied.
- Full Architecture Readiness Review verdict: **PARTIAL → READY** once the deployment architecture is sketched (this document) and the expiry-sweep reporter-ID decision is made.
- The `tool-stack.md` `build-workshop` profile already names `data.supabase`, `code.github`, and `infra.vercel` as the sanctioned integrations, with "production deployments and secret management require approval." This document is consistent with that tool stack — it does not introduce a new toolchain.

---

## 1. Purpose

This document defines the **minimum viable deployment architecture** required to begin implementation. It answers the questions Sprint 1 cannot start without:

1. **Where does the application run?** (hosting target, API service shape)
2. **How does code reach production?** (environments, CI/CD, migration workflow)
3. **How is the service-role key protected?** (secret strategy, the single highest-stakes deployment control)
4. **How is the verified database preserved as the system of record across environments?** (Supabase strategy, migration discipline)

The scope is deliberately narrow: enough to stand up a local dev environment against the live Supabase project, ship a human MVP, and never leak the service key. It is not a full SRE/platform-engineering plan; capacity planning, multi-region, blue-green, and autoscaling are explicitly deferred until a real consumer and real load exist.

---

## 2. Scope

### In scope
- The hosting decision for the frontend + API service
- The Supabase project/branching strategy across environments
- Edge Function role and boundary
- The service-role secret strategy (storage, rotation, isolation)
- Local / staging / production environment definitions
- Migration workflow and CI/CD minimums
- GitHub and Vercel workflow shape
- Test execution placement in the pipeline
- Rollback and basic observability
- The deployment-specific security rules

### Non-Goals
- No code, config files, CI YAML, or `.env` templates (this is a decision record; artifacts come in Sprint 1)
- No microservice decomposition (MVP is one Next.js app + Supabase Edge Functions, per G9)
- No multi-region, autoscaling, blue-green, or canary infrastructure
- No new authorization model, schema, or migration (RLS `005`–`020` remains authoritative)
- No domain (GovCon) deployment specifics
- No realtime enablement (deferred per the realtime plan until frontend subscription work begins)

---

## 3. Deployment Principles

| # | Principle | Consequence |
|---|---|---|
| 1 | **Supabase is the system of record in every environment** | The application never holds authoritative state; each environment points at exactly one Supabase project, and the database is the source of truth for that environment. |
| 2 | **The service-role key is the crown jewel** | It bypasses RLS entirely. It lives only in server-side secret stores, never in client bundles, never in git, never in logs. Every other deployment control is secondary to this one. |
| 3 | **Two trust tiers map to two runtime contexts** | Client-Safe code (browser + RLS-bound server) holds only the publishable/anon key. Service-Role code (Edge Functions, server-only job runner) holds the service key. They are physically separated. |
| 4 | **Migrations are the only way schema changes ship** | No console clicks against production. Schema evolves through sequential, reviewed, additive migrations in version control; CI verifies them. |
| 5 | **Environments are isolated and promote forward** | local → staging → production. Code and migrations flow one direction; secrets never cross environments. |
| 6 | **CI gates correctness before deploy** | At minimum: lint, typecheck, and Supabase migration/lint checks when available. A red pipeline does not deploy. |
| 7 | **Everything is reversible** | Every deploy can roll back; every migration is additive or has a documented down path; nothing destructive ships without an explicit, reviewed exception. |
| 8 | **Least privilege at the edge** | Browsers get the anon key + user JWT. Build/deploy automation gets scoped tokens. Humans get production access only through reviewed, audited paths (consistent with `tool-stack.md`: production deploys require approval). |

---

## 4. Application Hosting Decision

**Decision: a single Next.js application deployed to Vercel.** *(Locked — consistent with `tool-stack.md` `infra.vercel`; no repo evidence contradicts it.)*

| Concern | Decision | Rationale |
|---|---|---|
| App shell | **Next.js (App Router)** | The natural pairing with Supabase + Vercel; first-class Supabase SSR/auth helpers; a single framework hosts both the human frontend and the Client-Safe API (route handlers / server actions), matching the G9 "single API service + agent runtime" MVP shape. |
| Hosting target | **Vercel** | Named in `tool-stack.md` (`infra.vercel`); native Next.js host; integrated preview deployments per PR; environment-scoped secret management; serverless functions for the Client-Safe API tier. |
| Service split | **One deployable for client + Client-Safe API; Supabase Edge Functions for Service-Role** | Avoids premature microservice decomposition (G9 §2 non-goal) while keeping the two trust tiers physically separate (Principle 3). |

**Why not a separate standalone API service for MVP?** G9 §25 keeps the MVP to a single API service plus the agent runtime. Next.js route handlers / server actions running on Vercel *are* that Client-Safe API service. A standalone API can be split out later behind the same `/v1` contract (API layer plan §28) without a client-visible change. This is the documented upgrade path, not a rewrite.

**Boundary restated:** the Next.js app holds the **publishable/anon key** only. It never imports or references the service-role key. The service key lives exclusively in Supabase Edge Functions and any server-only job runner (§7, §8).

---

## 5. API Service Strategy

The application exposes two surfaces, mapped to the two trust tiers from G9 §6:

| Surface | Runtime | Postgres role | Key held | Backs |
|---|---|---|---|---|
| **Client-Safe API** | Next.js route handlers / server actions on Vercel; PostgREST via the Supabase client | `authenticated` (caller's JWT) | anon/publishable | All RLS-bound CRUD and orchestration (API layer plan §5, §9–§20 read/write paths) |
| **Service-Role API** | Supabase Edge Functions (+ optional server-only job runner) | `service_role` | service key | Enumerated service-role operations only (G9 §36 SR-01…SR-13) |

**Client-Safe rules (from G1 §15, G9 §3):**
- Every client-facing call runs under the caller's Supabase Auth JWT so RLS is always in force.
- The API derives org/department/role exclusively via the `private.*` helpers — never from client input.
- The API may add Layer 4/5 checks that *narrow* access (transition validity, approver correctness, approval gates) and produce the typed error envelope (G1 §19); it never widens what RLS allows.
- Simple reads/writes go through PostgREST (least code, RLS already encodes the rules); multi-step orchestration and approval sequencing live in route handlers.

**Versioning:** URI-prefixed `/v1` for the API service; Edge Functions versioned by name/route (API layer plan §28). Additive changes are non-breaking and do not bump the major version. Generated TypeScript types from the database (`generate_typescript_types`) keep client and server aligned.

---

## 6. Supabase Strategy

**Supabase is the system of record in every environment (Principle 1).** Each environment maps to exactly one Supabase project context:

| Environment | Supabase context | Notes |
|---|---|---|
| Local dev | Local Supabase stack (`supabase start`) **or** a dedicated shared dev project | Local stack is preferred for isolation; a shared dev project is acceptable early if local Docker is impractical. Never the production project. |
| Staging | A dedicated staging Supabase project (or a Supabase **branch** of production) | Mirrors production schema; safe to seed with non-production fixtures. |
| Production | The live project `wbtvrzivthuqqntnorsw` | The verified, deployed system of record. Migrations `001`–`020` already applied. |

**Supabase responsibilities (unchanged from the runtime data model §1):** Postgres (system of record), RLS (authoritative authorization), Auth (identity provider), Storage (research-asset binaries), Edge Functions (service-role + external I/O), Realtime (deferred — publication exists, zero member tables).

**Schema parity is mandatory.** Staging and local must carry the same migration head as production before any feature is validated against them. The migration workflow (§13) enforces this; CI verifies it (§14).

**Branching note:** Supabase database branches are the cleanest way to give staging/PR-preview environments an isolated copy of the schema. Whether to use Supabase branches vs. a standing staging project is an implementation choice for Sprint 1; both satisfy the parity requirement. This document does not force one — it requires only that production is never the target of unreviewed schema changes.

---

## 7. Edge Function Strategy

**Decision: Supabase Edge Functions are used *only* for Service-Role operations and external I/O.** *(Locked.)*

Edge Functions are the **sole home of the service key** alongside any server-only job runner. They run in one of the two declared modes (G1 §16); the mode is fixed per function and never mixed:

| Mode | Identity | RLS | Used for |
|---|---|---|---|
| **Authenticated** | Caller JWT forwarded | In force | (Rare) user-initiated server logic that must stay RLS-bound but needs the Edge runtime. Prefer Next.js route handlers for this. |
| **Service-Role** | Service key (server-only) | Bypassed | The enumerated G9 §36 operations: job lifecycle, DLQ insert, metrics/audit emission, schedule firing, approval expiry sweep, webhook intake/emit, output delivery, knowledge sync, agent-activity bypass ingestion. |

**Hard rules (G1 §16, G9 §9):**
- Service-Role Edge Functions are **never** invokable directly by a browser or agent. They are triggered by the API service, schedulers, or verified Supabase/webhook events.
- Inbound webhooks authenticate by **signature/secret**, not a user JWT, and resolve the tenant explicitly before any write.
- Every service-role function carries `organization_id` explicitly and records the acting identity (`audit_events.actor_user_id` / `execution_logs.actor`) — no anonymous privileged mutation.
- A function that writes on behalf of a user must record that actor.

**What does NOT go in Edge Functions:** ordinary RLS-bound CRUD (that is the Client-Safe tier in Next.js), and anything the browser could call directly.

---

## 8. Service-Role Secret Strategy

This is the single most important section of this document. The service-role key bypasses all RLS; its leakage is a total-compromise event (G9 Risk R1, G1 Threat T3).

**Storage:**

| Location | Holds service key? | Holds anon/publishable key? |
|---|---|---|
| Browser bundle / client code | **NEVER** | Yes (publishable is safe by design) |
| Next.js client components | **NEVER** | Yes |
| Next.js server runtime env (Vercel server-side) | Only if a server-only job runner truly needs it; prefer Edge Functions | Yes |
| Supabase Edge Function secrets | **Yes** — this is its home | As needed |
| Supabase project secret store | **Yes** | n/a |
| Git repository (any branch) | **NEVER** | **NEVER** commit keys; use env references |
| CI logs / build output | **NEVER** | **NEVER** |
| Local `.env*` files | Local only, **gitignored** (§9, §17) | Local only, gitignored |

**Isolation controls:**
- The service key is referenced only by Service-Role code paths (§7). Static separation: the client bundle and the agent broker must not import any module that reads the service key (G9 §25 "boundary discipline").
- **CI secret scanning** fails the build if a key-shaped string appears in committed code or client bundles (G1 §21 T3 control).
- **`NEXT_PUBLIC_` discipline:** only the anon/publishable key and non-secret config may use the `NEXT_PUBLIC_` prefix. The service key must never be prefixed `NEXT_PUBLIC_` (that would inline it into the browser bundle). This is a named, testable rule.

**Rotation:**
- The service key is rotatable from the Supabase dashboard; rotation invalidates the old key. Edge Function / job-runner secrets are updated on rotation.
- Rotation is a documented runbook (deferred artifact); MVP requirement is that rotation is *possible without code changes* because the key is referenced by env, never hardcoded.

**Acting identity:** every service-role action records `actor_user_id`/`actor_role` (or `execution_logs.actor`) so no privileged action is anonymous (G1 §10, §18).

---

## 9. Environment Strategy

Three environments, isolated, promoting forward only:

```text
   LOCAL              STAGING                 PRODUCTION
 ┌────────┐         ┌──────────┐            ┌──────────────────┐
 │ dev box│  ─PR─►  │ preview/ │  ─merge─►  │ live project     │
 │ local  │         │ staging  │            │ wbtvrzivthuqq... │
 │ supabase│        │ supabase │            │ migrations 001–020│
 └────────┘         └──────────┘            └──────────────────┘
   anon key           anon key                 anon key
   service key        service key              service key
   (local only)       (staging secret store)   (prod secret store)
```

| Property | Local | Staging | Production |
|---|---|---|---|
| Supabase | local stack or dev project | staging project / branch | `wbtvrzivthuqqntnorsw` |
| Secrets source | gitignored `.env.local` | Vercel + Supabase staging secret stores | Vercel + Supabase production secret stores |
| Data | disposable fixtures | non-production fixtures | real tenant data |
| Who deploys | the developer | CI on PR / merge to staging branch | CI on merge to `main`, production deploy gated by approval (`tool-stack.md`) |
| Schema head | must equal prod migration head | must equal prod migration head | authoritative head |

**Secrets never cross environments.** A staging service key is distinct from production. A leaked staging key cannot touch production data.

---

## 10. Local Development Workflow

**Goal:** a developer can run the full app against an isolated Supabase that carries the same schema as production, without ever touching the production service key.

Shape (artifacts created in Sprint 1, not here):
1. Clone the repo; install dependencies.
2. Start Supabase locally (`supabase start`) — applies migrations `001`–`020` to the local stack — **or** point at the shared dev project.
3. Create `.env.local` (gitignored) with the **local/dev** anon key and, only for local Edge Function testing, the local service key.
4. Run the Next.js dev server against the local Supabase URL.
5. Run the RLS conformance suite (the `BEGIN … ROLLBACK` JWT-impersonation harness from Phase F / G1 §22) against the local stack.

**Rules:**
- `.env.local` and any `.env*` containing secrets are **gitignored** (Principle 2, §17). Locked decision.
- Local never uses the production service key.
- The local schema must match the production migration head before a feature is considered validated.

---

## 11. Staging Strategy

**Purpose:** a production-faithful environment to validate features, run the full test suite against real Supabase RLS, and exercise service-role/Edge paths before they reach production.

- **Schema:** identical migration head to production; migrations applied through the same workflow (§13).
- **Data:** non-production fixtures (two-org, multi-department fixtures for the isolation tests in G1 §22 / G9 §39). No production data.
- **Secrets:** a dedicated staging anon key and staging service key in the staging secret stores. Distinct from production.
- **Deployment:** PR preview deployments (Vercel) and/or a standing staging deployment on merge to a staging branch.
- **Validation gate:** the approval-gate contract tests, cross-org/cross-dept isolation tests, and agent-pin regression must pass here before promotion to production.

Staging is where realtime would first be exercised *when* it is enabled (deferred); until then, staging validates request/response paths only.

---

## 12. Production Strategy

- **Supabase:** the live project `wbtvrzivthuqqntnorsw`, the verified system of record. Migrations `001`–`020` are already applied; future migrations ship only through §13.
- **Hosting:** the Next.js app on Vercel production; Service-Role logic in production Supabase Edge Functions.
- **Access:** production deploys are gated by approval, consistent with `tool-stack.md` (`build-workshop`: "Production deployments and secret management require approval"). No direct console schema edits.
- **Secrets:** production anon + service keys in the production secret stores only.
- **Change flow:** code and migrations reach production only via merge to `main` + green CI + (for production) an approval gate. Nothing skips CI.

---

## 13. Migration Workflow

**Migrations are the only sanctioned way schema changes ship (Principle 4).** The repo's `supabase/migrations/` directory is the authoritative, sequential history (`001`–`020` today).

Workflow for any future schema change:
1. Author a new sequential migration file (`0NN_description.sql`) — next number after the current head. Additive by convention (the existing migration discipline; the API tolerates added columns, API layer plan §28).
2. Apply locally (`supabase db reset` / `supabase migration up`) and run the RLS conformance suite.
3. Open a PR. CI runs `supabase db lint` and verifies migrations apply cleanly to a fresh database (§14).
4. Merge → apply to staging → validate → apply to production through the gated path.

**Rules:**
- No console-driven schema changes against staging or production. Drift is prohibited.
- Down/rollback path documented per migration where feasible (e.g., the realtime enable migration's down path is `ALTER PUBLICATION … DROP TABLE …`, realtime plan §9).
- Idempotency guards where appropriate (existence checks) so re-runs are safe.
- This document does **not** author any migration; the next concrete one is the deferred realtime-publication migration, triggered by frontend subscription work.

---

## 14. CI/CD Strategy

**Minimum CI gates (Principle 6) — must be green before deploy:**

| Gate | What it checks | When available |
|---|---|---|
| **Lint** | Code style / static rules | Sprint 1 (once code exists) |
| **Typecheck** | TypeScript types, including generated Supabase types vs. live schema (drift fails the build, API layer plan §28 / Risk R10) | Sprint 1 |
| **Supabase migration check** | Migrations apply cleanly to a fresh DB; `supabase db lint` is clean | Now (migrations exist) / Sprint 1 wiring |
| **RLS conformance suite** | The `BEGIN … ROLLBACK` JWT-impersonation tests (G1 §22): cross-org isolation, cross-dept scoping, agent-pin positive+negative, `read_only` exclusions, governance INSERT 42501s | Sprint 1 onward |
| **Secret scan** | No service-key-shaped string in committed code or client bundle (G1 §21 T3) | Sprint 1 |

**CD shape:**
- PR → Vercel preview deployment + full CI.
- Merge to staging branch → staging deploy (auto).
- Merge to `main` → production deploy **gated by approval** (`tool-stack.md`).
- A red pipeline never deploys.

CI/CD config files are a Sprint 1 artifact; this section locks *what* CI must do, not the YAML.

---

## 15. GitHub Workflow

Consistent with `tool-stack.md` (`code.github`):

- **Trunk-based with short-lived feature branches.** `main` is the production-tracking branch; work happens on feature branches and merges via PR. (Matches the repo's current `main`-centric layout.)
- **PRs are the unit of review.** Every change — code or migration — lands through a PR with green CI.
- **Branch protection on `main`:** required CI checks, required review. No direct pushes to `main`.
- **Migrations reviewed like code:** a PR touching `supabase/migrations/` gets schema review; the additive convention is enforced in review.
- **No secrets in git, ever** (§8, §17); `.gitignore` covers `.env*` and any secret material.
- **Generated artifacts** (e.g., Supabase TypeScript types) are regenerated in CI and drift-checked, not hand-edited.

A staging branch (or environment-mapped branches) is acceptable if the team wants an explicit staging promotion step; otherwise PR previews + `main` cover the three environments.

---

## 16. Vercel / Hosting Workflow

- **Project link:** the Next.js repo is linked to a Vercel project; `main` → Production, PRs → Preview deployments, optional staging branch → a staging alias.
- **Environment variables are environment-scoped** in Vercel: Production, Preview, and Development each carry their own values. The **service key is never set as a `NEXT_PUBLIC_` variable** and ideally is not set on Vercel at all (it belongs in Supabase Edge Function secrets); if a server-only job runner on Vercel genuinely needs it, it is a server-scoped (non-`NEXT_PUBLIC_`) Production/Preview secret, never exposed to the client.
- **Preview = staging-grade validation:** preview deployments point at the staging/branch Supabase context, not production, so PRs are validated without touching production data.
- **Build output is scanned** (secret scan, §14) before promotion.
- **Production promotion is gated by approval** (`tool-stack.md`), either via a manual promote step or a protected `main` merge.

---

## 17. Supabase Secrets Handling

Concrete handling rules (extends §8):

| Secret | Where it lives | Where it must NOT live |
|---|---|---|
| **anon / publishable key** | Vercel env (all scopes), `.env.local`, client bundle (safe by design) | — (safe to expose) |
| **service-role key** | Supabase Edge Function secrets; production/staging server secret stores; `.env.local` for local Edge testing only | client bundle, `NEXT_PUBLIC_*`, git, CI logs, agent runtime, browser |
| **JWT / Auth signing** | Managed by Supabase Auth | application code |
| **Webhook signing secrets** | Edge Function secrets (server-only) | client, git, logs |
| **External integration credentials** (SMTP, outbound webhook targets) | Edge Function / job-runner secrets | client, git, logs, `execution_logs`/`agent_activity` metadata (G9 §25) |

**Rules:**
- `.env.local` and all secret-bearing `.env*` files are **gitignored** (locked). A committed `.env.example` may document *variable names* with empty/placeholder values — never real keys.
- Secrets are injected at runtime from the environment's secret store; they are never baked into build artifacts.
- Rotation updates the secret store only; no code change required (§8).
- Secret scanning in CI is the backstop against accidental commits.

---

## 18. Test Execution Strategy

Placement of the test architecture already defined in G1 §22, G9 §39, and the API layer plan §29:

| Test layer | Where it runs | Against |
|---|---|---|
| **Unit / typecheck / lint** | CI on every PR | code only |
| **RLS conformance** (`BEGIN … ROLLBACK` JWT impersonation) | CI + local | a real Supabase with migrations applied (local stack in CI, or staging) |
| **Cross-org / cross-dept isolation** | CI | two-org / multi-dept fixtures on staging-grade DB |
| **Agent identity pin** (positive + negative) | CI regression | real RLS |
| **Governance INSERT exclusions** (decisions/approvals/blockers → 42501 for agent) | CI regression | real RLS |
| **Approval-gate contract tests** (every gate: blocked→409, approved→success; incl. `won_t_fix → open` keystone) | CI | app + real DB |
| **Service-role boundary** | CI | static scan (key absent from client bundle) + Edge Function integration tests |
| **External integration** (signature, idempotency, delivery gating, retry/DLQ) | staging | simulated webhook/delivery harness |
| **Realtime** | staging, **after** enablement | subscribe-as-role tests |

**Non-mutating guarantee:** all DB verification uses the `BEGIN … ROLLBACK` harness so the system of record is never mutated by tests (G1 §22, API layer plan §29).

---

## 19. Rollback Strategy

Everything is reversible (Principle 7):

| Layer | Rollback mechanism |
|---|---|
| **Application (Vercel)** | Instant redeploy of the previous build (Vercel keeps immutable deployments); promote the last-known-good deployment. |
| **Edge Functions** | Redeploy the prior function version (versioned by name/route). |
| **Schema (migrations)** | Forward-fix preferred (a new additive corrective migration). Where a down path exists it is documented per migration (e.g., realtime publication drop). Destructive rollbacks require an explicit, reviewed exception. |
| **Secrets** | Rotation; the old key is invalidated, the new key propagated to secret stores. |
| **Data** | Supabase point-in-time recovery / backups for production (a deferred runbook detail; the requirement is that production has backups enabled before real tenant data lands). |

**Rule:** prefer roll-forward for schema (additive corrective migration) over destructive down-migrations against production, consistent with the additive migration convention.

---

## 20. Monitoring / Observability

MVP observability leans on what the verified runtime already provides, plus host-level signals:

| Signal | Source |
|---|---|
| **Platform audit** | `audit_events` (org_admin read; service-role write) — auth, admin, system, migration events (G9 §35) |
| **Entity action trail** | `execution_logs` (per task/request/output) |
| **Agent session trace** | `agent_activity` |
| **Runtime metrics** | `runtime_metrics` (dept-scoped + org-wide reads) |
| **Failure queue** | `dead_letter_queue` (review/resolve surface) |
| **Application logs / errors** | Vercel function logs; Supabase logs/Logflare |
| **Edge Function logs** | Supabase Edge runtime logs |

**Rules:**
- No realtime on `audit_events`/`runtime_metrics` — admin polled reads (G9 §34, realtime plan §5).
- `audit_events.ip_address` is PII-adjacent: confined to `org_admin`, never projected to other roles or into application log lines that non-admins can read (G9 §35).
- Secrets never appear in any log stream (§8, §17).

Dashboards, alerting thresholds, and SLOs are deferred until there is production traffic to observe.

---

## 21. Security Rules

The deployment-specific security rules, consolidating G1 §20–§21 and G9 §31–§32 controls into deploy-time guarantees:

1. **Service key isolation** — service-role key only in Edge Function / server-only secret stores; never in client bundles, `NEXT_PUBLIC_*`, git, or logs. CI secret scan enforces.
2. **Two-tier physical separation** — client + agent code paths never import a module that can read the service key (G9 §25).
3. **Anon key + user JWT for all client access** — RLS is always in force on the Client-Safe tier; the app never substitutes its own row filter for a policy.
4. **No client-supplied scope** — `organization_id`/`department_id`/`role` are never accepted as authorization input; derived from `private.*` (G1 §15).
5. **Webhook authenticity before any write** — inbound external calls verify signature/secret and resolve tenant before touching the DB (G9 §25).
6. **Environment secret isolation** — staging and production keys are distinct; secrets never cross environments.
7. **Production change control** — schema changes only via reviewed migrations; production deploys gated by approval (`tool-stack.md`).
8. **Branch protection** — `main` requires green CI + review; no direct pushes; no secrets in history.
9. **Backups before real data** — production point-in-time recovery / backups enabled before live tenant data lands.
10. **Audit completeness** — every service-role action records the acting identity; no anonymous privileged mutation (G1 §10, §18).

---

## 22. MVP Deployment Sequence

The order in which to stand up the deployment substrate, aligned to the API layer plan build order (§31) and G1 §24:

1. **Repo + app scaffold** — Next.js app linked to a Vercel project; `.gitignore` covers `.env*`; `.env.example` documents variable names only.
2. **Supabase wiring (dev)** — local Supabase stack (or dev project) carrying migrations `001`–`020`; anon key in `.env.local`; confirm `private.*` context resolution end-to-end (G1 §24 step 1).
3. **CI skeleton** — lint + typecheck + `supabase db lint` + migration-applies-clean + secret scan on every PR (§14). Red blocks merge.
4. **RLS conformance suite in CI** — the G1 §22 tests (cross-org, cross-dept, agent pin, `read_only` exclusions, governance INSERT 42501s) running against a fresh Supabase in CI.
5. **Staging environment** — staging Supabase (project or branch) at the production migration head; Vercel preview pointed at staging; non-production fixtures seeded.
6. **Service-role boundary** — first Edge Function(s) for the enumerated SR operations needed early (e.g., audit emission), service key only in Edge secrets; static scan proves the key is absent from the client bundle.
7. **Production promotion path** — `main` → production deploy gated by approval; production secret stores populated; backups enabled.
8. **Then Sprint 1 feature work** — Auth Context Spine + Client-Safe read layer (API layer plan §31 steps 1–2) ship through this pipeline.

Steps 1–4 are the minimum to begin Sprint 1 coding; 5–7 are completed during Sprint 1 before the first production-facing feature.

---

## 23. Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Service-role key leakage** into the client bundle / `NEXT_PUBLIC_*` / git → total RLS bypass | High | Key only in Edge/server secret stores; CI secret scan; two-tier physical separation; `NEXT_PUBLIC_` discipline (§8, §17, §21). |
| R2 | **Environment drift** — staging/local schema diverges from production | Medium | Migrations are the only schema path (§13); CI verifies clean apply; parity required before validation (§6, §11). |
| R3 | **Console-driven production change** bypassing migrations | Medium | Production change control + branch protection + approval gate (§12, §15, §21). |
| R4 | **Secrets committed to git** | High | `.gitignore` for all `.env*`; `.env.example` holds names only; CI secret scan; no real keys in history (§17). |
| R5 | **Generated-types vs live-schema drift** breaking the client/server contract | Low | Regenerate types in CI; fail the build on drift (§14, API layer plan §28). |
| R6 | **Preview deployments pointed at production data** | High | PR previews use the staging/branch Supabase context, never production (§16). |
| R7 | **Realtime enabled prematurely** during deployment setup with no consumer | Medium | Realtime deferred per the realtime plan; not part of MVP deployment; publication stays at zero member tables until frontend subscription work (§2, §6, §20). |
| R8 | **Edge Function used for RLS-bound CRUD**, blurring the trust tiers | Low | Edge Functions are Service-Role-only (§7); ordinary CRUD stays in the Client-Safe Next.js tier. |
| R9 | **No production backups before real data lands** | High | Backups / PITR enabled as a gate before production tenant data (§19, §21 rule 9). |
| R10 | **Approval gate for production deploys not wired**, contradicting tool-stack | Medium | Production promotion gated by approval per `tool-stack.md` (§12, §14, §16). |

---

## 24. Definition of Done

This deployment architecture is satisfied — and Sprint 1 is unblocked — when **all** hold:

**Decisions locked:**
- [ ] App shell = Next.js; host = Vercel; one deployable for client + Client-Safe API; Supabase Edge Functions for Service-Role only.
- [ ] Supabase is the system of record in every environment; production is `wbtvrzivthuqqntnorsw`.
- [ ] Service-role key strategy defined: Edge/server secret stores only; never client/`NEXT_PUBLIC_`/git/logs.
- [ ] Three environments (local / staging / production) defined with isolated, non-crossing secrets.

**Substrate stood up (during the MVP deployment sequence):**
- [ ] Repo scaffolded; `.env*` gitignored; `.env.example` documents names only.
- [ ] Local/dev Supabase carries migrations `001`–`020`; `private.*` resolution verified end-to-end.
- [ ] CI runs lint + typecheck + `supabase db lint` + clean-migration-apply + secret scan; red blocks merge.
- [ ] RLS conformance suite (G1 §22) runs in CI against a real Supabase.
- [ ] Staging environment at production migration head with non-production fixtures.
- [ ] First Service-Role Edge Function ships with the key only in Edge secrets; client-bundle scan confirms the key is absent.
- [ ] `main` protected; production deploy gated by approval; production backups/PITR enabled before real data.

**Invariants preserved:**
- [ ] No migration, schema change, or code was introduced by this document.
- [ ] RLS (`005`–`020`) remains the primary authorization layer; the app may only narrow.
- [ ] Realtime remains deferred (publication at zero member tables) until frontend subscription work.
- [ ] Every service-role path carries `organization_id` and records the acting identity.

**Open decisions tracked elsewhere (not blockers for this document):**
- [ ] Expiry-sweep reporter-ID decision (which system user populates `blockers.reported_by_user_id` on approval-expiry-raised blockers) — owned by the Approval/Blocker implementation, flagged in the readiness review and G9 Risk R7.
- [ ] Supabase branch vs. standing staging project — implementation choice in Sprint 1; either satisfies schema parity.

---

## Document Boundaries

This is Phase G10 **deployment-architecture and decision-record output**. It introduces no code, configuration files, migrations, or schema changes, and modifies no prior plan. It locks the hosting, environment, secret, migration, and CI/CD decisions required to begin Sprint 1, consistent with `tool-stack.md` (`data.supabase`, `code.github`, `infra.vercel`), with Supabase remaining the system of record and RLS (`005`–`020`) remaining the primary authorization layer. Configuration artifacts (CI YAML, `.env.example`, Vercel/Supabase project setup) are produced in Sprint 1 against the decisions recorded here.
