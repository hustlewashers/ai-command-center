# Detail UI Components (Sprint 5.15)

Shared, presentational building blocks for entity **detail pages** (`app/*/[id]/page.tsx`).
They lift the inline scaffolding that every detail page had been re-declaring
(header, field grid, related-record lists, JSON preview, trace pills, and the
`fmt`/`durationStr`/`short` formatters) into one place.

- **UI infrastructure only.** No data fetching, no RLS, no API, no state machines.
- **Server-safe.** None use client hooks, so they render inside Server Components.
- **Behavior-preserving.** Styles match the previous inline `s` objects exactly, so
  refactoring a page changes structure, not appearance.

Location:
- `components/detail/` — components + shared `styles.ts` (`ds`) + barrel `index.ts`
- `lib/ui/format.ts` — pure formatters

Import from the barrel:

```ts
import { EntityHeader, MetaGrid, RelatedList, DetailRow, Tag, JsonPreview, TraceLink, TraceLinks, ds } from '@/components/detail'
import type { MetaItem, TraceType } from '@/components/detail'
import { formatDate, formatDuration, formatMs, shortId, safeText, jsonPreview } from '@/lib/ui/format'
```

---

## Components

### `EntityHeader`
Top-of-page header: back link, title, optional subtitle/actions, right-aligned
status badge, and an optional right slot (typically the viewer role).

Props:
| prop | type | notes |
|---|---|---|
| `title` | `string` | page heading |
| `backHref` | `string` | back-link target |
| `backLabel` | `string` | e.g. `"← Tasks"` |
| `subtitle?` | `ReactNode` | optional muted text after the title |
| `status?` | `string \| null` | rendered as a `StatusBadge`, pushed right |
| `right?` | `ReactNode` | far-right text (e.g. `context.role`) |
| `actions?` | `ReactNode` | optional slot for buttons/links |

### `MetaGrid`
Responsive label/value grid for an entity's own fields.

Props: `items: MetaItem[]` where `MetaItem = { label: string; value: ReactNode; full?: boolean }`.
- `value` is **pre-rendered** by the caller — pass text, `<code>`, a `<Link>`, a `StatusBadge`, etc.
- `full: true` spans the whole row (use for long values: objective, summary, trigger reason, error).
- Date formatting / link safety / empty fallbacks are the caller's job (use the helpers below).

### `RelatedList` + `DetailRow` + `Tag`
A titled section listing related records with a graceful empty state and an
optional `viewAllHref`.

`RelatedList` props:
| prop | type | notes |
|---|---|---|
| `title` | `string` | usually `` `Outputs (${n})` `` |
| `empty` | `boolean` | caller computes (e.g. `rows.length === 0` or `!row`) |
| `emptyLabel` | `string` | shown when `empty` is true |
| `viewAllHref?` | `string` | optional "View all →" link |
| `children` | rows | compose with `DetailRow` |

- `DetailRow` — one flex row; put a `<Link>`, `<span style={ds.dim}>`, `<Tag>`, `<StatusBadge>` inside.
- `Tag` — small neutral `<code>` pill for type/category/severity labels.

### `JsonPreview`
Pretty-printed, length-capped JSON with a safe fallback.

Props: `{ value: unknown; max?: number (default 600); emptyLabel?: string (default "—") }`.
`null`/`undefined`/unstringifiable → renders `emptyLabel`, never throws.

### `TraceLink` / `TraceLinks`
Standard linked **pills** for navigating the execution trace.

- `TraceType`: `request | task | work_packet | output | decision | blocker | approval | project | workflow_run | background_job`.
- `TraceLink({ type, id, label? })` renders a pill to the entity's **detail** route,
  e.g. `/tasks/[id]`. Returns `null` when `id` is not a non-empty string.
- `background_job` has **no detail page** → it links to the list route `/background-jobs`
  (appending an id would 404). This is the one list-only exception, encoded in the component.
- `TraceLinks({ links })` renders a row of pills and nothing if all ids are absent.

### `ds` (shared styles)
The `Record<string, CSSProperties>` used by all the above (`page`, `section`, `h2`,
`grid`, `label`, `val`, `link`, `list`, `rowItem`, `dim`, `tag`, `empty`, `pre`,
`pill`, `viewAll`). Pages use `ds.page`, `ds.section`, `ds.h2`, `ds.link`, `ds.dim`
directly for the few wrapper elements the components don't own.

