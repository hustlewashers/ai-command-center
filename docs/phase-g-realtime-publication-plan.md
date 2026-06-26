# Phase G — Realtime Publication Plan

> **Status:** Analysis / decision document. **No realtime is enabled by this plan. No migration is created. No schema is modified.** This document defines *whether and how* to enable Supabase Realtime for `tasks`, `approvals`, and `blockers`, and recommends timing.

---

## 1. Purpose

The runtime data model names `tasks`, `approvals`, and `blockers` as the MVP realtime publication set, but the live database does not carry those tables in any publication. This plan resolves that gap by deciding three things explicitly:

1. **Whether** realtime push for these tables is required for the MVP, and if so for which use cases.
2. **How** it would be enabled safely — the publication mechanics, the RLS interaction, and the replica-identity decision — without guessing.
3. **When** it should be done: now, or deferred until the frontend that consumes the channel actually exists.

The plan is intentionally narrow. It does not design subscription APIs, channel naming, or client code. It establishes the contract and the gating decision so that no G-phase API plan continues to *promise* realtime delivery as a live guarantee while the publication is empty.

---

## 2. Current Documented Intent

The runtime data model (`docs/supabase-runtime-data-model.md`) states the intent in two places:

- **Capability table (§ Supabase capabilities):** *"Realtime — Pushes status changes for Tasks, Approvals, and Blockers to active sessions."*
- **Build-order step 28:** *"Realtime publication for `tasks`, `approvals`, `blockers`."*

The G3/G4/G5 API plans inherited this intent and reference a realtime channel for status/assignment/approval changes. The intent is therefore: **three tables, status-change push, scoped to active authenticated sessions, enforced by the same RLS that governs reads.** No other table was ever in the documented realtime set.

This is **intent**, not deployed state. Step 28 sits in the Phase F build order but was never materialized as a publication membership.

---

## 3. Live Database Finding

Verified directly against the live project (`wbtvrzivthuqqntnorsw`) on 2026-06-24:

**The `supabase_realtime` publication exists but is empty.**

```
pg_publication:
  pubname = supabase_realtime
  puballtables = false        -- not a FOR ALL TABLES publication
  pubinsert = t, pubupdate = t, pubdelete = t, pubtruncate = t

pg_publication_tables:
  (no rows)                   -- zero member tables, for any publication
```

So the earlier shorthand "no publication" was imprecise. The accurate finding is:

| Fact | Live value |
|------|-----------|
| Does `supabase_realtime` publication exist? | **Yes** (Supabase default, created at project init) |
| Is it `FOR ALL TABLES`? | **No** (`puballtables = false`) — membership is explicit/opt-in |
| Are `tasks` / `approvals` / `blockers` members? | **No** — `pg_publication_tables` returns zero rows |
| Which DML events would publish if a table were added? | insert, update, delete, truncate (all enabled on the publication) |

**Replica identity and RLS for the three candidate tables:**

| Table | RLS enabled | RLS forced | Replica identity |
|-------|-------------|------------|------------------|
| `tasks` | yes | no | `default` (primary key) |
| `approvals` | yes | no | `default` (primary key) |
| `blockers` | yes | no | `default` (primary key) |

**Interpretation:** enabling realtime for these tables is *additive and small* — it does not require creating a publication (one exists) or enabling RLS (already on). It requires (a) adding each table to `supabase_realtime`, and (b) a deliberate decision on replica identity, because `default` (PK-only old image) constrains what UPDATE/DELETE events can carry and therefore what RLS can filter on the **old** row image.

---

## 4. Tables in Scope

Exactly three, matching the documented intent — no more:

| Table | Why realtime is wanted | Dominant event |
|-------|------------------------|----------------|
| `tasks` | Status and assignment changes drive the operator dashboard and agent work surface | UPDATE (status, `assigned_to_user_id`) |
| `approvals` | A pending gate resolving (approved/rejected/withdrawn) must reach the waiting requester and approvers without polling | INSERT (new gate), UPDATE (resolution) |
| `blockers` | A blocker opening or resolving changes whether dependent work can proceed | INSERT (opened), UPDATE (resolved) |

