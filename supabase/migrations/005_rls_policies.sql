-- AI Command Center
-- Phase 005 RLS Policies
--
-- Source documents:
-- - docs/005-rls-policy-plan.md
-- - docs/supabase-runtime-data-model.md
-- - docs/approval-rules.md
-- - supabase/migrations/001_foundation.sql
-- - supabase/migrations/002_foundation_hardening.sql
-- - supabase/migrations/003_system_intelligence.sql
-- - supabase/migrations/004_seed_bootstrap.sql
--
-- Scope:
-- - RLS policies for existing runtime tables only:
--   organizations, users, departments, projects, tool_profiles, workflows
--
-- Explicitly excluded:
-- - New tables
-- - Seed data
-- - Supabase command execution
-- - Hard-delete access from the authenticated client path

-- These helper functions are the minimal extra database objects required to
-- avoid recursive RLS checks on public.users while still using public.users as
-- the membership source keyed by auth.uid(). They live in a non-exposed schema,
-- use a pinned search_path, and are executable only by authenticated sessions.
create schema if not exists private;

revoke all on schema private from public;

grant usage on schema private to authenticated;

create or replace function private.current_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.status = 'active'
    and u.deleted_at is null
  limit 1;
$$;

create or replace function private.current_organization_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.organization_id
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.status = 'active'
    and u.deleted_at is null
  limit 1;
$$;

create or replace function private.current_department_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.department_id
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.status = 'active'
    and u.deleted_at is null
  limit 1;
$$;

create or replace function private.current_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.role
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.status = 'active'
    and u.deleted_at is null
  limit 1;
$$;

create or replace function private.current_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email
  from public.users as u
  where u.auth_user_id = auth.uid()
    and u.status = 'active'
    and u.deleted_at is null
  limit 1;
$$;

create or replace function private.is_org_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_role() = 'org_admin';
$$;

revoke all on function private.current_user_id() from public;
revoke all on function private.current_organization_id() from public;
revoke all on function private.current_department_id() from public;
revoke all on function private.current_role() from public;
revoke all on function private.current_email() from public;
revoke all on function private.is_org_admin() from public;

grant execute on function private.current_user_id() to authenticated;
grant execute on function private.current_organization_id() to authenticated;
grant execute on function private.current_department_id() to authenticated;
grant execute on function private.current_role() to authenticated;
grant execute on function private.current_email() to authenticated;
grant execute on function private.is_org_admin() to authenticated;

-- organizations
create policy organizations_select_own_org
on public.organizations
for select
to authenticated
using (
  id = private.current_organization_id()
  and deleted_at is null
);

create policy organizations_update_org_admin
on public.organizations
for update
to authenticated
using (
  private.is_org_admin()
  and id = private.current_organization_id()
  and deleted_at is null
)
with check (
  private.is_org_admin()
  and id = private.current_organization_id()
);

-- users
create policy users_select_same_org
on public.users
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
);

create policy users_insert_org_admin
on public.users
for insert
to authenticated
with check (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and auth_user_id is not null
  and deleted_at is null
);

create policy users_update_org_admin
on public.users
for update
to authenticated
using (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and deleted_at is null
)
with check (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
);

-- Self-service updates are intentionally narrow. RLS cannot grant by column,
-- so this policy keeps identity, tenancy, role, department, status, and email
-- pinned while allowing profile fields such as display_name to change.
create policy users_update_self_profile
on public.users
for update
to authenticated
using (
  id = private.current_user_id()
  and auth_user_id = auth.uid()
  and organization_id = private.current_organization_id()
  and deleted_at is null
)
with check (
  id = private.current_user_id()
  and auth_user_id = auth.uid()
  and organization_id = private.current_organization_id()
  and role = private.current_role()
  and department_id is not distinct from private.current_department_id()
  and status = 'active'
  and email = private.current_email()
);

-- departments
create policy departments_select_same_org
on public.departments
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and status != 'archived'
  and deleted_at is null
);

create policy departments_insert_org_admin
on public.departments
for insert
to authenticated
with check (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and deleted_at is null
);

create policy departments_update_org_admin
on public.departments
for update
to authenticated
using (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and deleted_at is null
)
with check (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and (
    default_tool_profile_id is null
    or exists (
      select 1
      from public.tool_profiles as tp
      where tp.id = default_tool_profile_id
        and tp.organization_id = private.current_organization_id()
        and tp.deleted_at is null
    )
  )
);

