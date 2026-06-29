import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { StatusBadge } from '@/components/ui'
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

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
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

  const canResolve = approval.status === 'pending' && RESOLVE_ROLES.has(context.role)

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/approvals" style={s.back}>← Approvals</Link>
        <h1 style={s.h1}>Approval Detail</h1>
        <span style={{ marginLeft: 'auto' }}><StatusBadge status={approval.status} /></span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      {/* Subject */}
      <div style={s.section}>
        <h2 style={s.h2}>Subject</h2>
        <div style={s.subjectBox}>
          <code style={s.tag}>{approval.subject_type}</code>
          {subjectVisible && subjectHref
            ? <Link href={subjectHref} style={s.link}>{subjectName?.slice(0, 80) || approval.subject_id.slice(0, 8) + '…'}</Link>
            : <span style={s.dim}>Subject not visible</span>}
          {subjectStatus && <StatusBadge status={subjectStatus} />}
        </div>
      </div>

      {/* Fields */}
      <div style={s.section}>
        <h2 style={s.h2}>Approval</h2>
        <div style={s.grid}>
          <div><div style={s.label}>ID</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{approval.id}</code></div></div>
          <div><div style={s.label}>Status</div><div style={s.val}><StatusBadge status={approval.status} /></div></div>
          <div><div style={s.label}>Category</div><div style={s.val}>{approval.category}</div></div>
          <div><div style={s.label}>Subject Type</div><div style={s.val}>{approval.subject_type}</div></div>
          <div>
            <div style={s.label}>Subject</div>
            <div style={s.val}>
              {subjectVisible && subjectHref
                ? <Link href={subjectHref} style={s.link}>{approval.subject_id.slice(0, 8)}…</Link>
                : <code>{approval.subject_id.slice(0, 8)}…</code>}
            </div>
          </div>
          <div><div style={s.label}>Department</div><div style={s.val}><code>{approval.department_id}</code></div></div>
          <div><div style={s.label}>Approver Role</div><div style={s.val}>{approval.approver_role}</div></div>
          <div><div style={s.label}>Requested By</div><div style={s.val}>{approval.requested_by_user_id ? <code>{approval.requested_by_user_id.slice(0, 8)}…</code> : <span style={s.dim}>—</span>}</div></div>
          <div><div style={s.label}>Decided By</div><div style={s.val}>{approval.approver_user_id ? <code>{approval.approver_user_id.slice(0, 8)}…</code> : <span style={s.dim}>—</span>}</div></div>
          <div><div style={s.label}>Decided At</div><div style={s.val}>{fmt(approval.decided_at)}</div></div>
          <div><div style={s.label}>Expires At</div><div style={s.val}>{fmt(approval.expires_at)}</div></div>
          <div><div style={s.label}>Created</div><div style={s.val}>{fmt(approval.created_at)}</div></div>
          <div><div style={s.label}>Updated</div><div style={s.val}>{fmt(approval.updated_at)}</div></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Trigger Reason</div><div style={s.val}>{approval.trigger_reason}</div></div>
          {approval.decision_note && (
            <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Decision Note</div><div style={s.val}>{approval.decision_note}</div></div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div style={s.section}>
        <h2 style={s.h2}>Resolve</h2>
        <ApprovalActions approvalId={approval.id} status={approval.status} canResolve={canResolve} />
      </div>

      {/* Timeline */}
      <div style={s.section}>
        <h2 style={s.h2}>Related Execution ({logs.length + runs.length})</h2>
        <div style={s.list}>
          {logs.length === 0 && runs.length === 0 && <Empty>No related execution records.</Empty>}
          {runs.map(r => (
            <Row key={r.id}><code style={s.tag}>run</code> <Link href={`/workflow-runs/${r.id}`} style={s.link}>{r.id.slice(0, 8)}…</Link> <code style={s.tag}>{r.workflow_id}</code> <StatusBadge status={r.status} /></Row>
          ))}
          {logs.map(l => (
            <Row key={l.id}><code style={s.tag}>log</code> <code style={s.tag}>{l.event_type}</code> <span style={s.dim}>{(l.summary ?? '').slice(0, 70)}</span> <span style={s.time}>{fmt(l.occurred_at)}</span></Row>
          ))}
        </div>
      </div>
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) { return <div style={s.rowItem}>{children}</div> }
function Empty({ children }: { children: React.ReactNode }) { return <div style={s.empty}>{children}</div> }

const s: Record<string, React.CSSProperties> = {
  page:      { padding: '24px', fontFamily: 'monospace', maxWidth: 1000 },
  header:    { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
  h1:        { fontSize: 20, fontWeight: 700, margin: 0 },
  back:      { fontSize: 13, color: '#6b7280', textDecoration: 'none' },
  section:   { marginBottom: 22 },
  h2:        { fontSize: 14, fontWeight: 700, color: '#374151', margin: '0 0 10px' },
  subjectBox:{ display: 'flex', alignItems: 'center', gap: 10, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 16px', flexWrap: 'wrap' },
  grid:      { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 16 },
  label:     { fontSize: 11, color: '#6b7280', marginBottom: 2 },
  val:       { fontSize: 13 },
  link:      { color: '#2563eb', textDecoration: 'none' },
  list:      { display: 'flex', flexDirection: 'column', gap: 4 },
  rowItem:   { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, flexWrap: 'wrap' },
  dim:       { color: '#6b7280' },
  tag:       { background: '#f3f4f6', padding: '1px 5px', borderRadius: 3, fontSize: 11 },
  time:      { color: '#9ca3af', fontSize: 11, marginLeft: 'auto' },
  empty:     { color: '#9ca3af', fontSize: 12, padding: '4px 0' },
}
