-- AI Command Center
-- Phase B System Intelligence Migration
--
-- Source documents:
-- - docs/phase-b-system-intelligence-migration-plan.md
-- - docs/phase-b-design-addendum.md
-- - docs/supabase-runtime-data-model.md
-- - docs/system-entities.md
--
-- Scope:
-- - tool_profiles table
-- - workflows table
-- - Phase A forward-reference FK constraints
-- - Indexes, RLS enablement, and updated_at triggers
--
-- Explicitly excluded:
-- - RLS policies
-- - Seed data
-- - Phase C+ tables

-- Tool profiles define the runtime permission boundary for agents and
-- automations. They store the canonical allowed tool IDs and execution
-- constraints that determine which tools a task or workflow may invoke.
create table public.tool_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  slug text not null,
  description text not null,
  allowed_tools jsonb not null default '[]'::jsonb,
  constraints jsonb not null default '{}'::jsonb,
  owner_department_id uuid not null,
  created_by uuid not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint tool_profiles_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint tool_profiles_owner_department_id_fkey
    foreign key (owner_department_id)
    references public.departments (id)
    on delete restrict,
  constraint tool_profiles_created_by_fkey
    foreign key (created_by)
    references public.users (id)
    on delete restrict,
  constraint tool_profiles_name_not_empty
    check (length(trim(name)) > 0),
  constraint tool_profiles_slug_not_empty
    check (length(trim(slug)) > 0),
  constraint tool_profiles_description_not_empty
    check (length(trim(description)) > 0),
  constraint tool_profiles_allowed_tools_is_array
    check (jsonb_typeof(allowed_tools) = 'array'),
  constraint tool_profiles_constraints_is_object
    check (jsonb_typeof(constraints) = 'object'),
  constraint tool_profiles_status_check
    check (status in ('draft', 'active', 'deprecated', 'archived'))
);

-- Workflow rows represent either templates or instances:
-- - template: reusable orchestration blueprint; project_id and template_id stay null
-- - instance: running workflow attached to a project; project_id is required
--
-- The definition jsonb column follows the v1.0 contract in
-- docs/phase-b-design-addendum.md. Deep contract validation is handled by the
-- application layer; this migration enforces only basic row-level invariants.
create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  kind text not null,
  definition jsonb not null,
  tool_profile_id uuid not null,
  department_id uuid,
  project_id uuid,
  template_id uuid,
  created_by uuid not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint workflows_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint workflows_tool_profile_id_fkey
    foreign key (tool_profile_id)
    references public.tool_profiles (id)
    on delete restrict,
  constraint workflows_department_id_fkey
    foreign key (department_id)
    references public.departments (id)
    on delete restrict,
  constraint workflows_project_id_fkey
    foreign key (project_id)
    references public.projects (id)
    on delete restrict,
  constraint workflows_template_id_fkey
    foreign key (template_id)
    references public.workflows (id)
    on delete set null,
  constraint workflows_created_by_fkey
    foreign key (created_by)
    references public.users (id)
    on delete restrict,
  constraint workflows_name_not_empty
    check (length(trim(name)) > 0),
  constraint workflows_kind_check
    check (kind in ('template', 'instance')),
  constraint workflows_definition_is_object
    check (jsonb_typeof(definition) = 'object'),
  constraint workflows_template_shape_check
    check (
      (kind = 'template' and project_id is null and template_id is null)
      or
      (kind = 'instance' and project_id is not null and department_id is not null)
    ),
  constraint workflows_status_check
    check (status in ('draft', 'active', 'paused', 'completed', 'failed', 'archived'))
);

-- Soft-delete-aware unique indexes keep active names and slugs unique while
-- allowing replacement rows after a profile has been soft-deleted.
create unique index tool_profiles_organization_slug_active_key
  on public.tool_profiles (organization_id, slug)
  where deleted_at is null;

create unique index tool_profiles_organization_name_active_key
  on public.tool_profiles (organization_id, name)
  where deleted_at is null;

create index tool_profiles_organization_status_idx
  on public.tool_profiles (organization_id, status);

create index tool_profiles_owner_department_id_idx
  on public.tool_profiles (owner_department_id);

create index workflows_organization_kind_idx
  on public.workflows (organization_id, kind);

create index workflows_organization_status_idx
  on public.workflows (organization_id, status);

create index workflows_organization_department_id_idx
  on public.workflows (organization_id, department_id);

create index workflows_project_id_idx
  on public.workflows (project_id);

create index workflows_template_id_idx
  on public.workflows (template_id);

create index workflows_tool_profile_id_idx
  on public.workflows (tool_profile_id);

-- Nullable FK assumptions:
-- - departments.default_tool_profile_id remains nullable long-term because new
--   departments may exist before their default profile is assigned.
-- - projects.workflow_template_id remains nullable long-term because many
--   projects will not use a default workflow template.
alter table public.departments
  add constraint departments_default_tool_profile_id_fkey
  foreign key (default_tool_profile_id)
  references public.tool_profiles (id)
  on delete set null;

alter table public.projects
  add constraint projects_workflow_template_id_fkey
  foreign key (workflow_template_id)
  references public.workflows (id)
  on delete set null;

-- RLS is enabled without policies to preserve the deny-by-default posture
-- established in Phase A. Detailed read/write policies are intentionally
-- deferred until the role and JWT claim model is finalized.
alter table public.tool_profiles enable row level security;
alter table public.workflows enable row level security;

-- Reuse the centralized Phase A updated_at trigger function so timestamp
-- behavior stays consistent across foundation and system intelligence tables.
create trigger set_tool_profiles_updated_at
before update on public.tool_profiles
for each row
execute function public.set_updated_at();

create trigger set_workflows_updated_at
before update on public.workflows
for each row
execute function public.set_updated_at();
