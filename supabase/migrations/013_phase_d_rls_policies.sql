-- AI Command Center
-- Phase 013 Phase D RLS Policies
--
-- Source documents:
-- - docs/phase-d-governance-layer-migration-plan.md
-- - docs/approval-rules.md
-- - docs/phase-c-rls-policy-plan.md
-- - supabase/migrations/005_rls_policies.sql
-- - supabase/migrations/009_phase_c_rls_policies.sql
-- - supabase/migrations/011_governance_layer.sql
-- - supabase/migrations/012_phase_d_grants.sql
--
-- Scope:
-- - RLS policies for Phase D governance-layer tables only:
--   decisions, approvals, blockers
--
-- Explicitly excluded:
-- - New helper functions
-- - New tables
-- - Seed data
-- - Supabase command execution
-- - Hard-delete access from the authenticated client path

-- decisions
--
-- Decisions are task-scoped. Department access is derived through the parent
-- task; agents only read decisions on tasks assigned to their user record.
create policy decisions_select_task_scope
on public.decisions
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and exists (
    select 1
    from public.tasks as t
    where t.id = task_id
      and t.organization_id = private.current_organization_id()
      and t.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or (
          private.current_role() in ('department_lead', 'department_member', 'read_only')
          and t.department_id = private.current_department_id()
        )
        or (
          private.current_role() = 'agent'
          and t.assigned_to_user_id = private.current_user_id()
        )
      )
  )
);

create policy decisions_insert_task_scope
on public.decisions
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and status in ('proposed', 'pending_approval')
  and (
    decided_by_user_id is null
    or decided_by_user_id = private.current_user_id()
  )
  and exists (
    select 1
    from public.tasks as t
    where t.id = task_id
      and t.organization_id = private.current_organization_id()
      and t.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or t.department_id = private.current_department_id()
      )
  )
);

create policy decisions_update_lead_scope
on public.decisions
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and exists (
    select 1
    from public.tasks as t
    where t.id = task_id
      and t.organization_id = private.current_organization_id()
      and t.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or (
          private.current_role() = 'department_lead'
          and t.department_id = private.current_department_id()
        )
      )
  )
)
with check (
  organization_id = private.current_organization_id()
  and exists (
    select 1
    from public.tasks as t
    where t.id = task_id
      and t.organization_id = private.current_organization_id()
      and t.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or (
          private.current_role() = 'department_lead'
          and t.department_id = private.current_department_id()
        )
      )
  )
  and (
    decided_by_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = decided_by_user_id
        and u.organization_id = private.current_organization_id()
        and u.deleted_at is null
    )
  )
);

-- approvals
--
-- Approvals are department-owned governance gates. Although the table-level
-- check allows output for Phase E, authenticated Phase D policies reject output
-- subjects until the outputs table exists.
create policy approvals_select_department_scope
on public.approvals
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and subject_type in ('task', 'work_packet', 'decision')
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and department_id = private.current_department_id()
    )
    or (
      private.current_role() = 'agent'
      and (
        (
          subject_type = 'task'
          and exists (
            select 1
            from public.tasks as t
            where t.id = subject_id
              and t.organization_id = private.current_organization_id()
              and t.assigned_to_user_id = private.current_user_id()
              and t.deleted_at is null
          )
        )
        or (
          subject_type = 'decision'
          and exists (
            select 1
            from public.decisions as d
            join public.tasks as t
              on t.id = d.task_id
            where d.id = subject_id
              and d.organization_id = private.current_organization_id()
              and d.deleted_at is null
              and t.organization_id = private.current_organization_id()
              and t.assigned_to_user_id = private.current_user_id()
              and t.deleted_at is null
          )
        )
      )
    )
  )
);

