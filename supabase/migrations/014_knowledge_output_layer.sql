-- AI Command Center
-- Phase E Knowledge / Output Layer Migration
--
-- Source documents:
-- - docs/phase-e-knowledge-output-layer-migration-plan.md
-- - docs/supabase-runtime-data-model.md
-- - docs/system-entities.md
-- - supabase/migrations/007_execution_layer.sql
-- - supabase/migrations/011_governance_layer.sql
--
-- Scope:
-- - research_assets table
-- - outputs table
-- - knowledge_records table
-- - output_research_assets junction table
-- - task_research_assets junction table
-- - work_packet_research_assets junction table
-- - knowledge_record_links support table
-- - Indexes, RLS enablement, and updated_at triggers where applicable
--
-- Explicitly excluded:
-- - RLS policies
-- - Table grants
-- - Seed data
-- - Approval policy changes for approvals.subject_type = 'output'
-- - Phase F tables
-- - Supabase command execution

-- Research assets store raw reusable knowledge inputs: documents, URLs, notes,
-- datasets, transcripts, or other captured context used to inform work.
create table public.research_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid,
  title text not null,
  asset_type text not null,
  source text not null,
  storage_path text,
  content_preview text,
  created_by_user_id uuid,
  status text not null default 'draft',
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint research_assets_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint research_assets_project_id_fkey
    foreign key (project_id)
    references public.projects (id)
    on delete set null,
  constraint research_assets_created_by_user_id_fkey
    foreign key (created_by_user_id)
    references public.users (id)
    on delete set null,
  constraint research_assets_title_not_empty
    check (length(trim(title)) > 0),
  constraint research_assets_asset_type_check
    check (asset_type in ('document', 'url', 'note', 'dataset', 'transcript', 'other')),
  constraint research_assets_source_not_empty
    check (length(trim(source)) > 0),
  constraint research_assets_status_check
    check (status in ('draft', 'active', 'stale', 'archived', 'rejected'))
);

-- Outputs are task-produced deliverables. department_id is intentionally direct
-- (not derived via task_id) for RLS, routing, audit, and delivery accountability.
-- Application logic must keep it aligned with the parent task's department_id.
create table public.outputs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  department_id uuid not null,
  task_id uuid not null,
  project_id uuid not null,
  title text not null,
  output_type text not null,
  content text,
  storage_path text,
  created_by_user_id uuid,
  status text not null default 'draft',
  produced_at timestamptz not null default now(),
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint outputs_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint outputs_department_id_fkey
    foreign key (department_id)
    references public.departments (id)
    on delete restrict,
  constraint outputs_task_id_fkey
    foreign key (task_id)
    references public.tasks (id)
    on delete restrict,
  constraint outputs_project_id_fkey
    foreign key (project_id)
    references public.projects (id)
    on delete restrict,
  constraint outputs_created_by_user_id_fkey
    foreign key (created_by_user_id)
    references public.users (id)
    on delete set null,
  constraint outputs_title_not_empty
    check (length(trim(title)) > 0),
  constraint outputs_output_type_check
    check (output_type in ('report', 'artifact', 'message', 'data', 'other')),
  constraint outputs_status_check
    check (status in ('draft', 'in_review', 'approved', 'delivered', 'superseded', 'rejected')),
  constraint outputs_delivered_at_status_check
    check (
      (status = 'delivered' and delivered_at is not null)
      or status != 'delivered'
    )
);

