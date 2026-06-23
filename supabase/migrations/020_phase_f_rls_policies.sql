-- AI Command Center
-- Phase F Runtime Operations & Hardening — RLS Policies
--
-- Source documents:
-- - docs/phase-f-runtime-hardening-plan.md
-- - docs/supabase-runtime-data-model.md
-- - supabase/migrations/005_rls_policies.sql
-- - supabase/migrations/009_phase_c_rls_policies.sql
-- - supabase/migrations/013_phase_d_rls_policies.sql
-- - supabase/migrations/016_phase_e_rls_policies.sql
-- - supabase/migrations/018_runtime_hardening.sql
-- - supabase/migrations/019_phase_f_grants.sql
--
-- Scope:
-- - RLS policies for Phase F runtime operations and hardening tables only:
--   audit_events, scheduled_tasks, background_jobs, dead_letter_queue,
--   runtime_metrics, agent_activity
--
-- Explicitly excluded:
-- - New helper functions
-- - New tables
-- - Seed data
-- - Supabase command execution
-- - Hard-delete access from the authenticated client path
-- - Anonymous role access
-- - Policies for privileges not granted by 019_phase_f_grants.sql

-- audit_events
--
-- Platform-level security and admin audit envelope. Read access is restricted
-- to org_admin; all other roles are denied by default. INSERT is service_role
-- only — no authenticated INSERT policy is created here. No UPDATE or DELETE
-- policies exist; audit_events is append-only by design.
create policy audit_events_select_org_admin
on public.audit_events
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and private.current_role() = 'org_admin'
);

-- scheduled_tasks
--
-- Schedule definitions are scoped to the owning department. org_admin reads and
-- writes all schedules in the organization. department_lead and department_member
-- and read_only read schedules owned by their department (owner_department_id
-- matches their department_id). Schedules with no owner_department_id are
-- org-wide and visible to org_admin only. Only org_admin and department_lead
-- may create or update schedule definitions; department_member and read_only
-- have no write access. Agents have no access to scheduled_tasks.
create policy scheduled_tasks_select_org_and_department_scope
on public.scheduled_tasks
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and owner_department_id = private.current_department_id()
    )
  )
);

create policy scheduled_tasks_insert_admin_or_department_lead
on public.scheduled_tasks
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and private.current_role() in ('org_admin', 'department_lead')
  and (
    private.current_role() = 'org_admin'
    or owner_department_id = private.current_department_id()
  )
  and (
    created_by_user_id is null
    or created_by_user_id = private.current_user_id()
  )
  and (
    owner_department_id is null
    or exists (
      select 1
      from public.departments as d
      where d.id = owner_department_id
        and d.organization_id = private.current_organization_id()
        and d.deleted_at is null
    )
  )
);

create policy scheduled_tasks_update_admin_or_department_lead
on public.scheduled_tasks
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and owner_department_id = private.current_department_id()
    )
  )
)
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead')
  and (
    private.current_role() = 'org_admin'
    or owner_department_id = private.current_department_id()
  )
  and (
    owner_department_id is null
    or exists (
      select 1
      from public.departments as d
      where d.id = owner_department_id
        and d.organization_id = private.current_organization_id()
        and d.deleted_at is null
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
);

-- background_jobs
--
-- Background jobs are org-scoped with indirect department access through related
-- entity FKs. A job is visible to department-scoped roles when one of its related
-- entity references (related_task_id, related_request_id, related_work_packet_id,
-- parent_schedule_id) resolves to the caller's department. Jobs with no related
-- entities are visible to org_admin only. Agents access jobs related to their
-- assigned task only. INSERT is restricted to org_admin for manual job creation;
-- service_role enqueues system jobs outside RLS. UPDATE is restricted to
-- org_admin (cancel/retry); service_role drives automated status transitions
-- outside RLS.
create policy background_jobs_select_org_and_department_scope
on public.background_jobs
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member')
      and (
        (
          related_task_id is not null
          and exists (
            select 1
            from public.tasks as t
            where t.id = related_task_id
              and t.organization_id = private.current_organization_id()
              and t.department_id = private.current_department_id()
              and t.deleted_at is null
          )
        )
        or (
          related_request_id is not null
          and exists (
            select 1
            from public.requests as r
            where r.id = related_request_id
              and r.organization_id = private.current_organization_id()
              and r.routed_department_id = private.current_department_id()
              and r.deleted_at is null
          )
        )
        or (
          related_work_packet_id is not null
          and exists (
            select 1
            from public.work_packets as wp
            where wp.id = related_work_packet_id
              and wp.organization_id = private.current_organization_id()
              and wp.department_id = private.current_department_id()
              and wp.deleted_at is null
          )
        )
        or (
          parent_schedule_id is not null
          and exists (
            select 1
            from public.scheduled_tasks as st
            where st.id = parent_schedule_id
              and st.organization_id = private.current_organization_id()
              and st.owner_department_id = private.current_department_id()
              and st.deleted_at is null
          )
        )
      )
    )
    or (
      private.current_role() = 'agent'
      and related_task_id is not null
      and exists (
        select 1
        from public.tasks as t
        where t.id = related_task_id
          and t.organization_id = private.current_organization_id()
          and t.assigned_to_user_id = private.current_user_id()
          and t.deleted_at is null
      )
    )
  )
);

