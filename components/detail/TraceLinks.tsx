import Link from 'next/link'
import type { ReactNode } from 'react'
import { shortId } from '@/lib/ui/format'
import { ds } from './styles'

// Standard linked pills for navigating the execution trace. Each pill links to
// the entity's detail route — except background_job, which has only a LIST page,
// so it links there. A link renders ONLY when the id is a non-empty string, so
// missing/RLS-absent references never produce a broken link.

export type TraceType =
  | 'request' | 'task' | 'work_packet' | 'output' | 'decision'
  | 'blocker' | 'approval' | 'project' | 'workflow_run' | 'background_job'

const ROUTE: Record<TraceType, string> = {
  request:        '/requests',
  task:           '/tasks',
  work_packet:    '/work-packets',
  output:         '/outputs',
  decision:       '/decisions',
  blocker:        '/blockers',
  approval:       '/approvals',
  project:        '/projects',
  workflow_run:   '/workflow-runs',
  background_job: '/background-jobs',
}

// Entities with no detail route — link to the list page (id appended would 404).
const LIST_ONLY = new Set<TraceType>(['background_job'])

const LABEL: Record<TraceType, string> = {
  request: 'Request', task: 'Task', work_packet: 'Work Packet', output: 'Output',
  decision: 'Decision', blocker: 'Blocker', approval: 'Approval', project: 'Project',
  workflow_run: 'Run', background_job: 'Job',
}

export function traceHref(type: TraceType, id: string): string {
  return LIST_ONLY.has(type) ? ROUTE[type] : `${ROUTE[type]}/${id}`
}

export interface TraceLinkSpec {
  type: TraceType
  id: string | null | undefined
  label?: ReactNode
}

// A single trace pill. Returns null when id is not a usable string.
export function TraceLink({ type, id, label }: TraceLinkSpec) {
  if (typeof id !== 'string' || id.length === 0) return null
  return (
    <Link href={traceHref(type, id)} style={ds.pill}>
      {label ?? `${LABEL[type]} ${shortId(id)}`}
    </Link>
  )
}

// A row of trace pills; renders nothing if none of the ids are present.
export function TraceLinks({ links }: { links: TraceLinkSpec[] }) {
  const visible = links.filter(l => typeof l.id === 'string' && l.id.length > 0)
  if (visible.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {visible.map((l, i) => <TraceLink key={i} {...l} />)}
    </div>
  )
}
