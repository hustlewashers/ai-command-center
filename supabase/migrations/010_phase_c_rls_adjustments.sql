-- AI Command Center
-- Phase 010 Phase C RLS Adjustments
--
-- Purpose:
-- Tighten the Phase C request UPDATE policy so read_only users and agents
-- cannot cancel requests through the submitter branch.
--
-- Source:
-- - supabase/migrations/009_phase_c_rls_policies.sql
-- - docs/phase-c-rls-policy-plan.md
--
-- Scope:
-- - Replace public.requests UPDATE policy only
--
-- Explicitly excluded:
-- - Changes to work_packets, tasks, or execution_logs policies
-- - New helper functions
-- - New tables
-- - Seed data
-- - Supabase command execution

drop policy if exists requests_update_triage_and_admin
on public.requests;

-- read_only users remain read-only: they can see request rows allowed by SELECT
-- policies, but they cannot mutate requests, including cancellation.
--
-- Agents only write execution logs in the Phase C authenticated client path.
-- They cannot update requests, even when they submitted the original request.
--
-- Submitter cancellation is limited to human operational roles:
-- org_admin, department_lead, and department_member.
create policy requests_update_triage_and_admin
on public.requests
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member')
      and routed_department_id = private.current_department_id()
    )
    or (
      private.current_role() in ('org_admin', 'department_lead', 'department_member')
      and submitted_by_user_id = private.current_user_id()
      and status in ('received', 'triaged', 'in_progress')
    )
  )
)
with check (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member')
      and routed_department_id = private.current_department_id()
    )
    or (
      private.current_role() in ('org_admin', 'department_lead', 'department_member')
      and submitted_by_user_id = private.current_user_id()
      and status = 'cancelled'
    )
  )
  and (
    submitted_by_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = submitted_by_user_id
        and u.organization_id = private.current_organization_id()
        and u.deleted_at is null
    )
  )
  and (
    routed_department_id is null
    or exists (
      select 1
      from public.departments as d
      where d.id = routed_department_id
        and d.organization_id = private.current_organization_id()
        and d.deleted_at is null
    )
  )
  and (
    project_id is null
    or exists (
      select 1
      from public.projects as p
      where p.id = project_id
        and p.organization_id = private.current_organization_id()
        and p.deleted_at is null
    )
  )
);
