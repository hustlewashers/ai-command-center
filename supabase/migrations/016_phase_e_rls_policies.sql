-- AI Command Center
-- Phase 016 Phase E RLS Policies
--
-- Source documents:
-- - docs/phase-e-knowledge-output-layer-migration-plan.md
-- - supabase/migrations/005_rls_policies.sql
-- - supabase/migrations/009_phase_c_rls_policies.sql
-- - supabase/migrations/013_phase_d_rls_policies.sql
-- - supabase/migrations/014_knowledge_output_layer.sql
-- - supabase/migrations/015_phase_e_grants.sql
--
-- Scope:
-- - RLS policies for Phase E knowledge/output-layer tables only:
--   research_assets, outputs, knowledge_records, output_research_assets,
--   task_research_assets, work_packet_research_assets, knowledge_record_links
--
-- Explicitly excluded:
-- - New helper functions
-- - New tables
-- - Seed data
-- - Supabase command execution
-- - Hard-delete access from the authenticated client path
-- - Approval policy changes for approvals.subject_type = 'output'

-- research_assets
--
-- Research assets are department-scoped through their project or through
-- task/work-packet/output junction links. Unscoped assets are admin-only until
-- a future org-wide knowledge surfacing policy exists.
create policy research_assets_select_department_scope
on public.research_assets
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and (
        (
          project_id is not null
          and exists (
            select 1
            from public.projects as p
            where p.id = project_id
              and p.organization_id = private.current_organization_id()
              and p.owning_department_id = private.current_department_id()
              and p.deleted_at is null
          )
        )
        or exists (
          select 1
          from public.task_research_assets as tra
          join public.tasks as t
            on t.id = tra.task_id
          where tra.research_asset_id = public.research_assets.id
            and tra.organization_id = private.current_organization_id()
            and t.organization_id = private.current_organization_id()
            and t.department_id = private.current_department_id()
            and t.deleted_at is null
        )
        or exists (
          select 1
          from public.work_packet_research_assets as wpra
          join public.work_packets as wp
            on wp.id = wpra.work_packet_id
          where wpra.research_asset_id = public.research_assets.id
            and wpra.organization_id = private.current_organization_id()
            and wp.organization_id = private.current_organization_id()
            and wp.department_id = private.current_department_id()
            and wp.deleted_at is null
        )
        or exists (
          select 1
          from public.output_research_assets as ora
          join public.outputs as o
            on o.id = ora.output_id
          where ora.research_asset_id = public.research_assets.id
            and ora.organization_id = private.current_organization_id()
            and o.organization_id = private.current_organization_id()
            and o.department_id = private.current_department_id()
            and o.deleted_at is null
        )
      )
    )
    or (
      private.current_role() = 'agent'
      and (
        exists (
          select 1
          from public.task_research_assets as tra
          join public.tasks as t
            on t.id = tra.task_id
          where tra.research_asset_id = public.research_assets.id
            and tra.organization_id = private.current_organization_id()
            and t.organization_id = private.current_organization_id()
            and t.assigned_to_user_id = private.current_user_id()
            and t.deleted_at is null
        )
        or exists (
          select 1
          from public.work_packet_research_assets as wpra
          join public.tasks as t
            on t.work_packet_id = wpra.work_packet_id
          where wpra.research_asset_id = public.research_assets.id
            and wpra.organization_id = private.current_organization_id()
            and t.organization_id = private.current_organization_id()
            and t.assigned_to_user_id = private.current_user_id()
            and t.deleted_at is null
        )
        or exists (
          select 1
          from public.output_research_assets as ora
          join public.outputs as o
            on o.id = ora.output_id
          join public.tasks as t
            on t.id = o.task_id
          where ora.research_asset_id = public.research_assets.id
            and ora.organization_id = private.current_organization_id()
            and o.organization_id = private.current_organization_id()
            and o.deleted_at is null
            and t.organization_id = private.current_organization_id()
            and t.assigned_to_user_id = private.current_user_id()
            and t.deleted_at is null
        )
      )
    )
  )
);

create policy research_assets_insert_department_scope
on public.research_assets
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member', 'agent')
  and (
    created_by_user_id is null
    or created_by_user_id = private.current_user_id()
  )
  and (
    project_id is null
    or exists (
      select 1
      from public.projects as p
      where p.id = project_id
        and p.organization_id = private.current_organization_id()
        and p.deleted_at is null
        and (
          private.current_role() = 'org_admin'
          or (
            private.current_role() in ('department_lead', 'department_member')
            and p.owning_department_id = private.current_department_id()
          )
          or (
            private.current_role() = 'agent'
            and exists (
              select 1
              from public.tasks as t
              where t.project_id = p.id
                and t.organization_id = private.current_organization_id()
                and t.assigned_to_user_id = private.current_user_id()
                and t.deleted_at is null
            )
          )
        )
    )
  )
);

