-- AI Command Center
-- Migration 023 — Workflow Run Persistence
--
-- Source documents:
-- - docs/sprint-5-5-workflow-runtime-blueprint.md  (Section 14 — Database Model Proposal)
--
-- Scope:
-- - workflow_runs         — one row per workflow execution; structured observability anchor
-- - workflow_step_runs    — one row per step per execution; per-step timing and I/O
-- - background_jobs       — add workflow_run_id cross-reference column
-- - indexes               — all indexes from blueprint Section 14 (adapted to final column names)
-- - RLS                   — enable + org-scoped SELECT policies for authenticated users
-- - grants                — service_role SELECT/INSERT/UPDATE on both new tables
--
-- Explicitly excluded:
-- - Executor / handler code changes (Sprint 5.6 Task 2)
-- - UI or API routes (Sprint 5.6 Tasks 6–10)
-- - No DELETE grants on any table
-- - No changes to migrations 001–022


-- ─────────────────────────────────────────────────────────────
-- TABLE: workflow_runs
--
-- One row per invocation of a named workflow definition.
-- Created by the executor before the first step executes.
-- Updated in-place as the run progresses and on completion/failure.
-- Survives background_job cleanup — run history is permanent.
-- ─────────────────────────────────────────────────────────────
create table public.workflow_runs (
  -- identity
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null
    references public.organizations (id) on delete restrict,

  -- workflow definition reference (text slug, no FK — registry may be in-code or DB)
  workflow_id         text        not null,
  workflow_version    integer     not null default 1,

  -- linkage to the job that started this run (nullable: run may outlive the job row)
  background_job_id   uuid
    references public.background_jobs (id) on delete set null,

  -- resume chain: non-null only for child runs created by resume operations
  parent_run_id       uuid
    references public.workflow_runs (id) on delete set null,

  -- lifecycle status
  status              text        not null default 'pending',

  -- what triggered this workflow run
  trigger_type        text,           -- 'manual' | 'scheduled' | 'api' | 'workflow'
  trigger_entity_type text,           -- e.g. 'request', 'task' (free text, soft reference)
  trigger_entity_id   uuid,           -- id of the triggering entity (no FK — polymorphic)

  -- initial workflow context (org_id, dept_id, project_id, title, created_by, …)
  -- persisted to enable resume: child runs inherit parent.inputs unmodified
  inputs              jsonb       not null default '{}'::jsonb,

  -- step output accumulator; grows with each completed step
  accumulated         jsonb       not null default '{}'::jsonb,

  -- timing
  started_at          timestamptz,
  completed_at        timestamptz,
  failed_at           timestamptz,

  -- current position — tracks progress during execution; on failure identifies the failed step
  current_step_id     text,           -- step definition id (e.g. 'create_task_1')
  current_step_index  integer,        -- 0-based index into the step array

  -- retry/resume counter (increments each time this run is resumed from a parent)
  retry_count         integer     not null default 0,

  -- error detail on failure
  error_message       text,

  -- timestamps
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- ── constraints ──────────────────────────────────────────
  constraint workflow_runs_workflow_id_not_empty
    check (length(trim(workflow_id)) > 0),

  constraint workflow_runs_workflow_version_check
    check (workflow_version >= 1),

  constraint workflow_runs_status_check
    check (status in (
      'pending', 'running', 'completed', 'failed', 'cancelled', 'resuming'
    )),

  constraint workflow_runs_trigger_type_check
    check (trigger_type is null or length(trim(trigger_type)) > 0),

  constraint workflow_runs_trigger_entity_pair_check
    check (
      (trigger_entity_type is null and trigger_entity_id is null)
      or (trigger_entity_type is not null and trigger_entity_id is not null)
    ),

  constraint workflow_runs_trigger_entity_type_not_empty
    check (trigger_entity_type is null or length(trim(trigger_entity_type)) > 0),

  constraint workflow_runs_inputs_is_object
    check (jsonb_typeof(inputs) = 'object'),

  constraint workflow_runs_accumulated_is_object
    check (jsonb_typeof(accumulated) = 'object'),

  constraint workflow_runs_current_step_index_check
    check (current_step_index is null or current_step_index >= 0),

  constraint workflow_runs_retry_count_check
    check (retry_count >= 0)
);


