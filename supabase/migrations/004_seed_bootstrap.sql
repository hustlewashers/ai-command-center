-- AI Command Center
-- Bootstrap Seed Migration
--
-- Source documents:
-- - docs/phase-b-design-addendum.md
-- - docs/phase-b-system-intelligence-migration-plan.md
-- - docs/department-map.md
-- - docs/tool-stack.md
-- - supabase/migrations/001_foundation.sql
-- - supabase/migrations/003_system_intelligence.sql
--
-- Scope:
-- - Initial organization
-- - Bootstrap user placeholder
-- - Initial departments
-- - Initial tool profiles
-- - Department default tool profile assignments
-- - Initial workflow templates
--
-- Explicitly excluded:
-- - RLS policies
-- - New tables
-- - Supabase command execution

-- Seed order matters:
-- 1. organizations is the root tenant boundary.
-- 2. users must exist before created_by references on tool_profiles/workflows.
-- 3. departments must exist before tool_profiles.owner_department_id.
-- 4. tool_profiles must exist before departments.default_tool_profile_id can be populated.
-- 5. workflows must exist before projects.workflow_template_id can be populated.
--
-- Circular FK handling:
-- departments.default_tool_profile_id points to tool_profiles, while
-- tool_profiles.owner_department_id points back to departments. This is resolved
-- by inserting departments first with default_tool_profile_id = null, inserting
-- profiles second, then updating each department to its default profile.
--
-- Role mapping:
-- The requested bootstrap role is platform_admin. The current Phase A schema
-- permits org_admin, department_lead, department_member, agent, and read_only.
-- This seed stores the bootstrap placeholder as org_admin, which is the current
-- schema-compatible platform administrator role. A distinct platform_admin role
-- is deferred until multi-org platform administration roles exist.

do $$
declare
  v_org_id uuid;
  v_bootstrap_user_id uuid;
  v_command_center_department_id uuid;
  v_research_department_id uuid;
  v_command_center_brain_id uuid;
  v_execution_worker_id uuid;
  v_build_workshop_id uuid;
  v_operations_external_id uuid;
