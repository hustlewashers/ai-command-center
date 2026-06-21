-- AI Command Center
-- Phase C Execution Layer Migration
--
-- Source documents:
-- - docs/phase-c-execution-layer-migration-plan.md
-- - docs/system-entities.md
-- - docs/supabase-runtime-data-model.md
-- - docs/work-packet-template.md
-- - supabase/migrations/001_foundation.sql
-- - supabase/migrations/003_system_intelligence.sql
-- - supabase/migrations/005_rls_policies.sql
-- - supabase/migrations/006_table_grants.sql
--
-- Scope:
-- - requests table
-- - work_packets table
-- - tasks table
-- - execution_logs table
-- - Indexes, RLS enablement, and updated_at triggers where applicable
--
-- Explicitly excluded:
-- - RLS policies
-- - Seed data
-- - Phase D+ tables
-- - Supabase command execution

-- Requests capture inbound intent from humans, automations, webhooks, and
-- scheduled jobs. Requests may exist before routing, project scoping, or task
-- creation is complete.
create table public.requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  source text not null,
  intent text not null,
  submitted_at timestamptz not null default now(),
  submitted_by_user_id uuid,
  routed_department_id uuid,
  project_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'received',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint requests_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint requests_submitted_by_user_id_fkey
    foreign key (submitted_by_user_id)
    references public.users (id)
    on delete set null,
  constraint requests_routed_department_id_fkey
    foreign key (routed_department_id)
    references public.departments (id)
    on delete set null,
  constraint requests_project_id_fkey
    foreign key (project_id)
    references public.projects (id)
    on delete set null,
  constraint requests_source_check
    check (source in ('human', 'automation', 'webhook', 'scheduled_job')),
  constraint requests_intent_not_empty
    check (length(trim(intent)) > 0),
  constraint requests_metadata_is_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint requests_status_check
    check (status in ('received', 'triaged', 'in_progress', 'completed', 'rejected', 'cancelled'))
);

-- Work packets are department-owned execution specifications. The direct
-- department_id FK is required so routing, audit, and RLS can use department
-- scope without resolving the polymorphic parent reference.
create table public.work_packets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  title text not null,
  objective text not null,
  scope jsonb not null default '{"in":[],"out":[]}'::jsonb,
  acceptance_criteria jsonb not null default '[]'::jsonb,
  department_id uuid not null,
  parent_type text not null,
  parent_id uuid not null,
  priority text not null default 'normal',
  constraints jsonb not null default '{}'::jsonb,
  approval_required_before_start boolean not null default false,
  author_user_id uuid not null,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint work_packets_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint work_packets_department_id_fkey
    foreign key (department_id)
    references public.departments (id)
    on delete restrict,
  constraint work_packets_author_user_id_fkey
    foreign key (author_user_id)
    references public.users (id)
    on delete restrict,
  constraint work_packets_title_not_empty
    check (length(trim(title)) > 0),
  constraint work_packets_objective_not_empty
    check (length(trim(objective)) > 0),
  constraint work_packets_scope_is_object
    check (jsonb_typeof(scope) = 'object'),
  constraint work_packets_acceptance_criteria_is_array
    check (jsonb_typeof(acceptance_criteria) = 'array'),
  constraint work_packets_parent_type_check
    check (parent_type in ('task', 'project')),
  constraint work_packets_priority_check
    check (priority in ('low', 'normal', 'high', 'critical')),
  constraint work_packets_constraints_is_object
    check (jsonb_typeof(constraints) = 'object'),
  constraint work_packets_status_check
    check (status in ('draft', 'ready', 'pending_approval', 'in_execution', 'accepted', 'superseded', 'cancelled'))
);

-- Tasks are the atomic executable work units. They are department-owned, may be
-- linked to a request, work packet, workflow, and tool profile, and provide the
-- main anchor for later decisions, blockers, outputs, and execution logs.
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  title text not null,
  project_id uuid not null,
  department_id uuid not null,
  request_id uuid,
  work_packet_id uuid,
  workflow_id uuid,
  tool_profile_id uuid,
  priority text not null default 'normal',
  assigned_to_user_id uuid,
  created_by uuid not null,
  status text not null default 'backlog',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint tasks_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint tasks_project_id_fkey
    foreign key (project_id)
    references public.projects (id)
    on delete restrict,
  constraint tasks_department_id_fkey
    foreign key (department_id)
    references public.departments (id)
    on delete restrict,
  constraint tasks_request_id_fkey
    foreign key (request_id)
    references public.requests (id)
    on delete set null,
  constraint tasks_work_packet_id_fkey
    foreign key (work_packet_id)
    references public.work_packets (id)
    on delete set null,
  constraint tasks_workflow_id_fkey
    foreign key (workflow_id)
    references public.workflows (id)
    on delete set null,
  constraint tasks_tool_profile_id_fkey
    foreign key (tool_profile_id)
    references public.tool_profiles (id)
    on delete set null,
  constraint tasks_assigned_to_user_id_fkey
    foreign key (assigned_to_user_id)
    references public.users (id)
    on delete set null,
  constraint tasks_created_by_fkey
    foreign key (created_by)
    references public.users (id)
    on delete restrict,
  constraint tasks_title_not_empty
    check (length(trim(title)) > 0),
  constraint tasks_priority_check
    check (priority in ('low', 'normal', 'high', 'critical')),
  constraint tasks_status_check
    check (status in ('backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'))
);

