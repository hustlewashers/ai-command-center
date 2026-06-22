-- AI Command Center
-- Phase 017 Phase E Approvals RLS Adjustment
--
-- Source documents:
-- - docs/phase-e-knowledge-output-layer-migration-plan.md
-- - docs/approval-rules.md
-- - supabase/migrations/011_governance_layer.sql
-- - supabase/migrations/013_phase_d_rls_policies.sql
-- - supabase/migrations/014_knowledge_output_layer.sql
-- - supabase/migrations/016_phase_e_rls_policies.sql
--
-- Scope:
-- - Replace the three Phase D approvals policies so authenticated users can
--   safely use approvals.subject_type = 'output'.
--
-- Explicitly excluded:
-- - New tables
-- - New helper functions
-- - Seed data
-- - Supabase command execution
-- - Category C approval gates
--
-- The approvals table check constraint already accepts 'output'. This migration
-- only extends RLS behavior, preserving Phase D task/work_packet/decision logic.

drop policy if exists approvals_select_department_scope on public.approvals;
drop policy if exists approvals_insert_department_scope on public.approvals;
drop policy if exists approvals_update_approver_scope on public.approvals;

create policy approvals_select_department_scope
on public.approvals
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and subject_type in ('task', 'work_packet', 'decision', 'output')
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and department_id = private.current_department_id()
      and (
        subject_type != 'output'
        or exists (
          select 1
          from public.outputs as o
          where o.id = subject_id
            and o.organization_id = private.current_organization_id()
            and o.department_id = private.current_department_id()
            and o.deleted_at is null
        )
      )
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
        or (
          subject_type = 'output'
          and exists (
            select 1
            from public.outputs as o
            join public.tasks as t
              on t.id = o.task_id
            where o.id = subject_id
              and o.organization_id = private.current_organization_id()
              and o.department_id = public.approvals.department_id
              and o.deleted_at is null
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
  and subject_type in ('task', 'work_packet', 'decision', 'output')
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
    or (
      subject_type = 'output'
      and exists (
        select 1
        from public.outputs as o
        where o.id = subject_id
          and o.organization_id = private.current_organization_id()
          and o.department_id = public.approvals.department_id
          and o.deleted_at is null
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
  and subject_type in ('task', 'work_packet', 'decision', 'output')
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
  and subject_type in ('task', 'work_packet', 'decision', 'output')
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
    or (
      subject_type = 'output'
      and exists (
        select 1
        from public.outputs as o
        where o.id = subject_id
          and o.organization_id = private.current_organization_id()
          and o.department_id = public.approvals.department_id
          and o.deleted_at is null
      )
    )
  )
);
