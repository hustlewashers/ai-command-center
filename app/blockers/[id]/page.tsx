import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import { EntityHeader, MetaGrid, RelatedList, DetailRow, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatDate, shortId, safeText } from '@/lib/ui/format'
import type { BlockerRow } from '@/types/blockers'

const BLOCKER_COLS =
  'id, organization_id, description, severity, status, blocked_entity_type, blocked_entity_id, department_id, reported_by_user_id, assigned_to_user_id, resolution_note, created_at, updated_at'

export default async function BlockerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()
  let context
  try {
    context = await resolveUserContext(supabase)
  } catch {
    redirect('/login')
  }

  const { data: blkData } = await supabase.from('blockers').select(BLOCKER_COLS).eq('id', id).maybeSingle()
  if (!blkData) notFound()
  const blocker = blkData as unknown as BlockerRow

  // Resolve the blocked entity (task or work_packet) for a deep link + label.
  type EntityRel = { id: string; title: string; status: string }
  let blockedTask: EntityRel | null = null
  let blockedWp: EntityRel | null = null
  if (blocker.blocked_entity_type === 'task') {
    const { data } = await supabase.from('tasks').select('id, title, status').eq('id', blocker.blocked_entity_id).maybeSingle()
    blockedTask = (data ?? null) as EntityRel | null
  } else if (blocker.blocked_entity_type === 'work_packet') {
    const { data } = await supabase.from('work_packets').select('id, title, status').eq('id', blocker.blocked_entity_id).maybeSingle()
    blockedWp = (data ?? null) as EntityRel | null
  }

  const blockedHref = blocker.blocked_entity_type === 'task'
    ? `/tasks/${blocker.blocked_entity_id}`
    : `/work-packets/${blocker.blocked_entity_id}`
  const blockedLabel = blockedTask?.title ?? blockedWp?.title ?? null
  const blockedStatus = blockedTask?.status ?? blockedWp?.status ?? null

  const fields: MetaItem[] = [
    { label: 'Description', value: blocker.description, full: true },
    { label: 'ID', value: <code style={{ wordBreak: 'break-all' }}>{blocker.id}</code> },
    { label: 'Severity', value: blocker.severity },
    { label: 'Status', value: <StatusBadge status={blocker.status} /> },
    { label: 'Blocked Entity Type', value: blocker.blocked_entity_type },
    { label: 'Blocked Entity', value: <Link href={blockedHref} style={ds.link}>{shortId(blocker.blocked_entity_id)}</Link> },
    { label: 'Department', value: <code>{blocker.department_id}</code> },
    { label: 'Reported By', value: <code>{shortId(blocker.reported_by_user_id)}</code> },
    { label: 'Assigned To', value: blocker.assigned_to_user_id ? <code>{shortId(blocker.assigned_to_user_id)}</code> : <span style={ds.empty}>—</span> },
    { label: 'Created', value: formatDate(blocker.created_at) },
    { label: 'Updated', value: formatDate(blocker.updated_at) },
    ...(blocker.resolution_note ? [{ label: 'Resolution Note', value: blocker.resolution_note, full: true }] as MetaItem[] : []),
  ]

  return (
    <div style={ds.page}>
      <EntityHeader title="Blocker Detail" backHref="/blockers" backLabel="← Blockers" status={blocker.status} right={context.role} />

      <div style={ds.section}>
        <h2 style={ds.h2}>Blocker</h2>
        <MetaGrid items={fields} />
      </div>

      <RelatedList
        title={`Blocked ${blocker.blocked_entity_type === 'task' ? 'Task' : 'Work Packet'}`}
        empty={!blockedLabel}
        emptyLabel="Blocked entity not visible."
      >
        {blockedLabel && (
          <DetailRow>
            <Link href={blockedHref} style={ds.link}>{shortId(blocker.blocked_entity_id)}</Link>
            <span style={ds.dim}>{safeText(blockedLabel, 70)}</span>
            {blockedStatus && <StatusBadge status={blockedStatus} />}
          </DetailRow>
        )}
      </RelatedList>
    </div>
  )
}
