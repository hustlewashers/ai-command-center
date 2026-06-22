# Phase E Knowledge / Output Layer Migration Plan

Data model design for the AI Command Center **Knowledge / Output Layer** — the three tables that close the Phase D `output` forward reference, capture deliverables, store raw knowledge inputs, and provide universal agent-readable memory.

> **Canonical entities:** [system-entities.md](system-entities.md) §8 Research Asset · §9 Output · §14 Knowledge Record  
> **Runtime data model:** [supabase-runtime-data-model.md](supabase-runtime-data-model.md) §3 Knowledge Layer  
> **Approval gates:** [approval-rules.md](approval-rules.md)  
> **Phase D governance:** [phase-d-governance-layer-migration-plan.md](phase-d-governance-layer-migration-plan.md)

This document is **planning only**. No SQL, migrations, or Supabase commands are included.

Phase E depends on all Phase A–D migrations having been applied successfully. It also resolves the forward reference introduced in `011_governance_layer.sql` where `approvals.subject_type` allows `'output'` but no backing table existed.

---

## Relationship to Existing Tables

| Phase E table | Connects to | Via |
|---------------|-------------|-----|
| `research_assets` | `organizations` | `organization_id` |
| `research_assets` | `projects` | `project_id` (nullable — asset may be org-wide) |
| `research_assets` | `users` | `created_by_user_id` (nullable — may be agent-created) |
| `outputs` | `organizations` | `organization_id` |
| `outputs` | `tasks` | `task_id` (required — outputs are always task-produced) |
| `outputs` | `projects` | `project_id` (required — outputs belong to a project) |
| `outputs` | `departments` | `department_id` (required — outputs are department-owned for RLS, routing, audit, and delivery accountability; direct column avoids a join through `tasks` and matches the `approvals`/`blockers` denormalization pattern) |
| `outputs` | `users` | `created_by_user_id` (nullable — agent-created outputs allowed) |
| `knowledge_records` | `organizations` | `organization_id` |
| `knowledge_records` | `projects` | `project_id` (nullable — optional scope anchor for multi-entity subjects) |
| `knowledge_records` | `users` | `created_by_user_id` (nullable — agent or system-created) |
| `knowledge_record_links` | `organizations` | `organization_id` |
| `knowledge_record_links` | `knowledge_records` | `knowledge_record_id` |

**Polymorphic subjects:**
- `knowledge_records.subject_type` / `subject_id` is the **primary subject anchor** and references `project`, `request`, `task`, `work_packet`, `decision`, `research_asset`, or `output`.
- `knowledge_record_links.linked_entity_type` / `linked_entity_id` stores **secondary related entities** for associative memory, traceability, and related-context retrieval. Valid linked types are `project`, `request`, `task`, `work_packet`, `decision`, `research_asset`, `output`, and `execution_log`.
- `approvals.subject_type = 'output'` / `subject_id` references `outputs.id` once Phase E is applied.

**Junction tables (required, same migration):**
- `task_research_assets` — many-to-many `tasks ↔ research_assets`
- `work_packet_research_assets` — many-to-many `work_packets ↔ research_assets`
- `output_research_assets` — many-to-many `outputs ↔ research_assets`

**Knowledge support link table (required, same migration):**
- `knowledge_record_links` — one-to-many `knowledge_records → related entities` for secondary context links; this does not replace the primary `knowledge_records.subject_type` / `subject_id` anchor.

> `blocker_research_assets` (linking blockers to research assets) is noted in the runtime model but deferred to Phase F. Phase E creates the three research-asset junction tables above plus `knowledge_record_links`.

---

## 1. `research_assets`

### Purpose

