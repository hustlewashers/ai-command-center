# Phase B — Design Addendum

Resolves the two open design questions identified in [phase-b-system-intelligence-migration-plan.md](phase-b-system-intelligence-migration-plan.md) before SQL authoring begins.

> **Resolves:** Phase B risks R1 (tool ID validation) and R2 (`definition` jsonb contract)  
> **Source:** [tool-stack.md](tool-stack.md) · [system-entities.md](system-entities.md) · [supabase-runtime-data-model.md](supabase-runtime-data-model.md) · [work-packet-template.md](work-packet-template.md)

This document is **design specification only**. It does not contain SQL, migrations, or application code.

---

## Open Questions Resolved

| Risk | Question | Resolved in |
|------|----------|-------------|
| R1 | What are the canonical allowed tool IDs for the initial stack? | §1 Tool ID Registry |
| R2 | What is the minimum valid shape of `workflows.definition`? | §2 Workflow Definition Contract |

---

## 1. Tool ID Registry

### Namespace Convention

All tool IDs follow the pattern established in [tool-stack.md](tool-stack.md):

```
{category}.{service_or_operation}[.{action}]
```

The existing `tool-stack.md` IDs (`acc.*`, `research.*`, `comms.*`, `code.*`, `data.*`, `auto.*`) define **abstract operation categories** available to all departments. The IDs below define **concrete service integrations** for the initial AI Command Center stack. They are stored as strings in `tool_profiles.allowed_tools` and validated at the application layer.

When a concrete service integration maps to an existing abstract category, both IDs apply. For example, `code.github.read` is a concrete implementation of the abstract `code.repo.read` operation.

---

### Tool ID Catalog

#### `ai.chatgpt`

| Field | Value |
|-------|-------|
| **Tool ID** | `ai.chatgpt` |
| **Display name** | ChatGPT (OpenAI) |
| **Category** | AI / LLM |
| **Role** | Language model for drafting, summarization, classification, and conversational reasoning |
| **Allowed use cases** | Draft outputs and summaries; classify and route requests; answer questions against provided context; generate work packet content; support decision rationale writing |
| **Restricted use cases** | Must not be invoked with raw PII, client credentials, or proprietary contract data without an approved data handling policy |
| **Approval limit** | Category C (no approval) for internal drafting; Category B if output is delivered externally without human review |
| **Maps to abstract IDs** | None (AI inference; not a repo or comms operation) |

---

#### `ai.claude`

| Field | Value |
|-------|-------|
| **Tool ID** | `ai.claude` |
| **Display name** | Claude (Anthropic) |
| **Category** | AI / LLM |
| **Role** | Language model for long-context reasoning, document analysis, structured output generation, and complex task decomposition |
| **Allowed use cases** | Analyze research assets; decompose work packets into tasks; synthesize knowledge records; review and critique outputs; author approval rationales |
| **Restricted use cases** | Same data handling restrictions as `ai.chatgpt`; do not pass full database contents or user PII |
| **Approval limit** | Category C for internal use; Category B if producing externally delivered outputs without review |
| **Maps to abstract IDs** | None |

---

#### `ai.openai_api`

| Field | Value |
|-------|-------|
| **Tool ID** | `ai.openai_api` |
| **Display name** | OpenAI API (Direct) |
| **Category** | AI / LLM API |
| **Role** | Direct programmatic access to OpenAI models (GPT-4, embeddings, function calling) via API key; higher capability and lower latency than chat UI |
| **Allowed use cases** | Generate embeddings for knowledge record search; structured JSON output via function calling; batch processing of research assets; automated content classification |
| **Restricted use cases** | API calls that incur > $5 spend in a single invocation require Category B approval; production function calls that mutate external systems require Category A |
| **Approval limit** | Category C for read/generate; Category B for spend thresholds; Category A for external mutations |
| **Maps to abstract IDs** | None |

---

#### `ide.cursor`

| Field | Value |
|-------|-------|
| **Tool ID** | `ide.cursor` |
| **Display name** | Cursor (AI IDE) |
| **Category** | IDE / Code Assistant |
| **Role** | AI-powered IDE for code generation, review, refactoring, and agent-driven repository work; the primary authoring environment for Engineering tasks |
| **Allowed use cases** | Generate, edit, and review code within project repositories; run agent sessions against scoped tasks; create pull requests via embedded workflow |
| **Restricted use cases** | Agent sessions in Cursor may not commit to protected branches without Engineering lead approval; must not connect to production databases without explicit Task scope |
| **Approval limit** | Category C for read and draft; Category B for commits to non-protected branches; Category A for protected branch commits (mirrors `code.repo.commit` rule) |
| **Maps to abstract IDs** | `code.repo.read`, `code.repo.write`, `code.repo.commit`, `code.repo.pr.create` |

