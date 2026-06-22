-- AI Command Center
-- Phase D Governance Layer Migration
--
-- Source documents:
-- - docs/phase-d-governance-layer-migration-plan.md
-- - docs/system-entities.md
-- - docs/supabase-runtime-data-model.md
-- - docs/approval-rules.md
-- - docs/phase-c-execution-layer-migration-plan.md
-- - supabase/migrations/001_foundation.sql
-- - supabase/migrations/007_execution_layer.sql
--
-- Scope:
-- - decisions table
-- - approvals table
-- - blockers table
-- - Indexes, RLS enablement, and updated_at triggers
--
-- Explicitly excluded:
-- - RLS policies
-- - Table grants
-- - Seed data
-- - Phase E+ tables
-- - Supabase command execution

-- Decisions are recorded choices made in task context. They may be autonomous
-- records, or they may enter pending_approval and produce an approvals row.
create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  summary text not null,
  rationale text not null,
  decided_by_user_id uuid,
  decided_at timestamptz not null default now(),
  status text not null default 'proposed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint decisions_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint decisions_task_id_fkey
    foreign key (task_id)
    references public.tasks (id)
    on delete restrict,
  constraint decisions_decided_by_user_id_fkey
    foreign key (decided_by_user_id)
    references public.users (id)
    on delete set null,
  constraint decisions_summary_not_empty
    check (length(trim(summary)) > 0),
  constraint decisions_rationale_not_empty
    check (length(trim(rationale)) > 0),
  constraint decisions_status_check
    check (status in ('proposed', 'confirmed', 'pending_approval', 'approved', 'rejected', 'superseded'))
);

-- Approvals are governance artifacts and intentionally have no deleted_at.
-- Withdrawal and expiry are represented through status instead of soft deletion.
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  department_id uuid not null,
  subject_type text not null,
  subject_id uuid not null,
  category text not null,
  trigger_reason text not null,
  requested_by_user_id uuid,
  approver_user_id uuid,
  approver_role text not null,
  status text not null default 'pending',
  decided_at timestamptz,
  decision_note text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint approvals_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint approvals_department_id_fkey
    foreign key (department_id)
    references public.departments (id)
    on delete restrict,
  constraint approvals_requested_by_user_id_fkey
    foreign key (requested_by_user_id)
    references public.users (id)
    on delete set null,
  constraint approvals_approver_user_id_fkey
    foreign key (approver_user_id)
    references public.users (id)
    on delete set null,
  constraint approvals_subject_type_check
    check (subject_type in ('task', 'work_packet', 'decision', 'output')),
  constraint approvals_category_check
    check (category in ('a', 'b', 'c')),
  constraint approvals_trigger_reason_not_empty
    check (length(trim(trigger_reason)) > 0),
  constraint approvals_approver_role_not_empty
    check (length(trim(approver_role)) > 0),
  constraint approvals_status_check
    check (status in ('pending', 'approved', 'rejected', 'expired', 'withdrawn')),
  constraint approvals_decided_at_status_check
    check (
      (status = 'pending' and decided_at is null)
      or (status != 'pending' and decided_at is not null)
    )
);

-- Blockers are department-owned impediments against tasks or work packets.
-- Project-level blockers are intentionally deferred beyond Phase D.
create table public.blockers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  department_id uuid not null,
  description text not null,
  blocked_entity_type text not null,
  blocked_entity_id uuid not null,
  severity text not null default 'medium',
  reported_by_user_id uuid not null,
  assigned_to_user_id uuid,
  resolution_note text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint blockers_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint blockers_department_id_fkey
    foreign key (department_id)
    references public.departments (id)
    on delete restrict,
  constraint blockers_reported_by_user_id_fkey
    foreign key (reported_by_user_id)
    references public.users (id)
    on delete restrict,
  constraint blockers_assigned_to_user_id_fkey
    foreign key (assigned_to_user_id)
    references public.users (id)
    on delete set null,
  constraint blockers_description_not_empty
    check (length(trim(description)) > 0),
  constraint blockers_blocked_entity_type_check
    check (blocked_entity_type in ('task', 'work_packet')),
  constraint blockers_severity_check
    check (severity in ('low', 'medium', 'high', 'critical')),
  constraint blockers_status_check
    check (status in ('open', 'investigating', 'pending_external', 'resolved', 'won_t_fix'))
);

create index decisions_organization_task_id_idx
  on public.decisions (organization_id, task_id);

create index decisions_organization_status_idx
  on public.decisions (organization_id, status);

create index decisions_decided_by_user_id_idx
  on public.decisions (decided_by_user_id)
  where decided_by_user_id is not null;

create index decisions_organization_created_at_idx
  on public.decisions (organization_id, created_at desc);

create index approvals_organization_status_idx
  on public.approvals (organization_id, status);

create index approvals_organization_department_status_idx
  on public.approvals (organization_id, department_id, status);

create index approvals_subject_idx
  on public.approvals (organization_id, subject_type, subject_id);

create index approvals_approver_user_id_idx
  on public.approvals (approver_user_id)
  where approver_user_id is not null;

create index approvals_expires_at_idx
  on public.approvals (expires_at)
  where expires_at is not null
    and status = 'pending';

create index approvals_organization_created_at_idx
  on public.approvals (organization_id, created_at desc);

create index blockers_organization_status_idx
  on public.blockers (organization_id, status)
  where status not in ('resolved', 'won_t_fix');

create index blockers_organization_department_status_idx
  on public.blockers (organization_id, department_id, status);

create index blockers_blocked_entity_idx
  on public.blockers (organization_id, blocked_entity_type, blocked_entity_id);

create index blockers_assigned_to_user_id_idx
  on public.blockers (assigned_to_user_id)
  where assigned_to_user_id is not null;

create index blockers_severity_idx
  on public.blockers (organization_id, severity, status)
  where status not in ('resolved', 'won_t_fix');

create index blockers_organization_created_at_idx
  on public.blockers (organization_id, created_at desc);

-- RLS is enabled without policies to preserve the deny-by-default posture used
-- throughout prior phases. Phase D policies are intentionally deferred to a
-- later migration after this table shape is audited.
alter table public.decisions enable row level security;
alter table public.approvals enable row level security;
alter table public.blockers enable row level security;

-- Reuse the centralized updated_at trigger function for all governance tables.
-- Unlike execution_logs, these records are mutable governance state.
create trigger set_decisions_updated_at
before update on public.decisions
for each row
execute function public.set_updated_at();

create trigger set_approvals_updated_at
before update on public.approvals
for each row
execute function public.set_updated_at();

create trigger set_blockers_updated_at
before update on public.blockers
for each row
execute function public.set_updated_at();