Stores raw knowledge inputs used to inform work — documents, URLs, notes, datasets, and transcripts. Research assets are reusable across tasks and work packets and may be cited in decisions and outputs. They are consumed by, but distinct from, `knowledge_records` (curated synthesis) and `outputs` (deliverables).

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `project_id` | `uuid` | NULL | FK → `projects.id`, `on delete set null`; null for org-wide or cross-project assets |
| `title` | `text` | NOT NULL | Asset label; check `length(trim(title)) > 0` |
| `asset_type` | `text` | NOT NULL | Check: `('document','url','note','dataset','transcript','other')` |
| `source` | `text` | NOT NULL | Where the asset originated; check `length(trim(source)) > 0` |
| `storage_path` | `text` | NULL | Supabase Storage path for binary payloads; null for inline content |
| `content_preview` | `text` | NULL | First N characters or summary for display; null for binary-only assets |
| `created_by_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; null for agent-created or imported assets |
| `status` | `text` | NOT NULL | Default `'draft'`; check: `('draft','active','stale','archived','rejected')` |
| `captured_at` | `timestamptz` | NOT NULL | Default `now()`; timestamp of ingestion or capture |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by `set_updated_at()` trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete |

### Foreign Keys

| Column | References | On delete |
|--------|-----------|-----------|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `project_id` | `public.projects.id` | SET NULL |
| `created_by_user_id` | `public.users.id` | SET NULL |

### Primary Subject vs Secondary Links

`knowledge_records.subject_type` / `subject_id` is the canonical, single primary subject for a record. It answers: "What entity is this knowledge record about?"

`knowledge_record_links` stores secondary related entities that informed the record or should be retrieved with it. It answers: "What other entities are associated with this memory?" This enables associative memory, traceability from synthesized knowledge back to source artifacts or execution logs, and related-context retrieval without overloading the primary subject pair.

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `research_assets_organization_status_idx` | `(organization_id, status)` | Active assets overview |
| `research_assets_organization_project_idx` | `(organization_id, project_id)` WHERE `project_id IS NOT NULL` | Assets by project; RLS support |
| `research_assets_organization_asset_type_idx` | `(organization_id, asset_type)` | Filter by type |
| `research_assets_created_by_user_id_idx` | `(created_by_user_id)` WHERE `created_by_user_id IS NOT NULL` | Per-actor asset history |
| `research_assets_organization_created_at_idx` | `(organization_id, created_at DESC)` | Timeline views |

### Status Values

| Status | Meaning |
|--------|---------|
| `draft` | Partial or unverified capture; not yet trusted for agent use |
| `active` | Trusted and available for use |
| `stale` | Potentially outdated; refresh recommended |
| `archived` | Retained but not used for new work |
| `rejected` | Deemed unreliable or out of scope |

### Ownership Rules

- `organization_id` is org-pinned on INSERT.
- `project_id` is optional; if provided it must be in the same org (co-tenancy checked in RLS INSERT policy).
- `created_by_user_id` is null-or-self pinned for authenticated users.
- Research department manages quality (`status` advancement), but any department member may INSERT assets for their work.

### RLS Considerations

- SELECT: `org_admin` reads all org-scoped assets where `deleted_at is null`. Department members and leads read assets scoped to their department's projects (`project_id` co-tenancy) or linked via junction tables (`task_research_assets`, `work_packet_research_assets`, `output_research_assets`). Assets with no project and no junction link are readable by `org_admin` only. Org-wide read across all departments (cross-department knowledge discovery) is deferred to a future phase.
- INSERT: `org_admin`, `department_lead`, `department_member`, `agent` in own org; `created_by_user_id` null-or-self; co-tenancy on `project_id`.
- UPDATE: `org_admin`, `department_lead`, `department_member` in same org. Status advancement (`active`/`archived`/`rejected`) may be restricted to leads/admins in a follow-on adjustment.
- No DELETE policy for `authenticated`. Soft-delete via `deleted_at`.

### Initial Seed Requirements

None.

---

## 2. `outputs`

### Purpose

Deliverables produced by task execution — reports, artifacts, message drafts, code summaries, data exports, and other tangible results. Outputs are approval-gated for external delivery (Category A). Phase E's creation of this table activates the `approvals.subject_type = 'output'` forward reference from `011_governance_layer.sql`.

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `department_id` | `uuid` | NOT NULL | FK → `departments.id`, `on delete restrict`; direct column for clean RLS without task join |
| `task_id` | `uuid` | NOT NULL | FK → `tasks.id`, `on delete restrict`; outputs are always task-produced |
| `project_id` | `uuid` | NOT NULL | FK → `projects.id`, `on delete restrict`; outputs always belong to a project |
| `title` | `text` | NOT NULL | Output name; check `length(trim(title)) > 0` |
| `output_type` | `text` | NOT NULL | Check: `('report','artifact','message','data','other')` |
| `content` | `text` | NULL | Inline content for text outputs; null for binary/storage-only |
| `storage_path` | `text` | NULL | Supabase Storage path for binary payloads |
| `created_by_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; null for agent-produced outputs |
| `status` | `text` | NOT NULL | Default `'draft'`; check: `('draft','in_review','approved','delivered','superseded','rejected')` |
| `produced_at` | `timestamptz` | NOT NULL | Default `now()` |
| `delivered_at` | `timestamptz` | NULL | Populated when status → `delivered`; application-enforced |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by `set_updated_at()` trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete |

