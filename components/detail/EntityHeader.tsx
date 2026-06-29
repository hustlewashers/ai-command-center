import Link from 'next/link'
import type { ReactNode } from 'react'
import { StatusBadge } from '@/components/ui'
import { ds } from './styles'

// Standard detail-page header: back link, title, optional subtitle/actions, a
// right-aligned status badge, and an optional right slot (e.g. the viewer role).
// Server-safe (no client hooks).
export interface EntityHeaderProps {
  title: string
  backHref: string
  backLabel: string
  subtitle?: ReactNode
  status?: string | null
  right?: ReactNode
  actions?: ReactNode
}

export function EntityHeader({
  title, backHref, backLabel, subtitle, status, right, actions,
}: EntityHeaderProps) {
  return (
    <div style={ds.header}>
      <Link href={backHref} style={ds.back}>{backLabel}</Link>
      <h1 style={ds.h1}>{title}</h1>
      {subtitle != null && <span style={{ fontSize: 13, color: '#6b7280' }}>{subtitle}</span>}
      {actions}
      <span style={{ marginLeft: 'auto' }}>{status ? <StatusBadge status={status} /> : null}</span>
      {right != null && <span style={{ fontSize: 12, color: '#9ca3af' }}>{right}</span>}
    </div>
  )
}
