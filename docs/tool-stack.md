# Tool Stack

Planned tools, integrations, and execution boundaries for the **AI Command Center** core platform.

> **Entity definition:** [system-entities.md](system-entities.md) §11 Tool Profile  
> **Department ownership:** [department-map.md](department-map.md)  
> **Approval triggers:** [approval-rules.md](approval-rules.md)

This document describes **conceptual tool categories and boundaries**. It does not prescribe frameworks, SDKs, or database implementations.

---

## Purpose

**Tool Profiles** govern which tools agents and automations may invoke during **Task** and **Workflow** execution. This document catalogs the planned tool surface so departments can configure profiles with least-privilege access.

Every tool invocation should produce an **Execution Log** entry. Tools that perform high-risk actions may trigger **Approval** gates per [approval-rules.md](approval-rules.md).

---

## Tool Categories

### 1. Command Center Core

Internal platform operations — not external integrations.

| Tool ID | Purpose | Default access |
|---------|---------|----------------|
| `acc.request.create` | Create and triage Requests | All departments |
| `acc.task.manage` | Create, update, and close Tasks | All departments |
| `acc.work-packet.manage` | Author and update Work Packets | All departments |
| `acc.decision.record` | Record Decisions with rationale | All departments |
| `acc.blocker.manage` | Raise and resolve Blockers | All departments |
| `acc.output.publish` | Submit Outputs for review/delivery | All departments |
| `acc.execution-log.read` | Read audit trail | All departments |
| `acc.approval.request` | Request human Approval | All departments |

### 2. Research and Knowledge

Tools for capturing and querying **Research Assets**.

| Tool ID | Purpose | Approval trigger |
|---------|---------|------------------|
| `research.web.fetch` | Retrieve public web content | None (read-only) |
| `research.document.ingest` | Ingest documents into Research Assets | None |
| `research.note.create` | Create internal research notes | None |
| `research.asset.archive` | Archive stale assets | Low — log only |

### 3. Communication

External or cross-system messaging. High-risk by default.

| Tool ID | Purpose | Approval trigger |
|---------|---------|------------------|
| `comms.email.draft` | Draft email content (no send) | None |
| `comms.email.send` | Send email to external recipients | **Required** |
| `comms.slack.post` | Post to Slack channels | Department policy |
| `comms.webhook.emit` | Emit outbound webhook events | **Required** for production targets |

### 4. Code and Repository

Development and change management tools.

| Tool ID | Purpose | Approval trigger |
|---------|---------|------------------|
| `code.repo.read` | Read repository contents | None |
| `code.repo.write` | Modify files in repository | Branch policy |
| `code.repo.commit` | Create commits | **Required** for protected branches |
| `code.repo.pr.create` | Open pull requests | None (review via PR process) |
| `code.shell.exec` | Execute shell commands | **Required** for destructive or network commands |

### 5. Data and Storage

Planned persistence layer — **not implemented in Phase 0**.

| Tool ID | Purpose | Phase |
|---------|---------|-------|
| `data.store.read` | Read persisted Command Center records | APP 5+ |
| `data.store.write` | Write persisted Command Center records | APP 5+ |
| `data.store.query` | Query across entities | APP 5+ |

> Supabase and Postgres are planned runtime storage options. Schema design begins after Phase 0 review, mapped from [system-entities.md](system-entities.md). No schema exists yet.

### 6. Automation and Scheduling

Workflow orchestration and timed execution.

| Tool ID | Purpose | Approval trigger |
|---------|---------|------------------|
| `auto.workflow.run` | Start a Workflow instance | Department policy |
| `auto.workflow.pause` | Pause a running Workflow | None |
| `auto.schedule.create` | Create scheduled triggers | **Required** |
| `auto.agent.invoke` | Invoke an agent on a Task | Tool Profile scope |

### 7. External Integrations (Planned)

Third-party systems connected per department need. Specific integrations are configured at implementation time.

| Integration area | Example use | Owning department |
|------------------|-------------|-------------------|
| Project management | Sync Tasks and Blockers | Operations |
| Document storage | Research Asset sources | Research |
| CRM / ERP | Domain-specific data (GovCon, etc.) | Domain teams |
| Notification services | Alert on Approvals and Blockers | Platform |

Implementation domains (for example, GovCon) may register additional tools. Domain tools must map to a **Tool Profile** and respect core **Approval** rules.

---

## Default Tool Profiles