---

## Helpers — `lib/ui/format.ts`

| fn | signature | behavior |
|---|---|---|
| `formatDate` | `(iso) => string` | compact local datetime; `null` → `—` |
| `formatMs` | `(ms) => string` | `ms` / `s` / `m`; `null` → `—` |
| `formatDuration` | `(start, end) => string` | duration between two ISO times; either missing → `—` |
| `shortId` | `(uuid, len=8) => string` | `"dcd5469c…"`; `null` → `—` |
| `safeText` | `(value, max?) => string` | coalesce to string + optional truncate; never throws |
| `jsonPreview` | `(value, max=600) => string` | pretty JSON, capped; `null`/`undefined` → `""` |

Pure, dependency-free.

---

## Link safety rules

- **Only render a link when the id is a usable string.** `TraceLink` enforces this;
  in `MetaGrid`/`RelatedList`, the caller guards (e.g. `id ? <Link/> : <span style={ds.dim}>—</span>`).
- **Never fabricate a detail route.** Entities without a `[id]` page link to their list
  page (currently only `background_job`). Approvals link to `/approvals/[id]` (exists since 5.14).
- **RLS-hidden subjects/relations** must resolve to an empty state or a non-link label
  (e.g. approval detail shows "Subject not visible" when the subject row isn't returned),
  never a link the viewer can't follow.

## RLS / empty-state expectations

- Related queries are **independent and non-fatal**: an RLS-hidden related row simply
  doesn't appear; `RelatedList` shows `emptyLabel`.
- **JSONB path filters** (`accumulated->>x_id`, `metadata->>x_id`) are wrapped so a filter
  error yields an empty array, never a 500.
- The page's own fetch uses `maybeSingle()` → `notFound()` on miss (404 with a session).

---

## Refactor status

**All detail pages now use the shared components.**

| Page | Migrated | Notes |
|---|---|---|
| `app/tasks/[id]` | 5.15 | |
| `app/work-packets/[id]` | 5.15 | |
| `app/approvals/[id]` | 5.15 | bespoke Subject box + `ApprovalActions` kept |
| `app/decisions/[id]` | 5.16 | |
| `app/blockers/[id]` | 5.16 | |
| `app/outputs/[id]` | 5.16 | plain-text content uses `<pre style={ds.pre}>` (not `JsonPreview` — content isn't JSON) |
| `app/projects/[id]` | 5.16 | |
| `app/requests/[id]` | 5.16 | kept page-specific workflow badge, `deriveAction`, Recovery-History table; preserved `RequestWorkflowActions` / `RequestWorkflowRecovery` |
| `app/workflow-runs/[id]` | 5.16 | most complex — see below |

## Guidance for complex diagnostic pages (e.g. Workflow Run detail)

Some pages legitimately keep bespoke parts. Rules of thumb from the 5.16 migration:

- **Wide pages:** keep their own `maxWidth` by spreading `ds.page` and overriding,
  e.g. `style={{ ...ds.page, maxWidth: 1200 }}`. Don't force every page to 1000.
- **Custom-colored status pills** (workflow/run status) are page-specific — pass them
  to `EntityHeader`'s `actions` slot (raw, no wrapper) rather than the `status` prop,
  which renders the neutral `StatusBadge`.
- **Multi-column diagnostic tables** (step timeline, execution logs, recovery-history
  lineage) do **not** fit `RelatedList` — keep them as bespoke `<table>`s with local
  styles. Do not over-abstract them.
- **Timing precision:** the shared `formatDate` omits seconds. Pages that need
  second-level precision keep a local formatter (workflow-run detail does). Use
  `formatMs` for `duration_ms` columns.
- **JSON cells:** the `JsonPreview` component uses `ds.pre` (taller). For compact
  in-table cells, keep a local `<pre>` and reuse the `jsonPreview` **helper** from
  `lib/ui/format` for the string. Reserve the `JsonPreview` **component** for
  standalone JSON blocks.
- **Trace pills:** use `TraceLinks` for "linked entity" rows. Note all pills render in
  the same blue `ds.pill` style (the previous per-type colors are normalized).
- **Page-specific helpers** that are genuinely not shared (e.g. `deriveAction`,
  colored-pill builders, local table styles) stay co-located with the page.
