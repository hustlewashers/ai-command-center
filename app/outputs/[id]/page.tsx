import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import type { OutputRow } from '@/types/outputs'

const OUTPUT_COLS =
  'id, organization_id, title, output_type, status, department_id, project_id, task_id, created_by_user_id, content, storage_path, produced_at, delivered_at, created_at, updated_at'

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

type ApprRel = { id: string; category: string; status: string; trigger_reason: string }
type RunRel  = { id: string; workflow_id: string; status: string }

export default async function OutputDetailPage({
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

  const { data: outData } = await supabase.from('outputs').select(OUTPUT_COLS).eq('id', id).maybeSingle()
  if (!outData) notFound()
  const output = outData as unknown as OutputRow

  const [taskRes, projRes, apprRes] = await Promise.all([
    supabase.from('tasks').select('id, title, status').eq('id', output.task_id).maybeSingle(),
    supabase.from('projects').select('id, name').eq('id', output.project_id).maybeSingle(),
    supabase.from('approvals').select('id, category, status, trigger_reason')
      .eq('subject_type', 'output').eq('subject_id', output.id)
      .order('created_at', { ascending: false }).limit(50),
  ])

  // Forward-compatible: a future workflow step may stamp accumulated.output_id.
  let runs: RunRel[] = []
  const runRes = await supabase.from('workflow_runs').select('id, workflow_id, status')
    .filter('accumulated->>output_id', 'eq', output.id)
    .order('created_at', { ascending: false }).limit(20)
  if (!runRes.error) runs = (runRes.data ?? []) as unknown as RunRel[]

  const task     = (taskRes.data ?? null) as { id: string; title: string; status: string } | null
  const project  = (projRes.data ?? null) as { id: string; name: string } | null
  const approvals = (apprRes.data ?? []) as unknown as ApprRel[]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/outputs" style={s.back}>← Outputs</Link>
        <h1 style={s.h1}>Output Detail</h1>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={output.status} /></span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      <div style={s.section}>
        <h2 style={s.h2}>Output</h2>
        <div style={s.grid}>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Title</div><div style={s.val}>{output.title}</div></div>
          <div><div style={s.label}>ID</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{output.id}</code></div></div>
          <div><div style={s.label}>Type</div><div style={s.val}>{output.output_type}</div></div>
          <div><div style={s.label}>Status</div><div style={s.val}><StatusBadge status={output.status} /></div></div>
          <div><div style={s.label}>Department</div><div style={s.val}><code>{output.department_id}</code></div></div>
          <div>
            <div style={s.label}>Project</div>
            <div style={s.val}><Link href={`/projects/${output.project_id}`} style={s.link}>{project ? project.name : output.project_id.slice(0, 8) + '…'}</Link></div>
          </div>
          <div>
            <div style={s.label}>Task</div>
            <div style={s.val}><Link href={`/tasks/${output.task_id}`} style={s.link}>{task ? task.title.slice(0, 30) : output.task_id.slice(0, 8) + '…'}</Link></div>
          </div>
          <div><div style={s.label}>Created By</div><div style={s.val}>{output.created_by_user_id ? <code>{output.created_by_user_id.slice(0, 8)}…</code> : <span style={s.empty}>—</span>}</div></div>
          <div><div style={s.label}>Produced</div><div style={s.val}>{fmt(output.produced_at)}</div></div>
          <div><div style={s.label}>Delivered</div><div style={s.val}>{fmt(output.delivered_at)}</div></div>
          <div><div style={s.label}>Created</div><div style={s.val}>{fmt(output.created_at)}</div></div>
          <div><div style={s.label}>Updated</div><div style={s.val}>{fmt(output.updated_at)}</div></div>
          {output.storage_path && (
            <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Storage Path</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{output.storage_path}</code></div></div>
          )}
        </div>
        {output.content && (
          <div style={{ marginTop: 12 }}>
            <div style={s.label}>Content Preview</div>
            <pre style={s.pre}>{output.content.slice(0, 1000)}{output.content.length > 1000 ? '\n…' : ''}</pre>
          </div>
        )}
      </div>

      <Section title={`Approvals (${approvals.length})`}>
        {approvals.length === 0 ? <Empty>No approvals for this output.</Empty> : approvals.map(a => (
          <Row key={a.id}><Link href="/approvals" style={s.link}>{a.id.slice(0, 8)}…</Link> <code style={s.tag}>{a.category}</code> <span style={s.dim}>{(a.trigger_reason ?? '').slice(0, 60)}</span> <StatusBadge status={a.status} /></Row>
        ))}
      </Section>

      <Section title={`Workflow Runs (${runs.length})`}>
        {runs.length === 0 ? <Empty>No workflow runs reference this output.</Empty> : runs.map(r => (
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
  pre:     { margin: 0, fontSize: 11, background: '#f3f4f6', padding: '8px 10px', borderRadius: 4, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
}