---

#### `workspace.notion`

| Field | Value |
|-------|-------|
| **Tool ID** | `workspace.notion` |
| **Display name** | Notion |
| **Category** | Workspace / Knowledge |
| **Role** | Primary knowledge base and project documentation surface; source of Research Assets, meeting notes, SOPs, and department wikis |
| **Allowed use cases** | Read pages and databases for Research Asset ingestion; write task notes, meeting summaries, and knowledge records; sync project status; create work packet drafts |
| **Restricted use cases** | Writing to shared public Notion spaces requires Operations lead review; deleting pages requires Category A approval |
| **Approval limit** | Category C for read and internal write; Category B for shared space writes; Category A for deletions |
| **Maps to abstract IDs** | `research.document.ingest` (read path); `research.note.create` (write path) |

---

#### `data.supabase`

| Field | Value |
|-------|-------|
| **Tool ID** | `data.supabase` |
| **Display name** | Supabase |
| **Category** | Data / Storage |
| **Role** | Primary runtime database and storage layer for the Command Center; source of truth for all entity rows |
| **Allowed use cases** | Query entity tables within RLS scope; insert execution logs and knowledge records; read project and task context for agent sessions; access Supabase Storage for research asset binaries |
| **Restricted use cases** | Schema migrations require Engineering lead approval and documented migration plan; bulk deletes are Category A; service role key usage is Category A |
| **Approval limit** | Category C for reads within RLS; Category B for writes outside task scope; Category A for schema changes, bulk deletes, service role use |
| **Maps to abstract IDs** | `data.store.read`, `data.store.write`, `data.store.query` |

---

#### `auto.n8n`

| Field | Value |
|-------|-------|
| **Tool ID** | `auto.n8n` |
| **Display name** | n8n |
| **Category** | Automation / Workflow |
| **Role** | Low-code automation platform for connecting external services, triggering workflows from external events, and executing scheduled background operations |
| **Allowed use cases** | Trigger Command Center requests from external webhooks; automate research asset ingestion pipelines; send notifications on approval and blocker events; schedule recurring operational tasks |
| **Restricted use cases** | n8n workflows that emit outbound messages to external parties are Category A; workflows that write to production databases require Engineering lead approval |
| **Approval limit** | Category C for internal triggers and reads; Category B for scheduled production operations; Category A for external message emission |
| **Maps to abstract IDs** | `auto.workflow.run`, `auto.schedule.create`, `comms.webhook.emit` |

---

#### `infra.vercel`

| Field | Value |
|-------|-------|
| **Tool ID** | `infra.vercel` |
| **Display name** | Vercel |
| **Category** | Infrastructure / Deployment |
| **Role** | Frontend and serverless deployment platform; hosts the Command Center application layer and any domain-specific web surfaces |
| **Allowed use cases** | Deploy preview builds from pull requests; promote builds from staging to production; manage environment variables for application config; trigger deployment hooks from CI |
| **Restricted use cases** | Production deployments require Engineering lead approval; environment variable updates containing secrets are Category A; rollbacks to previous production deploys are Category B |
| **Approval limit** | Category C for preview deployments; Category B for production promotions and rollbacks; Category A for secret management |
| **Maps to abstract IDs** | None (deployment; no existing abstract category) |

---

#### `code.github`

| Field | Value |
|-------|-------|
| **Tool ID** | `code.github` |
| **Display name** | GitHub |
| **Category** | Code / Version Control |
| **Role** | Source code host; issue and PR tracker; CI/CD trigger point; primary code collaboration surface for Engineering |
| **Allowed use cases** | Read repository contents and history; create branches and commits; open pull requests; read and post issue comments; trigger GitHub Actions workflows |
| **Restricted use cases** | Force pushes to protected branches are Category A; merging to `main` without passing CI is Category A; repository settings changes require Platform lead approval |
| **Approval limit** | Category C for reads, branch creation, PR creation; Category B for merges to non-protected branches; Category A for protected branch merges and force pushes |
| **Maps to abstract IDs** | `code.repo.read`, `code.repo.write`, `code.repo.commit`, `code.repo.pr.create` |

---

### Tool ID Master List

The full canonical tool ID set that may appear in `tool_profiles.allowed_tools`:

**Existing abstract IDs from [tool-stack.md](tool-stack.md):**

