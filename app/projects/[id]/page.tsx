import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import { EntityHeader, MetaGrid, RelatedList, DetailRow, Tag, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatDate, shortId, safeText } from '@/lib/ui/format'

const PROJECT_COLS =
  'id, organization_id, name, objective, status, owning_department_id, workflow_template_id, created_by, created_at, updated_at'

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

  const fields: MetaItem[] = [
    { label: 'Name', value: project.name, full: true },
    { label: 'Objective', value: project.objective, full: true },
    { label: 'ID', value: <code style={{ wordBreak: 'break-all' }}>{project.id}</code> },
    { label: 'Status', value: <StatusBadge status={project.status} /> },
    { label: 'Owning Department', value: <code>{project.owning_department_id}</code> },
    { label: 'Workflow Template', value: project.workflow_template_id ? <code>{shortId(project.workflow_template_id)}</code> : <span style={ds.empty}>—</span> },
    { label: 'Created By', value: <code>{shortId(project.created_by)}</code> },
    { label: 'Created', value: formatDate(project.created_at) },
    { label: 'Updated', value: formatDate(project.updated_at) },
  ]

  return (
    <div style={ds.page}>
      <EntityHeader title="Project Detail" backHref="/" backLabel="← Home" status={project.status} right={context.role} />

      <div style={ds.section}>
        <h2 style={ds.h2}>Project</h2>
        <MetaGrid items={fields} />
      </div>

      <RelatedList title={`Tasks (${tasks.length})`} empty={tasks.length === 0} emptyLabel="No tasks.">
        {tasks.map(t => (
          <DetailRow key={t.id}>
            <Link href={`/tasks/${t.id}`} style={ds.link}>{shortId(t.id)}</Link>
            <span style={ds.dim}>{safeText(t.title, 70)}</span>
            <StatusBadge status={t.status} />
          </DetailRow>
        ))}
      </RelatedList>

      <RelatedList title={`Work Packets (${packets.length})`} empty={packets.length === 0} emptyLabel="No work packets.">
        {packets.map(w => (
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

      <RelatedList title={`Requests (${requests.length})`} empty={requests.length === 0} emptyLabel="No requests.">
        {requests.map(r => (
          <DetailRow key={r.id}>
            <Link href={`/requests/${r.id}`} style={ds.link}>{shortId(r.id)}</Link>
            <span style={ds.dim}>{safeText(r.intent, 70)}</span>
            <StatusBadge status={r.status} />
          </DetailRow>
        ))}
      </RelatedList>
    </div>
  )
}
