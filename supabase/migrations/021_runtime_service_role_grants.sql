-- AI Command Center
-- Migration 021 — Runtime service_role table grants
--
-- Source: docs/sprint-5-runtime-execution-engine-plan.md
--
-- Problem:
--   Phase F (migrations 018–020) granted table privileges to the `authenticated`
--   role only. The runtime worker uses the service_role key, which bypasses RLS
--   but still requires explicit table-level privileges granted to service_role.
--   Without these grants, service_role queries return "permission denied for table".
--
-- Scope:
--   - USAGE on schema public for service_role
--   - SELECT / INSERT / UPDATE on the six runtime worker tables
--   - No DELETE granted to any role
--   - No new RLS policies
--   - No schema changes
--
-- Explicitly excluded:
--   - DELETE on any table
--   - RLS policies
--   - Changes to existing migrations

grant usage on schema public to service_role;

-- Job queue: worker must claim (UPDATE), enqueue (INSERT), and read (SELECT) jobs
grant select, insert, update
  on public.background_jobs
  to service_role;

-- Dead-letter queue: worker must create DLQ entries (INSERT), mark resolved (UPDATE), and read (SELECT)
grant select, insert, update
  on public.dead_letter_queue
  to service_role;

-- Execution logs: worker must append log entries (INSERT) and read them (SELECT)
grant select, insert
  on public.execution_logs
  to service_role;

-- Agent activity: worker must append activity rows (INSERT) and read them (SELECT)
grant select, insert
  on public.agent_activity
  to service_role;

-- Runtime metrics: worker must record metrics (INSERT), update aggregates (UPDATE), and read (SELECT)
grant select, insert, update
  on public.runtime_metrics
  to service_role;

-- Scheduled tasks: worker must read schedules (SELECT) and update next_run_at / last_run_at (UPDATE)
grant select, update
  on public.scheduled_tasks
  to service_role;
