import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
import { EntityHeader, MetaGrid, RelatedList, DetailRow, Tag, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatDate, shortId, safeText } from '@/lib/ui/format'
import { getAiDraftReviewContext } from '@/lib/ai/draft-review'
import ApprovalActions from './ApprovalActions'
import type { ApprovalRow } from '@/types/approvals'

const APPROVAL_COLS = [
  'id', 'organization_id', 'department_id',
  'subject_type', 'subject_id', 'category', 'trigger_reason',
  'requested_by_user_id', 'approver_user_id', 'approver_role',
  'status', 'decided_at', 'decision_note', 'expires_at',
  'created_at', 'updated_at',
].join(', ')

const RESOLVE_ROLES = new Set(['org_admin', 'department_lead'])

// subject_type → { table, route, name column }
const SUBJECT_MAP: Record<string, { table: string; route: string; nameCol: string }> = {
  task:        { table: 'tasks',        route: '/tasks',        nameCol: 'title' },
  work_packet: { table: 'work_packets', route: '/work-packets', nameCol: 'title' },
  decision:    { table: 'decisions',    route: '/decisions',    nameCol: 'summary' },
  output:      { table: 'outputs',      route: '/outputs',      nameCol: 'title' },
}

type LogRow = { id: string; event_type: string; summary: string | null; status: string; occurred_at: string }
type RunRow = { id: string; workflow_id: string; status: string }

