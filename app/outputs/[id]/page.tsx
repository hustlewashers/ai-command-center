import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import { EntityHeader, MetaGrid, RelatedList, DetailRow, Tag, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatDate, shortId, safeText } from '@/lib/ui/format'
import type { OutputRow } from '@/types/outputs'

const OUTPUT_COLS =
  'id, organization_id, title, output_type, status, department_id, project_id, task_id, created_by_user_id, content, storage_path, produced_at, delivered_at, created_at, updated_at'

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

  const fields: MetaItem[] = [
    { label: 'Title', value: output.title, full: true },
    { label: 'ID', value: <code style={{ wordBreak: 'break-all' }}>{output.id}</code> },
    { label: 'Type', value: output.output_type },
    { label: 'Status', value: <StatusBadge status={output.status} /> },
    { label: 'Department', value: <code>{output.department_id}</code> },
    { label: 'Project', value: <Link href={`/projects/${output.project_id}`} style={ds.link}>{project ? project.name : shortId(output.project_id)}</Link> },
    { label: 'Task', value: <Link href={`/tasks/${output.task_id}`} style={ds.link}>{task ? safeText(task.title, 30) : shortId(output.task_id)}</Link> },
    { label: 'Created By', value: output.created_by_user_id ? <code>{shortId(output.created_by_user_id)}</code> : <span style={ds.empty}>—</span> },
    { label: 'Produced', value: formatDate(output.produced_at) },
    { label: 'Delivered', value: formatDate(output.delivered_at) },
    { label: 'Created', value: formatDate(output.created_at) },
    { label: 'Updated', value: formatDate(output.updated_at) },
    ...(output.storage_path ? [{ label: 'Storage Path', value: <code style={{ wordBreak: 'break-all' }}>{output.storage_path}</code>, full: true }] as MetaItem[] : []),
  ]

  return (
    <div style={ds.page}>
      <EntityHeader title="Output Detail" backHref="/outputs" backLabel="← Outputs" status={output.status} right={context.role} />

      <div style={ds.section}>
        <h2 style={ds.h2}>Output</h2>
        <MetaGrid items={fields} />
        {output.content && (
          <div style={{ marginTop: 12 }}>
            <div style={ds.label}>Content Preview</div>
            <pre style={ds.pre}>{output.content.slice(0, 1000)}{output.content.length > 1000 ? '\n…' : ''}</pre>
          </div>
        )}
      </div>

      <RelatedList title={`Approvals (${approvals.length})`} empty={approvals.length === 0} emptyLabel="No approvals for this output.">
        {approvals.map(a => (
          <DetailRow key={a.id}>
            <Link href={`/approvals/${a.id}`} style={ds.link}>{shortId(a.id)}</Link>
            <Tag>{a.category}</Tag>
            <span style={ds.dim}>{safeText(a.trigger_reason, 60)}</span>
            <StatusBadge status={a.status} />
          </DetailRow>
        ))}
      </RelatedList>

      <RelatedList title={`Workflow Runs (${runs.length})`} empty={runs.length === 0} emptyLabel="No workflow runs reference this output.">
        {runs.map(r => (
          <DetailRow key={r.id}>
            <Link href={`/workflow-runs/${r.id}`} style={ds.link}>{shortId(r.id)}</Link>
            <Tag>{r.workflow_id}</Tag>
            <StatusBadge status={r.status} />
          </DetailRow>
        ))}
      </RelatedList>
    </div>
  )
}
