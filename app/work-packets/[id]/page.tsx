import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import type { WorkPacketRow } from '@/types/work-packets'

const WP_COLS =
  'id, organization_id, title, objective, status, priority, department_id, parent_type, parent_id, author_user_id, approval_required_before_start, created_at, updated_at'

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type TaskRel = { id: string; title: string; status: string }
type ProjRel = { id: string; name: string }
type BlkRel  = { id: string; description: string; severity: string; status: string }
type RunRel  = { id: string; workflow_id: string; status: string }

export default async function WorkPacketDetailPage({
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

  const { data: wpData } = await supabase.from('work_packets').select(WP_COLS).eq('id', id).maybeSingle()
  if (!wpData) notFound()
  const wp = wpData as unknown as WorkPacketRow

  // Parent (task or project), blockers, workflow runs — all non-fatal.
  // Note: outputs have no work_packet_id column (schema) — outputs attach to
  // tasks, not work packets, so there is no outputs section here.
  const [parentTaskRes, parentProjRes, blkRes] = await Promise.all([
    wp.parent_type === 'task'
      ? supabase.from('tasks').select('id, title, status').eq('id', wp.parent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    wp.parent_type === 'project'
      ? supabase.from('projects').select('id, name').eq('id', wp.parent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('blockers').select('id, description, severity, status')
      .eq('blocked_entity_type', 'work_packet').eq('blocked_entity_id', wp.id)
      .order('created_at', { ascending: false }).limit(50),
  ])

  let runs: RunRel[] = []
  const runRes = await supabase.from('workflow_runs').select('id, workflow_id, status')
    .filter('accumulated->>work_packet_id', 'eq', wp.id)
    .order('created_at', { ascending: false }).limit(20)
  if (!runRes.error) runs = (runRes.data ?? []) as unknown as RunRel[]

  const parentTask    = (parentTaskRes.data ?? null) as TaskRel | null
  const parentProject = (parentProjRes.data ?? null) as ProjRel | null
  const blockers      = (blkRes.data ?? []) as unknown as BlkRel[]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/work-packets" style={s.back}>← Work Packets</Link>
        <h1 style={s.h1}>Work Packet Detail</h1>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={wp.status} /></span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      {/* Fields */}
      <div style={s.section}>
        <h2 style={s.h2}>Work Packet</h2>
        <div style={s.grid}>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Title</div><div style={s.val}>{wp.title}</div></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Objective</div><div style={s.val}>{wp.objective}</div></div>
          <div><div style={s.label}>ID</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{wp.id}</code></div></div>
          <div><div style={s.label}>Status</div><div style={s.val}><StatusBadge status={wp.status} /></div></div>
          <div><div style={s.label}>Priority</div><div style={s.val}>{wp.priority}</div></div>
          <div><div style={s.label}>Department</div><div style={s.val}><code>{wp.department_id}</code></div></div>
          <div><div style={s.label}>Parent Type</div><div style={s.val}>{wp.parent_type}</div></div>
          <div>
            <div style={s.label}>Parent</div>
            <div style={s.val}>
              {wp.parent_type === 'task'
                ? <Link href={`/tasks/${wp.parent_id}`} style={s.link}>{wp.parent_id.slice(0, 8)}…</Link>
                : <code>{wp.parent_id.slice(0, 8)}…</code>}
            </div>
          </div>
          <div><div style={s.label}>Author</div><div style={s.val}><code>{wp.author_user_id.slice(0, 8)}…</code></div></div>
          <div><div style={s.label}>Approval Required</div><div style={s.val}>{wp.approval_required_before_start ? 'yes' : 'no'}</div></div>
          <div><div style={s.label}>Created</div><div style={s.val}>{fmt(wp.created_at)}</div></div>
          <div><div style={s.label}>Updated</div><div style={s.val}>{fmt(wp.updated_at)}</div></div>
        </div>
      </div>

      {/* Parent */}
      <Section title="Parent">
        {wp.parent_type === 'task'
          ? (parentTask
              ? <Row><Link href={`/tasks/${parentTask.id}`} style={s.link}>{parentTask.id.slice(0, 8)}…</Link> <span style={s.dim}>{parentTask.title.slice(0, 70)}</span> <StatusBadge status={parentTask.status} /></Row>
              : <Empty>Parent task not visible.</Empty>)
          : (parentProject
              ? <Row><code>{parentProject.id.slice(0, 8)}…</code> <span style={s.dim}>{parentProject.name}</span> <span style={s.tag}>project</span></Row>
              : <Empty>Parent project not visible.</Empty>)}
      </Section>

      {/* Blockers */}
      <Section title={`Blockers (${blockers.length})`}>
        {blockers.length === 0 ? <Empty>No blockers.</Empty> : blockers.map(b => (
          <Row key={b.id}><Link href="/blockers" style={s.link}>{b.id.slice(0, 8)}…</Link> <span style={s.dim}>{(b.description ?? '').slice(0, 60)}</span> <code style={s.tag}>{b.severity}</code> <StatusBadge status={b.status} /></Row>
        ))}
      </Section>

      {/* Workflow runs */}
      <Section title={`Workflow Runs (${runs.length})`}>
        {runs.length === 0 ? <Empty>No workflow runs reference this work packet.</Empty> : runs.map(r => (
          <Row key={r.id}><Link href={`/workflow-runs/${r.id}`} style={s.link}>{r.id.slice(0, 8)}…</Link> <code style={s.tag}>{r.workflow_id}</code> <StatusBadge status={r.status} /></Row>
        ))}
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={s.section}>
      <h2 style={s.h2}>{title}</h2>
      <div style={s.list}>{children}</div>
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={s.rowItem}>{children}</div>
}
function Empty({ children }: { children: React.ReactNode }) {
  return <div style={s.empty}>{children}</div>
}

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