### Foreign Keys

| Column | References | On delete |
|--------|-----------|-----------|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `department_id` | `public.departments.id` | RESTRICT |
| `task_id` | `public.tasks.id` | RESTRICT |
| `project_id` | `public.projects.id` | RESTRICT |
| `created_by_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `outputs_organization_status_idx` | `(organization_id, status)` | Active outputs overview |
| `outputs_organization_department_status_idx` | `(organization_id, department_id, status)` | Department output queue; RLS support |
| `outputs_organization_task_id_idx` | `(organization_id, task_id)` | Outputs for a task |
| `outputs_organization_project_id_idx` | `(organization_id, project_id)` | Outputs for a project |
| `outputs_created_by_user_id_idx` | `(created_by_user_id)` WHERE `created_by_user_id IS NOT NULL` | Per-actor output history |
| `outputs_pending_delivery_idx` | `(organization_id, status)` WHERE `status IN ('in_review','approved')` | Delivery pipeline view |
| `outputs_organization_created_at_idx` | `(organization_id, created_at DESC)` | Timeline views |

### Status Values

| Status | Meaning | Approval gate |
|--------|---------|--------------|
| `draft` | In progress; not ready for review | None |
| `in_review` | Awaiting quality or approval check | Optional (department lead review) |
| `approved` | Cleared for delivery | Approval required for external delivery (Category A) |
| `delivered` | Released to requester or target system | Requires approved `approvals` row per `approval-rules.md` |
| `superseded` | Replaced by a newer output | None |
| `rejected` | Not accepted; requires rework | None |

### `delivered_at` note

`delivered_at` is populated by the application layer when `status` transitions to `delivered`. The DB column is nullable. Application layer must verify an `approvals` row with `status='approved'` exists on this output before allowing the `delivered` transition (Category A gate).

### `department_id` note

`department_id` is carried directly on `outputs` — not derived via `task_id → tasks.department_id` — for four reasons:

1. **RLS**: Policy `USING` and `WITH CHECK` clauses can filter on `outputs.department_id` without a subquery join, keeping policy execution lightweight.
2. **Routing**: Delivery queues and department dashboards query `(organization_id, department_id, status)` directly (covered by `outputs_organization_department_status_idx`).
3. **Audit**: Approval and execution-log records reference `department_id` on their own rows; having it on `outputs` keeps the audit chain self-contained.
4. **Delivery accountability**: The department that owns an output is the department accountable for its release — this must be explicit, not inferred.

This is the same denormalization pattern used by `approvals` and `blockers` in Phase D. The trade-off is that `department_id` must match the task's owning department (application-enforced; see Ownership Rules and Risk #2). `supabase-runtime-data-model.md` §3 also lists `department_id` on `outputs` for the reasons above.

### Ownership Rules

- `organization_id`, `department_id`, `task_id`, and `project_id` are required on INSERT.
- `department_id` must match the task's owning department (application-enforced; RLS enforces direct column match).
- `project_id` must match the task's project (application-enforced; RLS enforces co-tenancy).
- `created_by_user_id` is null-or-self pinned for authenticated users.
- External delivery is gated by an approved `approvals` row — this is **not enforced by RLS** but by the application layer (same as the `work_packets.approval_required_before_start` pattern).

### RLS Considerations

- SELECT: own department + org admin; `deleted_at is null`.
- INSERT: `org_admin`, `department_lead`, `department_member` in own dept; `created_by_user_id` null-or-self; co-tenancy on `task_id`, `project_id`, `department_id`.
- UPDATE: `org_admin`, `department_lead` (own dept), `department_member` (own dept).
- No DELETE policy for `authenticated`. Soft-delete via `deleted_at`.

### Initial Seed Requirements

None.

---

## 3. `knowledge_records`

### Purpose

Universal memory and knowledge layer for the AI Command Center. Curated summaries, context notes, constraints, lessons learned, and agent-retrievable synthesis attachable to any core entity. Knowledge records are distinct from raw `research_assets` (inputs), formal `decisions` (point-in-time choices), and append-only `execution_logs` (audit). They support agent continuity across sessions.

### Required Fields

| Field | Type | Nullable | Notes |
|-------|------|----------|-------|
| `id` | `uuid` | NOT NULL | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | NOT NULL | FK → `organizations.id`, `on delete restrict` |
| `project_id` | `uuid` | NULL | FK → `projects.id`, `on delete set null`; optional scope anchor for cross-cutting subjects |
| `subject_type` | `text` | NOT NULL | Check: `('project','request','task','work_packet','decision','research_asset','output')` |
| `subject_id` | `uuid` | NOT NULL | Polymorphic; DB-level FK not enforceable; application + RLS co-tenancy enforced |
| `record_type` | `text` | NOT NULL | Check: `('summary','context','constraint','lesson','index','synthesis','other')` |
| `title` | `text` | NOT NULL | Short label; check `length(trim(title)) > 0` |
| `summary` | `text` | NOT NULL | Brief abstract; check `length(trim(summary)) > 0` |
| `content` | `text` | NOT NULL | Full curated content body; check `length(trim(content)) > 0` |
| `source` | `text` | NOT NULL | Origin of the knowledge; check: `('human','agent','execution_log','research_asset','system','other')` — `'other'` retained for extensibility per [system-entities.md](system-entities.md) §14 |
| `confidence` | `text` | NOT NULL | Default `'medium'`; check: `('low','medium','high','verified')` |
| `created_by_user_id` | `uuid` | NULL | FK → `users.id`, `on delete set null`; null for agent or system-created records |
| `status` | `text` | NOT NULL | Default `'draft'`; check: `('draft','active','superseded','archived')` |
| `created_at` | `timestamptz` | NOT NULL | Default `now()` |
| `updated_at` | `timestamptz` | NOT NULL | Default `now()`; maintained by `set_updated_at()` trigger |
| `deleted_at` | `timestamptz` | NULL | Soft-delete |

### Foreign Keys

| Column | References | On delete |
|--------|-----------|-----------|
| `organization_id` | `public.organizations.id` | RESTRICT |
| `project_id` | `public.projects.id` | SET NULL |
| `created_by_user_id` | `public.users.id` | SET NULL |

### Recommended Indexes

| Index | Columns | Rationale |
|-------|---------|-----------|
| `knowledge_records_organization_subject_idx` | `(organization_id, subject_type, subject_id)` | Retrieve all records for a subject entity (primary agent access pattern) |
| `knowledge_records_organization_project_idx` | `(organization_id, project_id)` WHERE `project_id IS NOT NULL` | Records scoped to a project |
| `knowledge_records_organization_status_idx` | `(organization_id, status)` | Active records overview |
| `knowledge_records_organization_record_type_idx` | `(organization_id, record_type)` | Filter by record type |
| `knowledge_records_created_by_user_id_idx` | `(created_by_user_id)` WHERE `created_by_user_id IS NOT NULL` | Per-actor knowledge creation history |
| `knowledge_records_organization_created_at_idx` | `(organization_id, created_at DESC)` | Timeline views |

### Status Values

| Status | Meaning |
|--------|---------|
| `draft` | Being authored; not yet trusted for agent retrieval |
| `active` | Trusted and available for agent use |
| `superseded` | Replaced by a newer knowledge record on the same subject |
| `archived` | Retained but not used for new work |

### Ownership Rules

- `organization_id` is org-pinned on INSERT.
- `project_id` is optional; if set, must be in the same org.
- `subject_type`/`subject_id` must reference a row in the same org (application and RLS `with check` enforced per subject type).
- `created_by_user_id` is null-or-self pinned for authenticated users.
- Department content ownership follows the referenced subject entity's department; the Platform department owns the schema.

### RLS Considerations

- SELECT: `org_admin` reads all org-scoped records where `deleted_at is null`. Department members and leads read records where the referenced `subject_id` belongs to an entity in their department (branched EXISTS check per `subject_type`). Agents read records where `subject_id` belongs to their assigned task context. Org-wide read across all departments (cross-department knowledge surfacing) is deferred to a future phase.
- INSERT: `org_admin`, `department_lead`, `department_member`, `agent` in own org; `created_by_user_id` null-or-self; branched co-tenancy EXISTS checks per `subject_type`.
- UPDATE: `org_admin`, `department_lead`, `department_member` (own org); status advancement restricted to leads/admins.
- No DELETE policy for `authenticated`. Soft-delete via `deleted_at`.

### Initial Seed Requirements

None.

---

## Junction Tables

### `task_research_assets`

| Field | Type | Notes |
|-------|------|-------|
| `id` | `uuid` | PK |
| `organization_id` | `uuid` | NOT NULL; FK → `organizations.id` |
| `task_id` | `uuid` | NOT NULL; FK → `tasks.id`, `on delete cascade` |
| `research_asset_id` | `uuid` | NOT NULL; FK → `research_assets.id`, `on delete cascade` |
| `linked_at` | `timestamptz` | NOT NULL; default `now()` |
| `notes` | `text` | NULL |

Unique constraint: `UNIQUE (task_id, research_asset_id)`. No `deleted_at` column on junction tables; duplicate links are prevented at the constraint level. RLS INSERT policy and application layer must also verify that `task_id` and `research_asset_id` belong to the same organization before linking (co-tenancy check via `organization_id` match on both parent rows).

### `work_packet_research_assets`

Same shape as above with `work_packet_id` instead of `task_id`. FK → `work_packets.id`, `on delete cascade`.

### `output_research_assets`

Same shape with `output_id` instead of `task_id`. FK → `outputs.id`, `on delete cascade`.

### `knowledge_record_links`

| Field | Type | Notes |
|-------|------|-------|
| `id` | `uuid` | PK |
| `organization_id` | `uuid` | NOT NULL; FK → `organizations.id` |
| `knowledge_record_id` | `uuid` | NOT NULL; FK → `knowledge_records.id`, `on delete cascade` |
| `linked_entity_type` | `text` | Check: `('project','request','task','work_packet','decision','research_asset','output','execution_log')` |
| `linked_entity_id` | `uuid` | NOT NULL; polymorphic secondary target |
| `link_type` | `text` | Default `'related'`; check: `('source','supports','derived_from','related','supersedes','other')` |
| `linked_at` | `timestamptz` | NOT NULL; default `now()` |
| `notes` | `text` | NULL |

Unique constraint: `UNIQUE (knowledge_record_id, linked_entity_type, linked_entity_id, link_type)`. Target FKs are not enforceable at the database level because `linked_entity_id` is polymorphic. RLS INSERT policy and application layer must verify linked targets exist in the same organization.

**RLS for junction/link tables:** All research-asset junction tables inherit org-scoped SELECT from their parent row's org. `knowledge_record_links` inherits visibility from the parent `knowledge_records` row and must never make a link visible based only on the linked target. Both sides are required: the parent knowledge record must be visible under the same subject-scope rules used by `knowledge_records` SELECT, and the linked target must resolve to a same-org row visible through its own department or assigned-task context. INSERT is restricted to members with write access to the parent entity or knowledge record. Agents may INSERT `knowledge_record_links` only when the parent knowledge record is accessible through an assigned task context. Agents may not INSERT `task_research_assets`, `work_packet_research_assets`, or `output_research_assets`; those research-asset junction inserts remain human/operator controlled for Phase E. No DELETE from `authenticated`; a soft-removal pattern requires physical delete by service role or a future logical link status column.

**Future policy notes:**
- Research-asset junction policies should verify both parent rows belong to the same `organization_id` before allowing INSERT.
- Research-asset junction INSERT remains human/operator controlled in Phase E (`org_admin`, `department_lead`, `department_member` only). Agents can read research-asset junctions through assigned tasks but cannot create those links.
- `knowledge_record_links` policies should verify both sides before allowing SELECT or INSERT: `knowledge_record_id` must resolve to a parent record visible to the caller, and `linked_entity_id` must resolve to a same-org row for the specified `linked_entity_type`.
- `knowledge_record_links` SELECT should not widen access beyond the parent `knowledge_records` row; linked targets should be filtered through the same department/agent context rules used for knowledge records.
- Agent INSERT on `knowledge_record_links` is allowed only when the parent knowledge record is accessible through an assigned task context, and linked-target validation also succeeds.

---

## Knowledge Flow

The canonical path from raw input to curated agent memory:

```text
[external or agent-discovered source]
         │
         ▼
  research_assets row created (status = 'draft')
  ─ captured_at recorded
  ─ linked to project, tasks, or work_packets via junction tables
         │
         ▼
  task execution proceeds using research_assets as inputs
  ─ execution_logs entries record tool_call events
  ─ decisions are made referencing asset context
         │
         ▼
  outputs row created (status = 'draft')
  ─ task produces a deliverable
  ─ output linked to research_assets via output_research_assets
         │
  ┌──────┴──────┐
  │             │