create policy background_jobs_insert_org_admin
on public.background_jobs
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and private.current_role() = 'org_admin'
  and (
    created_by_user_id is null
    or created_by_user_id = private.current_user_id()
  )
  and (
    related_task_id is null
    or exists (
      select 1
      from public.tasks as t
      where t.id = related_task_id
        and t.organization_id = private.current_organization_id()
        and t.deleted_at is null
    )
  )
  and (
    related_request_id is null
    or exists (
      select 1
      from public.requests as r
      where r.id = related_request_id
        and r.organization_id = private.current_organization_id()
        and r.deleted_at is null
    )
  )
  and (
    related_work_packet_id is null
    or exists (
      select 1
      from public.work_packets as wp
      where wp.id = related_work_packet_id
        and wp.organization_id = private.current_organization_id()
        and wp.deleted_at is null
    )
  )
  and (
    parent_schedule_id is null
    or exists (
      select 1
      from public.scheduled_tasks as st
      where st.id = parent_schedule_id
        and st.organization_id = private.current_organization_id()
        and st.deleted_at is null
    )
  )
);

create policy background_jobs_update_org_admin
on public.background_jobs
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and private.current_role() = 'org_admin'
)
with check (
  organization_id = private.current_organization_id()
  and private.current_role() = 'org_admin'
);

-- dead_letter_queue
--
-- Dead-letter entries connect to a background_job via job_id. Department scope
-- is resolved by joining through the failed job's related entity references
-- using the same co-tenancy logic as background_jobs SELECT. Entries whose
-- parent job has no related entities are visible to org_admin only. INSERT is
-- service_role only — no authenticated INSERT policy is created. org_admin and
-- department_lead may update resolution fields (resolution_status,
-- resolution_note, resolved_by_user_id, resolved_at) on entries visible to
-- them. resolved_by_user_id must match the caller's own user_id when set.
create policy dead_letter_queue_select_org_and_department_scope
on public.dead_letter_queue
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and exists (
        select 1
        from public.background_jobs as bj
        where bj.id = job_id
          and bj.organization_id = private.current_organization_id()
          and (
            (
              bj.related_task_id is not null
              and exists (
                select 1
                from public.tasks as t
                where t.id = bj.related_task_id
                  and t.organization_id = private.current_organization_id()
                  and t.department_id = private.current_department_id()
                  and t.deleted_at is null
              )
            )
            or (
              bj.related_request_id is not null
              and exists (
                select 1
                from public.requests as r
                where r.id = bj.related_request_id
                  and r.organization_id = private.current_organization_id()
                  and r.routed_department_id = private.current_department_id()
                  and r.deleted_at is null
              )
            )
            or (
              bj.related_work_packet_id is not null
              and exists (
                select 1
                from public.work_packets as wp
                where wp.id = bj.related_work_packet_id
                  and wp.organization_id = private.current_organization_id()
                  and wp.department_id = private.current_department_id()
                  and wp.deleted_at is null
              )
            )
            or (
              bj.parent_schedule_id is not null
              and exists (
                select 1
                from public.scheduled_tasks as st
                where st.id = bj.parent_schedule_id
                  and st.organization_id = private.current_organization_id()
                  and st.owner_department_id = private.current_department_id()
                  and st.deleted_at is null
              )
            )
          )
      )
    )
  )
);

