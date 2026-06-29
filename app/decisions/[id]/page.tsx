import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import type { DecisionRow } from '@/types/decisions'

const DECISION_COLS =
  'id, organization_id, task_id, summary, rationale, status, decided_by_user_id, decided_at, created_at, updated_at'

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type ApprRel = { id: string; category: string; status: string; trigger_reason: string }
type RunRel  = { id: string; workflow_id: string; status: string }

export default async function DecisionDetailPage({
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

  const { data: decData } = await supabase.from('decisions').select(DECISION_COLS).eq('id', id).maybeSingle()
  if (!decData) notFound()
  const decision = decData as unknown as DecisionRow

  const [taskRes, apprRes] = await Promise.all([
    supabase.from('tasks').select('id, title, status').eq('id', decision.task_id).maybeSingle(),
    supabase.from('approvals').select('id, category, status, trigger_reason')
      .eq('subject_type', 'decision').eq('subject_id', decision.id)
      .order('created_at', { ascending: false }).limit(50),
  ])

  // Forward-compatible JSONB relation; empty unless a workflow stamps decision_id.
  let runs: RunRel[] = []
  const runRes = await supabase.from('workflow_runs').select('id, workflow_id, status')
    .filter('accumulated->>decision_id', 'eq', decision.id)
    .order('created_at', { ascending: false }).limit(20)
  if (!runRes.error) runs = (runRes.data ?? []) as unknown as RunRel[]

  const task      = (taskRes.data ?? null) as { id: string; title: string; status: string } | null
  const approvals = (apprRes.data ?? []) as unknown as ApprRel[]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/decisions" style={s.back}>← Decisions</Link>
        <h1 style={s.h1}>Decision Detail</h1>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={decision.status} /></span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      <div style={s.section}>
        <h2 style={s.h2}>Decision</h2>
        <div style={s.grid}>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Summary</div><div style={s.val}>{decision.summary}</div></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Rationale</div><div style={s.val}>{decision.rationale}</div></div>
          <div><div style={s.label}>ID</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{decision.id}</code></div></div>
          <div><div style={s.label}>Status</div><div style={s.val}><StatusBadge status={decision.status} /></div></div>
          <div>
            <div style={s.label}>Task</div>
            <div style={s.val}><Link href={`/tasks/${decision.task_id}`} style={s.link}>{task ? task.title.slice(0, 30) : decision.task_id.slice(0, 8) + '…'}</Link></div>
          </div>
          <div><div style={s.label}>Decided By</div><div style={s.val}>{decision.decided_by_user_id ? <code>{decision.decided_by_user_id.slice(0, 8)}…</code> : <span style={s.empty}>—</span>}</div></div>
          <div><div style={s.label}>Decided At</div><div style={s.val}>{fmt(decision.decided_at)}</div></div>
          <div><div style={s.label}>Created</div><div style={s.val}>{fmt(decision.created_at)}</div></div>
          <div><div style={s.label}>Updated</div><div style={s.val}>{fmt(decision.updated_at)}</div></div>
        </div>
      </div>

      <Section title="Parent Task">
        {task
          ? <Row><Link href={`/tasks/${task.id}`} style={s.link}>{task.id.slice(0, 8)}…</Link> <span style={s.dim}>{task.title.slice(0, 70)}</span> <StatusBadge status={task.status} /></Row>
          : <Empty>Parent task not visible.</Empty>}
      </Section>

      <Section title={`Approvals (${approvals.length})`}>
        {approvals.length === 0 ? <Empty>No approvals for this decision.</Empty> : approvals.map(a => (
          <Row key={a.id}><Link href="/approvals" style={s.link}>{a.id.slice(0, 8)}…</Link> <code style={s.tag}>{a.category}</code> <span style={s.dim}>{(a.trigger_reason ?? '').slice(0, 60)}</span> <StatusBadge status={a.status} /></Row>
        ))}
      </Section>

      <Section title={`Workflow Runs (${runs.length})`}>
        {runs.length === 0 ? <Empty>No workflow runs reference this decision.</Empty> : runs.map(r => (
          <Row key={r.id}><Link href={`/workflow-runs/${r.id}`} style={s.link}>{r.id.slice(0, 8)}…</Link> <code style={s.tag}>{r.workflow_id}</code> <StatusBadge status={r.status} /></Row>
        ))}
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