For all three, the **UPDATE** event is the primary signal (a status transition). INSERT matters for `approvals` and `blockers` (a new gate / new blocker appearing). DELETE is **not** a meaningful signal — none of these tables is hard-deleted on the authenticated path (removal is `deleted_at` via UPDATE), so a DELETE event would only ever originate from a service-role/maintenance path.

---

## 5. Tables Out of Scope

Everything else. Explicitly **not** in the realtime set, and this plan does not propose adding them:

- `work_packets` — deliberately read/request-response per the G4 plan; no agent SELECT path; never named in the realtime intent.
- `decisions`, `outputs`, `knowledge_records` — surfaced through their parent task context, not pushed.
- `requests`, `projects`, `departments`, `users`, `organizations` — configuration / intake entities, not live operational signals.
- `agent_activity`, `execution_logs`, `audit_events`, `background_jobs`, `scheduled_tasks` — append-only telemetry / runtime internals; high volume; no client-subscription use case in the MVP.

Adding any of these is a separate future decision with its own RLS and volume analysis. This plan does not pre-authorize it.

---

## 6. Realtime Use Cases

The use cases that justify the three in-scope tables — and bound the scope so realtime is not enabled "just in case":

1. **Operator dashboard live task board.** A department lead/member viewing the task list sees status and assignment changes without refresh. Filtered to the caller's department by the same `tasks` SELECT RLS.
2. **Approval inbox.** A user awaiting a gate (or an approver/lead in the department) sees a `pending` approval appear and its resolution (`approved`/`rejected`/`withdrawn`) in real time, replacing poll-for-status.
3. **Blocker awareness.** When a blocker opens or resolves on a task/work-packet the caller can see, dependent-work UI updates immediately.
4. **Agent work surface (narrow).** An agent session subscribed to its assigned tasks sees assignment and status changes for *only* tasks assigned to it — driven by the agent-assigned SELECT policy, not a broad channel.

**Non-use-cases (explicitly excluded):** cross-department visibility, org-wide firehoses, telemetry streaming, agent visibility into approvals/blockers beyond what their assigned-task SELECT policies already grant. Realtime must never widen what a role can see; it only changes *when* they see it.

---

## 7. Security / RLS Interaction

This is the section that determines whether enabling realtime is safe, and it is the main reason to be deliberate rather than to "just add the tables."

**RLS does apply to Realtime.** Supabase Realtime's Postgres-changes feature evaluates the table's RLS SELECT policy per subscriber before delivering a row. Because RLS is already enabled on all three tables, a subscriber will only receive change events for rows they could SELECT. This means the existing, verified policies are the realtime authorization model — no new policy is needed, and none should be written:

- `tasks` — `tasks_select_dept_scope` + `tasks_select_agent_assigned`. Dept-scoped for humans; assigned-only for agents. (Confirmed in the G3 verification matrix.)
- `approvals` — `approvals_select_department_scope` (live, from `017`). Org-admin/dept-scoped for humans with the output sub-check; agents limited to approvals derived from their assigned tasks, **no work_packet branch**. (Confirmed in the G5 plan.)
- `blockers` — `blockers_select_department_scope` (from `013`). Dept-scoped for humans; agents see only blockers on tasks/work-packets tied to their assigned tasks.

**The replica-identity caveat is the real decision.** All three tables are `REPLICA IDENTITY DEFAULT` (primary key only in the old-row image). Consequences for RLS-filtered realtime:

- **INSERT** — full new row is available; RLS evaluates normally. ✅
- **UPDATE** — Realtime evaluates RLS against the **new** row image, which is complete; normal status-change pushes work. ✅
- **The "moved out of scope" gap** — if a row is updated such that it *leaves* a subscriber's visible set (e.g., a task is re-routed from department A to department B, or `deleted_at` is set), a department-A subscriber may **not** receive a clean "this row left your view" event, because the old image carries only the PK and the new image fails their RLS check. With `REPLICA IDENTITY FULL`, the old image is complete and these transitions become observable.
- **DELETE** — old image is PK-only; RLS cannot be meaningfully evaluated on a PK-only old row, so DELETE events are effectively unusable under RLS with default replica identity. This is acceptable here because **none of the three tables is hard-deleted on the authenticated path** — soft-delete is an UPDATE.

