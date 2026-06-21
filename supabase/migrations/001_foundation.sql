-- AI Command Center
-- Phase A Foundation Migration
--
-- Source documents:
-- - docs/phase-a-foundation-migration-plan.md
-- - docs/system-entities.md
-- - docs/supabase-runtime-data-model.md
--
-- Scope:
-- - Table definitions
-- - Constraints
-- - Indexes
--
-- Explicitly excluded:
-- - RLS policies
-- - Triggers
-- - Functions
-- - Views
-- - Seed data

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint organizations_name_not_empty
    check (length(trim(name)) > 0),
  constraint organizations_slug_not_empty
    check (length(trim(slug)) > 0),
  constraint organizations_status_check
    check (status in ('active', 'suspended', 'archived'))
);

create table public.users (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  auth_user_id uuid,
  email text not null,
  display_name text not null,
  role text not null default 'department_member',
  department_id uuid,
  status text not null default 'invited',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint users_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint users_auth_user_id_fkey
    foreign key (auth_user_id)
    references auth.users (id)
    on delete set null,
  constraint users_email_not_empty
    check (length(trim(email)) > 0),
  constraint users_display_name_not_empty
    check (length(trim(display_name)) > 0),
  constraint users_role_check
    check (role in ('org_admin', 'department_lead', 'department_member', 'agent', 'read_only')),
  constraint users_status_check
    check (status in ('active', 'invited', 'suspended', 'archived'))
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  slug text not null,
  mission text not null,
  default_tool_profile_id uuid,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint departments_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint departments_name_not_empty
    check (length(trim(name)) > 0),
  constraint departments_slug_not_empty
    check (length(trim(slug)) > 0),
  constraint departments_mission_not_empty
    check (length(trim(mission)) > 0),
  constraint departments_status_check
    check (status in ('active', 'inactive', 'archived'))
);

alter table public.users
  add constraint users_department_id_fkey
  foreign key (department_id)
  references public.departments (id)
  on delete restrict;

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  objective text not null,
  owning_department_id uuid not null,
  workflow_template_id uuid,
  created_by uuid not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint projects_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint projects_owning_department_id_fkey
    foreign key (owning_department_id)
    references public.departments (id)
    on delete restrict,
  constraint projects_created_by_fkey
    foreign key (created_by)
    references public.users (id)
    on delete restrict,
  constraint projects_name_not_empty
    check (length(trim(name)) > 0),
  constraint projects_objective_not_empty
    check (length(trim(objective)) > 0),
  constraint projects_status_check
    check (status in ('draft', 'active', 'on_hold', 'completed', 'archived', 'cancelled'))
);

create unique index organizations_slug_key
  on public.organizations (slug);

create index organizations_status_idx
  on public.organizations (status);

create unique index users_organization_email_key
  on public.users (organization_id, email);

create unique index users_auth_user_id_key
  on public.users (auth_user_id);

create index users_organization_role_idx
  on public.users (organization_id, role);

create index users_organization_department_id_idx
  on public.users (organization_id, department_id);

create index users_status_idx
  on public.users (status);

create unique index departments_organization_slug_key
  on public.departments (organization_id, slug);

create unique index departments_organization_name_key
  on public.departments (organization_id, name);

create index departments_organization_status_idx
  on public.departments (organization_id, status);

create index projects_organization_owning_department_id_idx
  on public.projects (organization_id, owning_department_id);

create index projects_organization_status_idx
  on public.projects (organization_id, status);

create index projects_created_by_idx
  on public.projects (created_by);

create index projects_organization_created_at_idx
  on public.projects (organization_id, created_at desc);

-- # Validation Notes
--
-- Nullable FK decisions:
-- - users.department_id is nullable to support bootstrap creation of the first
--   org admin before departments are seeded.
-- - departments.default_tool_profile_id is nullable because tool_profiles is a
--   Phase B table. The FK constraint must be added in Phase B after that table
--   exists.
-- - projects.workflow_template_id is nullable because workflows is a Phase B
--   table. The FK constraint must be added in Phase B after that table exists.
--
-- Forward references:
-- - departments.default_tool_profile_id intentionally has no FK constraint in
--   this migration.
-- - projects.workflow_template_id intentionally has no FK constraint in this
--   migration.
--
-- Migration assumptions:
-- - Supabase provides auth.users and gen_random_uuid().
-- - RLS policies are intentionally omitted and must be added in a later
--   hardening migration.
-- - updated_at is present for every table, but no trigger is created in this
--   migration. Application code or a later trigger migration must maintain it.
-- - deleted_at is included for soft-delete readiness. No soft-delete behavior
--   is implemented in this migration.