-- ─────────────────────────────────────────────────────────────
-- TABLE: workflow_step_runs
--
-- One row per step attempted within a workflow run.
-- Created before the step executes (status='running').
-- Updated in-place with output, error, and timing on completion.
-- Append-only within a run — failed rows are never deleted.
-- On step-level retry: new row with retry_count+1 (unique constraint).
-- ─────────────────────────────────────────────────────────────
create table public.workflow_step_runs (
  -- identity
  id                  uuid        primary key default gen_random_uuid(),
  organization_id     uuid        not null
    references public.organizations (id) on delete restrict,

  -- parent run (cascade delete: step rows follow the run)
  workflow_run_id     uuid        not null
    references public.workflow_runs (id) on delete cascade,

  -- step definition fields
  step_id             text        not null,   -- e.g. 'create_task_1'
  step_index          integer     not null,   -- 0-based position in step array
  step_type           text        not null,   -- e.g. 'create_task'

  -- lifecycle status
  status              text        not null default 'pending',

  -- timing
  started_at          timestamptz,
  completed_at        timestamptz,
  duration_ms         integer,                -- computed and stored for convenience

  -- retry counter (distinct from workflow_run.retry_count — tracks step-level retries)
  retry_count         integer     not null default 0,

  -- step I/O
  input_payload       jsonb       not null default '{}'::jsonb,  -- accumulated at step start
  output_payload      jsonb,                                     -- produced by step on success
  error_message       text,                                      -- error string on failure

  -- timestamps
  created_at          timestamptz not null default now(),

  -- ── constraints ──────────────────────────────────────────
  constraint workflow_step_runs_step_id_not_empty
    check (length(trim(step_id)) > 0),

  constraint workflow_step_runs_step_type_not_empty
    check (length(trim(step_type)) > 0),

  constraint workflow_step_runs_step_index_check
    check (step_index >= 0),

  constraint workflow_step_runs_status_check
    check (status in ('pending', 'running', 'completed', 'failed', 'skipped')),

  constraint workflow_step_runs_duration_ms_check
    check (duration_ms is null or duration_ms >= 0),

  constraint workflow_step_runs_retry_count_check
    check (retry_count >= 0),

  constraint workflow_step_runs_input_payload_is_object
    check (jsonb_typeof(input_payload) = 'object'),

  constraint workflow_step_runs_output_payload_is_object
    check (output_payload is null or jsonb_typeof(output_payload) = 'object'),

  -- supports step-level retry: same step in same run must have a distinct retry_count
  unique (workflow_run_id, step_id, retry_count)
);


-- ─────────────────────────────────────────────────────────────
-- ALTER: background_jobs — add workflow_run_id cross-reference
--
-- Nullable FK: background_jobs that are not workflow_step jobs
-- leave this null. The executor sets it after creating the run row.
-- ON DELETE SET NULL: run history survives job table cleanup.
-- This creates a mutual nullable reference with
-- workflow_runs.background_job_id — both are nullable with
-- ON DELETE SET NULL, so there is no circular blocking constraint.
-- ─────────────────────────────────────────────────────────────
alter table public.background_jobs
  add column workflow_run_id uuid
    references public.workflow_runs (id) on delete set null;


-- ─────────────────────────────────────────────────────────────
-- UPDATED_AT trigger — workflow_runs only
-- workflow_step_runs has no updated_at column (rows start with
-- status='running' and are updated once on completion; the
-- created_at + completed_at pair provides timing without a trigger)
-- ─────────────────────────────────────────────────────────────
create trigger set_workflow_runs_updated_at
before update on public.workflow_runs
for each row
execute function public.set_updated_at();


-- ─────────────────────────────────────────────────────────────
-- INDEXES — workflow_runs
-- ─────────────────────────────────────────────────────────────

-- primary read path: list runs for an org filtered by workflow and recency
create index workflow_runs_org_workflow_started_idx
  on public.workflow_runs (organization_id, workflow_id, started_at desc);

-- dashboard status card queries
create index workflow_runs_org_status_started_idx
  on public.workflow_runs (organization_id, status, started_at desc);

-- job → run cross-navigation (sparse: only workflow_step jobs set this)
create index workflow_runs_background_job_idx
  on public.workflow_runs (background_job_id)
  where background_job_id is not null;

-- resume chain traversal
create index workflow_runs_parent_run_idx
  on public.workflow_runs (parent_run_id)
  where parent_run_id is not null;


-- ─────────────────────────────────────────────────────────────
-- INDEXES — workflow_step_runs
-- ─────────────────────────────────────────────────────────────