begin
  insert into public.organizations (name, slug, status)
  select 'AI Command Center', 'ai-command-center', 'active'
  where not exists (
    select 1
    from public.organizations
    where slug = 'ai-command-center'
      and deleted_at is null
  );

  select id
    into v_org_id
  from public.organizations
  where slug = 'ai-command-center'
    and deleted_at is null;

  insert into public.users (
    organization_id,
    auth_user_id,
    email,
    display_name,
    role,
    status,
    department_id
  )
  select
    v_org_id,
    null,
    'bootstrap@ai-command-center.local',
    'Bootstrap Admin',
    'org_admin',
    'active',
    null
  where not exists (
    select 1
    from public.users
    where organization_id = v_org_id
      and email = 'bootstrap@ai-command-center.local'
      and deleted_at is null
  );

  select id
    into v_bootstrap_user_id
  from public.users
  where organization_id = v_org_id
    and email = 'bootstrap@ai-command-center.local'
    and deleted_at is null;

  insert into public.departments (organization_id, name, slug, mission, status)
  select v_org_id, seed.name, seed.slug, seed.mission, 'active'
  from (
    values
      ('Command Center', 'command-center', 'Own the core AI Command Center operating system, routing model, orchestration standards, and cross-department governance.'),
      ('Research', 'research', 'Gather, evaluate, and synthesize research assets for decisions, work packets, and knowledge records.'),
      ('Product / Strategy', 'product-strategy', 'Define product direction, strategy, prioritization, and high-level execution intent.'),
      ('App Builder', 'app-builder', 'Build application features, technical workflows, and software outputs for the Command Center and implementation domains.'),
      ('Website Builder', 'website-builder', 'Create and maintain websites, landing pages, and web delivery surfaces.'),
      ('Automation', 'automation', 'Design and maintain automations, scheduled workflows, and integration handoffs.'),
      ('Design / Creative', 'design-creative', 'Produce visual design, brand systems, creative assets, and presentation-ready materials.'),
      ('Content / SEO', 'content-seo', 'Create, optimize, and maintain content assets for search, education, and growth.'),
      ('Sales / Growth', 'sales-growth', 'Drive outreach, pipeline support, growth campaigns, and revenue-facing outputs.'),
      ('QA / Compliance', 'qa-compliance', 'Validate quality, policy alignment, acceptance criteria, and compliance-sensitive outputs.'),
      ('HR', 'hr', 'Support people operations, role documentation, onboarding, and internal operating practices.'),
      ('Audit', 'audit', 'Review execution history, decisions, approvals, and system behavior for accountability.'),
      ('Maintenance', 'maintenance', 'Handle upkeep, issue remediation, backlog cleanup, and operational repairs.'),
      ('Monitoring', 'monitoring', 'Observe workflow health, blocker signals, uptime, alerts, and operational metrics.'),
      ('Operations / Documentation', 'operations-documentation', 'Run day-to-day coordination, documentation, delivery tracking, and operating procedures.')
  ) as seed(name, slug, mission)
  where not exists (
    select 1
    from public.departments d
    where d.organization_id = v_org_id
      and d.slug = seed.slug
      and d.deleted_at is null
  );

  select id
    into v_command_center_department_id
  from public.departments
  where organization_id = v_org_id
    and slug = 'command-center'
    and deleted_at is null;

  select id
    into v_research_department_id
  from public.departments
  where organization_id = v_org_id
    and slug = 'research'
    and deleted_at is null;

  update public.users
  set department_id = v_command_center_department_id
  where id = v_bootstrap_user_id
    and department_id is null;

  insert into public.tool_profiles (
    organization_id,
    name,
    slug,
    description,
    allowed_tools,
    constraints,
    owner_department_id,
    created_by,
    status
  )
  select
    v_org_id,
    seed.name,
    seed.slug,
    seed.description,
    seed.allowed_tools,
    seed.constraints,
    v_command_center_department_id,
    v_bootstrap_user_id,
    'active'
  from (
    values
      (
        'Command Center Brain',
        'command-center-brain',
        'Strategic reasoning and orchestration profile for Command Center planning, routing, synthesis, and governance.',
        '["acc.request.create","acc.task.manage","acc.work-packet.manage","acc.decision.record","acc.blocker.manage","acc.output.publish","acc.execution-log.read","acc.approval.request","research.web.fetch","research.document.ingest","research.note.create","research.asset.archive","data.store.read","data.store.write","data.store.query","auto.workflow.run","auto.workflow.pause","auto.agent.invoke","ai.chatgpt","ai.claude","workspace.notion","data.supabase"]'::jsonb,
        '{"approval_limits":{"external_delivery":"approval_required","destructive_actions":"not_allowed","service_role_use":"approval_required"},"notes":"Primary reasoning and orchestration profile for internal Command Center work."}'::jsonb
      ),
      (
        'Execution Worker',
        'execution-worker',
        'General execution profile for task work, research capture, internal automation, and operational follow-through.',
        '["acc.task.manage","acc.work-packet.manage","acc.decision.record","acc.blocker.manage","acc.output.publish","acc.execution-log.read","research.web.fetch","research.document.ingest","research.note.create","research.asset.archive","data.store.read","data.store.write","auto.workflow.run","auto.workflow.pause","auto.agent.invoke","ai.chatgpt","ai.claude","workspace.notion","data.supabase","auto.n8n"]'::jsonb,
        '{"approval_limits":{"external_delivery":"approval_required","scheduled_production_operations":"approval_required","destructive_actions":"not_allowed"},"notes":"Default worker profile for internal execution tasks."}'::jsonb
      ),
      (
        'Build Workshop',
        'build-workshop',
        'Engineering and build profile for app, website, repository, deployment, and implementation work.',
        '["acc.task.manage","acc.work-packet.manage","acc.decision.record","acc.blocker.manage","acc.output.publish","acc.execution-log.read","code.repo.read","code.repo.write","code.repo.commit","code.repo.pr.create","code.shell.exec","data.store.read","data.store.write","data.store.query","auto.agent.invoke","ide.cursor","code.github","data.supabase","infra.vercel","ai.claude","ai.openai_api"]'::jsonb,
        '{"approval_limits":{"protected_branch_commit":"approval_required","production_deployment":"approval_required","secret_management":"approval_required","destructive_shell":"approval_required"},"notes":"Build profile for technical implementation and deployment work."}'::jsonb
      ),
      (
        'Operations External',
        'operations-external',
        'Operations profile for documentation, coordination, external communication preparation, and controlled delivery.',
        '["acc.request.create","acc.task.manage","acc.work-packet.manage","acc.decision.record","acc.blocker.manage","acc.output.publish","acc.execution-log.read","acc.approval.request","research.note.create","comms.email.draft","comms.email.send","comms.slack.post","comms.webhook.emit","auto.workflow.run","auto.workflow.pause","auto.schedule.create","workspace.notion","auto.n8n","ai.chatgpt","ai.claude"]'::jsonb,
        '{"approval_limits":{"email_send":"approval_required","external_webhook":"approval_required","schedule_create":"approval_required","page_deletion":"approval_required"},"notes":"Operations profile for controlled external-facing work."}'::jsonb
      )
  ) as seed(name, slug, description, allowed_tools, constraints)
  where not exists (
    select 1
    from public.tool_profiles tp
    where tp.organization_id = v_org_id
      and tp.slug = seed.slug
      and tp.name = seed.name
      and tp.deleted_at is null
  );

  select id
    into v_command_center_brain_id
  from public.tool_profiles
  where organization_id = v_org_id
    and slug = 'command-center-brain'
    and deleted_at is null;

  select id
    into v_execution_worker_id
  from public.tool_profiles
  where organization_id = v_org_id
    and slug = 'execution-worker'
    and deleted_at is null;

  select id
    into v_build_workshop_id
  from public.tool_profiles
  where organization_id = v_org_id
    and slug = 'build-workshop'
    and deleted_at is null;

  select id
    into v_operations_external_id
  from public.tool_profiles
  where organization_id = v_org_id
    and slug = 'operations-external'
    and deleted_at is null;

  update public.departments
  set default_tool_profile_id =
    case slug
      when 'command-center' then v_command_center_brain_id
      when 'research' then v_command_center_brain_id
      when 'product-strategy' then v_command_center_brain_id
      when 'app-builder' then v_build_workshop_id
      when 'website-builder' then v_build_workshop_id
      when 'automation' then v_execution_worker_id
      when 'design-creative' then v_execution_worker_id
      when 'content-seo' then v_execution_worker_id
      when 'sales-growth' then v_operations_external_id
      when 'qa-compliance' then v_execution_worker_id
      when 'hr' then v_operations_external_id
      when 'audit' then v_command_center_brain_id
      when 'maintenance' then v_execution_worker_id
      when 'monitoring' then v_execution_worker_id
      when 'operations-documentation' then v_operations_external_id
      else default_tool_profile_id
    end
  where organization_id = v_org_id
    and slug in (
      'command-center',
      'research',
      'product-strategy',
      'app-builder',
      'website-builder',
      'automation',
      'design-creative',
      'content-seo',
      'sales-growth',
      'qa-compliance',
      'hr',
      'audit',
      'maintenance',
      'monitoring',
      'operations-documentation'
    )
    and deleted_at is null;

  insert into public.workflows (
    organization_id,
    name,
    kind,
    definition,
    tool_profile_id,
    department_id,
    project_id,
    template_id,
    created_by,
    status
  )
  select
    v_org_id,
    'request-to-output',
    'template',
    $json$
    {
      "version": "1.0",
      "name": "Request to Output",
      "trigger": {
        "type": "request",
        "conditions": {}
      },
      "steps": [
        {
          "id": "triage",
          "name": "Triage Request",
          "type": "task",
          "assigned_department": "operations-documentation",
          "inputs": { "request_id": "string" },
          "outputs": { "routed_department": "string", "project_id": "string" },
          "on_success": "author_work_packet",
          "on_failure": "escalate_triage"
        },
        {
          "id": "author_work_packet",
          "name": "Author Work Packet",
          "type": "task",
          "assigned_department": "command-center",
          "inputs": { "project_id": "string", "request_id": "string" },
          "outputs": { "work_packet_id": "string" },
          "on_success": "approval_gate",
          "on_failure": "escalate_triage"
        },
        {
          "id": "approval_gate",
          "name": "Approval Gate",
          "type": "approval",
          "inputs": { "work_packet_id": "string" },
          "outputs": { "approval_status": "string" },
          "on_success": "execute_tasks",
          "on_failure": "end"
        },
        {
          "id": "execute_tasks",
          "name": "Execute Tasks",
          "type": "task",
          "inputs": { "work_packet_id": "string" },
          "outputs": { "output_id": "string" },
          "on_success": "review_output",
          "on_failure": "fail"
        },
        {
          "id": "review_output",
          "name": "Review Output",
          "type": "task",
          "assigned_department": "operations-documentation",
          "inputs": { "output_id": "string" },
          "outputs": { "output_status": "string" },
          "on_success": "deliver_output",
          "on_failure": "execute_tasks"
        },
        {
          "id": "deliver_output",
          "name": "Deliver Output",
          "type": "tool_call",
          "tool_id": "acc.output.publish",
          "assigned_department": "operations-documentation",
          "inputs": { "output_id": "string" },
          "outputs": { "delivered_at": "string" },
          "on_success": "end",
          "on_failure": "escalate_triage"
        },
        {
          "id": "escalate_triage",
          "name": "Escalate to Command Center",
          "type": "notify",
          "assigned_department": "command-center",
          "inputs": {},
          "outputs": {},
          "on_success": "end",
          "on_failure": "fail"
        }
      ],
      "required_inputs": ["request_id"],
      "expected_outputs": ["output_id"],
      "approval_gates": ["deliver_output"],
      "failure_handling": "escalate"
    }
    $json$::jsonb,
    v_command_center_brain_id,
    v_command_center_department_id,
    null,
    null,
    v_bootstrap_user_id,
    'active'
  where not exists (
    select 1
    from public.workflows wf
    where wf.organization_id = v_org_id
      and wf.name = 'request-to-output'
      and wf.kind = 'template'
      and wf.deleted_at is null
  );

  insert into public.workflows (
    organization_id,
    name,
    kind,
    definition,
    tool_profile_id,
    department_id,
    project_id,
    template_id,
    created_by,
    status
  )
  select
    v_org_id,
    'research-and-synthesize',
    'template',
    $json$
    {
      "version": "1.0",
      "name": "Research and Synthesize",
      "trigger": {
        "type": "manual",
        "conditions": {}
      },
      "steps": [
        {
          "id": "define_question",
          "name": "Define Research Question",
          "type": "task",
          "assigned_department": "research",
          "inputs": { "request_id": "string" },
          "outputs": { "research_question": "string", "work_packet_id": "string" },
          "on_success": "gather_assets",
          "on_failure": "fail"
        },
        {
          "id": "gather_assets",
          "name": "Gather Research Assets",
          "type": "tool_call",
          "tool_id": "research.web.fetch",
          "assigned_department": "research",
          "inputs": { "research_question": "string" },
          "outputs": { "research_asset_ids": "array" },
          "on_success": "synthesize",
          "on_failure": "retry"
        },
        {
          "id": "synthesize",
          "name": "Synthesize and Create Knowledge Record",
          "type": "tool_call",
          "tool_id": "ai.claude",
          "assigned_department": "research",
          "inputs": { "research_asset_ids": "array", "research_question": "string" },
          "outputs": { "knowledge_record_id": "string" },
          "on_success": "review_synthesis",
          "on_failure": "fail"
        },
        {
          "id": "review_synthesis",
          "name": "Review Knowledge Record",
          "type": "task",
          "assigned_department": "research",
          "inputs": { "knowledge_record_id": "string" },
          "outputs": { "approved": "boolean" },
          "on_success": "end",
          "on_failure": "synthesize"
        }
      ],
      "required_inputs": ["request_id"],
      "expected_outputs": ["knowledge_record_id"],
      "approval_gates": [],
      "failure_handling": "notify"
    }
    $json$::jsonb,
    v_execution_worker_id,
    v_research_department_id,
    null,
    null,
    v_bootstrap_user_id,
    'active'
  where not exists (
    select 1
    from public.workflows wf
    where wf.organization_id = v_org_id
      and wf.name = 'research-and-synthesize'
      and wf.kind = 'template'
      and wf.deleted_at is null
  );
end;
$$;
