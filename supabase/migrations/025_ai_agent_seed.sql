-- AI Command Center
-- Migration 025 — Seed a durable AI agent user per organization (Sprint 6.3)
--
-- Why this is safe:
-- - public.users.auth_user_id is NULLABLE (001), so an AI agent user needs no
--   row in auth.users. This does NOT create or touch any authentication identity.
-- - role 'agent' is an allowed value of users_role_check (001).
-- - The AI agent is a non-interactive service identity used only as the
--   NOT-NULL agent_user_id on agent_activity rows written by the call_ai step.
--   It can never sign in (no auth_user_id) and holds no elevated privilege.
--
-- service_role already has INSERT/SELECT on agent_activity, runtime_metrics, and
-- execution_logs via migration 021 — no additional grants are needed here.
--
-- Idempotent: only seeds an agent for organizations that don't already have one.
-- No DELETE. No schema changes.

insert into public.users (organization_id, email, display_name, role, status)
select
  o.id,
  'ai-agent+' || o.id::text || '@agent.local',   -- deterministic, unique per org
  'AI Agent',
  'agent',
  'active'
from public.organizations o
where not exists (
  select 1
  from public.users u
  where u.organization_id = o.id
    and u.role = 'agent'
    and u.deleted_at is null
);
