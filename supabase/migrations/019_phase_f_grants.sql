-- AI Command Center
-- Phase F Runtime Operations & Hardening — Table Grants
--
-- Purpose:
-- Grant table privileges required for authenticated users to reach the Phase F
-- RLS policies planned for runtime operations and hardening tables.
--
-- Source documents:
-- - docs/phase-f-runtime-hardening-plan.md
-- - docs/supabase-runtime-data-model.md
-- - supabase/migrations/015_phase_e_grants.sql
-- - supabase/migrations/018_runtime_hardening.sql
--
-- Scope:
-- - Phase F runtime operations and hardening tables only:
--   audit_events, scheduled_tasks, background_jobs, dead_letter_queue,
--   runtime_metrics, agent_activity
--
-- Explicitly excluded:
-- - RLS policy creation or modification
-- - New tables
-- - Seed data
-- - Helper functions
-- - Supabase command execution
-- - Anonymous role privileges

-- GRANT controls whether a database role can attempt a table operation.
-- RLS controls which rows that role can see or mutate after the table-level
-- privilege check succeeds. Both are required: table grants alone do not bypass
-- RLS, and RLS policies alone do not satisfy PostgreSQL table privileges.
grant usage on schema public to authenticated;

-- Platform-level security and observability tables are read-only for
-- authenticated users. INSERT on audit_events is reserved for the service role
-- (system events, auth hooks, and migration markers). INSERT on runtime_metrics
-- is reserved for the service-role metrics pipeline. Future RLS policies will
-- restrict SELECT on audit_events to org_admin and SELECT on runtime_metrics to
-- org- or department-scoped rows.
grant select
  on public.audit_events,
     public.runtime_metrics
  to authenticated;

-- Schedule definitions and background job queue records are mutable within the
-- boundaries enforced by future RLS policies. org_admin and department_lead may
-- create and update scheduled_tasks. org_admin may enqueue or cancel
-- background_jobs; service_role drives automated status transitions on
-- background_jobs.
grant select, insert, update
  on public.scheduled_tasks,
     public.background_jobs
  to authenticated;

-- Dead-letter queue entries are written only by the service role job runner on
-- permanent job failure. Authenticated users (org_admin and department_lead)
-- need SELECT and UPDATE to review and resolve entries — updating
-- resolution_status, resolution_note, resolved_by_user_id, and resolved_at.
-- INSERT is not granted here and is explicitly revoked below.
grant select, update
  on public.dead_letter_queue
  to authenticated;

-- Agent activity rows are inserted by the agent service identity (pinned to
-- agent_user_id = private.current_user_id() in the future 020 RLS INSERT
-- policy) or by service_role on the bypass path. Authenticated users need
-- SELECT to review session activity within department scope. No UPDATE is
-- granted: agent_activity is append-only and rows are never mutated after
-- insert.
grant select, insert
  on public.agent_activity
  to authenticated;

-- Defense in depth: explicitly revoke INSERT on dead_letter_queue from
-- authenticated. The privilege was not granted above, but this REVOKE makes the
-- service-role-only INSERT restriction DB-enforced rather than convention-only.
-- All DLQ entries are created by service_role on permanent job failure.
revoke insert
  on public.dead_letter_queue
  from authenticated;

-- Defense in depth: explicitly revoke UPDATE on append-only Phase F tables.
-- audit_events has no correction path for authenticated users; incorrect rows
-- are superseded by new rows. runtime_metrics rows are upserted by the
-- service-role pipeline and are immutable for authenticated users.
-- agent_activity is append-only; rows are never mutated after insert.
revoke update
  on public.audit_events,
     public.runtime_metrics,
     public.agent_activity
  from authenticated;

-- DELETE remains denied on the authenticated client path for all Phase F tables.
-- audit_events, runtime_metrics, and agent_activity are append-only with no
-- hard-delete path. background_jobs and dead_letter_queue deletions are
-- service-role-only retention operations. scheduled_tasks use deleted_at for
-- soft deletion.
revoke delete
  on public.audit_events,
     public.scheduled_tasks,
     public.background_jobs,
     public.dead_letter_queue,
     public.runtime_metrics,
     public.agent_activity
  from authenticated;
