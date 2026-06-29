import Link from 'next/link'
import type { ReactNode } from 'react'
import { ds } from './styles'

// A titled section listing related records, with a graceful empty state and an
// optional "View all" link. Rows are passed as children — compose them with
// <DetailRow> and <Tag>. `empty` is computed by the caller (so RLS-hidden /
// zero-row cases render the empty label instead of crashing).
export function RelatedList({
  title, empty, emptyLabel, viewAllHref, children,
}: {
  title: string
  empty: boolean
  emptyLabel: string
  viewAllHref?: string
  children?: ReactNode
}) {
  return (
    <div style={ds.section}>
      <h2 style={ds.h2}>
        {title}
        {viewAllHref && <Link href={viewAllHref} style={ds.viewAll}>View all →</Link>}
      </h2>
      <div style={ds.list}>
        {empty ? <div style={ds.empty}>{emptyLabel}</div> : children}
      </div>
    </div>
  )
}

// One row inside a RelatedList (or any list section).
export function DetailRow({ children }: { children: ReactNode }) {
  return <div style={ds.rowItem}>{children}</div>
}

// Small neutral tag/pill for inline labels (type, category, severity, …).
export function Tag({ children }: { children: ReactNode }) {
  return <code style={ds.tag}>{children}</code>
}