**Decision implied, not taken here:** whether to set `REPLICA IDENTITY FULL` on `tasks` (and possibly `approvals`/`blockers`) depends on whether the frontend needs to react to rows *leaving* a scope (re-route, soft-delete) versus only to in-scope changes. That requirement is a frontend requirement and is not yet known — which is a primary input to the timing recommendation (§12). `FULL` adds WAL volume (every column in every update is logged); it should be chosen deliberately, per-table, when the consumer's needs are concrete.

**No `FORCE ROW LEVEL SECURITY` change is proposed.** `rls_forced = false` is correct: table owners/service-role bypass RLS by design for maintenance, and Realtime delivery to authenticated subscribers still runs through RLS.

---

## 8. Publication Strategy

When realtime is enabled (not now), the strategy is:

1. **Use the existing `supabase_realtime` publication.** Do not create a new publication; do not convert it to `FOR ALL TABLES` (that would expose every table to the changes feed and is the opposite of the explicit, three-table intent). Membership stays opt-in.
2. **Add exactly the three tables**, e.g. `ALTER PUBLICATION supabase_realtime ADD TABLE public.tasks, public.approvals, public.blockers;` — additive, online, reversible with `DROP TABLE` from the publication. (Shown for reference; **not executed by this plan.**)
3. **Scope the published events.** The publication currently publishes insert/update/delete/truncate. For these tables the meaningful events are INSERT and UPDATE. Truncate and delete are not part of the authenticated lifecycle. If event narrowing is desired, it is set per-publication, not per-table; the simplest safe posture is to leave the publication's event set as-is and rely on the client subscription filters + RLS, since DELETE/TRUNCATE will not occur on the authenticated path anyway.
4. **Replica identity, per §7.** Default is sufficient for "in-scope change" pushes. Set `FULL` only on tables where the frontend must observe rows leaving a scope — decided per table when that requirement is real.
5. **Subscription filtering is a client concern, backed by RLS.** Channel/topic design (per-department, per-assigned-agent) belongs to the frontend plan; the server-side guarantee is purely "RLS decides who receives what." This plan does not design channels.

---

## 9. Migration Strategy

**No migration is created by this plan.** When the decision in §12 is to proceed, the migration would be characterized as follows so it is ready to author cleanly:

- **Form:** a new sequential migration (next number after the current head) named e.g. `0NN_realtime_publication.sql`, containing only `ALTER PUBLICATION supabase_realtime ADD TABLE …` and, if §7 concludes it is needed, `ALTER TABLE … REPLICA IDENTITY FULL` for the specific table(s).
- **Idempotency:** guard with existence checks (`pg_publication_tables`) so re-running is safe; `ALTER PUBLICATION … ADD TABLE` errors if the table is already a member.
- **No new policies, tables, functions, grants, or seed data.** RLS already governs delivery; grants already exist. The migration is purely publication membership (+ optional replica identity).
- **Reversibility:** down path is `ALTER PUBLICATION supabase_realtime DROP TABLE …` (+ revert replica identity). Fully reversible, no data effect.
- **Ordering:** independent of other pending G-phase work; it can land at any point once a consumer exists. It does **not** block the API plans.

---