-- Execution logs are append-only. They intentionally do not include updated_at
-- or deleted_at, and they do not receive the centralized updated_at trigger.
-- Corrections are represented by new rows, commonly with metadata.corrects_log_id.
create table public.execution_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  event_type text not null,
  actor text not null,
  occurred_at timestamptz not null default now(),
  summary text not null,
  context_type text not null,
  context_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'recorded',
  created_at timestamptz not null default now(),

  constraint execution_logs_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint execution_logs_event_type_check
    check (event_type in ('tool_call', 'state_change', 'error', 'note', 'approval_action')),
  constraint execution_logs_actor_not_empty
    check (length(trim(actor)) > 0),
  constraint execution_logs_summary_not_empty
    check (length(trim(summary)) > 0),
  constraint execution_logs_context_type_check
    check (context_type in ('request', 'task', 'workflow')),
  constraint execution_logs_metadata_is_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint execution_logs_status_check
    check (status in ('recorded', 'flagged', 'reviewed', 'corrected'))
);

create index requests_organization_status_idx
  on public.requests (organization_id, status);

create index requests_organization_source_idx
  on public.requests (organization_id, source);

create index requests_routed_department_id_idx
  on public.requests (routed_department_id);

create index requests_project_id_idx
  on public.requests (project_id);

create index requests_submitted_by_user_id_idx
  on public.requests (submitted_by_user_id);

create index requests_organization_submitted_at_idx
  on public.requests (organization_id, submitted_at desc);

create index work_packets_organization_status_idx
  on public.work_packets (organization_id, status);

create index work_packets_organization_department_status_idx
  on public.work_packets (organization_id, department_id, status);

create index work_packets_organization_parent_idx
  on public.work_packets (organization_id, parent_type, parent_id);

create index work_packets_author_user_id_idx
  on public.work_packets (author_user_id);

create index work_packets_approval_required_idx
  on public.work_packets (organization_id, department_id, approval_required_before_start)
  where approval_required_before_start = true;

create index work_packets_organization_created_at_idx
  on public.work_packets (organization_id, created_at desc);

create index tasks_organization_department_status_idx
  on public.tasks (organization_id, department_id, status);

create index tasks_organization_project_id_idx
  on public.tasks (organization_id, project_id);

create index tasks_request_id_idx
  on public.tasks (request_id)
  where request_id is not null;

create index tasks_work_packet_id_idx
  on public.tasks (work_packet_id)
  where work_packet_id is not null;

create index tasks_workflow_id_idx
  on public.tasks (workflow_id)
  where workflow_id is not null;

create index tasks_assigned_to_user_id_idx
  on public.tasks (assigned_to_user_id)
  where assigned_to_user_id is not null;

create index tasks_created_by_idx
  on public.tasks (created_by);

create index tasks_organization_status_idx
  on public.tasks (organization_id, status);

create index tasks_organization_created_at_idx
  on public.tasks (organization_id, created_at desc);

create index execution_logs_organization_context_idx
  on public.execution_logs (organization_id, context_type, context_id);

create index execution_logs_organization_event_type_idx
  on public.execution_logs (organization_id, event_type);

create index execution_logs_organization_occurred_at_idx
  on public.execution_logs (organization_id, occurred_at desc);

create index execution_logs_organization_status_idx
  on public.execution_logs (organization_id, status)
  where status != 'recorded';

create index execution_logs_actor_idx
  on public.execution_logs (actor);

-- RLS is enabled without policies to preserve the deny-by-default posture used
-- throughout prior phases. Phase C policies are intentionally deferred to a
-- later migration after this table shape is audited.
alter table public.requests enable row level security;
alter table public.work_packets enable row level security;
alter table public.tasks enable row level security;
alter table public.execution_logs enable row level security;

-- Reuse the centralized Phase A updated_at trigger function for mutable
-- execution-layer tables. execution_logs remains append-only and receives no
-- updated_at trigger.
create trigger set_requests_updated_at
before update on public.requests
for each row
execute function public.set_updated_at();

create trigger set_work_packets_updated_at
before update on public.work_packets
for each row
execute function public.set_updated_at();

create trigger set_tasks_updated_at
before update on public.tasks
for each row
execute function public.set_updated_at();