-- Knowledge records are curated, retrievable memory attached to a core subject
-- by subject_type + subject_id. Cross-table subject existence and co-tenancy are
-- validated by application logic and later RLS policies.
create table public.knowledge_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  project_id uuid,
  subject_type text not null,
  subject_id uuid not null,
  record_type text not null,
  title text not null,
  summary text not null,
  content text not null,
  source text not null,
  confidence text not null default 'medium',
  created_by_user_id uuid,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint knowledge_records_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint knowledge_records_project_id_fkey
    foreign key (project_id)
    references public.projects (id)
    on delete set null,
  constraint knowledge_records_created_by_user_id_fkey
    foreign key (created_by_user_id)
    references public.users (id)
    on delete set null,
  constraint knowledge_records_subject_type_check
    check (subject_type in ('project', 'request', 'task', 'work_packet', 'decision', 'research_asset', 'output')),
  constraint knowledge_records_record_type_check
    check (record_type in ('summary', 'context', 'constraint', 'lesson', 'index', 'synthesis', 'other')),
  constraint knowledge_records_title_not_empty
    check (length(trim(title)) > 0),
  constraint knowledge_records_summary_not_empty
    check (length(trim(summary)) > 0),
  constraint knowledge_records_content_not_empty
    check (length(trim(content)) > 0),
  constraint knowledge_records_source_check
    check (source in ('human', 'agent', 'execution_log', 'research_asset', 'system', 'other')),
  constraint knowledge_records_confidence_check
    check (confidence in ('low', 'medium', 'high', 'verified')),
  constraint knowledge_records_status_check
    check (status in ('draft', 'active', 'superseded', 'archived'))
);

-- Links outputs to the research assets cited or used to produce them.
create table public.output_research_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  output_id uuid not null,
  research_asset_id uuid not null,
  linked_at timestamptz not null default now(),
  notes text,

  constraint output_research_assets_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint output_research_assets_output_id_fkey
    foreign key (output_id)
    references public.outputs (id)
    on delete cascade,
  constraint output_research_assets_research_asset_id_fkey
    foreign key (research_asset_id)
    references public.research_assets (id)
    on delete cascade,
  constraint output_research_assets_unique
    unique (output_id, research_asset_id)
);

-- Links tasks to the research assets used as execution inputs.
create table public.task_research_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  task_id uuid not null,
  research_asset_id uuid not null,
  linked_at timestamptz not null default now(),
  notes text,

  constraint task_research_assets_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint task_research_assets_task_id_fkey
    foreign key (task_id)
    references public.tasks (id)
    on delete cascade,
  constraint task_research_assets_research_asset_id_fkey
    foreign key (research_asset_id)
    references public.research_assets (id)
    on delete cascade,
  constraint task_research_assets_unique
    unique (task_id, research_asset_id)
);

-- Links work packets to the research assets referenced by the specification.
create table public.work_packet_research_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  work_packet_id uuid not null,
  research_asset_id uuid not null,
  linked_at timestamptz not null default now(),
  notes text,

  constraint work_packet_research_assets_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint work_packet_research_assets_work_packet_id_fkey
    foreign key (work_packet_id)
    references public.work_packets (id)
    on delete cascade,
  constraint work_packet_research_assets_research_asset_id_fkey
    foreign key (research_asset_id)
    references public.research_assets (id)
    on delete cascade,
  constraint work_packet_research_assets_unique
    unique (work_packet_id, research_asset_id)
);

-- Generic supporting links from a knowledge record to the source or related
-- entity it summarizes. Because targets are polymorphic, target FKs are not
-- enforceable at the database level; co-tenancy is enforced by future RLS and
-- application checks.
create table public.knowledge_record_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  knowledge_record_id uuid not null,
  linked_entity_type text not null,
  linked_entity_id uuid not null,
  link_type text not null default 'related',
  linked_at timestamptz not null default now(),
  notes text,

  constraint knowledge_record_links_organization_id_fkey
    foreign key (organization_id)
    references public.organizations (id)
    on delete restrict,
  constraint knowledge_record_links_knowledge_record_id_fkey
    foreign key (knowledge_record_id)
    references public.knowledge_records (id)
    on delete cascade,
  constraint knowledge_record_links_linked_entity_type_check
    check (linked_entity_type in ('project', 'request', 'task', 'work_packet', 'decision', 'research_asset', 'output', 'execution_log')),
  constraint knowledge_record_links_link_type_check
    check (link_type in ('source', 'supports', 'derived_from', 'related', 'supersedes', 'other')),
  constraint knowledge_record_links_unique
    unique (knowledge_record_id, linked_entity_type, linked_entity_id, link_type)
);