-- projects
create policy projects_select_by_role_scope
on public.projects
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or owning_department_id = private.current_department_id()
  )
);

create policy projects_insert_admin_or_department_lead
on public.projects
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and created_by = private.current_user_id()
  and deleted_at is null
  and exists (
    select 1
    from public.departments as d
    where d.id = owning_department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
  and (
    workflow_template_id is null
    or exists (
      select 1
      from public.workflows as w
      where w.id = workflow_template_id
        and w.organization_id = private.current_organization_id()
        and w.kind = 'template'
        and w.deleted_at is null
    )
  )
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and owning_department_id = private.current_department_id()
    )
  )
);

create policy projects_update_admin_or_department_lead
on public.projects
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and owning_department_id = private.current_department_id()
    )
  )
)
with check (
  organization_id = private.current_organization_id()
  and exists (
    select 1
    from public.departments as d
    where d.id = owning_department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
  and (
    workflow_template_id is null
    or exists (
      select 1
      from public.workflows as w
      where w.id = workflow_template_id
        and w.organization_id = private.current_organization_id()
        and w.kind = 'template'
        and w.deleted_at is null
    )
  )
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and owning_department_id = private.current_department_id()
    )
  )
);

-- tool_profiles
create policy tool_profiles_select_same_org
on public.tool_profiles
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and status != 'archived'
  and deleted_at is null
);

create policy tool_profiles_insert_org_admin
on public.tool_profiles
for insert
to authenticated
with check (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and created_by = private.current_user_id()
  and deleted_at is null
  and exists (
    select 1
    from public.departments as d
    where d.id = owner_department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
);

create policy tool_profiles_update_org_admin
on public.tool_profiles
for update
to authenticated
using (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and deleted_at is null
)
with check (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and exists (
    select 1
    from public.departments as d
    where d.id = owner_department_id
      and d.organization_id = private.current_organization_id()
      and d.deleted_at is null
  )
);

-- workflows
create policy workflows_select_templates_or_department_instances
on public.workflows
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and deleted_at is null
  and (
    (
      kind = 'template'
      and status != 'archived'
    )
    or private.current_role() = 'org_admin'
    or (
      kind = 'instance'
      and department_id = private.current_department_id()
    )
  )
);

create policy workflows_insert_templates_org_admin
on public.workflows
for insert
to authenticated
with check (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and created_by = private.current_user_id()
  and kind = 'template'
  and deleted_at is null
  and exists (
    select 1
    from public.tool_profiles as tp
    where tp.id = tool_profile_id
      and tp.organization_id = private.current_organization_id()
      and tp.deleted_at is null
  )
  and (
    department_id is null
    or exists (
      select 1
      from public.departments as d
      where d.id = department_id
        and d.organization_id = private.current_organization_id()
        and d.deleted_at is null
    )
  )
);

create policy workflows_insert_instances_department_scope
on public.workflows
for insert
to authenticated
with check (
  organization_id = private.current_organization_id()
  and created_by = private.current_user_id()
  and kind = 'instance'
  and deleted_at is null
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
    from public.tool_profiles as tp
    where tp.id = tool_profile_id
      and tp.organization_id = private.current_organization_id()
      and tp.deleted_at is null
  )
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member')
      and department_id = private.current_department_id()
    )
  )
);

create policy workflows_update_templates_org_admin
on public.workflows
for update
to authenticated
using (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and kind = 'template'
  and deleted_at is null
)
with check (
  private.is_org_admin()
  and organization_id = private.current_organization_id()
  and kind = 'template'
  and exists (
    select 1
    from public.tool_profiles as tp
    where tp.id = tool_profile_id
      and tp.organization_id = private.current_organization_id()
      and tp.deleted_at is null
  )
  and (
    department_id is null
    or exists (
      select 1
      from public.departments as d
      where d.id = department_id
        and d.organization_id = private.current_organization_id()
        and d.deleted_at is null
    )
  )
);

create policy workflows_update_instances_admin_or_department_lead
on public.workflows
for update
to authenticated
using (
  organization_id = private.current_organization_id()
  and kind = 'instance'
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
  and kind = 'instance'
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
    from public.tool_profiles as tp
    where tp.id = tool_profile_id
      and tp.organization_id = private.current_organization_id()
      and tp.deleted_at is null
  )
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() = 'department_lead'
      and department_id = private.current_department_id()
    )
  )
);
