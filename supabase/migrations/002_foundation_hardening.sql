-- AI Command Center
-- Phase A Foundation Hardening Migration
--
-- Source documents:
-- - supabase/migrations/001_foundation.sql
-- - docs/phase-a-foundation-migration-plan.md
-- - docs/supabase-runtime-data-model.md
--
-- Scope:
-- - Replace full unique indexes with soft-delete-aware partial unique indexes
-- - Enable RLS deny-by-default on Phase A tables
-- - Add centralized updated_at maintenance
--
-- Explicitly excluded:
-- - RLS policies
-- - Seed data
-- - Phase B tables

-- Partial unique indexes are used because Phase A tables include deleted_at for
-- soft-delete readiness. Full unique indexes would keep deleted rows occupying
-- unique slots forever, preventing safe reuse of slugs, emails, and department
-- names after a row has been soft-deleted.
drop index if exists public.organizations_slug_key;
drop index if exists public.users_organization_email_key;
drop index if exists public.users_auth_user_id_key;
drop index if exists public.departments_organization_slug_key;
drop index if exists public.departments_organization_name_key;

create unique index organizations_slug_active_key
  on public.organizations (slug)
  where deleted_at is null;

create unique index users_organization_email_active_key
  on public.users (organization_id, email)
  where deleted_at is null;

create unique index users_auth_user_id_active_key
  on public.users (auth_user_id)
  where deleted_at is null;

create unique index departments_organization_slug_active_key
  on public.departments (organization_id, slug)
  where deleted_at is null;

create unique index departments_organization_name_active_key
  on public.departments (organization_id, name)
  where deleted_at is null;

-- RLS is enabled without policies to establish a deny-by-default security
-- posture for public Supabase tables. The detailed policies are intentionally
-- deferred to a later migration after the role and JWT claim model is finalized.
alter table public.organizations enable row level security;
alter table public.users enable row level security;
alter table public.departments enable row level security;
alter table public.projects enable row level security;

-- updated_at maintenance is centralized so every mutable table receives the
-- same timestamp behavior. Future Phase B+ tables can reuse this trigger
-- function instead of defining table-specific timestamp functions.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_organizations_updated_at
before update on public.organizations
for each row
execute function public.set_updated_at();

create trigger set_users_updated_at
before update on public.users
for each row
execute function public.set_updated_at();

create trigger set_departments_updated_at
before update on public.departments
for each row
execute function public.set_updated_at();

create trigger set_projects_updated_at
before update on public.projects
for each row
execute function public.set_updated_at();
