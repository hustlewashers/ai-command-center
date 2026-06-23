-- AI Command Center
-- Phase F Runtime Operations & Hardening Migration
--
-- Source documents:
-- - docs/phase-f-runtime-hardening-plan.md
-- - docs/supabase-runtime-data-model.md
-- - supabase/migrations/001_foundation.sql
-- - supabase/migrations/007_execution_layer.sql
-- - supabase/migrations/011_governance_layer.sql
-- - supabase/migrations/014_knowledge_output_layer.sql
--
-- Scope:
-- - audit_events table
-- - scheduled_tasks table
-- - background_jobs table
-- - dead_letter_queue table
-- - runtime_metrics table
-- - agent_activity table
-- - Indexes, RLS enablement, and updated_at triggers where applicable
--
-- Explicitly excluded:
-- - RLS policies
-- - Table grants
-- - Seed data
-- - Helper functions
-- - Supabase command execution

-- Platform-level security and admin audit envelope. This table is append-only:
-- no updated_at, no deleted_at, and no authenticated UPDATE/DELETE policies in
-- later migrations.
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  event_category text not null,
  event_type text not null,
  actor_user_id uuid,
  actor_role text,
  entity_type text,
  entity_id uuid,
  ip_address text,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  severity text not null default 'info',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint audit_events_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint audit_events_actor_user_id_fkey
    foreign key (actor_user_id)
    references public.users (id)
    on delete set null,
  constraint audit_events_event_category_check
    check (event_category in ('auth', 'security', 'admin', 'system', 'migration')),
  constraint audit_events_event_type_not_empty
    check (length(trim(event_type)) > 0),
  constraint audit_events_entity_reference_check
    check (
      (entity_type is null and entity_id is null)
      or (entity_type is not null and entity_id is not null)
    ),
  constraint audit_events_entity_type_not_empty
    check (entity_type is null or length(trim(entity_type)) > 0),
  constraint audit_events_summary_not_empty
    check (length(trim(summary)) > 0),
  constraint audit_events_metadata_is_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint audit_events_severity_check
    check (severity in ('info', 'warn', 'error', 'critical'))
);

-- Recurring or one-off schedule definitions. Create before background_jobs
-- because background_jobs.parent_schedule_id references this table.
create table public.scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  name text not null,
  description text,
  job_type text not null,
  payload_template jsonb not null default '{}'::jsonb,
  cron_expression text,
  run_at timestamptz,
  last_run_at timestamptz,
  next_run_at timestamptz,
  owner_department_id uuid,
  created_by_user_id uuid,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint scheduled_tasks_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint scheduled_tasks_owner_department_id_fkey
    foreign key (owner_department_id)
    references public.departments (id)
    on delete set null,
  constraint scheduled_tasks_created_by_user_id_fkey
    foreign key (created_by_user_id)
    references public.users (id)
    on delete set null,
  constraint scheduled_tasks_name_not_empty
    check (length(trim(name)) > 0),
  constraint scheduled_tasks_job_type_check
    check (job_type in ('workflow_step', 'approval_notification', 'scheduled_trigger', 'webhook_emit', 'output_delivery', 'dead_letter_retry', 'knowledge_sync', 'other')),
  constraint scheduled_tasks_payload_template_is_object
    check (jsonb_typeof(payload_template) = 'object'),
  constraint scheduled_tasks_cron_expression_not_empty
    check (cron_expression is null or length(trim(cron_expression)) > 0),
  constraint scheduled_tasks_cron_or_run_at_check
    check ((cron_expression is not null) <> (run_at is not null)),
  constraint scheduled_tasks_status_check
    check (status in ('active', 'paused', 'completed', 'archived'))
);

-- Internal job queue records for async runtime work. Results are emitted to
-- execution_logs and observability tables; this table tracks runnable state.
create table public.background_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_type text not null,
  status text not null default 'queued',
  payload jsonb not null default '{}'::jsonb,
  priority integer not null default 5,
  retry_count integer not null default 0,
  max_retries integer not null default 3,
  last_error text,
  scheduled_for timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  parent_schedule_id uuid,
  related_task_id uuid,
  related_request_id uuid,
  related_work_packet_id uuid,
  created_by_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint background_jobs_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint background_jobs_parent_schedule_id_fkey
    foreign key (parent_schedule_id)
    references public.scheduled_tasks (id)
    on delete set null,
  constraint background_jobs_related_task_id_fkey
    foreign key (related_task_id)
    references public.tasks (id)
    on delete set null,
  constraint background_jobs_related_request_id_fkey
    foreign key (related_request_id)
    references public.requests (id)
    on delete set null,
  constraint background_jobs_related_work_packet_id_fkey
    foreign key (related_work_packet_id)
    references public.work_packets (id)
    on delete set null,
  constraint background_jobs_created_by_user_id_fkey
    foreign key (created_by_user_id)
    references public.users (id)
    on delete set null,
  constraint background_jobs_job_type_check
    check (job_type in ('workflow_step', 'approval_notification', 'scheduled_trigger', 'webhook_emit', 'output_delivery', 'dead_letter_retry', 'knowledge_sync', 'other')),
  constraint background_jobs_status_check
    check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled', 'retrying')),
  constraint background_jobs_payload_is_object
    check (jsonb_typeof(payload) = 'object'),
  constraint background_jobs_priority_check
    check (priority between 1 and 10),
  constraint background_jobs_retry_count_check
    check (retry_count >= 0),
  constraint background_jobs_max_retries_check
    check (max_retries >= 0),
  constraint background_jobs_retry_count_max_check
    check (retry_count <= max_retries),
  constraint background_jobs_started_at_status_check
    check (
      started_at is null
      or status in ('processing', 'retrying', 'completed', 'failed', 'cancelled')
    ),
  constraint background_jobs_completed_at_status_check
    check (
      completed_at is null
      or status in ('completed', 'failed', 'cancelled')
    )
);