internal     external delivery
  │             │
status        output requires Category A approval
→ approved    approvals row (subject_type = 'output')
  │                    │
  ▼               approved
  delivered_at         │
  set                  ▼
                  outputs.status → 'delivered'
                  delivered_at populated
                  execution_log entry (event_type = 'approval_action')
         │
         ▼
  knowledge_records row created (status = 'active')
  ─ synthesizes lessons from task + output + decisions
  ─ subject_type = 'output' or 'task' or 'project'
  ─ reusable by agents in future sessions via subject query
```

---

## Output Approval Interaction

Phase E resolves the forward reference introduced in `011_governance_layer.sql`:

```sql
-- From 011:
constraint approvals_subject_type_check
  check (subject_type in ('task', 'work_packet', 'decision', 'output'))
```

The `output` subject type was valid at the table level but blocked at the policy level: `013_phase_d_rls_policies.sql` restricts all three approval policies to `subject_type in ('task','work_packet','decision')`, preventing any authenticated user from creating or reading `output`-subject approval rows until the `outputs` table exists.

### Precondition

`013_phase_d_rls_policies.sql` (applied in Phase D) restricts all three `approvals` RLS policies (`SELECT`, `INSERT`, `UPDATE`) to `subject_type in ('task','work_packet','decision')`. This means `'output'`-subject approval rows are blocked at the policy level even though the check constraint in `011_governance_layer.sql` already accepts `'output'`. Migration `017_phase_e_approvals_adjustment.sql` exists specifically to extend these three policies and must be applied as part of Phase E — it is not optional.

### Activation steps required after Phase E tables are created

1. **New approval RLS policy migration (`017_phase_e_approvals_adjustment.sql`):** Replace the three `approvals` policies from `013` (using `DROP POLICY IF EXISTS` / `CREATE POLICY`) to extend the `subject_type in` list to include `'output'`, and add a branched EXISTS co-tenancy check for `outputs` (same pattern as the `task`/`work_packet`/`decision` branches already in `013`).
2. **No schema change required:** The `approvals` table check constraint already accepts `'output'`. No `ALTER TABLE` is needed in Phase E.
3. **Application layer gate lifted:** Once `017` is applied, the application may create `approvals` rows with `subject_type = 'output'` for Category A external delivery gates.

### Delivery gate enforcement

`approval-rules.md` Category A gates:
- Deliver Output to external requester → `approvals` row, `category='a'`, `subject_type='output'`, `approver_role='operations_lead'`
- GovCon domain submission → `approvals` row, `category='a'`, `subject_type='output'`, `approver_role='domain_owner'`

The DB does not enforce the gate automatically; the application layer must:
1. Check that an `approvals` row with `status='approved'` exists for the `output.id` before setting `outputs.status = 'delivered'`.
2. Set `outputs.delivered_at` in the same UPDATE.
3. Insert an `execution_logs` row with `event_type = 'approval_action'`.

---

## Migration Order

```
[already applied]
Phase A–D: 001 through 013