## 10. Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **Enabling with no consumer** — turning on realtime before a frontend subscribes adds WAL/replication overhead and a security surface for zero benefit. | Medium | Defer until a consumer exists (§12). The change is one ALTER away when needed. |
| 2 | **Replica-identity surprise** — shipping with `DEFAULT` then discovering the UI needs "row left scope" / soft-delete events, requiring `FULL` later (more WAL, a follow-up migration). | Medium | Decide replica identity from concrete frontend requirements at enable-time, not speculatively now. Documented in §7. |
| 3 | **Over-publication drift** — a future hand turns `supabase_realtime` into `FOR ALL TABLES` or adds telemetry tables, leaking high-volume or broader data into the changes feed. | High if it happens | This plan fixes the scope at three tables and records out-of-scope tables (§5). Any addition is a separate, reviewed decision. |
| 4 | **Stale promises in API plans** — G3/G4/G5 currently describe realtime as if live; until enabled, that is aspirational and could mislead implementers into building clients against a dead channel. | Medium | Treat realtime as **intent, not live** in all G-plans until this plan's §12 action is taken. (Recommended one-line clarifications, not done here.) |
| 5 | **RLS-on-realtime misassumption** — assuming the changes feed needs its own auth, and writing redundant/looser policies. | Low | §7 is explicit: the existing SELECT policies *are* the realtime authorization. No new policy. |
| 6 | **Forgetting it entirely** — deferring and then shipping a frontend that silently polls because nobody re-opened the decision. | Low | §12 ties the trigger to a concrete event (frontend subscription work) and the build-order step 28 remains the tracking anchor. |

---

## 11. Verification Plan

To be run **after** realtime is enabled (not now), to confirm the contract:

1. **Publication membership.** `select * from pg_publication_tables where pubname='supabase_realtime';` returns exactly `tasks`, `approvals`, `blockers` — and nothing else.
2. **Replica identity.** Confirm each table's `relreplident` matches the §7 decision (`d` if default kept, `f` if FULL chosen).
3. **RLS delivery — dept isolation.** Two authenticated subscriptions in different departments; an UPDATE to a department-A task is received by the A subscriber and **not** the B subscriber.
4. **RLS delivery — agent confinement.** An agent subscription receives status/assignment events only for tasks assigned to that agent; a non-assigned task update produces no event.
5. **Approvals scope.** An approval resolution is delivered to org-admin and to the in-department lead/member; an agent receives only approvals derivable from its assigned tasks, and **never** a `work_packet` approval (no agent work_packet branch in `017`).
6. **Blocker scope.** A blocker open/resolve is delivered dept-scoped; agent receives only blockers tied to its assigned tasks.
7. **Scope-exit behavior.** Re-route a task A→B (or soft-delete it). Confirm the observed client behavior matches the replica-identity decision: with `DEFAULT`, the A subscriber simply stops receiving further events; with `FULL`, the A subscriber receives the transition. Document whichever was chosen as the expected contract.
8. **No DELETE leakage.** Confirm no authenticated path emits DELETE events (removal is soft-delete UPDATE), so RLS-on-DELETE's PK-only limitation never matters in practice.

All verification uses subscriptions under the established JWT/role simulation; no production data is mutated beyond `BEGIN…ROLLBACK`-style probes where applicable.

---

## 12. Recommended Next Action

**Defer enabling until frontend subscription work begins — do not enable now.**

Rationale:

- **There is no consumer.** Realtime is a delivery mechanism; with no subscribing client, enabling it adds replication overhead and a security surface for zero functional gain. The API plans deliver state correctly today via request/response.
- **The one material design choice (replica identity, §7) is a frontend-driven decision.** Whether the UI must observe rows *leaving* a scope (re-route, soft-delete) determines `DEFAULT` vs `FULL`. Choosing it now would be guessing; choosing it when the first subscription is built is informed and cheap.
- **The cost of deferral is ~zero and fully reversible.** The publication already exists, RLS is already on, and enabling is a single additive `ALTER PUBLICATION` (+ optional replica identity) in a small, idempotent, reversible migration. Nothing about deferring complicates the later enable.
- **Doing it now carries the over-publication and stale-promise risks (§10 #1, #3, #4) with no offsetting benefit.**

**Concretely:**

1. **Now:** adopt this plan as the decision of record. Treat realtime as *documented intent, not live capability* in G3/G4/G5 (a one-line clarification in each, when those are next touched).
2. **Trigger to revisit:** the start of frontend work that needs push updates for the task board, approval inbox, or blocker awareness. At that point, capture the scope-exit requirement, finalize the replica-identity decision per table, then author the §9 migration and run the §11 verification.
3. **Tracking anchor:** runtime-data-model build-order step 28 remains open and now points to this plan for the how/when.

This keeps the gap closed as a *decision* (we know exactly what to do and why we are waiting) rather than leaving it as an unexplained discrepancy between the docs and the database.