```
acc.request.create
acc.task.manage
acc.work-packet.manage
acc.decision.record
acc.blocker.manage
acc.output.publish
acc.execution-log.read
acc.approval.request
research.web.fetch
research.document.ingest
research.note.create
research.asset.archive
comms.email.draft
comms.email.send
comms.slack.post
comms.webhook.emit
code.repo.read
code.repo.write
code.repo.commit
code.repo.pr.create
code.shell.exec
data.store.read
data.store.write
data.store.query
auto.workflow.run
auto.workflow.pause
auto.schedule.create
auto.agent.invoke
```

**New concrete service IDs (this document):**

```
ai.chatgpt
ai.claude
ai.openai_api
ide.cursor
workspace.notion
data.supabase
auto.n8n
infra.vercel
code.github
```

Any `allowed_tools` value that is not on this combined list is **invalid** and must be rejected at the application layer on insert or update of a `tool_profiles` row.

---

### Profile → Tool ID Assignments

Updated assignments for the four seeded profiles, adding concrete service IDs:

| Profile | Concrete service IDs added |
|---------|---------------------------|
| `platform-standard` | `ai.chatgpt`, `ai.claude`, `workspace.notion`, `data.supabase` |
| `research-readonly` | `ai.chatgpt`, `ai.claude`, `ai.openai_api`, `workspace.notion` |
| `engineering-standard` | `ide.cursor`, `code.github`, `data.supabase`, `infra.vercel` (preview only) |
| `operations-external` | `workspace.notion`, `auto.n8n` (internal triggers only) |

The abstract IDs from Phase B seeding remain unchanged. Concrete IDs are additive.

---

## 2. Workflow Definition Contract

### Purpose

This section defines the minimum valid shape for the `workflows.definition` jsonb field. All workflow rows — whether templates or instances — must conform to this contract. The contract is validated at the application layer on insert and update.

This is **version 1.0** of the contract. The `version` field inside `definition` must match the version the application layer knows how to parse. Incompatible versions must be rejected.

---

### Top-Level Shape

```json
{
  "version": "1.0",
  "name": "string (required)",
  "trigger": { ... },
  "steps": [ ... ],
  "required_inputs": [ ... ],
  "expected_outputs": [ ... ],
  "approval_gates": [ ... ],
  "failure_handling": "string (required)"
}
```

---

### Field Reference

#### `version` — required, string

Contract version identifier. Must be `"1.0"` for this release. The application layer rejects definitions with unknown or missing versions.

---

#### `name` — required, string

Human-readable name for the workflow definition. Must be non-empty. Should match or derive from `workflows.name` (the database column) but is stored redundantly inside `definition` so the shape is self-describing.

---

#### `trigger` — required, object

Defines what starts the workflow.