[Phase E — four new migrations]

014_knowledge_output_layer.sql
  └── CREATE TABLE public.research_assets
        depends on: organizations, projects, users
  └── CREATE TABLE public.outputs
        depends on: organizations, departments, tasks, projects, users
  └── CREATE TABLE public.knowledge_records
        depends on: organizations, projects, users
  └── CREATE TABLE public.task_research_assets
        depends on: organizations, tasks, research_assets
  └── CREATE TABLE public.work_packet_research_assets
        depends on: organizations, work_packets, research_assets
  └── CREATE TABLE public.output_research_assets
        depends on: organizations, outputs, research_assets
  └── CREATE TABLE public.knowledge_record_links
        depends on: organizations, knowledge_records
  └── enable RLS deny-by-default on all seven tables
  └── attach set_updated_at() triggers to research_assets, outputs, knowledge_records
  └── no RLS policies yet
  └── no grants yet

015_phase_e_grants.sql
  └── GRANT SELECT, INSERT, UPDATE on research_assets, outputs, knowledge_records
  └── GRANT SELECT, INSERT on task_research_assets, work_packet_research_assets, output_research_assets, knowledge_record_links
  └── REVOKE DELETE on all seven tables from authenticated

016_phase_e_rls_policies.sql
  └── CREATE policies for research_assets (SELECT, INSERT, UPDATE)
  └── CREATE policies for outputs (SELECT, INSERT, UPDATE)
  └── CREATE policies for knowledge_records (SELECT, INSERT, UPDATE)
  └── CREATE policies for junction/link tables (SELECT, INSERT)

