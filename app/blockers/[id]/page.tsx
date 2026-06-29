import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import type { BlockerRow } from '@/types/blockers'

const BLOCKER_COLS =
  'id, organization_id, description, severity, status, blocked_entity_type, blocked_entity_id, department_id, reported_by_user_id, assigned_to_user_id, resolution_note, created_at, updated_at'

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

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

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/blockers" style={s.back}>← Blockers</Link>
        <h1 style={s.h1}>Blocker Detail</h1>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={blocker.status} /></span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      <div style={s.section}>
        <h2 style={s.h2}>Blocker</h2>
        <div style={s.grid}>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Description</div><div style={s.val}>{blocker.description}</div></div>
          <div><div style={s.label}>ID</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{blocker.id}</code></div></div>
          <div><div style={s.label}>Severity</div><div style={s.val}>{blocker.severity}</div></div>
          <div><div style={s.label}>Status</div><div style={s.val}><StatusBadge status={blocker.status} /></div></div>
          <div><div style={s.label}>Blocked Entity Type</div><div style={s.val}>{blocker.blocked_entity_type}</div></div>
          <div>
            <div style={s.label}>Blocked Entity</div>
            <div style={s.val}><Link href={blockedHref} style={s.link}>{blocker.blocked_entity_id.slice(0, 8)}…</Link></div>
          </div>
          <div><div style={s.label}>Department</div><div style={s.val}><code>{blocker.department_id}</code></div></div>
          <div><div style={s.label}>Reported By</div><div style={s.val}><code>{blocker.reported_by_user_id.slice(0, 8)}…</code></div></div>
          <div><div style={s.label}>Assigned To</div><div style={s.val}>{blocker.assigned_to_user_id ? <code>{blocker.assigned_to_user_id.slice(0, 8)}…</code> : <span style={s.empty}>—</span>}</div></div>
          <div><div style={s.label}>Created</div><div style={s.val}>{fmt(blocker.created_at)}</div></div>
          <div><div style={s.label}>Updated</div><div style={s.val}>{fmt(blocker.updated_at)}</div></div>
          {blocker.resolution_note && (
            <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Resolution Note</div><div style={s.val}>{blocker.resolution_note}</div></div>
          )}
        </div>
      </div>

      <Section title={`Blocked ${blocker.blocked_entity_type === 'task' ? 'Task' : 'Work Packet'}`}>
        {blockedLabel
          ? <Row><Link href={blockedHref} style={s.link}>{blocker.blocked_entity_id.slice(0, 8)}…</Link> <span style={s.dim}>{blockedLabel.slice(0, 70)}</span> {blockedStatus && <StatusBadge status={blockedStatus} />}</Row>
          : <Empty>Blocked entity not visible.</Empty>}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <div style={s.section}><h2 style={s.h2}>{title}</h2><div style={s.list}>{children}</div></div>
}
function Row({ children }: { children: React.ReactNode }) { return <div style={s.rowItem}>{children}</div> }
function Empty({ children }: { children: React.ReactNode }) { return <div style={s.empty}>{children}</div> }

const s: Record<string, React.CSSProperties> = {
  page:    { padding: '24px', fontFamily: 'monospace', maxWidth: 1000 },
  header:  { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
  h1:      { fontSize: 20, fontWeight: 700, margin: 0 },
  back:    { fontSize: 13, color: '#6b7280', textDecoration: 'none' },
  section: { marginBottom: 22 },
  h2:      { fontSize: 14, fontWeight: 700, color: '#374151', margin: '0 0 10px' },
  grid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 16 },
  label:   { fontSize: 11, color: '#6b7280', marginBottom: 2 },
  val:     { fontSize: 13 },
  link:    { color: '#2563eb', textDecoration: 'none' },
  list:    { display: 'flex', flexDirection: 'column', gap: 4 },
  rowItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, flexWrap: 'wrap' },
  dim:     { color: '#6b7280' },
  tag:     { background: '#f3f4f6', padding: '1px 5px', borderRadius: 3, fontSize: 11 },
  empty:   { color: '#9ca3af', fontSize: 12, padding: '4px 0' },
}
