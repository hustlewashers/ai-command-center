import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'

const PROJECT_COLS =
  'id, organization_id, name, objective, status, owning_department_id, workflow_template_id, created_by, created_at, updated_at'

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type ProjectRow = {
  id: string; organization_id: string; name: string; objective: string; status: string
  owning_department_id: string; workflow_template_id: string | null; created_by: string
  created_at: string; updated_at: string
}
type TaskRel = { id: string; title: string; status: string }
type WpRel   = { id: string; title: string; status: string }
type OutRel  = { id: string; title: string; output_type: string; status: string }
type ReqRel  = { id: string; intent: string; status: string }

export default async function ProjectDetailPage({
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

  const { data: projData } = await supabase.from('projects').select(PROJECT_COLS).eq('id', id).maybeSingle()
  if (!projData) notFound()
  const project = projData as unknown as ProjectRow

  const [taskRes, wpRes, outRes, reqRes] = await Promise.all([
    supabase.from('tasks').select('id, title, status')
      .eq('project_id', project.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('work_packets').select('id, title, status')
      .eq('parent_type', 'project').eq('parent_id', project.id).order('created_at', { ascending: false }).limit(50),
    supabase.from('outputs').select('id, title, output_type, status')
      .eq('project_id', project.id).order('produced_at', { ascending: false }).limit(50),
    supabase.from('requests').select('id, intent, status')
      .eq('project_id', project.id).order('created_at', { ascending: false }).limit(50),
  ])

  const tasks    = (taskRes.data ?? []) as unknown as TaskRel[]
  const packets  = (wpRes.data ?? []) as unknown as WpRel[]
  const outputs  = (outRes.data ?? []) as unknown as OutRel[]
  const requests = (reqRes.data ?? []) as unknown as ReqRel[]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/" style={s.back}>← Home</Link>
        <h1 style={s.h1}>Project Detail</h1>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={project.status} /></span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      <div style={s.section}>
        <h2 style={s.h2}>Project</h2>
        <div style={s.grid}>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Name</div><div style={s.val}>{project.name}</div></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Objective</div><div style={s.val}>{project.objective}</div></div>
          <div><div style={s.label}>ID</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{project.id}</code></div></div>
          <div><div style={s.label}>Status</div><div style={s.val}><StatusBadge status={project.status} /></div></div>
          <div><div style={s.label}>Owning Department</div><div style={s.val}><code>{project.owning_department_id}</code></div></div>
          <div><div style={s.label}>Workflow Template</div><div style={s.val}>{project.workflow_template_id ? <code>{project.workflow_template_id.slice(0, 8)}…</code> : <span style={s.empty}>—</span>}</div></div>
          <div><div style={s.label}>Created By</div><div style={s.val}><code>{project.created_by.slice(0, 8)}…</code></div></div>
          <div><div style={s.label}>Created</div><div style={s.val}>{fmt(project.created_at)}</div></div>
          <div><div style={s.label}>Updated</div><div style={s.val}>{fmt(project.updated_at)}</div></div>
        </div>
      </div>

      <Section title={`Tasks (${tasks.length})`}>
        {tasks.length === 0 ? <Empty>No tasks.</Empty> : tasks.map(t => (
          <Row key={t.id}><Link href={`/tasks/${t.id}`} style={s.link}>{t.id.slice(0, 8)}…</Link> <span style={s.dim}>{t.title.slice(0, 70)}</span> <StatusBadge status={t.status} /></Row>
        ))}
      </Section>

      <Section title={`Work Packets (${packets.length})`}>
        {packets.length === 0 ? <Empty>No work packets.</Empty> : packets.map(w => (
          <Row key={w.id}><Link href={`/work-packets/${w.id}`} style={s.link}>{w.id.slice(0, 8)}…</Link> <span style={s.dim}>{w.title.slice(0, 70)}</span> <StatusBadge status={w.status} /></Row>
        ))}
      </Section>

      <Section title={`Outputs (${outputs.length})`}>
        {outputs.length === 0 ? <Empty>No outputs.</Empty> : outputs.map(o => (
          <Row key={o.id}><Link href={`/outputs/${o.id}`} style={s.link}>{o.id.slice(0, 8)}…</Link> <span style={s.dim}>{o.title.slice(0, 60)}</span> <code style={s.tag}>{o.output_type}</code> <StatusBadge status={o.status} /></Row>
        ))}
      </Section>

      <Section title={`Requests (${requests.length})`}>
        {requests.length === 0 ? <Empty>No requests.</Empty> : requests.map(r => (
          <Row key={r.id}><Link href={`/requests/${r.id}`} style={s.link}>{r.id.slice(0, 8)}…</Link> <span style={s.dim}>{r.intent.slice(0, 70)}</span> <StatusBadge status={r.status} /></Row>
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