create policy research_assets_update_department_scope
on public.research_assets
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and (
    private.current_role() = 'org_admin'
    or (
      project_id is not null
      and exists (
        select 1
        from public.projects as p
        where p.id = project_id
          and p.organization_id = private.current_organization_id()
          and p.owning_department_id = private.current_department_id()
          and p.deleted_at is null
      )
    )
    or exists (
      select 1
      from public.task_research_assets as tra
      join public.tasks as t
        on t.id = tra.task_id
      where tra.research_asset_id = public.research_assets.id
        and tra.organization_id = private.current_organization_id()
        and t.organization_id = private.current_organization_id()
        and t.department_id = private.current_department_id()
        and t.deleted_at is null
    )
    or exists (
      select 1
      from public.work_packet_research_assets as wpra
      join public.work_packets as wp
        on wp.id = wpra.work_packet_id
      where wpra.research_asset_id = public.research_assets.id
        and wpra.organization_id = private.current_organization_id()
        and wp.organization_id = private.current_organization_id()
        and wp.department_id = private.current_department_id()
        and wp.deleted_at is null
    )
    or exists (
      select 1
      from public.output_research_assets as ora
      join public.outputs as o
        on o.id = ora.output_id
      where ora.research_asset_id = public.research_assets.id
        and ora.organization_id = private.current_organization_id()
        and o.organization_id = private.current_organization_id()
        and o.department_id = private.current_department_id()
        and o.deleted_at is null
    )
  )
)
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and (
    created_by_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = created_by_user_id
        and u.organization_id = private.current_organization_id()
        and u.deleted_at is null
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
        and (
          private.current_role() = 'org_admin'
          or p.owning_department_id = private.current_department_id()
        )
    )
  )
);

-- outputs
--
-- Outputs are department-owned through outputs.department_id. Delivery approval
-- enforcement is intentionally application-layer and the approvals output branch
-- is activated separately in 017.
create policy outputs_select_department_scope
on public.outputs
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
      and exists (
        select 1
        from public.tasks as t
        where t.id = task_id
          and t.organization_id = private.current_organization_id()
          and t.assigned_to_user_id = private.current_user_id()
          and t.deleted_at is null
      )
    )
  )
);

create policy outputs_insert_department_scope
on public.outputs
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and (
    private.current_role() = 'org_admin'
    or department_id = private.current_department_id()
  )
  and (
    created_by_user_id is null
    or created_by_user_id = private.current_user_id()
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
    from public.tasks as t
    where t.id = task_id
      and t.organization_id = private.current_organization_id()
      and t.department_id = public.outputs.department_id
      and t.project_id = public.outputs.project_id
      and t.deleted_at is null
  )
  and exists (
    select 1
    from public.projects as p
    where p.id = project_id
      and p.organization_id = private.current_organization_id()
      and p.deleted_at is null
  )
);

create policy outputs_update_department_scope
on public.outputs
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and (
    private.current_role() = 'org_admin'
    or department_id = private.current_department_id()
  )
)
with check (
  organization_id = private.current_organization_id()
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
    from public.tasks as t
    where t.id = task_id
      and t.organization_id = private.current_organization_id()
      and t.department_id = public.outputs.department_id
      and t.project_id = public.outputs.project_id
      and t.deleted_at is null
  )
  and exists (
    select 1
    from public.projects as p
    where p.id = project_id
      and p.organization_id = private.current_organization_id()
      and p.deleted_at is null
  )
  and (
    created_by_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = created_by_user_id
        and u.organization_id = private.current_organization_id()
        and u.deleted_at is null
    )
  )
);

