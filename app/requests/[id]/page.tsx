import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getRequestTriggerStatus } from '@/lib/workflows/trigger-status'
import RequestWorkflowActions from './RequestWorkflowActions'
import RequestWorkflowRecovery from './RequestWorkflowRecovery'
import type { WorkflowRunRow, WorkflowRunStatus } from '@/types/workflow-runs'
import type { RequestRow } from '@/types/requests'

const TRIGGER_ROLES = new Set(['org_admin', 'department_lead'])

function fmtShort(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const REQUEST_COLS =
  'id, organization_id, source, intent, status, submitted_at, submitted_by_user_id, routed_department_id, project_id, metadata, created_at, updated_at'

const RUN_COLS = [
  'id', 'organization_id', 'workflow_id', 'workflow_version',
  'background_job_id', 'parent_run_id', 'status',
  'trigger_type', 'trigger_entity_type', 'trigger_entity_id', 'accumulated',
  'started_at', 'completed_at', 'failed_at',
  'current_step_id', 'current_step_index', 'retry_count', 'error_message',
  'created_at', 'updated_at',
].join(', ')

// Best-effort recovery action label from persisted run fields (not stored
// per-run): no parent = initial; parent + retry_count 0 = restart (resets);
// parent + retry_count > 0 = retry/resume (both increment). Coarse but honest.
function deriveAction(parentRunId: string | null, retryCount: number): string {
  if (!parentRunId) return 'initial'
  return retryCount === 0 ? 'restart' : 'retry/resume'
}

// Duration between start and the run's end (completed or failed).
function durationStr(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return '—'
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

const JOB_COLS  = 'id, job_type, status, retry_count, max_retries, last_error, created_at'
const LOG_COLS  = 'id, event_type, actor, summary, status, occurred_at'

const RUN_STATUS_COLOR: Record<WorkflowRunStatus, string> = {
  pending: '#6b7280', running: '#2563eb', completed: '#16a34a',
  failed: '#dc2626', cancelled: '#9ca3af', resuming: '#d97706',
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

type JobRow = {
  id: string; job_type: string; status: string
  retry_count: number; max_retries: number; last_error: string | null; created_at: string
}
type LogRow = {
  id: string; event_type: string; actor: string
  summary: string | null; status: string; occurred_at: string
}

export default async function RequestDetailPage({
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

  // Phase 1: request + latest workflow run + latest request-scoped log (parallel)
  const [reqRes, runRes, logRes] = await Promise.all([
    supabase.from('requests').select(REQUEST_COLS).eq('id', id).maybeSingle(),
    supabase.from('workflow_runs').select(RUN_COLS)
      .eq('trigger_entity_type', 'request').eq('trigger_entity_id', id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('execution_logs').select(LOG_COLS)
      .eq('context_type', 'request').eq('context_id', id)
      .order('occurred_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  if (!reqRes.data) notFound()
  const req = reqRes.data as unknown as RequestRow
  const run = (runRes.data ?? null) as unknown as WorkflowRunRow | null
  const latestLog = (logRes.data ?? null) as unknown as LogRow | null

  // Phase 2: background job (depends on run)
  let job: JobRow | null = null

  if (run) {
    if (run.background_job_id) {
      const jobRes = await supabase.from('background_jobs').select(JOB_COLS)
        .eq('id', run.background_job_id).maybeSingle()
      job = (jobRes.data ?? null) as unknown as JobRow | null
    }
  } else {
    // No run yet — surface a queued/processing job if one is waiting.
    const jobRes = await supabase.from('background_jobs').select(JOB_COLS)
      .eq('related_request_id', id).eq('job_type', 'workflow_step')
      .in('status', ['queued', 'processing', 'retrying'])
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    job = (jobRes.data ?? null) as unknown as JobRow | null
  }

  // Trigger status (Sprint 5.9) — drives history + manual-start eligibility.
  const triggerStatus = await getRequestTriggerStatus(supabase, {
    id: req.id, project_id: req.project_id, routed_department_id: req.routed_department_id,
  })
  const roleAllowed = TRIGGER_ROLES.has(context.role)

  // ── workflow status summary (Sprint 5.11) ──
  let workflowStatus: { label: string; color: string }
  if (run) workflowStatus = { label: run.status, color: RUN_STATUS_COLOR[run.status] ?? '#6b7280' }
  else if (job) workflowStatus = { label: `job ${job.status}`, color: '#6b7280' }
  else workflowStatus = { label: 'none', color: '#9ca3af' }

  const runEndedAt = run ? (run.completed_at ?? run.failed_at) : null
  const runDuration = run ? durationStr(run.started_at, runEndedAt) : '—'

  // Safe deep-links only: task/work-packet detail routes don't exist, so link to
  // the list pages and only when an id is actually present (never a broken link).
  const acc = (run?.accumulated ?? {}) as Record<string, unknown>
  const taskId = typeof acc.task_id === 'string' ? acc.task_id : null
  const wpId   = typeof acc.work_packet_id === 'string' ? acc.work_packet_id : null

  // Concise outcome line for the latest run.
  let outcomeLine: { text: string; color: string } | null = null
  if (run?.status === 'failed') outcomeLine = { text: `Failed at ${run.current_step_id ?? 'unknown step'}: ${run.error_message ?? 'unknown error'}`, color: '#dc2626' }
  else if (run?.status === 'cancelled') outcomeLine = { text: 'Run was cancelled.', color: '#9ca3af' }
  else if (run?.status === 'completed') outcomeLine = { text: 'Workflow completed successfully.', color: '#16a34a' }

  const s = {
    page:    { padding: '24px', fontFamily: 'monospace', maxWidth: 1000 } as React.CSSProperties,
    header:  { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' as const } as React.CSSProperties,
    h1:      { fontSize: 20, fontWeight: 700, margin: 0 } as React.CSSProperties,
    back:    { fontSize: 13, color: '#6b7280', textDecoration: 'none' } as React.CSSProperties,
    badge:   (c: string): React.CSSProperties => ({ display: 'inline-block', padding: '3px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700, color: '#fff', background: c }),
    section: { marginBottom: 24 } as React.CSSProperties,
    h2:      { fontSize: 14, fontWeight: 700, color: '#374151', margin: '0 0 10px' } as React.CSSProperties,
    grid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 16 } as React.CSSProperties,
    label:   { fontSize: 11, color: '#6b7280', marginBottom: 2 } as React.CSSProperties,
    val:     { fontSize: 13 } as React.CSSProperties,
    link:    { color: '#2563eb', textDecoration: 'none' } as React.CSSProperties,
    empty:   { color: '#9ca3af', fontSize: 13 } as React.CSSProperties,
    table:   { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 } as React.CSSProperties,
    th:      { textAlign: 'left' as const, padding: '7px 10px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151', background: '#f9fafb' } as React.CSSProperties,
    td:      { padding: '7px 10px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' as const } as React.CSSProperties,
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/requests" style={s.back}>← Requests</Link>
        <h1 style={s.h1}>Request Detail</h1>
        <span style={s.badge(workflowStatus.color)}>workflow: {workflowStatus.label}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      {/* Request fields */}
      <div style={s.section}>
        <h2 style={s.h2}>Request</h2>
        <div style={s.grid}>
          <div><div style={s.label}>Request ID</div><div style={{ ...s.val, wordBreak: 'break-all' }}><code>{req.id}</code></div></div>
          <div><div style={s.label}>Status</div><div style={s.val}>{req.status}</div></div>
          <div><div style={s.label}>Source</div><div style={s.val}>{req.source}</div></div>
          <div style={{ gridColumn: '1 / -1' }}><div style={s.label}>Intent</div><div style={s.val}>{req.intent}</div></div>
          <div><div style={s.label}>Department</div><div style={s.val}><code>{req.routed_department_id ?? '—'}</code></div></div>
          <div><div style={s.label}>Project</div><div style={s.val}><code>{req.project_id ?? '—'}</code></div></div>
          <div><div style={s.label}>Submitted</div><div style={s.val}>{fmt(req.submitted_at)}</div></div>
        </div>
      </div>

      {/* Latest Workflow summary (Sprint 5.11) */}
      <div style={s.section}>
        <h2 style={s.h2}>Latest Workflow</h2>
        {!run ? (
          <div style={s.empty}>
            {job ? `A workflow job is ${job.status}; no run row yet.` : 'No workflow has run for this request yet.'}
          </div>
        ) : (
          <>
            {outcomeLine && (
              <p style={{ ...s.val, color: outcomeLine.color, margin: '0 0 12px', wordBreak: 'break-word' }}>
                {outcomeLine.text}
              </p>
            )}
            <div style={s.grid}>
              <div><div style={s.label}>Status</div><div style={s.val}><span style={s.badge(workflowStatus.color)}>{run.status}</span></div></div>
              <div><div style={s.label}>Workflow Run</div><div style={s.val}><Link href={`/workflow-runs/${run.id}`} style={s.link}>{run.id.slice(0, 8)}… ({run.workflow_id})</Link></div></div>
              <div><div style={s.label}>Background Job</div><div style={s.val}>{job ? <Link href="/background-jobs" style={s.link}>{job.id.slice(0, 8)}… ({job.status})</Link> : <span style={s.empty}>—</span>}</div></div>
              <div><div style={s.label}>Current Step</div><div style={s.val}>{run.current_step_id ?? '—'}{run.current_step_index !== null ? ` (#${run.current_step_index})` : ''}</div></div>
              <div><div style={s.label}>Retry Count</div><div style={s.val}>{run.retry_count}</div></div>
              <div><div style={s.label}>Started</div><div style={s.val}>{fmt(run.started_at)}</div></div>
              <div><div style={s.label}>Completed</div><div style={s.val}>{fmt(runEndedAt)}</div></div>
              <div><div style={s.label}>Duration</div><div style={s.val}>{runDuration}</div></div>
              <div><div style={s.label}>Recovery Available</div><div style={s.val}>{triggerStatus.recovery_available ? `yes${triggerStatus.recommended_action ? ` (${triggerStatus.recommended_action})` : ''}` : 'no'}</div></div>
              <div><div style={s.label}>Task</div><div style={s.val}>{taskId ? <Link href={`/tasks/${taskId}`} style={s.link}>{taskId.slice(0, 8)}…</Link> : <span style={s.empty}>—</span>}</div></div>
              <div><div style={s.label}>Work Packet</div><div style={s.val}>{wpId ? <Link href={`/work-packets/${wpId}`} style={s.link}>{wpId.slice(0, 8)}…</Link> : <span style={s.empty}>—</span>}</div></div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div style={s.label}>Latest Execution</div>
                <div style={s.val}>{latestLog ? <><code>{latestLog.event_type}</code> — {latestLog.summary ?? '—'} <span style={{ color: '#9ca3af' }}>({fmt(latestLog.occurred_at)})</span></> : <span style={s.empty}>—</span>}</div>
              </div>
              {run.status === 'failed' && run.error_message && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={s.label}>Latest Error</div>
                  <div style={{ ...s.val, color: '#dc2626', wordBreak: 'break-word' }}>{run.error_message}</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Workflow Recovery (Sprint 5.11) — reuses the existing recovery API */}
      <div id="recovery" style={s.section}>
        <h2 style={s.h2}>Workflow Recovery</h2>
        <RequestWorkflowRecovery
          runId={run?.id ?? null}
          eligibility={triggerStatus.eligibility}
          canRecover={roleAllowed}
          recommendedAction={triggerStatus.recommended_action}
        />
      </div>

      {/* Workflow Actions (Sprint 5.9 / polished 5.10) */}
      <div style={s.section}>
        <h2 style={s.h2}>Workflow Actions</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
          Request fields above are this request&apos;s stored values. Inputs supplied here are used to
          run <code>request_to_task</code>; any missing department/project you choose are saved back onto the request.
        </p>
        <div style={{ ...s.grid, gridTemplateColumns: '1fr' }}>
          <div>
            <div style={s.label}>Latest Trigger Reason</div>
            <div style={s.val}>
              {latestLog
                ? <>{latestLog.summary ?? '—'} <span style={{ color: '#9ca3af' }}>({fmt(latestLog.occurred_at)})</span></>
                : <span style={s.empty}>no trigger recorded yet</span>}
            </div>
          </div>
          <RequestWorkflowActions
            requestId={req.id}
            roleAllowed={roleAllowed}
            hasActiveWorkflow={triggerStatus.has_active_workflow}
            missingInputs={triggerStatus.missing_inputs}
            defaultProjectId={req.project_id ?? ''}
            defaultDepartmentId={req.routed_department_id ?? ''}
          />
        </div>
      </div>

      {/* Recovery History (Sprint 5.11) — workflow_runs lineage, newest first */}
      <div style={s.section}>
        <h2 style={s.h2}>Recovery History ({triggerStatus.recent_runs.length})</h2>
        {triggerStatus.recent_runs.length === 0 ? (
          <div style={s.empty}>No workflow runs for this request yet.</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Run</th>
                <th style={s.th}>Parent</th>
                <th style={s.th}>Action</th>
                <th style={s.th}>Retries</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Started</th>
                <th style={s.th}>Ended</th>
              </tr>
            </thead>
            <tbody>
              {triggerStatus.recent_runs.map(r => (
                <tr key={r.id}>
                  <td style={s.td}><Link href={`/workflow-runs/${r.id}`} style={s.link}>{r.id.slice(0, 8)}…</Link></td>
                  <td style={s.td}>
                    {r.parent_run_id
                      ? <Link href={`/workflow-runs/${r.parent_run_id}`} style={s.link}>{r.parent_run_id.slice(0, 8)}…</Link>
                      : <span style={s.empty}>—</span>}
                  </td>
                  <td style={s.td}><code>{deriveAction(r.parent_run_id, r.retry_count)}</code></td>
                  <td style={s.td}>{r.retry_count}</td>
                  <td style={s.td}>
                    <span style={s.badge(RUN_STATUS_COLOR[r.status as WorkflowRunStatus] ?? '#6b7280')}>{r.status}</span>
                  </td>
                  <td style={s.td}>{fmtShort(r.started_at)}</td>
                  <td style={s.td}>{fmtShort(r.completed_at ?? r.failed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