-- Permanently failed background jobs awaiting manual review and resolution.
-- The row itself is append-style; resolution_* columns record operator action.
create table public.dead_letter_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  job_type text not null,
  original_payload jsonb not null,
  error_summary text not null,
  error_detail jsonb,
  retry_count integer not null,
  resolution_status text not null default 'pending_review',
  resolved_by_user_id uuid,
  resolved_at timestamptz,
  resolution_note text,
  failed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint dead_letter_queue_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint dead_letter_queue_job_id_fkey
    foreign key (job_id)
    references public.background_jobs (id)
    on delete restrict,
  constraint dead_letter_queue_resolved_by_user_id_fkey
    foreign key (resolved_by_user_id)
    references public.users (id)
    on delete set null,
  constraint dead_letter_queue_job_type_check
    check (job_type in ('workflow_step', 'approval_notification', 'scheduled_trigger', 'webhook_emit', 'output_delivery', 'dead_letter_retry', 'knowledge_sync', 'other')),
  constraint dead_letter_queue_original_payload_is_object
    check (jsonb_typeof(original_payload) = 'object'),
  constraint dead_letter_queue_error_summary_not_empty
    check (length(trim(error_summary)) > 0),
  constraint dead_letter_queue_error_detail_is_object
    check (error_detail is null or jsonb_typeof(error_detail) = 'object'),
  constraint dead_letter_queue_retry_count_check
    check (retry_count >= 0),
  constraint dead_letter_queue_resolution_status_check
    check (resolution_status in ('pending_review', 'requeued', 'discarded', 'escalated')),
  constraint dead_letter_queue_resolved_status_check
    check (
      (resolution_status = 'pending_review' and resolved_at is null and resolved_by_user_id is null)
      or (resolution_status != 'pending_review' and resolved_at is not null)
    )
);

-- Aggregated runtime observability records. These are append-style aggregate
-- rows; service-role retention jobs may prune old data later.
create table public.runtime_metrics (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  metric_name text not null,
  metric_category text not null,
  dimension_type text,
  dimension_id uuid,
  department_id uuid,
  value_int bigint,
  value_float double precision,
  unit text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint runtime_metrics_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint runtime_metrics_department_id_fkey
    foreign key (department_id)
    references public.departments (id)
    on delete set null,
  constraint runtime_metrics_metric_name_not_empty
    check (length(trim(metric_name)) > 0),
  constraint runtime_metrics_metric_category_check
    check (metric_category in ('runtime_health', 'user_activity', 'agent_performance', 'workflow_execution', 'governance')),
  constraint runtime_metrics_dimension_type_check
    check (dimension_type is null or dimension_type in ('org', 'department', 'agent', 'job_type', 'workflow')),
  constraint runtime_metrics_dimension_pair_check
    check (
      (dimension_type is null and dimension_id is null)
      or (dimension_type is not null and dimension_id is not null)
    ),
  constraint runtime_metrics_value_check
    check ((value_int is not null) <> (value_float is not null)),
  constraint runtime_metrics_unit_check
    check (unit in ('count', 'ms', 'seconds', 'percent', 'bytes', 'rate_per_min')),
  constraint runtime_metrics_window_check
    check (window_end > window_start)
);

-- Per-agent session activity. This table preserves agent history and is
-- append-only: no updated_at, no deleted_at, and execution_log_id is a soft
-- reference only.
create table public.agent_activity (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  agent_user_id uuid not null,
  session_id uuid not null,
  task_id uuid,
  work_packet_id uuid,
  activity_type text not null,
  tool_name text,
  summary text not null,
  metadata jsonb not null default '{}'::jsonb,
  execution_log_id uuid,
  duration_ms integer,
  status text not null default 'completed',
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint agent_activity_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint agent_activity_agent_user_id_fkey
    foreign key (agent_user_id)
    references public.users (id)
    on delete restrict,
  constraint agent_activity_task_id_fkey
    foreign key (task_id)
    references public.tasks (id)
    on delete set null,
  constraint agent_activity_work_packet_id_fkey
    foreign key (work_packet_id)
    references public.work_packets (id)
    on delete set null,
  constraint agent_activity_activity_type_check
    check (activity_type in ('tool_call', 'decision_made', 'knowledge_record_created', 'output_produced', 'approval_requested', 'error_raised', 'session_start', 'session_end', 'other')),
  constraint agent_activity_summary_not_empty
    check (length(trim(summary)) > 0),
  constraint agent_activity_metadata_is_object
    check (jsonb_typeof(metadata) = 'object'),
  constraint agent_activity_duration_ms_check
    check (duration_ms is null or duration_ms >= 0),
  constraint agent_activity_status_check
    check (status in ('completed', 'failed', 'skipped', 'flagged'))
);

