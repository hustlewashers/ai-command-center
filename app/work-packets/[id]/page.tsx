import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import { EntityHeader, MetaGrid, RelatedList, DetailRow, Tag, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatDate, shortId, safeText } from '@/lib/ui/format'
import type { WorkPacketRow } from '@/types/work-packets'

const WP_COLS =
  'id, organization_id, title, objective, status, priority, department_id, parent_type, parent_id, author_user_id, approval_required_before_start, created_at, updated_at'

type TaskRel = { id: string; title: string; status: string }
type ProjRel = { id: string; name: string }
type BlkRel  = { id: string; description: string; severity: string; status: string }
type RunRel  = { id: string; workflow_id: string; status: string }
type ApprRel = { id: string; category: string; status: string; trigger_reason: string }

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

  // Parent (task or project), blockers, approvals, workflow runs — all non-fatal.
  // Note: outputs have no work_packet_id column (schema) — outputs attach to
  // tasks, not work packets, so there is no outputs section here.
  const [parentTaskRes, parentProjRes, blkRes, apprRes] = await Promise.all([
    wp.parent_type === 'task'
      ? supabase.from('tasks').select('id, title, status').eq('id', wp.parent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    wp.parent_type === 'project'
      ? supabase.from('projects').select('id, name').eq('id', wp.parent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('blockers').select('id, description, severity, status')
      .eq('blocked_entity_type', 'work_packet').eq('blocked_entity_id', wp.id)
      .order('created_at', { ascending: false }).limit(50),
    supabase.from('approvals').select('id, category, status, trigger_reason')
      .eq('subject_type', 'work_packet').eq('subject_id', wp.id)
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
  const approvals     = (apprRes.data ?? []) as unknown as ApprRel[]

  const parentHref = wp.parent_type === 'task' ? `/tasks/${wp.parent_id}` : `/projects/${wp.parent_id}`
  const fields: MetaItem[] = [
    { label: 'Title', value: wp.title, full: true },
    { label: 'Objective', value: wp.objective, full: true },
    { label: 'ID', value: <code style={{ wordBreak: 'break-all' }}>{wp.id}</code> },
    { label: 'Status', value: <StatusBadge status={wp.status} /> },
    { label: 'Priority', value: wp.priority },
    { label: 'Department', value: <code>{wp.department_id}</code> },
    { label: 'Parent Type', value: wp.parent_type },
    { label: 'Parent', value: <Link href={parentHref} style={ds.link}>{shortId(wp.parent_id)}</Link> },
    { label: 'Author', value: <code>{shortId(wp.author_user_id)}</code> },
    { label: 'Approval Required', value: wp.approval_required_before_start ? 'yes' : 'no' },
    { label: 'Created', value: formatDate(wp.created_at) },
    { label: 'Updated', value: formatDate(wp.updated_at) },
  ]

  // Parent section is empty when the parent row is not RLS-visible.
  const parentVisible = wp.parent_type === 'task' ? !!parentTask : !!parentProject

  return (
    <div style={ds.page}>
      <EntityHeader title="Work Packet Detail" backHref="/work-packets" backLabel="← Work Packets" status={wp.status} right={context.role} />

      <div style={ds.section}>
        <h2 style={ds.h2}>Work Packet</h2>
        <MetaGrid items={fields} />
      </div>

      <RelatedList
        title="Parent"
        empty={!parentVisible}
        emptyLabel={wp.parent_type === 'task' ? 'Parent task not visible.' : 'Parent project not visible.'}
      >
        {wp.parent_type === 'task' && parentTask && (
          <DetailRow>
            <Link href={`/tasks/${parentTask.id}`} style={ds.link}>{shortId(parentTask.id)}</Link>
            <span style={ds.dim}>{safeText(parentTask.title, 70)}</span>
            <StatusBadge status={parentTask.status} />
          </DetailRow>
        )}
        {wp.parent_type === 'project' && parentProject && (
          <DetailRow>
            <Link href={`/projects/${parentProject.id}`} style={ds.link}>{shortId(parentProject.id)}</Link>
            <span style={ds.dim}>{parentProject.name}</span>
            <Tag>project</Tag>
          </DetailRow>
        )}
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

      <RelatedList title={`Workflow Runs (${runs.length})`} empty={runs.length === 0} emptyLabel="No workflow runs reference this work packet.">
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
