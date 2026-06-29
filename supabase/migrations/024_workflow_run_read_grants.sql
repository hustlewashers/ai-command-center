-- Grant SELECT on workflow run tables to authenticated role.
-- Migration 023 enabled RLS with org-scoped SELECT policies but omitted
-- the table-level privilege that PostgreSQL requires before RLS is even evaluated.
-- service_role already has SELECT/INSERT/UPDATE from migration 023.

GRANT SELECT ON public.workflow_runs       TO authenticated;
GRANT SELECT ON public.workflow_step_runs  TO authenticated;