export default async function ApprovalDetailPage({
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

  const { data: apprData } = await supabase.from('approvals').select(APPROVAL_COLS).eq('id', id).maybeSingle()
  if (!apprData) notFound()
  const approval = apprData as unknown as ApprovalRow

  // ── Subject resolution (TASK 2) ──
  // Only render a subject link when the subject row is actually visible under
  // RLS — otherwise show "Subject not visible" (never a link to a hidden row).
  const subjectMeta = SUBJECT_MAP[approval.subject_type]
  let subjectName: string | null = null
  let subjectStatus: string | null = null
  let subjectVisible = false
  if (subjectMeta) {
    const { data: subj } = await supabase
      .from(subjectMeta.table)
      .select(`id, ${subjectMeta.nameCol}, status`)
      .eq('id', approval.subject_id)
      .maybeSingle()
    if (subj) {
      const row = subj as unknown as Record<string, unknown>
      subjectVisible = true
      subjectName = (row[subjectMeta.nameCol] as string | null) ?? null
      subjectStatus = (row.status as string | null) ?? null
    }
  }
  const subjectHref = subjectMeta ? `${subjectMeta.route}/${approval.subject_id}` : null

  // ── Timeline (TASK 4) — both filters non-fatal; empty states are expected ──
  let logs: LogRow[] = []
  const logRes = await supabase.from('execution_logs')
    .select('id, event_type, summary, status, occurred_at')
    .filter('metadata->>approval_id', 'eq', approval.id)
    .order('occurred_at', { ascending: true }).limit(50)
  if (!logRes.error) logs = (logRes.data ?? []) as unknown as LogRow[]

  let runs: RunRow[] = []
  const runRes = await supabase.from('workflow_runs')
    .select('id, workflow_id, status')
    .filter('accumulated->>approval_id', 'eq', approval.id)
    .order('created_at', { ascending: false }).limit(20)
  if (!runRes.error) runs = (runRes.data ?? []) as unknown as RunRow[]

  // AI review context (Sprint 6.6) — only when the subject is an AI draft output
  // produced by a governed request_ai_summary run. Read-only; partial on RLS.
  const aiContext = approval.subject_type === 'output'
    ? await getAiDraftReviewContext(supabase, { approval_id: approval.id })
    : null

  const canResolve = approval.status === 'pending' && RESOLVE_ROLES.has(context.role)

  const subjectIdCell = subjectVisible && subjectHref
    ? <Link href={subjectHref} style={ds.link}>{shortId(approval.subject_id)}</Link>
    : <code>{shortId(approval.subject_id)}</code>
  const dash = <span style={ds.dim}>—</span>

  const fields: MetaItem[] = [
    { label: 'ID', value: <code style={{ wordBreak: 'break-all' }}>{approval.id}</code> },
    { label: 'Status', value: <StatusBadge status={approval.status} /> },
    { label: 'Category', value: approval.category },
    { label: 'Subject Type', value: approval.subject_type },
    { label: 'Subject', value: subjectIdCell },
    { label: 'Department', value: <code>{approval.department_id}</code> },
    { label: 'Approver Role', value: approval.approver_role },
    { label: 'Requested By', value: approval.requested_by_user_id ? <code>{shortId(approval.requested_by_user_id)}</code> : dash },
    { label: 'Decided By', value: approval.approver_user_id ? <code>{shortId(approval.approver_user_id)}</code> : dash },
    { label: 'Decided At', value: formatDate(approval.decided_at) },
    { label: 'Expires At', value: formatDate(approval.expires_at) },
    { label: 'Created', value: formatDate(approval.created_at) },
    { label: 'Updated', value: formatDate(approval.updated_at) },
    { label: 'Trigger Reason', value: approval.trigger_reason, full: true },
    ...(approval.decision_note ? [{ label: 'Decision Note', value: approval.decision_note, full: true }] as MetaItem[] : []),
  ]

  return (
    <div style={ds.page}>
      <EntityHeader title="Approval Detail" backHref="/approvals" backLabel="← Approvals" status={approval.status} right={context.role} />

      {/* Subject */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Subject</h2>
        <div style={subjectBox}>
          <Tag>{approval.subject_type}</Tag>
          {subjectVisible && subjectHref
            ? <Link href={subjectHref} style={ds.link}>{safeText(subjectName, 80) || shortId(approval.subject_id)}</Link>
            : <span style={ds.dim}>Subject not visible</span>}
          {subjectStatus && <StatusBadge status={subjectStatus} />}
        </div>
      </div>

      {/* Fields */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Approval</h2>
        <MetaGrid items={fields} />
      </div>

      {/* AI Review Context (Sprint 6.6) */}
      {aiContext?.is_ai && (
        <div style={ds.section}>
          <h2 style={ds.h2}>AI Review Context</h2>
          <MetaGrid items={[
            { label: 'Draft Output', value: aiContext.output ? <Link href={`/outputs/${aiContext.output.id}`} style={ds.link}>{aiContext.output.title || shortId(aiContext.output.id)}</Link> : <span style={ds.dim}>hidden or not created</span> },
            { label: 'Source Request', value: aiContext.request ? <Link href={`/requests/${aiContext.request.id}#ai-summary`} style={ds.link}>{shortId(aiContext.request.id)}</Link> : <span style={ds.dim}>—</span> },
            { label: 'Workflow Run', value: aiContext.workflow_run ? <Link href={`/workflow-runs/${aiContext.workflow_run.id}`} style={ds.link}>{shortId(aiContext.workflow_run.id)} ({aiContext.workflow_run.status})</Link> : <span style={ds.dim}>—</span> },
            { label: 'Prompt', value: aiContext.prompt_id ? <code>{aiContext.prompt_id}</code> : <span style={ds.dim}>—</span> },
            { label: 'Model', value: aiContext.model ? <code>{aiContext.model}</code> : <span style={ds.dim}>—</span> },
            { label: 'Confidence', value: aiContext.confidence !== null ? aiContext.confidence.toFixed(2) : <span style={ds.dim}>—</span> },
            { label: 'Risk Level', value: aiContext.risk_level ? <Tag>{aiContext.risk_level}</Tag> : <span style={ds.dim}>—</span> },
            ...(aiContext.summary ? [{ label: 'Summary Preview', value: aiContext.summary.length > 400 ? `${aiContext.summary.slice(0, 400)}…` : aiContext.summary, full: true }] as MetaItem[] : []),
            ...(aiContext.recommended_next_steps && aiContext.recommended_next_steps.length > 0
              ? [{ label: 'Recommended Next Steps', value: <ul style={{ margin: 0, paddingLeft: 18 }}>{aiContext.recommended_next_steps.map((s, i) => <li key={i} style={{ wordBreak: 'break-word' }}>{s}</li>)}</ul>, full: true }] as MetaItem[]
              : []),
          ]} />
          <p style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '10px 12px', margin: '12px 0 0' }}>
            Approving this approval authorizes the draft output for the next governed step; it does not mean the AI is automatically trusted.
          </p>
        </div>
      )}

      {/* Actions */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Resolve</h2>
        <ApprovalActions approvalId={approval.id} status={approval.status} canResolve={canResolve} />
      </div>

      {/* Timeline */}
      <RelatedList
        title={`Related Execution (${logs.length + runs.length})`}
        empty={logs.length === 0 && runs.length === 0}
        emptyLabel="No related execution records."
      >
        {runs.map(r => (
          <DetailRow key={r.id}>
            <Tag>run</Tag>
            <Link href={`/workflow-runs/${r.id}`} style={ds.link}>{shortId(r.id)}</Link>
            <Tag>{r.workflow_id}</Tag>
            <StatusBadge status={r.status} />
          </DetailRow>
        ))}
        {logs.map(l => (
          <DetailRow key={l.id}>
            <Tag>log</Tag>
            <Tag>{l.event_type}</Tag>
            <span style={ds.dim}>{safeText(l.summary, 70)}</span>
            <span style={{ color: '#9ca3af', fontSize: 11, marginLeft: 'auto' }}>{formatDate(l.occurred_at)}</span>
          </DetailRow>
        ))}
      </RelatedList>
    </div>
  )
}

const subjectBox: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10,
  background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6,
  padding: '12px 16px', flexWrap: 'wrap',
}
