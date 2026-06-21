-- AI Command Center
-- Phase 008 Phase C Table Grants
--
-- Purpose:
-- Grant table privileges required for authenticated users to reach the Phase C
-- RLS policies planned in docs/phase-c-rls-policy-plan.md.
--
-- Scope:
-- - Existing Phase C execution-layer tables only:
--   requests, work_packets, tasks, execution_logs
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

-- Mutable Phase C execution tables need SELECT, INSERT, and UPDATE so their
-- planned RLS policies can evaluate read, create, status, routing, and
-- soft-delete operations.
grant select, insert, update
  on public.requests,
     public.work_packets,
     public.tasks
  to authenticated;

-- execution_logs is append-only. Authenticated clients may read and append log
-- rows, but they must not update existing records. Corrections are represented
-- as new rows rather than mutation of prior rows.
grant select, insert
  on public.execution_logs
  to authenticated;

-- Defense in depth for append-only logs: no UPDATE table privilege should exist
-- for authenticated users, even though Phase C RLS will also omit UPDATE
-- policies for execution_logs.
revoke update
  on public.execution_logs
  from authenticated;

-- DELETE remains denied on the authenticated client path. No Phase C table
-- should support hard deletion through authenticated users; mutable tables use
-- soft-delete updates, and execution_logs are permanent.
revoke delete
  on public.requests,
     public.work_packets,
     public.tasks,
     public.execution_logs
  from authenticated;
