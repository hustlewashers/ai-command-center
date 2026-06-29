import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import { EntityHeader, MetaGrid, RelatedList, DetailRow, Tag, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatDate, shortId, safeText } from '@/lib/ui/format'
import type { DecisionRow } from '@/types/decisions'

const DECISION_COLS =
  'id, organization_id, task_id, summary, rationale, status, decided_by_user_id, decided_at, created_at, updated_at'

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

  const fields: MetaItem[] = [
    { label: 'Summary', value: decision.summary, full: true },
    { label: 'Rationale', value: decision.rationale, full: true },
    { label: 'ID', value: <code style={{ wordBreak: 'break-all' }}>{decision.id}</code> },
    { label: 'Status', value: <StatusBadge status={decision.status} /> },
    { label: 'Task', value: <Link href={`/tasks/${decision.task_id}`} style={ds.link}>{task ? safeText(task.title, 30) : shortId(decision.task_id)}</Link> },
    { label: 'Decided By', value: decision.decided_by_user_id ? <code>{shortId(decision.decided_by_user_id)}</code> : <span style={ds.empty}>—</span> },
    { label: 'Decided At', value: formatDate(decision.decided_at) },
    { label: 'Created', value: formatDate(decision.created_at) },
    { label: 'Updated', value: formatDate(decision.updated_at) },
  ]

  return (
    <div style={ds.page}>
      <EntityHeader title="Decision Detail" backHref="/decisions" backLabel="← Decisions" status={decision.status} right={context.role} />

      <div style={ds.section}>
        <h2 style={ds.h2}>Decision</h2>
        <MetaGrid items={fields} />
      </div>

      <RelatedList title="Parent Task" empty={!task} emptyLabel="Parent task not visible.">
        {task && (
          <DetailRow>
            <Link href={`/tasks/${task.id}`} style={ds.link}>{shortId(task.id)}</Link>
            <span style={ds.dim}>{safeText(task.title, 70)}</span>
            <StatusBadge status={task.status} />
          </DetailRow>
        )}
      </RelatedList>

      <RelatedList title={`Approvals (${approvals.length})`} empty={approvals.length === 0} emptyLabel="No approvals for this decision.">
        {approvals.map(a => (
          <DetailRow key={a.id}>
            <Link href={`/approvals/${a.id}`} style={ds.link}>{shortId(a.id)}</Link>
            <Tag>{a.category}</Tag>
            <span style={ds.dim}>{safeText(a.trigger_reason, 60)}</span>
            <StatusBadge status={a.status} />
          </DetailRow>
        ))}
      </RelatedList>

      <RelatedList title={`Workflow Runs (${runs.length})`} empty={runs.length === 0} emptyLabel="No workflow runs reference this decision.">
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
