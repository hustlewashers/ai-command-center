-- AI Command Center
-- Phase 009 Phase C RLS Policies
--
-- Source documents:
-- - docs/phase-c-rls-policy-plan.md
-- - docs/005-rls-policy-plan.md
-- - docs/approval-rules.md
-- - supabase/migrations/005_rls_policies.sql
-- - supabase/migrations/007_execution_layer.sql
-- - supabase/migrations/008_phase_c_grants.sql
--
-- Scope:
-- - RLS policies for Phase C execution-layer tables only:
--   requests, work_packets, tasks, execution_logs
--
-- Explicitly excluded:
-- - New helper functions
-- - New tables
-- - Seed data
-- - Supabase command execution
-- - Hard-delete access from the authenticated client path

-- requests
--
-- Requests are organization-scoped intake records. They may begin unrouted, so
-- SELECT is org-wide for authenticated org members instead of department-bound.
create policy requests_select_org_members
on public.requests
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
);

create policy requests_insert_org_members
on public.requests
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead', 'department_member', 'agent')
  and status = 'received'
  and deleted_at is null
  and (
    submitted_by_user_id is null
    or submitted_by_user_id = private.current_user_id()
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
      submitted_by_user_id = private.current_user_id()
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
      submitted_by_user_id = private.current_user_id()
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

-- work_packets
--
-- Work packets are department-owned. Agents do not read, create, or update
-- packets directly; they operate through assigned tasks and execution logs.
create policy work_packets_select_dept_scope
on public.work_packets
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and department_id = private.current_department_id()
    )
  )
);

create policy work_packets_insert_dept_scope
on public.work_packets
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and author_user_id = private.current_user_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and (
    private.current_role() = 'org_admin'
    or department_id = private.current_department_id()
  )
  and exists (
    select 1
    from public.departments as d
    where d.id = department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
  and (
    (
      parent_type = 'project'
      and exists (
        select 1
        from public.projects as p
        where p.id = parent_id
          and p.organization_id = private.current_organization_id()
          and p.deleted_at is null
      )
    )
    or (
      parent_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = parent_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = public.work_packets.department_id
          and t.deleted_at is null
      )
    )
  )
);

create policy work_packets_update_dept_scope
on public.work_packets
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and department_id = private.current_department_id()
    )
  )
)
with check (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and department_id = private.current_department_id()
    )
  )
  and exists (
    select 1
    from public.departments as d
    where d.id = department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
  and exists (
    select 1
    from public.users as u
    where u.id = author_user_id
      and u.organization_id = private.current_organization_id()
      and u.deleted_at is null
  )
  and (
    (
      parent_type = 'project'
      and exists (
        select 1
        from public.projects as p
        where p.id = parent_id
          and p.organization_id = private.current_organization_id()
          and p.deleted_at is null
      )
    )
    or (
      parent_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = parent_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = public.work_packets.department_id
          and t.deleted_at is null
      )
    )
  )
);

-- tasks
--
-- Tasks are department-owned execution units. Agents receive a separate SELECT
-- branch limited to rows explicitly assigned to their user record.
create policy tasks_select_dept_scope
on public.tasks
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and department_id = private.current_department_id()
    )
  )
);

create policy tasks_select_agent_assigned
on public.tasks
for select
to authenticated
using (
  private.current_role() = 'agent'
  and organization_id = private.current_organization_id()
  and assigned_to_user_id = private.current_user_id()
  and deleted_at is null
);

create policy tasks_insert_dept_scope
on public.tasks
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and created_by = private.current_user_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and (
    private.current_role() = 'org_admin'
    or department_id = private.current_department_id()
  )
  and exists (
    select 1
    from public.departments as d
    where d.id = department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
  and exists (
    select 1
    from public.projects as p
    where p.id = project_id
      and p.organization_id = private.current_organization_id()
      and p.deleted_at is null
  )
  and (
    request_id is null
    or exists (
      select 1
      from public.requests as r
      where r.id = request_id
        and r.organization_id = private.current_organization_id()
        and r.deleted_at is null
    )
  )
  and (
    work_packet_id is null
    or exists (
      select 1
      from public.work_packets as wp
      where wp.id = work_packet_id
        and wp.organization_id = private.current_organization_id()
        and wp.department_id = public.tasks.department_id
        and wp.deleted_at is null
    )
  )
  and (
    workflow_id is null
    or exists (
      select 1
      from public.workflows as w
      where w.id = workflow_id
        and w.organization_id = private.current_organization_id()
        and w.deleted_at is null
    )
  )
  and (
    tool_profile_id is null
    or exists (
      select 1
      from public.tool_profiles as tp
      where tp.id = tool_profile_id
        and tp.organization_id = private.current_organization_id()
        and tp.deleted_at is null
    )
  )
  and (
    assigned_to_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = assigned_to_user_id
        and u.organization_id = private.current_organization_id()
        and u.status = 'active'
        and u.deleted_at is null
    )
  )
);

