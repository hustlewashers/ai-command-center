# Phase G11 — Expiry Sweep Reporter Decision

**Status:** DECIDED  
**Date:** 2026-06-24  
**Affects:** `blockers.reported_by_user_id`, approval expiry sweep (SR-07 → SR-08)  

> **Origin:** G9 Risk R7, G10 §24 open decisions  
> **Related:** [phase-g9-application-service-architecture.md](phase-g9-application-service-architecture.md) §36 SR-07/SR-08  
> **Schema authority:** `supabase/migrations/011_governance_layer.sql`

---

## Context

The approval expiry sweep (service-role operation SR-07) transitions `approvals.status` from `pending → expired` after 48 hours. When expiry leaves work blocked, SR-08 auto-raises a `blockers` row on the subject entity.

`blockers.reported_by_user_id` is `NOT NULL` with a `FOREIGN KEY … ON DELETE RESTRICT` constraint (migration `011`). The sweep runs as `service_role` (RLS bypassed), so it may write any valid `public.users.id` — but it must write one. A null is a constraint violation. A stale or deleted user ID is an FK violation.

The question: **which `public.users` row is the reporter?**

---

## Constraint Summary

| Constraint | Source | Effect |
|---|---|---|
| `reported_by_user_id NOT NULL` | `011` | Must provide a real value; null is rejected |
| `FK … ON DELETE RESTRICT` | `011` | The referenced user row cannot be deleted while the blocker exists |
| `organization_id` org isolation | All table policies | Reporter must belong to the same org as the blocker |
| Service-role writes carry `organization_id` explicitly | G9 §36 SR-08 | The sweep must pin org scope in application logic |

---

## Options Evaluated

### Option A — Dedicated system actor per org (Recommended)

Each organization has exactly one `public.users` row designated as the system actor: `role='agent'`, `status='active'`, `display_name` such as `System`, no `auth_user_id` (not a Supabase Auth identity — provision-only row managed by `org_admin` or org setup flow).

The expiry sweep resolves this row by `organization_id` + a stable marker (e.g., a reserved `email` like `system@<org-slug>` or a dedicated `role='agent'` + `display_name='System'` lookup) before inserting the blocker.

**Pros:**
- Semantically correct — "System" raised the blocker, not a human.
- RESTRICT FK never locks a human account.
- Permanent: the system actor row is provisioned once and never deleted.
- Org-isolated: each org's system actor belongs only to that org, consistent with the org boundary on every table.
- Auditable: all SR-08 blockers trace to a single identifiable actor per org; no ambiguity in audit logs.
- No dependency on any human user's lifecycle state at sweep time.

**Cons:**
- Org provisioning must include creating this row (one additional step).
- System actor has no `auth_user_id`, so it cannot sign in; the sweep must look it up by convention, not by JWT context.

**Mitigation:** the lookup is a single deterministic query in the sweep job: `SELECT id FROM public.users WHERE organization_id = $org AND email = $system_email AND status = 'active' LIMIT 1`. If the row is missing, the sweep logs an error and skips blocker creation for that org rather than inserting a corrupt row.

---

### Option B — Original approval requester

Use `approvals.requested_by_user_id` — the human who originally requested the approval — as the blocker reporter.

**Rejected because:**
- Semantically wrong: the human did not report this blocker; the expiry sweep did. Audit logs become misleading.
- Lifecycle fragility: the requester may be suspended or archived between approval creation (up to 48 h prior) and expiry. The FK lookup would fail or create an implicit RESTRICT lock on a human account depending on timing.
- RESTRICT FK side effect: the human requester cannot be deactivated or have their account cleaned up while any system-generated blocker naming them as reporter exists. This is invisible to the approver and unexpected.

---

### Option C — org_admin fallback

Use the first active `org_admin` in the org.

**Rejected because:**
- Non-deterministic: "first active org_admin" is ambiguous in orgs with multiple admins.
- Semantically wrong for the same reason as Option B.
- RESTRICT FK locks whichever admin is selected; they cannot be removed from the org while blockers cite them as reporter.
- Adds query complexity (find an admin, handle the case where none are active at sweep time).
- Confuses the audit trail: an admin appears to have manually raised a system blocker.

---

## Decision

**Use Option A: one dedicated system actor per organization.**

Every org must have exactly one `public.users` row that serves as the system reporter. It is:

| Field | Value |
|---|---|
| `role` | `agent` |
| `status` | `active` |
| `auth_user_id` | `NULL` (not an Auth identity; provision-only) |
| `display_name` | `System` (or org-specific equivalent) |
| `email` | A reserved, non-deliverable address, e.g. `system@internal` |
| `department_id` | `NULL` (system actor is not department-scoped) |
| `deleted_at` | `NULL` — must remain active permanently |

This row is created during org provisioning by `org_admin` (or an automated setup flow using `service_role`). It must not be soft-deleted while any blocker cites it as reporter.

---

## Impact on `blockers.reported_by_user_id`

### SR-08 sweep logic (application-level, no migration change)

Before inserting a blocker row, the expiry sweep must:

1. Resolve the system actor for the target org:
   ```
   SELECT id FROM public.users
   WHERE organization_id = $target_org_id
     AND email = 'system@internal'
     AND status = 'active'
   LIMIT 1
   ```
2. If no system actor is found: log `error` to `audit_events`, skip blocker creation for this org, alert (do not silently swallow).
3. If found: insert the blocker with `reported_by_user_id = <system_actor_id>`.

### Schema impact

None. Migration `011` does not change. `reported_by_user_id NOT NULL FK RESTRICT` is already the correct constraint; this decision provides the user row that satisfies it.

### Provisioning impact

Org setup (future G12 or provisioning flow) must create the system actor row as part of org initialization. Until that flow exists, the row is created manually by `org_admin` via the Supabase dashboard or a setup script.

### Deletion guard

`ON DELETE RESTRICT` already prevents deleting the system actor while blocker rows reference it. No additional constraint is needed. The operational rule is: do not soft-delete or change `status` on the system actor row; it is permanent for the life of the org.

---

## Open Items

| # | Item | Owner |
|---|---|---|
| 1 | Define the exact reserved email convention for system actors (e.g. `system@internal` vs. org-slug-scoped) | Org provisioning design |
| 2 | Decide whether `auth_user_id = NULL` is a permanent design (no sign-in ever) or whether the system actor should eventually have a machine identity | Auth design |
| 3 | Implement org provisioning flow that creates the system actor as step 0 | Sprint TBD |
| 4 | Implement SR-08 in the expiry sweep Edge Function with the system-actor lookup and missing-actor alert | Sprint TBD (after provisioning) |

Items 1–4 are not blockers for Sprint 1 (Auth Context Spine + read layer). The expiry sweep is an SR-07/SR-08 service-role operation that comes after the human approval workflow is live.

---

## Definition of Done

- [ ] System actor row exists for every active org before the expiry sweep goes live.
- [ ] SR-08 resolves `reported_by_user_id` from the system actor lookup, not from the approval record or any human user.
- [ ] Missing system actor → logged error + sweep skip (not a crash or silent corrupt insert).
- [ ] Ops runbook documents: "do not deactivate or delete the System user row."
- [ ] The system actor's `auth_user_id = NULL` is enforced at provisioning; it must not be bound to a Supabase Auth identity that could be used to sign in.