create policy approvals_insert_department_scope
on public.approvals
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and subject_type in ('task', 'work_packet', 'decision')
  and category in ('a', 'b')
  and status = 'pending'
  and decided_at is null
  and (
    requested_by_user_id is null
    or requested_by_user_id = private.current_user_id()
  )
  and (
    approver_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = approver_user_id
        and u.organization_id = private.current_organization_id()
        and u.status = 'active'
        and u.deleted_at is null
    )
  )
  and exists (
    select 1
    from public.departments as d
    where d.id = department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
  and (
    private.current_role() = 'org_admin'
    or department_id = private.current_department_id()
  )
  and (
    (
      subject_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = subject_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = public.approvals.department_id
          and t.deleted_at is null
      )
    )
    or (
      subject_type = 'work_packet'
      and exists (
        select 1
        from public.work_packets as wp
        where wp.id = subject_id
          and wp.organization_id = private.current_organization_id()
          and wp.department_id = public.approvals.department_id
          and wp.deleted_at is null
      )
    )
    or (
      subject_type = 'decision'
      and exists (
        select 1
        from public.decisions as d
        join public.tasks as t
          on t.id = d.task_id
        where d.id = subject_id
          and d.organization_id = private.current_organization_id()
          and d.deleted_at is null
          and t.organization_id = private.current_organization_id()
          and t.department_id = public.approvals.department_id
          and t.deleted_at is null
      )
    )
  )
);

create policy approvals_update_approver_scope
on public.approvals
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and status = 'pending'
  and subject_type in ('task', 'work_packet', 'decision')
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
  and subject_type in ('task', 'work_packet', 'decision')
  and category in ('a', 'b')
  and status in ('approved', 'rejected', 'withdrawn')
  and decided_at is not null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and department_id = private.current_department_id()
    )
  )
  and (
    requested_by_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = requested_by_user_id
        and u.organization_id = private.current_organization_id()
        and u.deleted_at is null
    )
  )
  and (
    approver_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = approver_user_id
        and u.organization_id = private.current_organization_id()
        and u.status = 'active'
        and u.deleted_at is null
    )
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
      subject_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = subject_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = public.approvals.department_id
          and t.deleted_at is null
      )
    )
    or (
      subject_type = 'work_packet'
      and exists (
        select 1
        from public.work_packets as wp
        where wp.id = subject_id
          and wp.organization_id = private.current_organization_id()
          and wp.department_id = public.approvals.department_id
          and wp.deleted_at is null
      )
    )
    or (
      subject_type = 'decision'
      and exists (
        select 1
        from public.decisions as d
        join public.tasks as t
          on t.id = d.task_id
        where d.id = subject_id
          and d.organization_id = private.current_organization_id()
          and d.deleted_at is null
          and t.organization_id = private.current_organization_id()
          and t.department_id = public.approvals.department_id
          and t.deleted_at is null
      )
    )
  )
);

-- blockers
--
-- Blockers are department-owned. Agents can read blockers attached to tasks
-- assigned to them, but they cannot create or update governance records.
create policy blockers_select_department_scope
on public.blockers
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
    or (
      private.current_role() = 'agent'
      and (
        (
          blocked_entity_type = 'task'
          and exists (
            select 1
            from public.tasks as t
            where t.id = blocked_entity_id
              and t.organization_id = private.current_organization_id()
              and t.assigned_to_user_id = private.current_user_id()
              and t.deleted_at is null
          )
        )
        or (
          blocked_entity_type = 'work_packet'
          and exists (
            select 1
            from public.tasks as t
            where t.work_packet_id = blocked_entity_id
              and t.organization_id = private.current_organization_id()
              and t.assigned_to_user_id = private.current_user_id()
              and t.deleted_at is null
          )
        )
      )
    )
  )
);

create policy blockers_insert_department_scope
on public.blockers
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and status = 'open'
  and reported_by_user_id = private.current_user_id()
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
  and (
    (
      blocked_entity_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = blocked_entity_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = public.blockers.department_id
          and t.deleted_at is null
      )
    )
    or (
      blocked_entity_type = 'work_packet'
      and exists (
        select 1
        from public.work_packets as wp
        where wp.id = blocked_entity_id
          and wp.organization_id = private.current_organization_id()
          and wp.department_id = public.blockers.department_id
          and wp.deleted_at is null
      )
    )
  )
);

create policy blockers_update_department_scope
on public.blockers
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
    from public.users as u
    where u.id = reported_by_user_id
      and u.organization_id = private.current_organization_id()
      and u.deleted_at is null
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
  and (
    (
      blocked_entity_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = blocked_entity_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = public.blockers.department_id
          and t.deleted_at is null
      )
    )
    or (
      blocked_entity_type = 'work_packet'
      and exists (
        select 1
        from public.work_packets as wp
        where wp.id = blocked_entity_id
          and wp.organization_id = private.current_organization_id()
          and wp.department_id = public.blockers.department_id
          and wp.deleted_at is null
      )
    )
  )
);
