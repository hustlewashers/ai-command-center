-- AI Command Center
-- Phase 012 Phase D Table Grants
--
-- Purpose:
-- Grant table privileges required for authenticated users to reach the Phase D
-- RLS policies planned for governance-layer tables.
--
-- Scope:
-- - Existing Phase D governance-layer tables only:
--   decisions, approvals, blockers
--
-- Explicitly excluded:
-- - RLS policy creation or modification
-- - New tables
-- - Seed data
-- - Supabase command execution
-- - Anonymous role privileges

-- GRANT controls whether a database role can attempt a table operation.
-- RLS controls which rows that role can see or mutate after the table-level
-- privilege check succeeds. Both are required: table grants alone do not bypass
-- RLS, and RLS policies alone do not satisfy PostgreSQL table privileges.
grant usage on schema public to authenticated;

-- Phase D governance tables are mutable workflow state. Authenticated users
-- need SELECT, INSERT, and UPDATE privileges so future RLS policies can evaluate
-- department scope, ownership, approver authority, and status transitions.
grant select, insert, update
  on public.decisions,
     public.approvals,
     public.blockers
  to authenticated;

-- Governance records should not be hard-deleted through the authenticated
-- client path. Approvals are retained permanently through status values
-- (pending, approved, rejected, expired, withdrawn). Decisions and blockers use
-- deleted_at for soft deletion where appropriate.
revoke delete
  on public.decisions,
     public.approvals,
     public.blockers
  from authenticated;

-- Approval terminal states require decided_at because of the
-- approvals_decided_at_status_check constraint created in 011. Future RLS and
-- application update paths must set decided_at when moving an approval out of
-- pending.
