import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { StatusBadge } from '@/components/ui'
import type { UserContext } from '@/types/api'

// ---------- row types ----------

type ReqRow        = { id: string; intent: string; status: string; submitted_at: string }
type TaskRow       = { id: string; title: string; status: string; priority: string }
type WpRow         = { id: string; title: string; status: string; priority: string }
type ApprRow       = { id: string; subject_type: string; category: string; trigger_reason: string | null; created_at: string }
type BlockRow      = { id: string; description: string | null; severity: string; blocked_entity_type: string; created_at: string }
type CritRow       = { id: string; description: string | null; severity: string }
type OutputRow     = { id: string; title: string; output_type: string; status: string; produced_at: string }
type DecRow        = { id: string; summary: string | null; status: string; created_at: string }
type ActivityRow   = { id: string; activity_type: string; summary: string | null; status: string; agent_user_id: string | null; created_at: string }
type ExecLogRow    = { id: string; event_type: string; summary: string | null; status: string; actor: string; occurred_at: string }
type DeptRow       = { id: string; name: string }
type ProjectRow    = { id: string; name: string }
type FailedActRow  = { id: string; activity_type: string; summary: string | null; created_at: string }
type FlaggedLogRow = { id: string; event_type: string; summary: string | null; occurred_at: string }
type RejDecRow     = { id: string; summary: string | null; created_at: string }

type TimelineItem = {
  kind: 'approval' | 'output' | 'blocker' | 'activity' | 'exec_log'
  id: string
  label: string
  status: string
  time: string
  href: string
  detail: string
}

// ---------- helpers ----------

function trunc(s: string | null | undefined, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}

// ---------- server sub-components ----------

function Card({
  title, count, href, badge, children, color,
}: {
  title: string; count?: number; href: string; badge?: string; children: React.ReactNode; color?: string
}) {
  return (
    <div style={{ ...s.card, ...(color ? { borderTop: `3px solid ${color}` } : {}) }}>
      <div style={s.cardHeader}>
        <span style={s.cardTitle}>{title}</span>
        {count !== undefined && <span style={s.cardCount}>{count}</span>}
        {badge && <span style={s.cardBadge}>{badge}</span>}
        <Link href={href} style={s.cardLink}>View all →</Link>
      </div>
      <div style={s.cardBody}>{children}</div>
    </div>
  )
}

