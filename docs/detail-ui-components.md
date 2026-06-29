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

## Refactor status & plan

**Refactored to shared components (Sprint 5.15):**
- `app/tasks/[id]/page.tsx`
- `app/work-packets/[id]/page.tsx`
- `app/approvals/[id]/page.tsx` (optional page; kept the bespoke Subject box + `ApprovalActions`)

**Not yet refactored (still use local inline scaffolding — identical output):**
- `app/requests/[id]/page.tsx`
- `app/outputs/[id]/page.tsx`
- `app/decisions/[id]/page.tsx`
- `app/blockers/[id]/page.tsx`
- `app/projects/[id]/page.tsx`
- `app/workflow-runs/[id]/page.tsx`

**Future plan:** migrate the remaining pages one at a time, verifying each renders
identically (typecheck + lint + a route smoke test) before moving on. Pages with
bespoke sections (e.g. workflow-runs step timeline, request recovery panel) keep those
sections inline and adopt only `EntityHeader` + `MetaGrid` + `RelatedList`. The goal is
prove-then-spread, not a big-bang rewrite.
