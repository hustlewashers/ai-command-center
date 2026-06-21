# Work Packet Template

Structured template for authoring a **Work Packet** — the primary handoff artifact between requesters and executors (human or agent).

> **Entity definition:** [system-entities.md](system-entities.md) §5 Work Packet  
> **When approval is required:** [approval-rules.md](approval-rules.md)  
> **Department routing:** [department-map.md](department-map.md)  
> **Available tools:** [tool-stack.md](tool-stack.md)

---

## When to Use a Work Packet

Create a Work Packet when:

- A **Request** needs to become executable **Task** work
- Scope, constraints, or acceptance criteria must be explicit before agents run
- Multiple executors (human and agent) need a shared specification
- An **Approval** gate must be satisfied before execution begins

Attach the Work Packet to a **Task** (single unit of work) or a **Project** (multi-task initiative).

---

## Template

Copy the section below and fill in every required field. Optional sections improve execution quality but may be omitted when not applicable.

---

### Work Packet

#### Identity

| Field | Value |
|-------|-------|
| **Title** | _Required. Short name for the packet._ |
| **Work Packet ID** | _Assigned on creation._ |
| **Parent type** | `task` or `project` |
| **Parent ID** | _Link to parent Task or Project._ |
| **Author** | _Human or agent who authored the packet._ |
| **Created** | _ISO 8601 timestamp._ |
| **Status** | `draft` → `ready` → `in_execution` → `accepted` |

#### Context

| Field | Value |
|-------|-------|
| **Request ID** | _Originating Request, if applicable._ |
| **Project** | _Project name and ID._ |
| **Department** | _Owning Department per [department-map.md](department-map.md)._ |
| **Priority** | `low` · `normal` · `high` · `critical` |

#### Objective

_Required. One paragraph stating the intended outcome. Must be verifiable against acceptance criteria._

> Example: Produce a comparative analysis of three integration options for the Command Center notification layer, with a recommended approach and implementation risks.

#### Scope

_Required. Explicit in-scope and out-of-scope boundaries._

**In scope:**

- _Bullet list_

**Out of scope:**

- _Bullet list_

#### Acceptance Criteria

_Required. Numbered, testable conditions for completion. Each criterion should map to a verifiable Output or Task state._

1. _Criterion 1_
2. _Criterion 2_
3. _Criterion 3_

#### Constraints

_Optional but recommended. Limits executors must respect._

| Constraint | Value |
|------------|-------|
| **Tool Profile** | _Which profile governs this work ([tool-stack.md](tool-stack.md))._ |
| **Deadline** | _If applicable._ |
| **Budget / cost ceiling** | _If applicable._ |
| **Environment** | _For example, documentation-only, staging, production._ |
| **Approval required before start** | `yes` / `no` — see [approval-rules.md](approval-rules.md) |

#### Research Assets

_Optional. Links to **Research Assets** that inform this work._

| Asset ID | Title | Source | Notes |
|----------|-------|--------|-------|
| _id_ | _title_ | _url or path_ | _relevance_ |

#### Task Breakdown

_Optional. Decompose the Work Packet into **Tasks** when multiple steps are needed._

| Task Title | Department | Depends On | Notes |
|------------|------------|------------|-------|
| _title_ | _dept_ | _task id or none_ | _notes_ |

#### Workflow Reference

_Optional. Link to a **Workflow** template or instance if orchestration is predefined._

| Field | Value |
|-------|-------|
| **Workflow ID** | _If applicable._ |
| **Workflow name** | _If applicable._ |

#### Risks and Assumptions

_Optional. Surface known risks early; unresolved items may become **Blockers**._

**Assumptions:**

- _List assumptions executors may rely on._

**Known risks:**

- _List risks that may affect delivery._

#### Approval Checklist

_Complete before moving status from `draft` to `ready`._

- [ ] Objective is clear and measurable
- [ ] Scope boundaries are explicit
- [ ] Acceptance criteria are numbered and testable
- [ ] Department assignment confirmed ([department-map.md](department-map.md))
- [ ] Tool Profile identified ([tool-stack.md](tool-stack.md))
- [ ] Approval requirements evaluated ([approval-rules.md](approval-rules.md))
- [ ] Research Assets attached or marked as not needed

---

## Status Lifecycle

Work Packet status values are defined in [system-entities.md](system-entities.md):

| Status | Meaning | Next actions |
|--------|---------|--------------|
| `draft` | Being authored | Complete template; run approval checklist |
| `ready` | Complete enough to start | Create Tasks; begin execution |
| `pending_approval` | Awaiting Approval | Approver acts per [approval-rules.md](approval-rules.md) |
| `in_execution` | Active work underway | Track Tasks, Decisions, Blockers |
| `accepted` | Acceptance criteria met | Link Outputs; close related Tasks |
| `superseded` | Replaced by newer packet | Reference replacement ID |
| `cancelled` | No longer valid | Document reason in Execution Log |

---

## Completion Checklist

Before setting status to `accepted`:

- [ ] All acceptance criteria verified
- [ ] **Outputs** linked and in `delivered` or `approved` status
- [ ] Open **Blockers** resolved or explicitly accepted (`won_t_fix`)
- [ ] Material **Decisions** recorded with rationale
- [ ] **Execution Logs** capture key actions taken

---

## Domain Extensions

Implementation domains may add optional sections (for example, GovCon contract references, compliance tags). Domain sections must not replace or rename core fields defined above. Domain attributes attach to the Work Packet entity as extensions per [system-entities.md](system-entities.md) § Cross-Entity Conventions.