function MiniTable({ cols, children }: { cols: string[]; children: React.ReactNode }) {
  return (
    <table style={s.miniTable}>
      <thead><tr>{cols.map(c => <th key={c} style={s.miniTh}>{c}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table>
  )
}

function Td({ children, w }: { children: React.ReactNode; w?: string }) {
  return (
    <td style={{ ...s.miniTd, ...(w ? { maxWidth: w, wordBreak: 'break-word' as const } : {}) }}>
      {children}
    </td>
  )
}

function Empty({ label }: { label: string }) {
  return <p style={s.empty}>{label}</p>
}

function KpiCard({
  label, value, href, color, sub,
}: { label: string; value: number; href: string; color: string; sub: string }) {
  return (
    <Link href={href} style={{ ...s.kpiCard, borderTop: `3px solid ${color}` }}>
      <span style={s.kpiValue}>{value}</span>
      <span style={s.kpiLabel}>{label}</span>
      <span style={s.kpiSub}>{sub}</span>
    </Link>
  )
}

const ALERT_KINDS: Record<string, { label: string; bg: string }> = {
  critical: { label: 'CRIT', bg: '#dc2626' },
  pending:  { label: 'WAIT', bg: '#d97706' },
  failed:   { label: 'FAIL', bg: '#b45309' },
  flagged:  { label: 'FLAG', bg: '#7c3aed' },
  rejected: { label: 'REJ',  bg: '#6b7280' },
  missing:  { label: 'WF',   bg: '#0891b2' },
}

function AlertRow({ kind, text, href }: { kind: string; text: string; href: string }) {
  const ak = ALERT_KINDS[kind] ?? { label: '!', bg: '#333' }
  return (
    <div style={s.alertRow}>
      <span style={{ ...s.alertKind, background: ak.bg }}>{ak.label}</span>
      <Link href={href} style={s.alertLink}>{text}</Link>
    </div>
  )
}

// ---------- page ----------

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const supabase = await createClient()

  let ctx: UserContext | null = null
  try { ctx = await resolveUserContext(supabase) } catch { /* unauthenticated */ }
  if (!ctx) redirect('/login')

  // Parse filter params (apply to tasks section only)
  const sp        = await searchParams
  const fDept     = typeof sp.dept     === 'string' ? sp.dept.trim()     : ''
  const fProject  = typeof sp.project  === 'string' ? sp.project.trim()  : ''
  const fStatus   = typeof sp.status   === 'string' ? sp.status.trim()   : ''
  const fAssigned = typeof sp.assigned === 'string' ? sp.assigned.trim() : ''
  const hasFilter = !!(fDept || fProject || fStatus || fAssigned)

  // Build task query with filters applied server-side
  let taskQ = supabase
    .from('tasks')
    .select('id, title, status, priority', { count: 'exact' })

  if (fStatus) {
    taskQ = taskQ.eq('status', fStatus)
  } else {
    taskQ = taskQ.in('status', ['backlog', 'ready', 'in_progress', 'blocked', 'in_review'])
  }
  if (fDept)     taskQ = taskQ.eq('department_id', fDept)
  if (fProject)  taskQ = taskQ.eq('project_id', fProject)
  if (fAssigned) taskQ = taskQ.eq('assigned_to_user_id', fAssigned)
  const finalTaskQ = taskQ.order('created_at', { ascending: false }).limit(5)

  // 15 parallel queries — no sequential dependencies
  const [
    reqResult,
    taskResult,
    wpResult,
    approvalResult,
    blockerResult,
    criticalResult,
    outputResult,
    decisionResult,
    activityResult,
    execLogResult,
    failedActResult,
    flaggedLogResult,
    rejectedDecResult,
    deptResult,
    projectResult,
    wfPendingResult,
    wfRunningResult,
    wfCompletedResult,
    wfFailedResult,
    wfFailedIdsResult,
    wfParentIdsResult,
    activeReqsResult,
    reqRunIdsResult,
    wfCancelledResult,
  ] = await Promise.all([
    supabase.from('requests')
      .select('id, intent, status, submitted_at', { count: 'exact' })
      .order('submitted_at', { ascending: false }).limit(5),

    finalTaskQ,

    supabase.from('work_packets')
      .select('id, title, status, priority', { count: 'exact' })
      .in('status', ['ready', 'pending_approval', 'in_execution'])
      .order('created_at', { ascending: false }).limit(5),

    supabase.from('approvals')
      .select('id, subject_type, category, trigger_reason, created_at', { count: 'exact' })
      .eq('status', 'pending')
      .order('created_at', { ascending: false }).limit(5),

    supabase.from('blockers')
      .select('id, description, severity, blocked_entity_type, created_at', { count: 'exact' })
      .eq('status', 'open')
      .order('created_at', { ascending: false }).limit(5),

    // critical open blockers — get rows (not head:true) so we can link each one in alerts
    supabase.from('blockers')
      .select('id, description, severity', { count: 'exact' })
      .eq('status', 'open')
      .eq('severity', 'critical')
      .order('created_at', { ascending: false }).limit(5),

    supabase.from('outputs')
      .select('id, title, output_type, status, produced_at', { count: 'exact' })
      .in('status', ['draft', 'in_review', 'approved'])
      .order('produced_at', { ascending: false }).limit(5),

    supabase.from('decisions')
      .select('id, summary, status, created_at', { count: 'exact' })
      .order('created_at', { ascending: false }).limit(5),

    supabase.from('agent_activity')
      .select('id, activity_type, summary, status, agent_user_id, created_at', { count: 'exact' })
      .order('created_at', { ascending: false }).limit(5),

    supabase.from('execution_logs')
      .select('id, event_type, summary, status, actor, occurred_at', { count: 'exact' })
      .order('occurred_at', { ascending: false }).limit(5),

    // alert sources — separate from the main display queries
    supabase.from('agent_activity')
      .select('id, activity_type, summary, created_at')
      .eq('status', 'failed')
      .order('created_at', { ascending: false }).limit(5),

    supabase.from('execution_logs')
      .select('id, event_type, summary, occurred_at')
      .eq('status', 'flagged')
      .order('occurred_at', { ascending: false }).limit(5),

    supabase.from('decisions')
      .select('id, summary, created_at')
      .eq('status', 'rejected')
      .order('created_at', { ascending: false }).limit(3),

    // filter dropdown data
    supabase.from('departments').select('id, name').order('name', { ascending: true }).limit(200),

    supabase.from('projects').select('id, name').order('name', { ascending: true }).limit(200),

    // Workflow Health (Sprint 5.8)
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'running'),
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
    supabase.from('workflow_runs').select('id').eq('status', 'failed').limit(500),
    supabase.from('workflow_runs').select('parent_run_id').not('parent_run_id', 'is', null).limit(1000),

    // Missing-trigger detection (Sprint 5.9): active requests + the set of
    // request ids that already have a workflow run.
    supabase.from('requests').select('id')
      .in('status', ['received', 'triaged', 'in_progress'])
      .order('created_at', { ascending: false }).limit(200),
    supabase.from('workflow_runs').select('trigger_entity_id, status, created_at')
      .eq('trigger_entity_type', 'request')
      .order('created_at', { ascending: false }).limit(2000),

    // Recoverable workflows (Sprint 5.11): cancelled count (failed already above).
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'cancelled'),
  ])

  // Extract with safe fallbacks
  const reqs        = { n: reqResult.count      ?? 0, rows: (reqResult.data      ?? []) as ReqRow[]      }
  const tasks       = { n: taskResult.count     ?? 0, rows: (taskResult.data     ?? []) as TaskRow[]     }
  const wps         = { n: wpResult.count       ?? 0, rows: (wpResult.data       ?? []) as WpRow[]       }
  const approvals   = { n: approvalResult.count ?? 0, rows: (approvalResult.data ?? []) as ApprRow[]     }
  const blockers    = { n: blockerResult.count  ?? 0, rows: (blockerResult.data  ?? []) as BlockRow[]    }
  const critRows    = (criticalResult.data ?? []) as CritRow[]
  const critCount   = criticalResult.count ?? 0
  const outputs     = { n: outputResult.count   ?? 0, rows: (outputResult.data   ?? []) as OutputRow[]   }
  const decisions   = { n: decisionResult.count ?? 0, rows: (decisionResult.data ?? []) as DecRow[]      }
  const activity    = { n: activityResult.count ?? 0, rows: (activityResult.data ?? []) as ActivityRow[] }
  const execLogs    = { n: execLogResult.count  ?? 0, rows: (execLogResult.data  ?? []) as ExecLogRow[]  }
  const failedActs  = (failedActResult.data  ?? []) as FailedActRow[]
  const flaggedLogs = (flaggedLogResult.data ?? []) as FlaggedLogRow[]
  const rejDecisions = (rejectedDecResult.data ?? []) as RejDecRow[]
  const depts       = (deptResult.data    ?? []) as DeptRow[]
  const projects    = (projectResult.data ?? []) as ProjectRow[]

  // Workflow Health (Sprint 5.8) — counts + "recovery needed" = failed runs not
  // yet superseded by a recovery child run (leaf failures).
  const wfFailedIds   = (wfFailedIdsResult.data ?? []) as { id: string }[]
  const wfParentIds   = (wfParentIdsResult.data ?? []) as { parent_run_id: string | null }[]
  const recoveredSet  = new Set(wfParentIds.map(p => p.parent_run_id).filter(Boolean) as string[])
  const wfHealth = {
    pending:        wfPendingResult.count   ?? 0,
    running:        wfRunningResult.count   ?? 0,
    completed:      wfCompletedResult.count ?? 0,
    failed:         wfFailedResult.count    ?? 0,
    recoveryNeeded: wfFailedIds.filter(r => !recoveredSet.has(r.id)).length,
  }
  // Requests needing workflow review (Sprint 5.10): active requests with no
  // workflow run, OR whose latest run failed/cancelled. Runs come newest-first,
  // so the first status seen per request id is its latest.
  const activeReqIds = (activeReqsResult.data ?? []) as { id: string }[]
  const latestRunStatusByReq: Record<string, string> = {}
  for (const run of (reqRunIdsResult.data ?? []) as { trigger_entity_id: string | null; status: string }[]) {
    if (!run.trigger_entity_id || latestRunStatusByReq[run.trigger_entity_id]) continue
    latestRunStatusByReq[run.trigger_entity_id] = run.status
  }
  const missingTriggerCount = activeReqIds.filter(r => {
    const st = latestRunStatusByReq[r.id]
    return st === undefined || st === 'failed' || st === 'cancelled'
  }).length

  const wfRecoverable = wfHealth.failed + (wfCancelledResult.count ?? 0)
  const workflowHealthCards = [
    { label: 'Pending',        value: wfHealth.pending,        href: '/workflow-runs?status=pending',   color: '#6b7280' },
    { label: 'Running',        value: wfHealth.running,        href: '/workflow-runs?status=running',   color: '#2563eb' },
    { label: 'Failed',         value: wfHealth.failed,         href: '/workflow-runs?status=failed',    color: '#dc2626' },
    { label: 'Completed',      value: wfHealth.completed,      href: '/workflow-runs?status=completed', color: '#16a34a' },
    { label: 'Recovery Needed', value: wfHealth.recoveryNeeded, href: '/workflow-runs?status=failed',    color: '#d97706' },
    { label: 'Recoverable',     value: wfRecoverable,           href: '/workflow-runs?status=failed',    color: '#b45309' },
  ]

  // Build alerts list (deduped: one entry per approval count, individual rows for others)
  type AlertItem = { key: string; kind: string; text: string; href: string }
  const alerts: AlertItem[] = []

  critRows.forEach(b =>
    alerts.push({ key: `crit-${b.id}`, kind: 'critical', text: `Critical blocker: ${trunc(b.description, 80)}`, href: '/blockers' })
  )
  if (approvals.n > 0) {
    alerts.push({ key: 'approvals-all', kind: 'pending', text: `${approvals.n} pending approval${approvals.n !== 1 ? 's' : ''} awaiting review`, href: '/approvals' })
  }
  failedActs.forEach(a =>
    alerts.push({ key: `act-${a.id}`, kind: 'failed', text: `Failed ${a.activity_type}: ${trunc(a.summary, 70)}`, href: '/agent-activity' })
  )
  flaggedLogs.forEach(l =>
    alerts.push({ key: `log-${l.id}`, kind: 'flagged', text: `Flagged execution: ${trunc(l.summary, 70)}`, href: `/execution-logs/${l.id}` })
  )
  rejDecisions.forEach(d =>
    alerts.push({ key: `dec-${d.id}`, kind: 'rejected', text: `Rejected decision: ${trunc(d.summary, 70)}`, href: '/decisions' })
  )
  if (missingTriggerCount > 0) {
    alerts.push({
      key: 'missing-trigger',
      kind: 'missing',
      text: `${missingTriggerCount} request${missingTriggerCount !== 1 ? 's' : ''} needing workflow review (no run, or latest failed/cancelled)`,
      href: '/requests',
    })
  }

  // Build recent events timeline — merge 5 sources, sort newest first, cap at 15
  const timeline: TimelineItem[] = [
    ...approvals.rows.map(a => ({
      kind: 'approval' as const,
      id: a.id,
      label: `${a.category} approval`,
      status: 'pending',
      time: a.created_at,
      href: '/approvals',
      detail: trunc(a.trigger_reason, 80),
    })),
    ...outputs.rows.map(o => ({
      kind: 'output' as const,
      id: o.id,
      label: o.title,
      status: o.status,
      time: o.produced_at,
      href: '/outputs',
      detail: o.output_type,
    })),
    ...blockers.rows.map(b => ({
      kind: 'blocker' as const,
      id: b.id,
      label: trunc(b.description, 50) || 'blocker',
      status: 'open',
      time: b.created_at,
      href: '/blockers',
      detail: b.severity,
    })),
    ...activity.rows.map(a => ({
      kind: 'activity' as const,
      id: a.id,
      label: a.activity_type,
      status: a.status,
      time: a.created_at,
      href: '/agent-activity',
      detail: trunc(a.summary, 80),
    })),
    ...execLogs.rows.map(e => ({
      kind: 'exec_log' as const,
      id: e.id,
      label: e.event_type,
      status: e.status,
      time: e.occurred_at,
      href: `/execution-logs/${e.id}`,
      detail: trunc(e.summary, 80),
    })),
  ]
  timeline.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
  const recentEvents = timeline.slice(0, 15)

  const KIND_COLOR: Record<string, string> = {
    approval: '#7c3aed',
    output:   '#0891b2',
    blocker:  '#dc2626',
    activity: '#059669',
    exec_log: '#2563eb',
  }

  const QUICK_ACTIONS = [
    { href: '/requests',     label: '+ Request'     },
    { href: '/tasks',        label: '+ Task'        },
    { href: '/work-packets', label: '+ Work Packet' },
    { href: '/decisions',    label: '+ Decision'    },
    { href: '/outputs',      label: '+ Output'      },
    { href: '/work-queue',   label: 'Work Queue'    },
  ]

  return (
    <main style={s.main}>

      {/* Context strip */}
      <div style={s.ctxBar}>
        <span><b>role:</b> {ctx.role}</span>
        <span><b>user:</b> <code>{ctx.userId.slice(0, 8)}…</code></span>
        <span><b>org:</b> <code>{ctx.organizationId.slice(0, 8)}…</code></span>
        {ctx.departmentId && <span><b>dept:</b> <code>{ctx.departmentId.slice(0, 8)}…</code></span>}
      </div>

      {/* Quick Actions */}
      <div style={s.quickRow}>
        <span style={s.quickLabel}>Quick actions</span>
        {QUICK_ACTIONS.map(a => (
          <Link key={a.href} href={a.href} style={s.quickBtn}>{a.label}</Link>
        ))}
      </div>

      {/* KPI Metrics */}
      <div style={s.kpiRow}>
        <KpiCard label="Requests"       value={reqs.n}      href="/requests"       color="#0891b2" sub="total"                                               />
        <KpiCard label="Open Tasks"     value={tasks.n}     href="/tasks"          color="#2563eb" sub={hasFilter ? 'filtered' : 'open'}                     />
        <KpiCard label="Work Packets"   value={wps.n}       href="/work-packets"   color="#7c3aed" sub="active"                                              />
        <KpiCard label="Approvals"      value={approvals.n} href="/approvals"      color="#d97706" sub="pending"                                             />
        <KpiCard label="Outputs"        value={outputs.n}   href="/outputs"        color="#059669" sub="active"                                              />
        <KpiCard label="Blockers"       value={blockers.n}  href="/blockers"       color={critCount > 0 ? '#dc2626' : '#6b7280'} sub={critCount > 0 ? `${critCount} critical` : 'open'} />
        <KpiCard label="Agent Activity" value={activity.n}  href="/agent-activity" color="#0891b2" sub="recent"                                              />
        <KpiCard label="Exec Logs"      value={execLogs.n}  href="/execution-logs" color="#6b7280" sub="recent"                                              />
      </div>

      {/* Workflow Health (Sprint 5.8) */}
      <h2 style={s.sectionTitle}>Workflow Health</h2>
      <div style={{ ...s.kpiRow, gridTemplateColumns: 'repeat(6, 1fr)' }}>
        {workflowHealthCards.map(c => (
          <KpiCard
            key={c.label}
            label={c.label}
            value={c.value}
            href={c.href}
            color={c.color}
            sub="workflow runs"
          />
        ))}
      </div>

      {/* Active Alerts — only rendered when there is something to show */}
      {alerts.length > 0 && (
        <div style={s.alertsBox}>
          <div style={s.alertsHeader}>
            <span style={s.alertsTitle}>Active Alerts</span>
            <span style={s.alertsBadge}>{alerts.length}</span>
          </div>
          <div style={s.alertsList}>
            {alerts.map(a => (
              <AlertRow key={a.key} kind={a.kind} text={a.text} href={a.href} />
            ))}
          </div>
        </div>
      )}

      {/* Filter Bar — native form GET; page re-renders with new searchParams */}
      <form method="GET" style={s.filterBar}>
        <span style={s.filterBarLabel}>Filters (tasks)</span>

        <label style={s.filterField}>
          <span style={s.filterFieldLabel}>Department</span>
          <select name="dept" defaultValue={fDept} style={s.filterSelect}>
            <option value="">All</option>
            {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>

        <label style={s.filterField}>
          <span style={s.filterFieldLabel}>Project</span>
          <select name="project" defaultValue={fProject} style={s.filterSelect}>
            <option value="">All</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>

        <label style={s.filterField}>
          <span style={s.filterFieldLabel}>Status</span>
          <select name="status" defaultValue={fStatus} style={s.filterSelect}>
            <option value="">Open (default)</option>
            {['backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'].map(v => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </label>

        <label style={s.filterField}>
          <span style={s.filterFieldLabel}>Assigned To</span>
          <input name="assigned" defaultValue={fAssigned} placeholder="user UUID" style={s.filterInput} />
        </label>

        <div style={s.filterActions}>
          <button type="submit" style={s.filterSubmit}>Apply</button>
          {hasFilter && <Link href="/" style={s.filterClear}>Clear</Link>}
        </div>
      </form>

      {/* Recent Events Timeline */}
      <div style={s.timelineSection}>
        <h2 style={s.sectionTitle}>Recent Events</h2>
        {recentEvents.length === 0 ? (
          <p style={s.muted}>No recent events across approvals, outputs, blockers, agent activity, or execution logs.</p>
        ) : (
          <div style={s.timeline}>
            {recentEvents.map(ev => (
              <div key={`${ev.kind}-${ev.id}`} style={s.timelineRow}>
                <span style={{ ...s.timelineKind, background: KIND_COLOR[ev.kind] ?? '#999' }}>
                  {ev.kind.replace('_', ' ')}
                </span>
                <Link href={ev.href} style={s.timelineLink}>{ev.label}</Link>
                <StatusBadge status={ev.status} />
                {ev.detail && <span style={s.timelineDetail}>{ev.detail}</span>}
                <span style={s.timelineTime}>{new Date(ev.time).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 3-column entity grid */}
      <h2 style={s.sectionTitle}>Entity Overview</h2>
      <div style={s.grid}>

        <Card title="Requests" count={reqs.n} href="/requests" color="#0891b2">
          {reqs.rows.length === 0 ? <Empty label="No requests visible." /> : (
            <MiniTable cols={['intent', 'status', 'date']}>
              {reqs.rows.map(r => (
                <tr key={r.id}>
                  <Td w="160px">{r.intent.slice(0, 60)}</Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td>{new Date(r.submitted_at).toLocaleDateString()}</Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>

        <Card title={hasFilter ? 'Tasks (filtered)' : 'Open Tasks'} count={tasks.n} href="/tasks" color="#2563eb">
          {tasks.rows.length === 0 ? <Empty label="No tasks match." /> : (
            <MiniTable cols={['title', 'priority', 'status']}>
              {tasks.rows.map(t => (
                <tr key={t.id}>
                  <Td w="130px">{t.title.slice(0, 40)}</Td>
                  <Td>{t.priority}</Td>
                  <Td><StatusBadge status={t.status} /></Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>

        <Card title="Active Work Packets" count={wps.n} href="/work-packets" color="#7c3aed">
          {wps.rows.length === 0 ? <Empty label="No active work packets." /> : (
            <MiniTable cols={['title', 'priority', 'status']}>
              {wps.rows.map(w => (
                <tr key={w.id}>
                  <Td w="130px">{w.title.slice(0, 40)}</Td>
                  <Td>{w.priority}</Td>
                  <Td><StatusBadge status={w.status} /></Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>

        <Card title="Pending Approvals" count={approvals.n} href="/approvals" color="#d97706">
          {approvals.rows.length === 0 ? <Empty label="No pending approvals." /> : (
            <MiniTable cols={['subject', 'cat', 'trigger']}>
              {approvals.rows.map(a => (
                <tr key={a.id}>
                  <Td><code>{a.subject_type}</code></Td>
                  <Td><code>{a.category}</code></Td>
                  <Td w="160px">{(a.trigger_reason ?? '').slice(0, 50)}</Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>

        <Card
          title="Open Blockers"
          count={blockers.n}
          href="/blockers"
          color={critCount > 0 ? '#dc2626' : '#6b7280'}
          badge={critCount > 0 ? `${critCount} critical` : undefined}
        >
          {blockers.rows.length === 0 ? <Empty label="No open blockers." /> : (
            <MiniTable cols={['description', 'severity', 'entity']}>
              {blockers.rows.map(b => (
                <tr key={b.id}>
                  <Td w="140px">{(b.description ?? '').slice(0, 50)}</Td>
                  <Td>{b.severity}</Td>
                  <Td>{b.blocked_entity_type}</Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>

        <Card title="Active Outputs" count={outputs.n} href="/outputs" color="#059669">
          {outputs.rows.length === 0 ? <Empty label="No active outputs." /> : (
            <MiniTable cols={['title', 'type', 'status']}>
              {outputs.rows.map(o => (
                <tr key={o.id}>
                  <Td w="120px">{o.title.slice(0, 40)}</Td>
                  <Td>{o.output_type}</Td>
                  <Td><StatusBadge status={o.status} /></Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>

      </div>

      {/* Full-width rows */}
      <div style={s.fullRow}>
        <Card title="Recent Decisions" count={decisions.n} href="/decisions">
          {decisions.rows.length === 0 ? <Empty label="No decisions." /> : (
            <MiniTable cols={['summary', 'status', 'date']}>
              {decisions.rows.map(d => (
                <tr key={d.id}>
                  <Td w="400px">{(d.summary ?? '').slice(0, 100)}</Td>
                  <Td><StatusBadge status={d.status} /></Td>
                  <Td>{new Date(d.created_at).toLocaleDateString()}</Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>
      </div>

      <div style={s.fullRow}>
        <Card title="Recent Agent Activity" count={activity.n} href="/agent-activity">
          {activity.rows.length === 0 ? <Empty label="No agent activity recorded yet." /> : (
            <MiniTable cols={['type', 'summary', 'status', 'agent', 'date']}>
              {activity.rows.map(a => (
                <tr key={a.id}>
                  <Td><code>{a.activity_type}</code></Td>
                  <Td w="300px">{(a.summary ?? '').slice(0, 80)}</Td>
                  <Td><StatusBadge status={a.status} /></Td>
                  <Td><code>{a.agent_user_id ? a.agent_user_id.slice(0, 8) + '…' : '—'}</code></Td>
                  <Td>{new Date(a.created_at).toLocaleDateString()}</Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>
      </div>

      <div style={s.fullRow}>
        <Card title="Recent Execution Logs" count={execLogs.n} href="/execution-logs">
          {execLogs.rows.length === 0 ? <Empty label="No execution logs recorded yet." /> : (
            <MiniTable cols={['event_type', 'summary', 'status', 'actor', 'occurred']}>
              {execLogs.rows.map(e => (
                <tr key={e.id}>
                  <Td><code>{e.event_type}</code></Td>
                  <Td w="300px">{(e.summary ?? '').slice(0, 80)}</Td>
                  <Td><StatusBadge status={e.status} /></Td>
                  <Td><code>{e.actor === 'system' ? 'system' : e.actor.slice(0, 8) + '…'}</code></Td>
                  <Td>{new Date(e.occurred_at).toLocaleDateString()}</Td>
                </tr>
              ))}
            </MiniTable>
          )}
        </Card>
      </div>

    </main>
  )
}

const s: Record<string, React.CSSProperties> = {
  main:      { fontFamily: 'monospace', padding: '2rem', maxWidth: '1600px' },
  ctxBar:    { display: 'flex', gap: '1.5rem', marginBottom: '1rem', fontSize: '0.8rem', color: '#555', flexWrap: 'wrap' },

  // Quick actions
  quickRow:  { display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.25rem', flexWrap: 'wrap' },
  quickLabel:{ fontSize: '0.72rem', color: '#888', marginRight: '0.25rem', whiteSpace: 'nowrap' },
  quickBtn:  { padding: '0.3rem 0.75rem', background: '#111', color: '#fff', textDecoration: 'none', fontSize: '0.8rem', borderRadius: '3px', whiteSpace: 'nowrap' },

  // KPI row
  kpiRow:    { display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: '0.75rem', marginBottom: '1.25rem' },
  kpiCard:   { display: 'flex', flexDirection: 'column', padding: '0.75rem', border: '1px solid #ddd', borderRadius: '4px', textDecoration: 'none', color: 'inherit', gap: '0.15rem', cursor: 'pointer' },
  kpiValue:  { fontSize: '2rem', fontWeight: 'bold', lineHeight: '1' },
  kpiLabel:  { fontSize: '0.72rem', color: '#444', fontWeight: 'bold' },
  kpiSub:    { fontSize: '0.68rem', color: '#999' },

  // Alerts
  alertsBox:    { border: '1px solid #fca5a5', borderRadius: '4px', marginBottom: '1.25rem', overflow: 'hidden' },
  alertsHeader: { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0.75rem', background: '#fee2e2', borderBottom: '1px solid #fca5a5' },
  alertsTitle:  { fontWeight: 'bold', fontSize: '0.83rem', color: '#b91c1c', flex: '1' },
  alertsBadge:  { background: '#dc2626', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.72rem' },
  alertsList:   { padding: '0.15rem 0' },
  alertRow:     { display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.3rem 0.75rem', borderBottom: '1px solid #fee2e2', fontSize: '0.8rem' },
  alertKind:    { color: '#fff', padding: '0.1rem 0.35rem', borderRadius: '2px', fontSize: '0.65rem', fontWeight: 'bold', whiteSpace: 'nowrap', flexShrink: '0' as unknown as number },
  alertLink:    { color: '#111', textDecoration: 'none', flex: '1' },

  // Filter bar
  filterBar:       { display: 'flex', alignItems: 'flex-end', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap', padding: '0.75rem', background: '#f8f8f8', border: '1px solid #e0e0e0', borderRadius: '4px' },
  filterBarLabel:  { fontSize: '0.72rem', color: '#888', alignSelf: 'center', whiteSpace: 'nowrap', marginRight: '0.25rem' },
  filterField:     { display: 'flex', flexDirection: 'column', gap: '0.15rem' },
  filterFieldLabel:{ fontSize: '0.7rem', color: '#666' },
  filterSelect:    { padding: '0.3rem 0.4rem', fontFamily: 'monospace', fontSize: '0.78rem', border: '1px solid #ccc', borderRadius: '2px' },
  filterInput:     { padding: '0.3rem 0.4rem', fontFamily: 'monospace', fontSize: '0.78rem', border: '1px solid #ccc', borderRadius: '2px', width: '180px' },
  filterActions:   { display: 'flex', gap: '0.4rem', alignSelf: 'flex-end' },
  filterSubmit:    { padding: '0.3rem 0.65rem', fontFamily: 'monospace', fontSize: '0.78rem', background: '#111', color: '#fff', border: 'none', cursor: 'pointer', borderRadius: '2px' },
  filterClear:     { padding: '0.3rem 0.65rem', fontFamily: 'monospace', fontSize: '0.78rem', color: '#555', textDecoration: 'none', border: '1px solid #ccc', borderRadius: '2px' },

  // Timeline
  timelineSection: { marginBottom: '1.5rem' },
  sectionTitle:    { margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 'bold' },
  timeline:        { display: 'flex', flexDirection: 'column' },
  timelineRow:     { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.3rem 0', borderBottom: '1px solid #f0f0f0', fontSize: '0.8rem', flexWrap: 'wrap' },
  timelineKind:    { color: '#fff', padding: '0.1rem 0.35rem', borderRadius: '2px', fontSize: '0.65rem', fontWeight: 'bold', whiteSpace: 'nowrap', flexShrink: '0' as unknown as number },
  timelineLink:    { color: '#0066cc', textDecoration: 'none', whiteSpace: 'nowrap', flexShrink: '0' as unknown as number },
  timelineDetail:  { color: '#666', flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  timelineTime:    { color: '#aaa', fontSize: '0.7rem', whiteSpace: 'nowrap', marginLeft: 'auto', flexShrink: '0' as unknown as number },

  // Entity grid
  grid:      { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1rem' },
  fullRow:   { marginTop: '1rem' },
  card:      { border: '1px solid #ddd', borderRadius: '4px', overflow: 'hidden' },
  cardHeader:{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.45rem 0.75rem', background: '#f5f5f5', borderBottom: '1px solid #ddd' },
  cardTitle: { fontWeight: 'bold', fontSize: '0.83rem', flex: '1' },
  cardCount: { background: '#333', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.75rem', fontWeight: 'bold' },
  cardBadge: { background: '#c00', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.72rem' },
  cardLink:  { color: '#666', fontSize: '0.75rem', textDecoration: 'none', whiteSpace: 'nowrap' },
  cardBody:  { padding: '0.25rem 0' },
  miniTable: { borderCollapse: 'collapse', width: '100%', fontSize: '0.78rem' },
  miniTh:    { textAlign: 'left', padding: '0.2rem 0.75rem', color: '#888', fontSize: '0.72rem', fontWeight: 'normal', borderBottom: '1px solid #eee' },
  miniTd:    { padding: '0.25rem 0.75rem', borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' },
  empty:     { margin: '0', padding: '0.5rem 0.75rem', color: '#aaa', fontSize: '0.8rem' },
  muted:     { color: '#666', fontSize: '0.875rem', margin: '0' },
}