-- primary read path: all steps in a run ordered by position
create index workflow_step_runs_run_step_index_idx
  on public.workflow_step_runs (workflow_run_id, step_index);

-- cross-run step-type analysis (P50/P95 duration per step_type)
create index workflow_step_runs_org_step_type_started_idx
  on public.workflow_step_runs (organization_id, step_type, started_at desc);

-- failure surfacing (only failed step rows)
create index workflow_step_runs_org_failed_idx
  on public.workflow_step_runs (organization_id, started_at desc)
  where status = 'failed';


-- ─────────────────────────────────────────────────────────────
-- INDEX — background_jobs (new column)
-- ─────────────────────────────────────────────────────────────
create index background_jobs_workflow_run_idx
  on public.background_jobs (workflow_run_id)
  where workflow_run_id is not null;


-- ─────────────────────────────────────────────────────────────
-- RLS — enable
-- ─────────────────────────────────────────────────────────────
alter table public.workflow_runs      enable row level security;
alter table public.workflow_step_runs enable row level security;


-- ─────────────────────────────────────────────────────────────
-- GRANTS — service_role
-- No DELETE granted on any table.
-- ─────────────────────────────────────────────────────────────
grant select, insert, update on public.workflow_runs      to service_role;
grant select, insert, update on public.workflow_step_runs to service_role;


-- ─────────────────────────────────────────────────────────────
-- RLS POLICIES — workflow_runs
--
-- All writes are service_role only (executor runs outside RLS).
-- Authenticated users read runs scoped to their organization.
-- org_admin reads all runs in the org.
-- department_lead, department_member, and read_only read runs
-- whose trigger_entity_id resolves to their department (soft
-- check via trigger_entity_type + EXISTS join). If trigger_entity_id
-- is null or the entity type is not department-scoped, only
-- org_admin can see it. This mirrors the background_jobs pattern.
-- ─────────────────────────────────────────────────────────────
create policy workflow_runs_select_org_and_department_scope
on public.workflow_runs
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and (
    -- org_admin sees everything in the org
    private.current_role() = 'org_admin'
    or (
      -- department-scoped roles: see runs triggered by a task in their department
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and trigger_entity_type = 'task'
      and trigger_entity_id is not null
      and exists (
        select 1
        from public.tasks as t
        where t.id = trigger_entity_id
          and t.organization_id = private.current_organization_id()
          and t.department_id = private.current_department_id()
          and t.deleted_at is null
      )
    )
    or (
      -- department-scoped roles: see runs triggered by a request routed to their department
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and trigger_entity_type = 'request'
      and trigger_entity_id is not null
      and exists (
        select 1
        from public.requests as r
        where r.id = trigger_entity_id
          and r.organization_id = private.current_organization_id()
          and r.routed_department_id = private.current_department_id()
          and r.deleted_at is null
      )
    )
  )
);


-- ─────────────────────────────────────────────────────────────
-- RLS POLICIES — workflow_step_runs
--
-- All writes are service_role only.
-- Authenticated users read step runs whose parent workflow_run
-- is visible to them (mirrors the workflow_runs SELECT policy
-- via organization_id direct check for efficiency).
-- ─────────────────────────────────────────────────────────────
create policy workflow_step_runs_select_org_and_department_scope
on public.workflow_step_runs
for select
to authenticated
using (
  organization_id = private.current_organization_id()
  and (
    private.current_role() = 'org_admin'
    or (
      private.current_role() in ('department_lead', 'department_member', 'read_only')
      and exists (
        select 1
        from public.workflow_runs as wr
        where wr.id = workflow_run_id
          and wr.organization_id = private.current_organization_id()
          and (
            (
              wr.trigger_entity_type = 'task'
              and wr.trigger_entity_id is not null
              and exists (
                select 1
                from public.tasks as t
                where t.id = wr.trigger_entity_id
                  and t.organization_id = private.current_organization_id()
                  and t.department_id = private.current_department_id()
                  and t.deleted_at is null
              )
            )
            or (
              wr.trigger_entity_type = 'request'
              and wr.trigger_entity_id is not null
              and exists (
                select 1
                from public.requests as r
                where r.id = wr.trigger_entity_id
                  and r.organization_id = private.current_organization_id()
                  and r.routed_department_id = private.current_department_id()
                  and r.deleted_at is null
              )
            )
          )
      )
    )
  )
);