create policy dead_letter_queue_update_org_and_department_lead
on public.dead_letter_queue
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and exists (
        select 1
        from public.background_jobs as bj
        where bj.id = job_id
          and bj.organization_id = private.current_organization_id()
          and (
            (
              bj.related_task_id is not null
              and exists (
                select 1
                from public.tasks as t
                where t.id = bj.related_task_id
                  and t.organization_id = private.current_organization_id()
                  and t.department_id = private.current_department_id()
                  and t.deleted_at is null
              )
            )
            or (
              bj.related_request_id is not null
              and exists (
                select 1
                from public.requests as r
                where r.id = bj.related_request_id
                  and r.organization_id = private.current_organization_id()
                  and r.routed_department_id = private.current_department_id()
                  and r.deleted_at is null
              )
            )
            or (
              bj.related_work_packet_id is not null
              and exists (
                select 1
                from public.work_packets as wp
                where wp.id = bj.related_work_packet_id
                  and wp.organization_id = private.current_organization_id()
                  and wp.department_id = private.current_department_id()
                  and wp.deleted_at is null
              )
            )
            or (
              bj.parent_schedule_id is not null
              and exists (
                select 1
                from public.scheduled_tasks as st
                where st.id = bj.parent_schedule_id
                  and st.organization_id = private.current_organization_id()
                  and st.owner_department_id = private.current_department_id()
                  and st.deleted_at is null
              )
            )
          )
      )
    )
  )
)
with check (
  organization_id = private.current_organization_id()
  and private.current_role() in ('org_admin', 'department_lead')
  and (
    resolved_by_user_id is null
    or resolved_by_user_id = private.current_user_id()
  )
);

-- runtime_metrics
--
-- Runtime metrics may be org-wide (department_id IS NULL) or department-scoped
-- (department_id is a direct FK to departments). org_admin reads all metrics in
-- the organization. department_lead, department_member, and read_only read both
-- their department-scoped metrics and org-wide aggregates (department_id IS
-- NULL). INSERT and UPDATE are service_role only — no authenticated write policy
-- exists for this table.
create policy runtime_metrics_select_org_and_department_scope
on public.runtime_metrics
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and (
        department_id is null
        or department_id = private.current_department_id()
      )
    )
  )
);

-- agent_activity
--
-- Agent activity rows are owned by the recording agent. org_admin reads all
-- activity in the organization. department_lead, department_member, and read_only
-- read activity where the referenced task belongs to their department; activity
-- rows with no task_id are not visible to department-scoped roles. Agents read
-- their own activity rows only (agent_user_id = current_user_id()). INSERT is
-- restricted to the agent role with agent_user_id pinned to
-- private.current_user_id() — this is the critical security constraint
-- (Risk #11) that prevents an agent from inserting rows claiming another
-- agent's identity. task_id, when present, must reference a task assigned to
-- the inserting agent. No UPDATE policy: agent_activity is append-only.
create policy agent_activity_select_org_and_department_scope
on public.agent_activity
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member')
      and task_id is not null
      and exists (
        select 1
        from public.tasks as t
        where t.id = task_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = private.current_department_id()
          and t.deleted_at is null
      )
    )
    or (
      private.current_role() = 'agent'
      and agent_user_id = private.current_user_id()
    )
  )
);

create policy agent_activity_insert_agent_self
on public.agent_activity
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and private.current_role() = 'agent'
  and agent_user_id = private.current_user_id()
  and (
    task_id is null
    or exists (
      select 1
      from public.tasks as t
      where t.id = task_id
        and t.organization_id = private.current_organization_id()
        and t.assigned_to_user_id = private.current_user_id()
        and t.deleted_at is null
    )
  )
  and (
    work_packet_id is null
    or exists (
      select 1
      from public.work_packets as wp
      where wp.id = work_packet_id
        and wp.organization_id = private.current_organization_id()
        and wp.deleted_at is null
    )
  )
);
