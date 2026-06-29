import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import type { TaskRow } from '@/types/tasks'

const TASK_COLS =
  'id, organization_id, title, status, priority, department_id, project_id, request_id, work_packet_id, assigned_to_user_id, created_by, created_at, updated_at'

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type ReqRel  = { id: string; intent: string; status: string }
type WpRel   = { id: string; title: string; status: string; priority: string }
type OutRel  = { id: string; title: string; output_type: string; status: string }
type DecRel  = { id: string; summary: string; status: string }
type BlkRel  = { id: string; description: string; severity: string; status: string }
type RunRel  = { id: string; workflow_id: string; status: string }
type ApprRel = { id: string; category: string; status: string; trigger_reason: string }

export default async function TaskDetailPage({
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

  const { data: taskData } = await supabase.from('tasks').select(TASK_COLS).eq('id', id).maybeSingle()
  if (!taskData) notFound()
  const task = taskData as unknown as TaskRow

  // Related entities — each independent and non-fatal (RLS-hidden rows just don't appear).
  // workflow_runs uses a JSONB path filter on accumulated.task_id; guarded separately.
  const [reqRes, wpRes, outRes, decRes, blkRes, apprRes] = await Promise.all([
    task.request_id
      ? supabase.from('requests').select('id, intent, status').eq('id', task.request_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('work_packets').select('id, title, status, priority')
      .eq('parent_type', 'task').eq('parent_id', task.id)
      .order('created_at', { ascending: false }).limit(50),
    supabase.from('outputs').select('id, title, output_type, status')
      .eq('task_id', task.id).order('produced_at', { ascending: false }).limit(50),
    supabase.from('decisions').select('id, summary, status')
      .eq('task_id', task.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('blockers').select('id, description, severity, status')
      .eq('blocked_entity_type', 'task').eq('blocked_entity_id', task.id)
      .order('created_at', { ascending: false }).limit(50),
    supabase.from('approvals').select('id, category, status, trigger_reason')
      .eq('subject_type', 'task').eq('subject_id', task.id)
      .order('created_at', { ascending: false }).limit(50),
  ])

  let runs: RunRel[] = []
  const runRes = await supabase.from('workflow_runs').select('id, workflow_id, status')
    .filter('accumulated->>task_id', 'eq', task.id)
    .order('created_at', { ascending: false }).limit(20)
  if (!runRes.error) runs = (runRes.data ?? []) as unknown as RunRel[]

  const parentRequest = (reqRes.data ?? null) as ReqRel | null
  const workPackets   = (wpRes.data ?? []) as unknown as WpRel[]
  const outputs       = (outRes.data ?? []) as unknown as OutRel[]
  const decisions     = (decRes.data ?? []) as unknown as DecRel[]
  const blockers      = (blkRes.data ?? []) as unknown as BlkRel[]
  const approvals     = (apprRes.data ?? []) as unknown as ApprRel[]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/tasks" style={s.back}>← Tasks</Link>
        <h1 style={s.h1}>Task Detail</h1>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={task.status} /></span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      {/* Fields */}
      <div style={s.section}>
        <h2 style={s.h2}>Task</h2>
        <div style={s.grid}>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Title</div><div style={s.val}>{task.title}</div></div>
          <div><div style={s.label}>ID</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{task.id}</code></div></div>
          <div><div style={s.label}>Status</div><div style={s.val}><StatusBadge status={task.status} /></div></div>
          <div><div style={s.label}>Priority</div><div style={s.val}>{task.priority}</div></div>
          <div><div style={s.label}>Department</div><div style={s.val}><code>{task.department_id}</code></div></div>
          <div><div style={s.label}>Project</div><div style={s.val}><Link href={`/projects/${task.project_id}`} style={s.link}>{task.project_id.slice(0, 8)}…</Link></div></div>
          <div>
            <div style={s.label}>Request</div>
            <div style={s.val}>{task.request_id ? <Link href={`/requests/${task.request_id}`} style={s.link}>{task.request_id.slice(0, 8)}…</Link> : <span style={s.empty}>—</span>}</div>
          </div>
          <div><div style={s.label}>Assigned To</div><div style={s.val}>{task.assigned_to_user_id ? <code>{task.assigned_to_user_id.slice(0, 8)}…</code> : <span style={s.empty}>—</span>}</div></div>
          <div><div style={s.label}>Created By</div><div style={s.val}><code>{task.created_by.slice(0, 8)}…</code></div></div>
          <div><div style={s.label}>Created</div><div style={s.val}>{fmt(task.created_at)}</div></div>
          <div><div style={s.label}>Updated</div><div style={s.val}>{fmt(task.updated_at)}</div></div>
        </div>
      </div>

      {/* Parent request */}
      <Section title="Parent Request">
        {parentRequest
          ? <Row><Link href={`/requests/${parentRequest.id}`} style={s.link}>{parentRequest.id.slice(0, 8)}…</Link> <span style={s.dim}>{parentRequest.intent.slice(0, 80)}</span> <StatusBadge status={parentRequest.status} /></Row>
          : <Empty>No parent request.</Empty>}
      </Section>

      {/* Work packets */}
      <Section title={`Work Packets (${workPackets.length})`}>
        {workPackets.length === 0 ? <Empty>No work packets.</Empty> : workPackets.map(w => (
          <Row key={w.id}><Link href={`/work-packets/${w.id}`} style={s.link}>{w.id.slice(0, 8)}…</Link> <span style={s.dim}>{w.title.slice(0, 70)}</span> <StatusBadge status={w.status} /></Row>
        ))}
      </Section>

      {/* Outputs */}
      <Section title={`Outputs (${outputs.length})`}>
        {outputs.length === 0 ? <Empty>No outputs.</Empty> : outputs.map(o => (
          <Row key={o.id}><Link href={`/outputs/${o.id}`} style={s.link}>{o.id.slice(0, 8)}…</Link> <span style={s.dim}>{o.title.slice(0, 60)}</span> <code style={s.tag}>{o.output_type}</code> <StatusBadge status={o.status} /></Row>
        ))}
      </Section>

      {/* Decisions */}
      <Section title={`Decisions (${decisions.length})`}>
        {decisions.length === 0 ? <Empty>No decisions.</Empty> : decisions.map(d => (
          <Row key={d.id}><Link href={`/decisions/${d.id}`} style={s.link}>{d.id.slice(0, 8)}…</Link> <span style={s.dim}>{(d.summary ?? '').slice(0, 70)}</span> <StatusBadge status={d.status} /></Row>
        ))}
      </Section>

      {/* Blockers */}
      <Section title={`Blockers (${blockers.length})`}>
        {blockers.length === 0 ? <Empty>No blockers.</Empty> : blockers.map(b => (
          <Row key={b.id}><Link href={`/blockers/${b.id}`} style={s.link}>{b.id.slice(0, 8)}…</Link> <span style={s.dim}>{(b.description ?? '').slice(0, 60)}</span> <code style={s.tag}>{b.severity}</code> <StatusBadge status={b.status} /></Row>
        ))}
      </Section>

      {/* Approvals */}
      <Section title={`Approvals (${approvals.length})`}>
        {approvals.length === 0 ? <Empty>No approvals.</Empty> : approvals.map(a => (
          <Row key={a.id}><Link href={`/approvals/${a.id}`} style={s.link}>{a.id.slice(0, 8)}…</Link> <code style={s.tag}>{a.category}</code> <span style={s.dim}>{(a.trigger_reason ?? '').slice(0, 60)}</span> <StatusBadge status={a.status} /></Row>
        ))}
      </Section>

      {/* Workflow runs */}
      <Section title={`Workflow Runs (${runs.length})`}>
        {runs.length === 0 ? <Empty>No workflow runs reference this task.</Empty> : runs.map(r => (
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
