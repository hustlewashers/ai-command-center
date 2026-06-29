import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import { EntityHeader, MetaGrid, RelatedList, DetailRow, Tag, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatDate, shortId, safeText } from '@/lib/ui/format'
import type { TaskRow } from '@/types/tasks'

const TASK_COLS =
  'id, organization_id, title, status, priority, department_id, project_id, request_id, work_packet_id, assigned_to_user_id, created_by, created_at, updated_at'

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

  const dash = <span style={ds.empty}>—</span>
  const fields: MetaItem[] = [
    { label: 'Title', value: task.title, full: true },
    { label: 'ID', value: <code style={{ wordBreak: 'break-all' }}>{task.id}</code> },
    { label: 'Status', value: <StatusBadge status={task.status} /> },
    { label: 'Priority', value: task.priority },
    { label: 'Department', value: <code>{task.department_id}</code> },
    { label: 'Project', value: <Link href={`/projects/${task.project_id}`} style={ds.link}>{shortId(task.project_id)}</Link> },
    { label: 'Request', value: task.request_id ? <Link href={`/requests/${task.request_id}`} style={ds.link}>{shortId(task.request_id)}</Link> : dash },
    { label: 'Assigned To', value: task.assigned_to_user_id ? <code>{shortId(task.assigned_to_user_id)}</code> : dash },
    { label: 'Created By', value: <code>{shortId(task.created_by)}</code> },
    { label: 'Created', value: formatDate(task.created_at) },
    { label: 'Updated', value: formatDate(task.updated_at) },
  ]

  return (
    <div style={ds.page}>
      <EntityHeader title="Task Detail" backHref="/tasks" backLabel="← Tasks" status={task.status} right={context.role} />

      <div style={ds.section}>
        <h2 style={ds.h2}>Task</h2>
        <MetaGrid items={fields} />
      </div>

      <RelatedList title="Parent Request" empty={!parentRequest} emptyLabel="No parent request.">
        {parentRequest && (
          <DetailRow>
            <Link href={`/requests/${parentRequest.id}`} style={ds.link}>{shortId(parentRequest.id)}</Link>
            <span style={ds.dim}>{safeText(parentRequest.intent, 80)}</span>
            <StatusBadge status={parentRequest.status} />
          </DetailRow>
        )}
      </RelatedList>

      <RelatedList title={`Work Packets (${workPackets.length})`} empty={workPackets.length === 0} emptyLabel="No work packets.">
        {workPackets.map(w => (
          <DetailRow key={w.id}>
            <Link href={`/work-packets/${w.id}`} style={ds.link}>{shortId(w.id)}</Link>
            <span style={ds.dim}>{safeText(w.title, 70)}</span>
            <StatusBadge status={w.status} />
          </DetailRow>
        ))}
      </RelatedList>

      <RelatedList title={`Outputs (${outputs.length})`} empty={outputs.length === 0} emptyLabel="No outputs.">
        {outputs.map(o => (
          <DetailRow key={o.id}>
            <Link href={`/outputs/${o.id}`} style={ds.link}>{shortId(o.id)}</Link>
            <span style={ds.dim}>{safeText(o.title, 60)}</span>
            <Tag>{o.output_type}</Tag>
            <StatusBadge status={o.status} />
          </DetailRow>
        ))}
      </RelatedList>

      <RelatedList title={`Decisions (${decisions.length})`} empty={decisions.length === 0} emptyLabel="No decisions.">
        {decisions.map(d => (
          <DetailRow key={d.id}>
            <Link href={`/decisions/${d.id}`} style={ds.link}>{shortId(d.id)}</Link>
            <span style={ds.dim}>{safeText(d.summary, 70)}</span>
            <StatusBadge status={d.status} />
          </DetailRow>
        ))}
      </RelatedList>

      <RelatedList title={`Blockers (${blockers.length})`} empty={blockers.length === 0} emptyLabel="No blockers.">
        {blockers.map(b => (
          <DetailRow key={b.id}>
            <Link href={`/blockers/${b.id}`} style={ds.link}>{shortId(b.id)}</Link>
            <span style={ds.dim}>{safeText(b.description, 60)}</span>
            <Tag>{b.severity}</Tag>
            <StatusBadge status={b.status} />
          </DetailRow>
        ))}
      </RelatedList>

      <RelatedList title={`Approvals (${approvals.length})`} empty={approvals.length === 0} emptyLabel="No approvals.">
        {approvals.map(a => (
          <DetailRow key={a.id}>
            <Link href={`/approvals/${a.id}`} style={ds.link}>{shortId(a.id)}</Link>
            <Tag>{a.category}</Tag>
            <span style={ds.dim}>{safeText(a.trigger_reason, 60)}</span>
            <StatusBadge status={a.status} />
          </DetailRow>
        ))}
      </RelatedList>

      <RelatedList title={`Workflow Runs (${runs.length})`} empty={runs.length === 0} emptyLabel="No workflow runs reference this task.">
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