017_phase_e_approvals_adjustment.sql
  └── DROP POLICY IF EXISTS approvals_select_department_scope on public.approvals
  └── DROP POLICY IF EXISTS approvals_insert_department_scope on public.approvals
  └── DROP POLICY IF EXISTS approvals_update_approver_scope on public.approvals
  └── CREATE updated approvals policies extending subject_type to include 'output'
        with branched EXISTS co-tenancy check for outputs.department_id
```

**Creation order within `014`:**
1. `research_assets` (depends only on Phase A/B tables)
2. `outputs` (depends on `tasks`, `departments`, `projects`)
3. `knowledge_records` (depends on `projects` and conceptually on all subject tables)
4. Research-asset junction tables in any order (all depend on their parent tables)
5. `knowledge_record_links` (depends on `knowledge_records`; secondary targets are polymorphic)

---

## Dependency Graph

```
organizations ◄──── research_assets.organization_id
                    research_assets.project_id ─────────► projects (nullable)
                    research_assets.created_by_user_id ─► users (nullable)

organizations ◄──── outputs.organization_id
                    outputs.department_id ───────────────► departments
                    outputs.task_id ─────────────────────► tasks
                    outputs.project_id ──────────────────► projects
                    outputs.created_by_user_id ──────────► users (nullable)

