# AI Command Center

The **AI Command Center** is a domain-agnostic platform for routing requests, orchestrating work across departments, enforcing approvals, and producing auditable outputs through human and agent collaboration.

GovCon, property operations, and other verticals are **implementation domains** that extend the core model — they are not the platform itself.

## Phase 0 — Operating Structure (Current)

Phase 0 establishes shared vocabulary, operating rules, and documentation before any runtime implementation.

```
Entities → Departments → Approvals → Work Packets → (then) Runtime
```

Jumping to database tables or application code before this foundation is complete will require redesign later.

### Phase 0 Deliverables

| File | Status |
|------|--------|
| `.cursor/rules/acc-core.mdc` | Persistent agent operating rules |
| `docs/system-entities.md` | Canonical entity model |
| `docs/system-overview.md` | Platform overview and operating flow |
| `docs/work-packet-template.md` | Work Packet authoring template |
| `docs/tool-stack.md` | Planned tool and integration boundaries |
| `docs/department-map.md` | Department responsibilities |
| `docs/approval-rules.md` | Approval gates and policies |

**Phase 0 is complete** when all files above exist and have been reviewed.

## Documentation Index

Start here based on your goal:

| Goal | Read |
|------|------|
| Understand what the platform does | [docs/system-overview.md](docs/system-overview.md) |
| Look up entity definitions | [docs/system-entities.md](docs/system-entities.md) |
| Author a unit of work | [docs/work-packet-template.md](docs/work-packet-template.md) |
| Route work to the right team | [docs/department-map.md](docs/department-map.md) |
| Determine if approval is required | [docs/approval-rules.md](docs/approval-rules.md) |
| See planned tools and integrations | [docs/tool-stack.md](docs/tool-stack.md) |

## Core Entities (Summary)

The full model is defined in [docs/system-entities.md](docs/system-entities.md). The fourteen canonical entities are:

Request · Project · Department · Task · Work Packet · Decision · Approval · Research Asset · Output · Workflow · Tool Profile · Execution Log · Blocker · Knowledge Record

## Operating Flow (Summary)

```text
Request
  → triage to Department
  → assign to Project
  → define Work Packet
  → execute Task(s) under Tool Profile
  → record Decisions and Execution Logs
  → pass Approval gates where required
  → deliver Output
```

See [docs/system-overview.md](docs/system-overview.md) for the full flow.

## What This Repo Does Not Contain (Yet)

- Application code or frameworks
- Supabase schema or migrations
- Domain-specific implementations (for example, GovCon product modules)

These begin after Phase 0 review, starting with **APP 5 — Supabase Setup Validation** and runtime data model design.

## Agent Rules

Agents working in this repository must follow [.cursor/rules/acc-core.mdc](.cursor/rules/acc-core.mdc).