-- knowledge_records
--
-- Knowledge records use subject_type/subject_id as the primary subject. Access
-- follows the referenced subject; agents are limited to assigned task context.
create policy knowledge_records_select_subject_scope
on public.knowledge_records
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and (
        (
          subject_type = 'project'
          and exists (
            select 1
            from public.projects as p
            where p.id = subject_id
              and p.organization_id = private.current_organization_id()
              and p.owning_department_id = private.current_department_id()
              and p.deleted_at is null
          )
        )
        or (
          subject_type = 'request'
          and exists (
            select 1
            from public.requests as r
            where r.id = subject_id
              and r.organization_id = private.current_organization_id()
              and r.routed_department_id = private.current_department_id()
              and r.deleted_at is null
          )
        )
        or (
          subject_type = 'task'
          and exists (
            select 1
            from public.tasks as t
            where t.id = subject_id
              and t.organization_id = private.current_organization_id()
              and t.department_id = private.current_department_id()
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
              and wp.department_id = private.current_department_id()
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
              and t.department_id = private.current_department_id()
              and t.deleted_at is null
          )
        )
        or (
          subject_type = 'research_asset'
          and exists (
            select 1
            from public.research_assets as ra
            where ra.id = subject_id
              and ra.organization_id = private.current_organization_id()
              and ra.deleted_at is null
          )
        )
        or (
          subject_type = 'output'
          and exists (
            select 1
            from public.outputs as o
            where o.id = subject_id
              and o.organization_id = private.current_organization_id()
              and o.department_id = private.current_department_id()
              and o.deleted_at is null
          )
        )
      )
    )
    or (
      private.current_role() = 'agent'
      and (
        (
          subject_type = 'project'
          and exists (
            select 1
            from public.tasks as t
            where t.project_id = subject_id
              and t.organization_id = private.current_organization_id()
              and t.assigned_to_user_id = private.current_user_id()
              and t.deleted_at is null
          )
        )
        or (
          subject_type = 'request'
          and exists (
            select 1
            from public.tasks as t
            where t.request_id = subject_id
              and t.organization_id = private.current_organization_id()
              and t.assigned_to_user_id = private.current_user_id()
              and t.deleted_at is null
          )
        )
        or (
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
          subject_type = 'work_packet'
          and exists (
            select 1
            from public.tasks as t
            where t.work_packet_id = subject_id
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
          subject_type = 'research_asset'
          and exists (
            select 1
            from public.task_research_assets as tra
            join public.tasks as t
              on t.id = tra.task_id
            where tra.research_asset_id = subject_id
              and tra.organization_id = private.current_organization_id()
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

create policy knowledge_records_insert_subject_scope
on public.knowledge_records
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member', 'agent')
  and (
    created_by_user_id is null
    or created_by_user_id = private.current_user_id()
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
  and (
    (
      subject_type = 'project'
      and exists (
        select 1
        from public.projects as p
        where p.id = subject_id
          and p.organization_id = private.current_organization_id()
          and p.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and p.owning_department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.project_id = p.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      subject_type = 'request'
      and exists (
        select 1
        from public.requests as r
        where r.id = subject_id
          and r.organization_id = private.current_organization_id()
          and r.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and r.routed_department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.request_id = r.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      subject_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = subject_id
          and t.organization_id = private.current_organization_id()
          and t.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and t.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
    or (
      subject_type = 'work_packet'
      and exists (
        select 1
        from public.work_packets as wp
        where wp.id = subject_id
          and wp.organization_id = private.current_organization_id()
          and wp.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and wp.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.work_packet_id = wp.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
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
          and t.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and t.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
    or (
      subject_type = 'research_asset'
      and exists (
        select 1
        from public.research_assets as ra
        where ra.id = subject_id
          and ra.organization_id = private.current_organization_id()
          and ra.deleted_at is null
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
          and o.deleted_at is null
          and t.organization_id = private.current_organization_id()
          and t.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and o.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
  )
);

create policy knowledge_records_update_subject_scope
on public.knowledge_records
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and (
    private.current_role() = 'org_admin'
    or (
      subject_type = 'project'
      and exists (
        select 1
        from public.projects as p
        where p.id = subject_id
          and p.organization_id = private.current_organization_id()
          and p.owning_department_id = private.current_department_id()
          and p.deleted_at is null
      )
    )
    or (
      subject_type = 'request'
      and exists (
        select 1
        from public.requests as r
        where r.id = subject_id
          and r.organization_id = private.current_organization_id()
          and r.routed_department_id = private.current_department_id()
          and r.deleted_at is null
      )
    )
    or (
      subject_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = subject_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = private.current_department_id()
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
          and wp.department_id = private.current_department_id()
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
          and t.department_id = private.current_department_id()
          and t.deleted_at is null
      )
    )
    or (
      subject_type = 'research_asset'
      and exists (
        select 1
        from public.research_assets as ra
        where ra.id = subject_id
          and ra.organization_id = private.current_organization_id()
          and ra.deleted_at is null
      )
    )
    or (
      subject_type = 'output'
      and exists (
        select 1
        from public.outputs as o
        where o.id = subject_id
          and o.organization_id = private.current_organization_id()
          and o.department_id = private.current_department_id()
          and o.deleted_at is null
      )
    )
  )
)
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and (
    private.current_role() = 'org_admin'
    or (
      subject_type = 'project'
      and exists (
        select 1
        from public.projects as p
        where p.id = subject_id
          and p.organization_id = private.current_organization_id()
          and p.owning_department_id = private.current_department_id()
          and p.deleted_at is null
      )
    )
    or (
      subject_type = 'request'
      and exists (
        select 1
        from public.requests as r
        where r.id = subject_id
          and r.organization_id = private.current_organization_id()
          and r.routed_department_id = private.current_department_id()
          and r.deleted_at is null
      )
    )
    or (
      subject_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = subject_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = private.current_department_id()
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
          and wp.department_id = private.current_department_id()
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
          and t.department_id = private.current_department_id()
          and t.deleted_at is null
      )
    )
    or (
      subject_type = 'research_asset'
      and exists (
        select 1
        from public.research_assets as ra
        where ra.id = subject_id
          and ra.organization_id = private.current_organization_id()
          and ra.deleted_at is null
      )
    )
    or (
      subject_type = 'output'
      and exists (
        select 1
        from public.outputs as o
        where o.id = subject_id
          and o.organization_id = private.current_organization_id()
          and o.department_id = private.current_department_id()
          and o.deleted_at is null
      )
    )
  )
  and (
    created_by_user_id is null
    or exists (
      select 1
      from public.users as u
      where u.id = created_by_user_id
        and u.organization_id = private.current_organization_id()
        and u.deleted_at is null
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

-- task_research_assets
create policy task_research_assets_select_parent_scope
on public.task_research_assets
for select
to authenticated
using (
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

create policy task_research_assets_insert_parent_scope
on public.task_research_assets
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
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
  and exists (
    select 1
    from public.research_assets as ra
    where ra.id = research_asset_id
      and ra.organization_id = private.current_organization_id()
      and ra.deleted_at is null
  )
);

-- work_packet_research_assets
create policy work_packet_research_assets_select_parent_scope
on public.work_packet_research_assets
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and exists (
    select 1
    from public.work_packets as wp
    where wp.id = work_packet_id
      and wp.organization_id = private.current_organization_id()
      and wp.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or (
          private.current_role() in ('department_lead', 'department_member', 'read_only')
          and wp.department_id = private.current_department_id()
        )
        or (
          private.current_role() = 'agent'
          and exists (
            select 1
            from public.tasks as t
            where t.work_packet_id = wp.id
              and t.organization_id = private.current_organization_id()
              and t.assigned_to_user_id = private.current_user_id()
              and t.deleted_at is null
          )
        )
      )
  )
);

create policy work_packet_research_assets_insert_parent_scope
on public.work_packet_research_assets
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and exists (
    select 1
    from public.work_packets as wp
    where wp.id = work_packet_id
      and wp.organization_id = private.current_organization_id()
      and wp.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or wp.department_id = private.current_department_id()
      )
  )
  and exists (
    select 1
    from public.research_assets as ra
    where ra.id = research_asset_id
      and ra.organization_id = private.current_organization_id()
      and ra.deleted_at is null
  )
);

-- output_research_assets
create policy output_research_assets_select_parent_scope
on public.output_research_assets
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and exists (
    select 1
    from public.outputs as o
    join public.tasks as t
      on t.id = o.task_id
    where o.id = output_id
      and o.organization_id = private.current_organization_id()
      and o.deleted_at is null
      and t.organization_id = private.current_organization_id()
      and t.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or (
          private.current_role() in ('department_lead', 'department_member', 'read_only')
          and o.department_id = private.current_department_id()
        )
        or (
          private.current_role() = 'agent'
          and t.assigned_to_user_id = private.current_user_id()
        )
      )
  )
);

create policy output_research_assets_insert_parent_scope
on public.output_research_assets
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead', 'department_member')
  and exists (
    select 1
    from public.outputs as o
    where o.id = output_id
      and o.organization_id = private.current_organization_id()
      and o.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or o.department_id = private.current_department_id()
      )
  )
  and exists (
    select 1
    from public.research_assets as ra
    where ra.id = research_asset_id
      and ra.organization_id = private.current_organization_id()
      and ra.deleted_at is null
  )
);

-- knowledge_record_links
--
-- Secondary links must pass both sides: the parent knowledge record must be
-- visible through the same subject-scope rules as knowledge_records SELECT,
-- and the linked target must be visible in the caller's department or assigned
-- task context. Link visibility must never come from the linked target alone.
create policy knowledge_record_links_select_related_scope
on public.knowledge_record_links
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and exists (
    select 1
    from public.knowledge_records as kr
    where kr.id = knowledge_record_id
      and kr.organization_id = private.current_organization_id()
      and kr.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or (
          private.current_role() in ('department_lead', 'department_member', 'read_only')
          and (
            (
              kr.subject_type = 'project'
              and exists (
                select 1
                from public.projects as p
                where p.id = kr.subject_id
                  and p.organization_id = private.current_organization_id()
                  and p.owning_department_id = private.current_department_id()
                  and p.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'request'
              and exists (
                select 1
                from public.requests as r
                where r.id = kr.subject_id
                  and r.organization_id = private.current_organization_id()
                  and r.routed_department_id = private.current_department_id()
                  and r.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'task'
              and exists (
                select 1
                from public.tasks as t
                where t.id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.department_id = private.current_department_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'work_packet'
              and exists (
                select 1
                from public.work_packets as wp
                where wp.id = kr.subject_id
                  and wp.organization_id = private.current_organization_id()
                  and wp.department_id = private.current_department_id()
                  and wp.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'decision'
              and exists (
                select 1
                from public.decisions as d
                join public.tasks as t
                  on t.id = d.task_id
                where d.id = kr.subject_id
                  and d.organization_id = private.current_organization_id()
                  and d.deleted_at is null
                  and t.organization_id = private.current_organization_id()
                  and t.department_id = private.current_department_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'research_asset'
              and exists (
                select 1
                from public.research_assets as ra
                where ra.id = kr.subject_id
                  and ra.organization_id = private.current_organization_id()
                  and ra.deleted_at is null
                  and (
                    (
                      ra.project_id is not null
                      and exists (
                        select 1
                        from public.projects as p
                        where p.id = ra.project_id
                          and p.organization_id = private.current_organization_id()
                          and p.owning_department_id = private.current_department_id()
                          and p.deleted_at is null
                      )
                    )
                    or exists (
                      select 1
                      from public.task_research_assets as tra
                      join public.tasks as t
                        on t.id = tra.task_id
                      where tra.research_asset_id = ra.id
                        and tra.organization_id = private.current_organization_id()
                        and t.organization_id = private.current_organization_id()
                        and t.department_id = private.current_department_id()
                        and t.deleted_at is null
                    )
                    or exists (
                      select 1
                      from public.work_packet_research_assets as wpra
                      join public.work_packets as wp
                        on wp.id = wpra.work_packet_id
                      where wpra.research_asset_id = ra.id
                        and wpra.organization_id = private.current_organization_id()
                        and wp.organization_id = private.current_organization_id()
                        and wp.department_id = private.current_department_id()
                        and wp.deleted_at is null
                    )
                    or exists (
                      select 1
                      from public.output_research_assets as ora
                      join public.outputs as o
                        on o.id = ora.output_id
                      where ora.research_asset_id = ra.id
                        and ora.organization_id = private.current_organization_id()
                        and o.organization_id = private.current_organization_id()
                        and o.department_id = private.current_department_id()
                        and o.deleted_at is null
                    )
                  )
              )
            )
            or (
              kr.subject_type = 'output'
              and exists (
                select 1
                from public.outputs as o
                where o.id = kr.subject_id
                  and o.organization_id = private.current_organization_id()
                  and o.department_id = private.current_department_id()
                  and o.deleted_at is null
              )
            )
          )
        )
        or (
          private.current_role() = 'agent'
          and (
            (
              kr.subject_type = 'project'
              and exists (
                select 1
                from public.tasks as t
                where t.project_id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'request'
              and exists (
                select 1
                from public.tasks as t
                where t.request_id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'task'
              and exists (
                select 1
                from public.tasks as t
                where t.id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'work_packet'
              and exists (
                select 1
                from public.tasks as t
                where t.work_packet_id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'decision'
              and exists (
                select 1
                from public.decisions as d
                join public.tasks as t
                  on t.id = d.task_id
                where d.id = kr.subject_id
                  and d.organization_id = private.current_organization_id()
                  and d.deleted_at is null
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'research_asset'
              and exists (
                select 1
                from public.task_research_assets as tra
                join public.tasks as t
                  on t.id = tra.task_id
                where tra.research_asset_id = kr.subject_id
                  and tra.organization_id = private.current_organization_id()
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'output'
              and exists (
                select 1
                from public.outputs as o
                join public.tasks as t
                  on t.id = o.task_id
                where o.id = kr.subject_id
                  and o.organization_id = private.current_organization_id()
                  and o.deleted_at is null
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
        )
      )
  )
  and (
    private.current_role() = 'org_admin'
    or (
      linked_entity_type = 'project'
      and exists (
        select 1
        from public.projects as p
        where p.id = linked_entity_id
          and p.organization_id = private.current_organization_id()
          and p.deleted_at is null
          and (
            (
              private.current_role() in ('department_lead', 'department_member', 'read_only')
              and p.owning_department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.project_id = p.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      linked_entity_type = 'request'
      and exists (
        select 1
        from public.requests as r
        where r.id = linked_entity_id
          and r.organization_id = private.current_organization_id()
          and r.deleted_at is null
          and (
            (
              private.current_role() in ('department_lead', 'department_member', 'read_only')
              and r.routed_department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.request_id = r.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      linked_entity_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = linked_entity_id
          and t.organization_id = private.current_organization_id()
          and t.deleted_at is null
          and (
            (
              private.current_role() in ('department_lead', 'department_member', 'read_only')
              and t.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
    or (
      linked_entity_type = 'work_packet'
      and exists (
        select 1
        from public.work_packets as wp
        where wp.id = linked_entity_id
          and wp.organization_id = private.current_organization_id()
          and wp.deleted_at is null
          and (
            (
              private.current_role() in ('department_lead', 'department_member', 'read_only')
              and wp.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.work_packet_id = wp.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      linked_entity_type = 'decision'
      and exists (
        select 1
        from public.decisions as d
        join public.tasks as t
          on t.id = d.task_id
        where d.id = linked_entity_id
          and d.organization_id = private.current_organization_id()
          and d.deleted_at is null
          and t.organization_id = private.current_organization_id()
          and t.deleted_at is null
          and (
            (
              private.current_role() in ('department_lead', 'department_member', 'read_only')
              and t.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
    or (
      linked_entity_type = 'research_asset'
      and exists (
        select 1
        from public.research_assets as ra
        where ra.id = linked_entity_id
          and ra.organization_id = private.current_organization_id()
          and ra.deleted_at is null
          and (
            (
              private.current_role() in ('department_lead', 'department_member', 'read_only')
              and (
                (
                  ra.project_id is not null
                  and exists (
                    select 1
                    from public.projects as p
                    where p.id = ra.project_id
                      and p.organization_id = private.current_organization_id()
                      and p.owning_department_id = private.current_department_id()
                      and p.deleted_at is null
                  )
                )
                or exists (
                  select 1
                  from public.task_research_assets as tra
                  join public.tasks as t
                    on t.id = tra.task_id
                  where tra.research_asset_id = ra.id
                    and tra.organization_id = private.current_organization_id()
                    and t.organization_id = private.current_organization_id()
                    and t.department_id = private.current_department_id()
                    and t.deleted_at is null
                )
                or exists (
                  select 1
                  from public.work_packet_research_assets as wpra
                  join public.work_packets as wp
                    on wp.id = wpra.work_packet_id
                  where wpra.research_asset_id = ra.id
                    and wpra.organization_id = private.current_organization_id()
                    and wp.organization_id = private.current_organization_id()
                    and wp.department_id = private.current_department_id()
                    and wp.deleted_at is null
                )
                or exists (
                  select 1
                  from public.output_research_assets as ora
                  join public.outputs as o
                    on o.id = ora.output_id
                  where ora.research_asset_id = ra.id
                    and ora.organization_id = private.current_organization_id()
                    and o.organization_id = private.current_organization_id()
                    and o.department_id = private.current_department_id()
                    and o.deleted_at is null
                )
              )
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.task_research_assets as tra
                join public.tasks as t
                  on t.id = tra.task_id
                where tra.research_asset_id = ra.id
                  and tra.organization_id = private.current_organization_id()
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      linked_entity_type = 'output'
      and exists (
        select 1
        from public.outputs as o
        join public.tasks as t
          on t.id = o.task_id
        where o.id = linked_entity_id
          and o.organization_id = private.current_organization_id()
          and o.deleted_at is null
          and t.organization_id = private.current_organization_id()
          and t.deleted_at is null
          and (
            (
              private.current_role() in ('department_lead', 'department_member', 'read_only')
              and o.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
    or (
      linked_entity_type = 'execution_log'
      and exists (
        select 1
        from public.execution_logs as el
        where el.id = linked_entity_id
          and el.organization_id = private.current_organization_id()
          and (
            (
              private.current_role() in ('department_lead', 'department_member', 'read_only')
              and (
                (
                  el.context_type = 'task'
                  and exists (
                    select 1
                    from public.tasks as t
                    where t.id = el.context_id
                      and t.organization_id = private.current_organization_id()
                      and t.department_id = private.current_department_id()
                      and t.deleted_at is null
                  )
                )
                or (
                  el.context_type = 'request'
                  and exists (
                    select 1
                    from public.requests as r
                    where r.id = el.context_id
                      and r.organization_id = private.current_organization_id()
                      and r.routed_department_id = private.current_department_id()
                      and r.deleted_at is null
                  )
                )
                or (
                  el.context_type = 'workflow'
                  and exists (
                    select 1
                    from public.workflows as w
                    where w.id = el.context_id
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
              and el.context_type = 'task'
              and exists (
                select 1
                from public.tasks as t
                where t.id = el.context_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
  )
);

create policy knowledge_record_links_insert_related_scope
on public.knowledge_record_links
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead', 'department_member', 'agent')
  and exists (
    select 1
    from public.knowledge_records as kr
    where kr.id = knowledge_record_id
      and kr.organization_id = private.current_organization_id()
      and kr.deleted_at is null
      and (
        private.current_role() = 'org_admin'
        or (
          private.current_role() in ('department_lead', 'department_member')
          and (
            (
              kr.subject_type = 'project'
              and exists (
                select 1
                from public.projects as p
                where p.id = kr.subject_id
                  and p.organization_id = private.current_organization_id()
                  and p.owning_department_id = private.current_department_id()
                  and p.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'request'
              and exists (
                select 1
                from public.requests as r
                where r.id = kr.subject_id
                  and r.organization_id = private.current_organization_id()
                  and r.routed_department_id = private.current_department_id()
                  and r.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'task'
              and exists (
                select 1
                from public.tasks as t
                where t.id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.department_id = private.current_department_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'work_packet'
              and exists (
                select 1
                from public.work_packets as wp
                where wp.id = kr.subject_id
                  and wp.organization_id = private.current_organization_id()
                  and wp.department_id = private.current_department_id()
                  and wp.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'decision'
              and exists (
                select 1
                from public.decisions as d
                join public.tasks as t
                  on t.id = d.task_id
                where d.id = kr.subject_id
                  and d.organization_id = private.current_organization_id()
                  and d.deleted_at is null
                  and t.organization_id = private.current_organization_id()
                  and t.department_id = private.current_department_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'research_asset'
              and exists (
                select 1
                from public.research_assets as ra
                where ra.id = kr.subject_id
                  and ra.organization_id = private.current_organization_id()
                  and ra.deleted_at is null
                  and (
                    (
                      ra.project_id is not null
                      and exists (
                        select 1
                        from public.projects as p
                        where p.id = ra.project_id
                          and p.organization_id = private.current_organization_id()
                          and p.owning_department_id = private.current_department_id()
                          and p.deleted_at is null
                      )
                    )
                    or exists (
                      select 1
                      from public.task_research_assets as tra
                      join public.tasks as t
                        on t.id = tra.task_id
                      where tra.research_asset_id = ra.id
                        and tra.organization_id = private.current_organization_id()
                        and t.organization_id = private.current_organization_id()
                        and t.department_id = private.current_department_id()
                        and t.deleted_at is null
                    )
                    or exists (
                      select 1
                      from public.work_packet_research_assets as wpra
                      join public.work_packets as wp
                        on wp.id = wpra.work_packet_id
                      where wpra.research_asset_id = ra.id
                        and wpra.organization_id = private.current_organization_id()
                        and wp.organization_id = private.current_organization_id()
                        and wp.department_id = private.current_department_id()
                        and wp.deleted_at is null
                    )
                    or exists (
                      select 1
                      from public.output_research_assets as ora
                      join public.outputs as o
                        on o.id = ora.output_id
                      where ora.research_asset_id = ra.id
                        and ora.organization_id = private.current_organization_id()
                        and o.organization_id = private.current_organization_id()
                        and o.department_id = private.current_department_id()
                        and o.deleted_at is null
                    )
                  )
              )
            )
            or (
              kr.subject_type = 'output'
              and exists (
                select 1
                from public.outputs as o
                where o.id = kr.subject_id
                  and o.organization_id = private.current_organization_id()
                  and o.department_id = private.current_department_id()
                  and o.deleted_at is null
              )
            )
          )
        )
        or (
          private.current_role() = 'agent'
          and (
            (
              kr.subject_type = 'project'
              and exists (
                select 1
                from public.tasks as t
                where t.project_id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'request'
              and exists (
                select 1
                from public.tasks as t
                where t.request_id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'task'
              and exists (
                select 1
                from public.tasks as t
                where t.id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'work_packet'
              and exists (
                select 1
                from public.tasks as t
                where t.work_packet_id = kr.subject_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'decision'
              and exists (
                select 1
                from public.decisions as d
                join public.tasks as t
                  on t.id = d.task_id
                where d.id = kr.subject_id
                  and d.organization_id = private.current_organization_id()
                  and d.deleted_at is null
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'research_asset'
              and exists (
                select 1
                from public.task_research_assets as tra
                join public.tasks as t
                  on t.id = tra.task_id
                where tra.research_asset_id = kr.subject_id
                  and tra.organization_id = private.current_organization_id()
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
            or (
              kr.subject_type = 'output'
              and exists (
                select 1
                from public.outputs as o
                join public.tasks as t
                  on t.id = o.task_id
                where o.id = kr.subject_id
                  and o.organization_id = private.current_organization_id()
                  and o.deleted_at is null
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
        )
      )
  )
  and (
    (
      linked_entity_type = 'project'
      and exists (
        select 1
        from public.projects as p
        where p.id = linked_entity_id
          and p.organization_id = private.current_organization_id()
          and p.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and p.owning_department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.project_id = p.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      linked_entity_type = 'request'
      and exists (
        select 1
        from public.requests as r
        where r.id = linked_entity_id
          and r.organization_id = private.current_organization_id()
          and r.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and r.routed_department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.request_id = r.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      linked_entity_type = 'task'
      and exists (
        select 1
        from public.tasks as t
        where t.id = linked_entity_id
          and t.organization_id = private.current_organization_id()
          and t.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and t.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
    or (
      linked_entity_type = 'work_packet'
      and exists (
        select 1
        from public.work_packets as wp
        where wp.id = linked_entity_id
          and wp.organization_id = private.current_organization_id()
          and wp.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and wp.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.tasks as t
                where t.work_packet_id = wp.id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      linked_entity_type = 'decision'
      and exists (
        select 1
        from public.decisions as d
        join public.tasks as t
          on t.id = d.task_id
        where d.id = linked_entity_id
          and d.organization_id = private.current_organization_id()
          and d.deleted_at is null
          and t.organization_id = private.current_organization_id()
          and t.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and t.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
    or (
      linked_entity_type = 'research_asset'
      and exists (
        select 1
        from public.research_assets as ra
        where ra.id = linked_entity_id
          and ra.organization_id = private.current_organization_id()
          and ra.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and (
                (
                  ra.project_id is not null
                  and exists (
                    select 1
                    from public.projects as p
                    where p.id = ra.project_id
                      and p.organization_id = private.current_organization_id()
                      and p.owning_department_id = private.current_department_id()
                      and p.deleted_at is null
                  )
                )
                or exists (
                  select 1
                  from public.task_research_assets as tra
                  join public.tasks as t
                    on t.id = tra.task_id
                  where tra.research_asset_id = ra.id
                    and tra.organization_id = private.current_organization_id()
                    and t.organization_id = private.current_organization_id()
                    and t.department_id = private.current_department_id()
                    and t.deleted_at is null
                )
                or exists (
                  select 1
                  from public.work_packet_research_assets as wpra
                  join public.work_packets as wp
                    on wp.id = wpra.work_packet_id
                  where wpra.research_asset_id = ra.id
                    and wpra.organization_id = private.current_organization_id()
                    and wp.organization_id = private.current_organization_id()
                    and wp.department_id = private.current_department_id()
                    and wp.deleted_at is null
                )
                or exists (
                  select 1
                  from public.output_research_assets as ora
                  join public.outputs as o
                    on o.id = ora.output_id
                  where ora.research_asset_id = ra.id
                    and ora.organization_id = private.current_organization_id()
                    and o.organization_id = private.current_organization_id()
                    and o.department_id = private.current_department_id()
                    and o.deleted_at is null
                )
              )
            )
            or (
              private.current_role() = 'agent'
              and exists (
                select 1
                from public.task_research_assets as tra
                join public.tasks as t
                  on t.id = tra.task_id
                where tra.research_asset_id = ra.id
                  and tra.organization_id = private.current_organization_id()
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
    or (
      linked_entity_type = 'output'
      and exists (
        select 1
        from public.outputs as o
        join public.tasks as t
          on t.id = o.task_id
        where o.id = linked_entity_id
          and o.organization_id = private.current_organization_id()
          and o.deleted_at is null
          and t.organization_id = private.current_organization_id()
          and t.deleted_at is null
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and o.department_id = private.current_department_id()
            )
            or (
              private.current_role() = 'agent'
              and t.assigned_to_user_id = private.current_user_id()
            )
          )
      )
    )
    or (
      linked_entity_type = 'execution_log'
      and exists (
        select 1
        from public.execution_logs as el
        where el.id = linked_entity_id
          and el.organization_id = private.current_organization_id()
          and (
            private.current_role() = 'org_admin'
            or (
              private.current_role() in ('department_lead', 'department_member')
              and (
                (
                  el.context_type = 'task'
                  and exists (
                    select 1
                    from public.tasks as t
                    where t.id = el.context_id
                      and t.organization_id = private.current_organization_id()
                      and t.department_id = private.current_department_id()
                      and t.deleted_at is null
                  )
                )
                or (
                  el.context_type = 'request'
                  and exists (
                    select 1
                    from public.requests as r
                    where r.id = el.context_id
                      and r.organization_id = private.current_organization_id()
                      and r.routed_department_id = private.current_department_id()
                      and r.deleted_at is null
                  )
                )
                or (
                  el.context_type = 'workflow'
                  and exists (
                    select 1
                    from public.workflows as w
                    where w.id = el.context_id
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
              and el.context_type = 'task'
              and exists (
                select 1
                from public.tasks as t
                where t.id = el.context_id
                  and t.organization_id = private.current_organization_id()
                  and t.assigned_to_user_id = private.current_user_id()
                  and t.deleted_at is null
              )
            )
          )
      )
    )
  )
);
