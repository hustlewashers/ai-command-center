-- AI Command Center
-- Phase 006 Table Grants
--
-- Purpose:
-- Grant table privileges required for authenticated users to reach the RLS
-- policies created in supabase/migrations/005_rls_policies.sql.
--
-- Scope:
-- - Existing runtime tables only:
--   organizations, users, departments, projects, tool_profiles, workflows
--
-- Explicitly excluded:
-- - RLS policy creation or modification
-- - New tables
-- - Seed data
-- - Supabase command execution
-- - Grants to anon

-- GRANT controls whether a database role can attempt a table operation.
-- RLS controls which rows that role can see or mutate after the table-level
-- privilege check succeeds. Both are required: table grants alone do not bypass
-- RLS, and RLS policies alone do not satisfy PostgreSQL table privileges.
grant usage on schema public to authenticated;

grant select
  on public.organizations,
     public.users,
     public.departments,
     public.projects,
     public.tool_profiles,
     public.workflows
  to authenticated;

-- Existing RLS policies allow org_admin updates to organizations, but no
-- authenticated INSERT policy exists for organizations. Organization creation
-- remains a service-role or migration operation.
grant update
  on public.organizations
  to authenticated;

-- Existing RLS policies allow authenticated INSERT/UPDATE only when the row
-- satisfies the role, organization, department, and created_by checks in 005.
grant insert, update
  on public.users,
     public.departments,
     public.projects,
     public.tool_profiles,
     public.workflows
  to authenticated;

-- DELETE remains denied on the authenticated client path. No DELETE policies
-- exist in 005, and this migration explicitly withholds table-level DELETE
-- privilege as defense in depth.
revoke delete
  on public.organizations,
     public.users,
     public.departments,
     public.projects,
     public.tool_profiles,
     public.workflows
  from authenticated;