organizations ◄──── knowledge_records.organization_id
                    knowledge_records.project_id ────────► projects (nullable)
                    knowledge_records.created_by_user_id ► users (nullable)
                    knowledge_records.subject_id ────────► project / request / task /
                                                           work_packet / decision /
                                                           research_asset / output
                                                           (polymorphic, all same org)

task_research_assets.task_id ──────────────────────────── tasks
task_research_assets.research_asset_id ──────────────── research_assets

work_packet_research_assets.work_packet_id ────────────── work_packets
work_packet_research_assets.research_asset_id ─────────── research_assets

output_research_assets.output_id ──────────────────────── outputs
output_research_assets.research_asset_id ──────────────── research_assets

knowledge_record_links.knowledge_record_id ────────────── knowledge_records
knowledge_record_links.linked_entity_id ───────────────── project / request / task /
                                                           work_packet / decision /
                                                           research_asset / output /
                                                           execution_log
                                                           (polymorphic, all same org)

approvals.subject_id (when subject_type = 'output') ────► outputs (Phase E activates)
knowledge_records.subject_id (subject_type = 'output') ─► outputs
knowledge_records.subject_id (subject_type = 'research_asset') ─► research_assets
```

---

## Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | **`knowledge_records.subject_id` is the broadest polymorphic reference in the system** — seven valid subject types, only three of which (`project`, `task`, `decisions`) have been in the DB for more than one phase. Stale or orphaned `subject_id` values are possible if subjects are soft-deleted without cascading knowledge records | Medium | RLS INSERT co-tenancy branches verify the subject row exists and belongs to the same org. Application layer should surface stale records when `subject.deleted_at IS NOT NULL`. |
| 2 | **`outputs.department_id` must match the parent task's department** — application enforced, not DB-enforced (no check constraint can span tables). A mismatch would make an output visible in a different department than its producing task. | Medium | RLS INSERT policy verifies both `task_id` co-tenancy and `department_id` pinning. `department_id` is carried directly for RLS, routing, audit, and delivery accountability (see `department_id` note in §2 `outputs`); the cross-table invariant is application-enforced. Document the invariant in Phase E SQL migration comments. |
| 3 | **Phase E activates the approval `output` subject type** — the `014` migration creates `outputs`, but the approval policies in `013` still block `output` subjects until `017` is applied. If `014`–`016` are run without `017`, outputs will exist but cannot be approval-gated through the client path. **Confirmed precondition:** `013_phase_d_rls_policies.sql` explicitly restricts all three `approvals` policies to `subject_type in ('task','work_packet','decision')`; `017` must extend them to include `'output'`. | Medium | Always apply `014`–`017` as a complete unit. The Precondition note in the Output Approval Interaction section documents this requirement. Verify `013` policy definitions before authoring `017` DROP/CREATE statements. |
| 4 | **Junction table DELETE is not available from `authenticated`** — unlinking a task from a research asset requires a service-role operation or a `deleted_at` column added to junction tables | Low | Acceptable for Phase E. If application-layer soft-link removal is needed, add an optional `unlinked_at` timestamp column in a follow-on migration. |
| 5 | **`knowledge_records.content` is a required `text` field** — very large knowledge records (summaries of many sessions) will bloat row storage and slow down query plans | Low | Enforce a soft character limit in the application layer. Consider Supabase Storage for long-form content in a future Phase F hardening migration. |
| 6 | **`research_assets.storage_path` is not validated by the DB** — an invalid storage path cannot be detected at INSERT time | Low | Application layer validates path before INSERT. Supabase Storage policies restrict which paths are writable. |
| 7 | **`outputs.delivered_at` is application-enforced** — the DB has no trigger setting `delivered_at` when `status` transitions to `'delivered'`. If the application sets status but forgets `delivered_at`, the row is inconsistent | Low | Add a DB-level check constraint: `check ((status = 'delivered' and delivered_at is not null) or status != 'delivered')` in the Phase E SQL migration. |
| 8 | **`knowledge_record_links` SELECT and INSERT are now the heaviest Phase E policies** — each embeds the full 7-branch parent `knowledge_records` subject-scope predicate (itself the prior widest policy) *and* the 8-branch linked-target predicate, with the `research_asset` branch nesting a further 4 sub-EXISTS. No RLS recursion is present: the subject-scope and linked-target branches reference `tasks`, `projects`, `outputs`, and junction tables but never `knowledge_record_links` itself. `knowledge_records` SELECT/INSERT remain complex but are now the second heaviest policies. | Medium (performance) | All branches are covered by FK-indexed parent tables, `knowledge_records_organization_subject_idx`, and linked-entity indexes. Benchmark both `knowledge_record_links` policies before production load. Future optimization: extract parent knowledge-record visibility into a private `security definer` helper function to reduce duplication and query depth. |
| 9 | **`work_packet_research_assets` cascade deletes if work packet is hard-deleted** — `on delete cascade` on the junction means hard-deleting a work packet removes junction rows | Low | Phase D/C tables use soft-delete; hard-delete is service-role-only. Application layer should prevent hard-delete on work packets with linked knowledge layers. |
| 10 | **Phase E is not yet included in `blockers.blocked_entity_type`** — the runtime model notes project-level blockers are deferred, and `research_asset`/`output` blockers are not in the Phase D check constraint | Low | Extend `blockers.blocked_entity_type` and `knowledge_records.subject_type` blockers in a Phase F follow-on. Phase E does not need this. |
| 11 | **Department-scoped SELECT on `research_assets` and `knowledge_records` means org-wide assets are admin-only** — `research_assets` with no `project_id` and no junction-table link, and `knowledge_records` whose subject belongs to no determinable department, are visible only to `org_admin` under the Phase E policy. Users cannot discover cross-cutting knowledge without org admin privileges. | Low | Acceptable for Phase E. Org-wide cross-department knowledge surfacing is intentionally deferred to a future phase. Application layer should surface a warning when creating an unscoped research asset. |
| 12 | **`knowledge_record_links` requires both-sides validation to prevent access widening** — secondary links may point to entities outside the caller's department. `016_phase_e_rls_policies.sql` now enforces: (a) parent `knowledge_records` visibility via the same subject-scope predicate used by the parent table's own SELECT/INSERT; (b) linked-target visibility per `linked_entity_type`; (c) agent INSERT only when the parent is accessible through an assigned task. The `research_asset` linked-target branch is department/assigned-task scoped rather than org-only. | Medium (resolved in 016) | Both policies require the parent record to be visible to the caller before any linked-target check is evaluated. Neither SELECT nor INSERT returns a link row based on target visibility alone. |