create index audit_events_org_occurred_at_idx
  on public.audit_events (organization_id, occurred_at desc);

create index audit_events_org_category_idx
  on public.audit_events (organization_id, event_category);

create index audit_events_org_actor_idx
  on public.audit_events (organization_id, actor_user_id)
  where actor_user_id is not null;

create index audit_events_entity_idx
  on public.audit_events (organization_id, entity_type, entity_id)
  where entity_id is not null;

create index audit_events_severity_idx
  on public.audit_events (organization_id, severity, occurred_at desc)
  where severity in ('warn', 'error', 'critical');

create index scheduled_tasks_org_status_next_run_idx
  on public.scheduled_tasks (organization_id, status, next_run_at)
  where status = 'active';

create index scheduled_tasks_org_department_idx
  on public.scheduled_tasks (organization_id, owner_department_id)
  where owner_department_id is not null;

create index scheduled_tasks_org_created_at_idx
  on public.scheduled_tasks (organization_id, created_at desc);

create index background_jobs_org_status_priority_idx
  on public.background_jobs (organization_id, status, priority, scheduled_for)
  where status in ('queued', 'retrying');

create index background_jobs_org_job_type_idx
  on public.background_jobs (organization_id, job_type);

create index background_jobs_org_created_at_idx
  on public.background_jobs (organization_id, created_at desc);

create index background_jobs_related_task_idx
  on public.background_jobs (related_task_id)
  where related_task_id is not null;

create index background_jobs_related_request_idx
  on public.background_jobs (related_request_id)
  where related_request_id is not null;

create index background_jobs_related_work_packet_idx
  on public.background_jobs (related_work_packet_id)
  where related_work_packet_id is not null;

create index background_jobs_schedule_idx
  on public.background_jobs (parent_schedule_id)
  where parent_schedule_id is not null;

create index dlq_org_resolution_failed_at_idx
  on public.dead_letter_queue (organization_id, resolution_status, failed_at desc)
  where resolution_status = 'pending_review';

create index dlq_org_job_type_idx
  on public.dead_letter_queue (organization_id, job_type);

create index dlq_job_id_idx
  on public.dead_letter_queue (job_id);

create index dlq_org_failed_at_idx
  on public.dead_letter_queue (organization_id, failed_at desc);

create index runtime_metrics_org_name_window_idx
  on public.runtime_metrics (organization_id, metric_name, window_start desc);

create index runtime_metrics_org_category_window_idx
  on public.runtime_metrics (organization_id, metric_category, window_start desc);

create index runtime_metrics_org_dept_idx
  on public.runtime_metrics (organization_id, department_id, metric_category)
  where department_id is not null;

create index runtime_metrics_window_idx
  on public.runtime_metrics (window_start, window_end);

create index agent_activity_org_agent_session_idx
  on public.agent_activity (organization_id, agent_user_id, session_id);

create index agent_activity_org_task_idx
  on public.agent_activity (organization_id, task_id, occurred_at desc)
  where task_id is not null;

create index agent_activity_org_activity_type_idx
  on public.agent_activity (organization_id, activity_type, occurred_at desc);

create index agent_activity_org_status_idx
  on public.agent_activity (organization_id, status)
  where status in ('failed', 'flagged');

create index agent_activity_org_occurred_at_idx
  on public.agent_activity (organization_id, occurred_at desc);

-- RLS is enabled without policies to preserve the deny-by-default posture used
-- throughout prior phases. Phase F policies are intentionally deferred to
-- 020_phase_f_rls_policies.sql after this table shape is audited.
alter table public.audit_events enable row level security;
alter table public.scheduled_tasks enable row level security;
alter table public.background_jobs enable row level security;
alter table public.dead_letter_queue enable row level security;
alter table public.runtime_metrics enable row level security;
alter table public.agent_activity enable row level security;

-- Reuse the centralized updated_at trigger function only for mutable Phase F
-- tables. audit_events, dead_letter_queue, runtime_metrics, and agent_activity
-- are append-style records and intentionally receive no updated_at trigger.
create trigger set_scheduled_tasks_updated_at
before update on public.scheduled_tasks
for each row
execute function public.set_updated_at();

create trigger set_background_jobs_updated_at
before update on public.background_jobs
for each row
execute function public.set_updated_at();
