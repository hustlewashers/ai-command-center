-- AI Command Center
-- Phase 015 Phase E Table Grants
--
-- Purpose:
-- Grant table privileges required for authenticated users to reach the Phase E
-- RLS policies planned for knowledge/output-layer tables.
--
-- Source documents:
-- - docs/phase-e-knowledge-output-layer-migration-plan.md
-- - supabase/migrations/006_table_grants.sql
-- - supabase/migrations/008_phase_c_grants.sql
-- - supabase/migrations/012_phase_d_grants.sql
-- - supabase/migrations/014_knowledge_output_layer.sql
--
-- Scope:
-- - Existing Phase E knowledge/output-layer tables only:
--   research_assets, outputs, knowledge_records, output_research_assets,
--   task_research_assets, work_packet_research_assets, knowledge_record_links
--
-- Explicitly excluded:
-- - RLS policy creation or modification
-- - New tables
-- - Seed data
-- - Supabase command execution
-- - Anonymous role privileges

-- GRANT controls whether a database role can attempt a table operation.
-- RLS controls which rows that role can see or mutate after the table-level
-- privilege check succeeds. Both are required: table grants alone do not bypass
-- RLS, and RLS policies alone do not satisfy PostgreSQL table privileges.
grant usage on schema public to authenticated;

-- Phase E entity tables are mutable knowledge/output state. Authenticated
-- clients need SELECT, INSERT, and UPDATE privileges so future RLS policies can
-- evaluate department scope, ownership, status transitions, and soft deletion.
grant select, insert, update
  on public.research_assets,
     public.outputs,
     public.knowledge_records
  to authenticated;

-- Junction/link tables are append-style relationship records. Authenticated
-- clients may read and create links through future RLS policies, but they must
-- not mutate existing link rows through UPDATE. Re-linking or unlinking should
-- be handled by service-role operations or a future logical link status column.
grant select, insert
  on public.output_research_assets,
     public.task_research_assets,
     public.work_packet_research_assets,
     public.knowledge_record_links
  to authenticated;

-- Defense in depth for append-style relationship records: no UPDATE table
-- privilege should exist for authenticated users, even though Phase E RLS will
-- also omit UPDATE policies for these tables.
revoke update
  on public.output_research_assets,
     public.task_research_assets,
     public.work_packet_research_assets,
     public.knowledge_record_links
  from authenticated;

-- DELETE remains denied on the authenticated client path. Phase E entity tables
-- use deleted_at for soft deletion where appropriate, while junction/link tables
-- are append-style relationship records with no authenticated hard-delete path.
revoke delete
  on public.research_assets,
     public.outputs,
     public.knowledge_records,
     public.output_research_assets,
     public.task_research_assets,
     public.work_packet_research_assets,
     public.knowledge_record_links
  from authenticated;