Profiles are owned by **Departments** ([department-map.md](department-map.md)). These defaults apply until overridden.

The canonical runtime profiles are:

| Profile slug | Display name | Primary role |
|--------------|--------------|--------------|
| `command-center-brain` | Command Center Brain | Strategic routing, planning, synthesis, governance, and cross-department orchestration |
| `execution-worker` | Execution Worker | General task execution, research capture, internal automation, and operational follow-through |
| `build-workshop` | Build Workshop | App, website, repository, deployment, and technical implementation work |
| `operations-external` | Operations External | Documentation, coordination, communication preparation, and controlled delivery |

The earlier planning names `platform-standard`, `research-readonly`, and `engineering-standard` are superseded by these runtime profiles. Historical references to those names should be interpreted as follows:

| Superseded profile | Runtime replacement |
|--------------------|---------------------|
| `platform-standard` | `command-center-brain` |
| `research-readonly` | `execution-worker` |
| `engineering-standard` | `build-workshop` |

Research work routes through `execution-worker` unless and until a dedicated research-specific profile is added.

### Profile: `command-center-brain`

Strategic reasoning and orchestration profile for Command Center planning, routing, synthesis, and governance.

| Allowed | Restricted |
|---------|------------|
| All `acc.*` core tools | External delivery requires approval |
| All `research.*` tools | Destructive actions not allowed |
| `data.store.read`, `data.store.write`, `data.store.query` | Service role use requires approval |
| `auto.workflow.run`, `auto.workflow.pause`, `auto.agent.invoke` | |
| `ai.chatgpt`, `ai.claude`, `workspace.notion`, `data.supabase` | |

### Profile: `execution-worker`

General execution profile for task work, research capture, internal automation, and operational follow-through.

| Allowed | Restricted |
|---------|------------|
| Task-oriented `acc.*` tools | External delivery requires approval |
| All `research.*` tools | Scheduled production operations require approval |
| `data.store.read`, `data.store.write` | Destructive actions not allowed |
| `auto.workflow.run`, `auto.workflow.pause`, `auto.agent.invoke` | |
| `ai.chatgpt`, `ai.claude`, `workspace.notion`, `data.supabase`, `auto.n8n` | |

### Profile: `build-workshop`

Engineering and build profile for app, website, repository, deployment, and implementation work.

| Allowed | Restricted |
|---------|------------|
| `code.repo.read`, `code.repo.write`, `code.repo.commit`, `code.repo.pr.create` | Protected branch commits require approval |
| `code.shell.exec` | Destructive shell commands require approval |
| `data.store.read`, `data.store.write`, `data.store.query` | Production data changes require approval |
| `ide.cursor`, `code.github`, `data.supabase`, `infra.vercel` | Production deployments and secret management require approval |
| `ai.claude`, `ai.openai_api` | |

### Profile: `operations-external`

Operations profile for documentation, coordination, external communication preparation, and controlled delivery.

| Allowed | Restricted |
|---------|------------|
| `acc.request.create`, `acc.task.manage`, `acc.output.publish`, `acc.approval.request` | Email send requires approval |
| `comms.email.draft`, `comms.email.send`, `comms.slack.post`, `comms.webhook.emit` | External webhooks require approval |
| `auto.workflow.run`, `auto.workflow.pause`, `auto.schedule.create` | Schedule creation requires approval |
| `workspace.notion`, `auto.n8n`, `ai.chatgpt`, `ai.claude` | Page deletion requires approval |

---

## Tool Profile Entity Mapping

When persisted (APP 5+), a Tool Profile maps to [system-entities.md](system-entities.md) §11:

| Conceptual field | Source in this doc |
|------------------|--------------------|
| `allowed_tools` | Tool IDs from categories above |
| `constraints` | Approval triggers and department policies |
| `owner_department_id` | [department-map.md](department-map.md) |

---

## Execution Logging Requirements

All tool invocations must record an **Execution Log** entry with:

- `event_type`: `tool_call`
- `actor`: human, agent, or system identifier
- `summary`: tool ID and action taken
- `context_type` / `context_id`: linked Request, Task, or Workflow

Tool calls that fail or violate **Tool Profile** constraints should set log status to `flagged` for review.

---

## Phase 0 Boundaries

This document is **planning only**:

- No tool implementations exist yet
- No MCP servers, SDKs, or frameworks are installed in this repo
- No Supabase schema or Edge Functions

Tool implementations are scoped during APP 5 and subsequent application phases, after the entity model and approval rules are validated.