create index research_assets_organization_status_idx
  on public.research_assets (organization_id, status);

create index research_assets_organization_project_idx
  on public.research_assets (organization_id, project_id)
  where project_id is not null;

create index research_assets_organization_asset_type_idx
  on public.research_assets (organization_id, asset_type);

create index research_assets_created_by_user_id_idx
  on public.research_assets (created_by_user_id)
  where created_by_user_id is not null;

create index research_assets_organization_created_at_idx
  on public.research_assets (organization_id, created_at desc);

create index outputs_organization_status_idx
  on public.outputs (organization_id, status);

create index outputs_organization_department_status_idx
  on public.outputs (organization_id, department_id, status);

create index outputs_organization_task_id_idx
  on public.outputs (organization_id, task_id);

create index outputs_organization_project_id_idx
  on public.outputs (organization_id, project_id);

create index outputs_created_by_user_id_idx
  on public.outputs (created_by_user_id)
  where created_by_user_id is not null;

create index outputs_pending_delivery_idx
  on public.outputs (organization_id, status)
  where status in ('in_review', 'approved');

create index outputs_organization_created_at_idx
  on public.outputs (organization_id, created_at desc);

create index knowledge_records_organization_subject_idx
  on public.knowledge_records (organization_id, subject_type, subject_id);

create index knowledge_records_organization_project_idx
  on public.knowledge_records (organization_id, project_id)
  where project_id is not null;

create index knowledge_records_organization_status_idx
  on public.knowledge_records (organization_id, status);

create index knowledge_records_organization_record_type_idx
  on public.knowledge_records (organization_id, record_type);

create index knowledge_records_created_by_user_id_idx
  on public.knowledge_records (created_by_user_id)
  where created_by_user_id is not null;

create index knowledge_records_organization_created_at_idx
  on public.knowledge_records (organization_id, created_at desc);

create index output_research_assets_organization_output_idx
  on public.output_research_assets (organization_id, output_id);

create index output_research_assets_organization_research_asset_idx
  on public.output_research_assets (organization_id, research_asset_id);

create index task_research_assets_organization_task_idx
  on public.task_research_assets (organization_id, task_id);

create index task_research_assets_organization_research_asset_idx
  on public.task_research_assets (organization_id, research_asset_id);

create index work_packet_research_assets_organization_id_idx
  on public.work_packet_research_assets (organization_id);

create index work_packet_research_assets_work_packet_id_idx
  on public.work_packet_research_assets (work_packet_id);

create index work_packet_research_assets_research_asset_id_idx
  on public.work_packet_research_assets (research_asset_id);

create index knowledge_record_links_organization_knowledge_record_idx
  on public.knowledge_record_links (organization_id, knowledge_record_id);

create index knowledge_record_links_organization_linked_entity_idx
  on public.knowledge_record_links (organization_id, linked_entity_type, linked_entity_id);

create index knowledge_record_links_organization_link_type_idx
  on public.knowledge_record_links (organization_id, link_type);

-- RLS is enabled without policies to preserve the deny-by-default posture used
-- throughout prior phases. Phase E policies and grants are intentionally
-- deferred to later migrations.
alter table public.research_assets enable row level security;
alter table public.outputs enable row level security;
alter table public.knowledge_records enable row level security;
alter table public.output_research_assets enable row level security;
alter table public.task_research_assets enable row level security;
alter table public.work_packet_research_assets enable row level security;
alter table public.knowledge_record_links enable row level security;

-- Reuse the centralized updated_at trigger function for mutable knowledge-layer
-- entity tables. Junction/link tables are append-style relationship rows and do
-- not include updated_at.
create trigger set_research_assets_updated_at
before update on public.research_assets
for each row
execute function public.set_updated_at();

create trigger set_outputs_updated_at
before update on public.outputs
for each row
execute function public.set_updated_at();

create trigger set_knowledge_records_updated_at
before update on public.knowledge_records
for each row
execute function public.set_updated_at();
