-- AI Command Center
-- Migration 022 — Business Execution Engine service_role grants
--
-- Problem:
--   Migration 021 granted service_role access to Phase F runtime tables.
--   Sprint 5.4 workflow execution now writes directly to Phase C/D/E business
--   entity tables (tasks, work_packets, outputs, approvals) and reads lookup
--   tables (requests, projects, departments, users).
--   Without these grants, service_role receives "permission denied for table X"
--   at the PostgreSQL privilege layer before RLS is ever evaluated.
--
-- Scope:
--   - INSERT, SELECT, UPDATE on entities the workflow engine creates or updates
--   - SELECT-only on lookup tables the engine reads for context
--   - No DELETE on any table
--   - No new RLS policies
--   - No schema changes

-- Business entities written by the execution engine
grant insert, select, update on public.tasks       to service_role;
grant insert, select, update on public.work_packets to service_role;
grant insert, select, update on public.outputs     to service_role;
grant insert, select, update on public.approvals   to service_role;

-- Lookup tables read for context resolution
grant select on public.requests    to service_role;
grant select on public.projects    to service_role;
grant select on public.departments to service_role;
grant select on public.users       to service_role;
