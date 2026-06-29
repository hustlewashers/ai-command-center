import type { ReactNode } from 'react'
import { ds } from './styles'

// A responsive label/value grid for an entity's fields. Each item is a
// label + value (any ReactNode — text, <code>, links, badges). `full: true`
// spans the whole row (for long values like objective/summary/error).
//
// Link safety, date formatting, and empty values are the caller's concern —
// pass an already-rendered value (e.g. lib/ui/format helpers or a <Link>).
export interface MetaItem {
  label: string
  value: ReactNode
  full?: boolean
}

export function MetaGrid({ items }: { items: MetaItem[] }) {
  return (
    <div style={ds.grid}>
      {items.map((it, i) => (
        <div key={i} style={it.full ? { gridColumn: '1 / -1' } : undefined}>
          <div style={ds.label}>{it.label}</div>
          <div style={it.full ? { ...ds.val, wordBreak: 'break-word' } : ds.val}>{it.value}</div>
        </div>
      ))}
    </div>
  )
}