create policy tasks_update_dept_scope
on public.tasks
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member')
      and department_id = private.current_department_id()
    )
  )
)
with check (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member')
      and department_id = private.current_department_id()
    )
  )
  and exists (
    select 1
    from public.departments as d
    where d.id = department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
  and exists (
    select 1
    from public.projects as p
    where p.id = project_id
      and p.organization_id = private.current_organization_id()
      and p.deleted_at is null
  )
  and exists (
    select 1
    from public.users as u
    where u.id = created_by
      and u.organization_id = private.current_organization_id()
      and u.deleted_at is null
  )
  and (
    request_id is null
    or exists (
      select 1
      from public.requests as r
      where r.id = request_id
        and r.organization_id = private.current_organization_id()
        and r.deleted_at is null
    )
  )
  and (
    work_packet_id is null
    or exists (
      select 1
      from public.work_packets as wp
      where wp.id = work_packet_id
        and wp.organization_id = private.current_organization_id()
        and wp.department_id = public.tasks.department_id
        and wp.deleted_at is null
    )
  )
  and (
    workflow_id is null
    or exists (
      select 1
      from public.workflows as w
      where w.id = workflow_id
        and w.organization_id = private.current_organization_id()
        and w.deleted_at is null
    )
  )
  and (
    tool_profile_id is null
    or exists (
      select 1
      from public.tool_profiles as tp
      where tp.id = tool_profile_id
        and tp.organization_id = private.current_organization_id()
        and tp.deleted_at is null
    )
  )
  and (
    assigned_to_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = assigned_to_user_id
        and u.organization_id = private.current_organization_id()
        and u.status = 'active'
        and u.deleted_at is null
    )
  )
);

-- execution_logs
--
-- Execution logs are append-only. This migration intentionally creates SELECT
-- and INSERT policies only; there are no UPDATE or DELETE policies.
create policy execution_logs_select_org_members
on public.execution_logs
for select
to authenticated
using (
  organization_id = private.current_organization_id()
);

create policy execution_logs_insert_by_role_scope
on public.execution_logs
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and status = 'recorded'
  and (
    (
      private.current_role() = 'org_admin'
      and (
        (
          context_type = 'task'
          and exists (
            select 1
            from public.tasks as t
            where t.id = context_id
              and t.organization_id = private.current_organization_id()
              and t.deleted_at is null
          )
        )
        or (
          context_type = 'request'
          and exists (
            select 1
            from public.requests as r
            where r.id = context_id
              and r.organization_id = private.current_organization_id()
              and r.deleted_at is null
          )
        )
        or (
          context_type = 'workflow'
          and exists (
            select 1
            from public.workflows as w
            where w.id = context_id
              and w.organization_id = private.current_organization_id()
              and w.deleted_at is null
          )
        )
      )
    )
    or (
      private.current_role() in ('department_lead', 'department_member')
      and (
        (
          context_type = 'task'
          and exists (
            select 1
            from public.tasks as t
            where t.id = context_id
              and t.organization_id = private.current_organization_id()
              and t.department_id = private.current_department_id()
              and t.deleted_at is null
          )
        )
        or (
          context_type = 'request'
          and exists (
            select 1
            from public.requests as r
            where r.id = context_id
              and r.organization_id = private.current_organization_id()
              and r.routed_department_id = private.current_department_id()
              and r.deleted_at is null
          )
        )
        or (
          context_type = 'workflow'
          and exists (
            select 1
            from public.workflows as w
            where w.id = context_id
              and w.organization_id = private.current_organization_id()
              and w.kind = 'instance'
              and w.department_id = private.current_department_id()
              and w.deleted_at is null
          )
        )
      )
    )
    or (
      private.current_role() = 'agent'
      and context_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = context_id
          and t.organization_id = private.current_organization_id()
          and t.assigned_to_user_id = private.current_user_id()
          and t.deleted_at is null
      )
    )
  )
);