```json
{
  "type": "manual | request | schedule | webhook",
  "conditions": { }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | string enum | Yes | One of: `manual`, `request`, `schedule`, `webhook` |
| `conditions` | object | No | Type-specific matching rules; empty object `{}` is valid |

**Trigger types:**

| Type | Meaning |
|------|---------|
| `manual` | Started by a human or agent explicitly via `auto.workflow.run` |
| `request` | Started automatically when a new `requests` row matches routing criteria |
| `schedule` | Started on a recurring schedule; requires Category A approval per [approval-rules.md](approval-rules.md) |
| `webhook` | Started by an inbound webhook; requires Category B approval before enabling in production |

---

#### `steps` — required, array, minimum 1 item

Ordered array of step definitions. Steps execute sequentially by default. Branching is controlled by `on_success` and `on_failure`.

```json
[
  {
    "id": "string (required, unique within definition)",
    "name": "string (required)",
    "type": "string (required)",
    "tool_id": "string (optional)",
    "assigned_department": "string (optional, department slug)",
    "inputs": { },
    "outputs": { },
    "on_success": "string (step id or 'end')",
    "on_failure": "string (step id, 'fail', 'retry', or 'escalate')"
  }
]
```

**Step field reference:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | Yes | Unique within this definition; used as FK target for `on_success`/`on_failure` |
| `name` | string | Yes | Human-readable step label |
| `type` | string enum | Yes | See step types below |
| `tool_id` | string | Conditional | Required for `type: tool_call`; must be a valid tool ID from §1 master list |
| `assigned_department` | string | No | Department slug from [department-map.md](department-map.md); defaults to workflow's `department_id` |
| `inputs` | object | No | Expected input keys this step consumes; empty object `{}` is valid |
| `outputs` | object | No | Expected output keys this step produces; empty object `{}` is valid |
| `on_success` | string | Yes | Step `id` to proceed to on success, or `"end"` to complete the workflow |
| `on_failure` | string | Yes | Step `id` to jump to on failure, or `"fail"`, `"retry"` (max 3 attempts), or `"escalate"` (raises a Blocker) |

**Step types:**

| Type | Meaning | `tool_id` required |
|------|---------|-------------------|
| `task` | Creates a Command Center Task entity and waits for completion | No |
| `approval` | Creates an Approval entity; pauses until `approved` or `rejected` | No |
| `decision` | Records a Decision entity; may branch on outcome | No |
| `tool_call` | Invokes a specific tool from the Tool Profile | Yes |
| `branch` | Conditional routing based on prior step output; no action taken | No |
| `notify` | Sends an internal notification (does not use `comms.*` send tools) | No |

---

#### `required_inputs` — optional, array

Declares the input keys the workflow expects to receive when triggered. Items are strings naming the input keys.

```json
["request_id", "project_id", "department_slug"]
```

An empty array `[]` is valid (no required inputs). If `trigger.type` is `request`, `request_id` should be listed here.

---

#### `expected_outputs` — optional, array

Declares the output keys the workflow is expected to produce on successful completion. Items are strings.

```json
["output_id", "knowledge_record_id"]
```

An empty array `[]` is valid. If the workflow produces a deliverable, `output_id` should be listed.

---

#### `approval_gates` — optional, array

Explicit list of step IDs where an Approval entity is required before the step executes. Steps of `type: approval` implicitly create a gate; this array allows non-approval steps to be gated when the definition warrants it.

```json
["step_deliver_output", "step_send_email"]
```

An empty array `[]` is valid. Must not conflict with [approval-rules.md](approval-rules.md) Category A requirements — those are enforced at the application layer regardless of this list.

---

#### `failure_handling` — required, string

Top-level fallback behavior when a step's `on_failure` value of `"fail"` is reached and no step-level recovery exists.

| Value | Behavior |
|-------|---------|
| `"stop"` | Workflow moves to `failed` status; no further action |
| `"escalate"` | Workflow moves to `paused` status; a Blocker entity is created on the parent project |
| `"notify"` | Workflow moves to `failed`; a notification is sent to the department lead |

---

### Template vs Instance Behavior

#### Templates (`kind = 'template'`)

| Rule | Value |
|------|-------|
| `definition.version` | Must be present and valid |
| `project_id` on `workflows` row | Must be `null` |
| `template_id` on `workflows` row | Must be `null` |
| `steps` | Must have at least one step |
| `trigger.type` | Any value is valid |
| Status | Starts as `draft`; published as `active` |
| Mutability | May be updated while `draft`; immutable while `active` (create a new version instead) |
| Instance creation | Application copies `definition` from template into the new instance row; instance may override `assigned_department` per step |

#### Instances (`kind = 'instance'`)

| Rule | Value |
|------|-------|
| `project_id` on `workflows` row | **Required** |
| `template_id` on `workflows` row | Recommended; null permitted for manually authored instances |
| `definition` | Copied from template at creation; instance-specific overrides allowed (must not add new step types) |
| Status lifecycle | `draft` → `active` → `paused` ↔ `active` → `completed` \| `failed` → `archived` |
| Mutability | `steps[*].inputs` and `steps[*].outputs` may be updated while `active`; step structure is immutable after `active` |

---

### Valid Template Example — `request-to-output`

```json
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
      "assigned_department": "operations",
      "inputs": { "request_id": "string" },
      "outputs": { "routed_department": "string", "project_id": "string" },
      "on_success": "author_work_packet",
      "on_failure": "escalate_triage"
    },
    {
      "id": "author_work_packet",
      "name": "Author Work Packet",
      "type": "task",
      "assigned_department": "platform",
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
      "assigned_department": "operations",
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
      "assigned_department": "operations",
      "inputs": { "output_id": "string" },
      "outputs": { "delivered_at": "string" },
      "on_success": "end",
      "on_failure": "escalate_triage"
    },
    {
      "id": "escalate_triage",
      "name": "Escalate to Platform",
      "type": "notify",
      "assigned_department": "platform",
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
```

---

### Valid Template Example — `research-and-synthesize`

```json
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
```

---

### Invalid Examples

The following `definition` objects are invalid. The application layer must reject them on insert or update.

**Invalid: missing `version`**

```json
{
  "name": "Bad Workflow",
  "trigger": { "type": "manual", "conditions": {} },
  "steps": [],
  "failure_handling": "stop"
}
```

Reason: `version` is required. `steps` is also an empty array, which violates the minimum one-step rule.

---

**Invalid: step `id` not unique**

```json
{
  "version": "1.0",
  "name": "Duplicate Step IDs",
  "trigger": { "type": "manual", "conditions": {} },
  "steps": [
    { "id": "step_1", "name": "First", "type": "task", "inputs": {}, "outputs": {}, "on_success": "end", "on_failure": "fail" },
    { "id": "step_1", "name": "Duplicate", "type": "task", "inputs": {}, "outputs": {}, "on_success": "end", "on_failure": "fail" }
  ],
  "failure_handling": "stop"
}
```

Reason: Step `id` values must be unique within a `definition`.

---

**Invalid: `on_success` references unknown step**

```json
{
  "version": "1.0",
  "name": "Broken Reference",
  "trigger": { "type": "manual", "conditions": {} },
  "steps": [
    { "id": "step_1", "name": "Only Step", "type": "task", "inputs": {}, "outputs": {}, "on_success": "step_2", "on_failure": "fail" }
  ],
  "failure_handling": "stop"
}
```

Reason: `on_success` references `"step_2"` which does not exist. All `on_success` and `on_failure` values must resolve to either a valid step `id` in the same `steps` array, or one of the terminal strings: `"end"`, `"fail"`, `"retry"`, `"escalate"`.

---

**Invalid: `type: tool_call` without `tool_id`**

```json
{
  "version": "1.0",
  "name": "Missing Tool ID",
  "trigger": { "type": "manual", "conditions": {} },
  "steps": [
    { "id": "step_1", "name": "Call Something", "type": "tool_call", "inputs": {}, "outputs": {}, "on_success": "end", "on_failure": "fail" }
  ],
  "failure_handling": "stop"
}
```

Reason: `type: tool_call` requires `tool_id`. The value must appear in the canonical tool ID list from §1.

---

**Invalid: `tool_id` not in canonical list**

```json
{
  "version": "1.0",
  "name": "Unknown Tool",
  "trigger": { "type": "manual", "conditions": {} },
  "steps": [
    { "id": "step_1", "name": "Bad Tool", "type": "tool_call", "tool_id": "custom.made.up", "inputs": {}, "outputs": {}, "on_success": "end", "on_failure": "fail" }
  ],
  "failure_handling": "stop"
}
```

Reason: `"custom.made.up"` is not in the §1 canonical tool ID list. The application layer must reject any `tool_id` not on the master list.

---

**Invalid: instance with null `project_id`**

A `workflows` row with `kind = 'instance'` and `project_id = null` violates the constraint defined in Phase B Plan R5. This is not a `definition` error — it is a row-level error enforced by a check constraint (or application layer check):

```
kind = 'instance' AND project_id IS NULL → reject
```

---

### Validation Checklist for `definition` on Insert/Update

The application layer must enforce these rules before writing a `workflows` row:

- [ ] `definition.version` is present and equals `"1.0"`
- [ ] `definition.name` is a non-empty string
- [ ] `definition.trigger.type` is one of: `manual`, `request`, `schedule`, `webhook`
- [ ] `definition.steps` is an array with at least one item
- [ ] All step `id` values are unique within `definition.steps`
- [ ] All `on_success` values resolve to a valid step `id` or terminal string
- [ ] All `on_failure` values resolve to a valid step `id` or terminal string
- [ ] Every step with `type: tool_call` has a `tool_id` field
- [ ] Every `tool_id` value appears in the canonical tool ID list (§1 master list)
- [ ] `definition.failure_handling` is one of: `stop`, `escalate`, `notify`
- [ ] If `kind = 'instance'`, the `workflows` row has a non-null `project_id`

---

## Impact on Phase B Migration Plan

This addendum closes both open risks in [phase-b-system-intelligence-migration-plan.md](phase-b-system-intelligence-migration-plan.md):

| Risk | Status | Resolution |
|------|--------|------------|
| R1 — `allowed_tools` schema enforcement | **Resolved** | §1 provides the canonical tool ID master list; application layer validates against it on `tool_profiles` insert/update |
| R2 — `workflows.definition` unstructured | **Resolved** | §2 defines the v1.0 contract; application layer validates using the checklist above |

**Updates required to Phase B seed data** (no schema changes, data values only):

1. Seeded `tool_profiles` must include the concrete service IDs from §1 Profile → Tool ID Assignments.
2. Seeded workflow templates must use the valid `definition` jsonb shapes from §2 Valid Template Examples.

No modifications to `phase-b-system-intelligence-migration-plan.md` are required — this addendum is the authoritative supplement.
