import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getRequestTriggerStatus } from '@/lib/workflows/trigger-status'
import { EntityHeader, MetaGrid, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatDate, formatDuration, shortId } from '@/lib/ui/format'
import RequestWorkflowActions from './RequestWorkflowActions'
import RequestWorkflowRecovery from './RequestWorkflowRecovery'
import type { WorkflowRunRow, WorkflowRunStatus } from '@/types/workflow-runs'
import type { RequestRow } from '@/types/requests'

const TRIGGER_ROLES = new Set(['org_admin', 'department_lead'])

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

const JOB_COLS  = 'id, job_type, status, retry_count, max_retries, last_error, created_at'
const LOG_COLS  = 'id, event_type, actor, summary, status, occurred_at'

const RUN_STATUS_COLOR: Record<WorkflowRunStatus, string> = {
  pending: '#6b7280', running: '#2563eb', completed: '#16a34a',
  failed: '#dc2626', cancelled: '#9ca3af', resuming: '#d97706',
}

// Page-specific: a colored workflow-status pill (distinct from the neutral
// StatusBadge) used in the header and the Latest Workflow summary.
function badge(color: string): React.CSSProperties {
  return { display: 'inline-block', padding: '3px 10px', borderRadius: 4, fontSize: 12, fontWeight: 700, color: '#fff', background: color }
}

// Best-effort recovery action label from persisted run fields (not stored
// per-run): no parent = initial; parent + retry_count 0 = restart (resets);
// parent + retry_count > 0 = retry/resume (both increment). Coarse but honest.
function deriveAction(parentRunId: string | null, retryCount: number): string {
  if (!parentRunId) return 'initial'
  return retryCount === 0 ? 'restart' : 'retry/resume'
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
  const runDuration = run ? formatDuration(run.started_at, runEndedAt) : '—'

  const acc = (run?.accumulated ?? {}) as Record<string, unknown>
  const taskId = typeof acc.task_id === 'string' ? acc.task_id : null
  const wpId   = typeof acc.work_packet_id === 'string' ? acc.work_packet_id : null

  // Concise outcome line for the latest run.
  let outcomeLine: { text: string; color: string } | null = null
  if (run?.status === 'failed') outcomeLine = { text: `Failed at ${run.current_step_id ?? 'unknown step'}: ${run.error_message ?? 'unknown error'}`, color: '#dc2626' }
  else if (run?.status === 'cancelled') outcomeLine = { text: 'Run was cancelled.', color: '#9ca3af' }
  else if (run?.status === 'completed') outcomeLine = { text: 'Workflow completed successfully.', color: '#16a34a' }

  const dash = <span style={ds.empty}>—</span>

  const requestFields: MetaItem[] = [
    { label: 'Request ID', value: <code style={{ wordBreak: 'break-all' }}>{req.id}</code> },
    { label: 'Status', value: req.status },
    { label: 'Source', value: req.source },
    { label: 'Intent', value: req.intent, full: true },
    { label: 'Department', value: <code>{req.routed_department_id ?? '—'}</code> },
    { label: 'Project', value: req.project_id ? <Link href={`/projects/${req.project_id}`} style={ds.link}>{shortId(req.project_id)}</Link> : dash },
    { label: 'Submitted', value: formatDate(req.submitted_at) },
  ]

  const runFields: MetaItem[] = run ? [
    { label: 'Status', value: <span style={badge(workflowStatus.color)}>{run.status}</span> },
    { label: 'Workflow Run', value: <Link href={`/workflow-runs/${run.id}`} style={ds.link}>{shortId(run.id)} ({run.workflow_id})</Link> },
    { label: 'Background Job', value: job ? <Link href="/background-jobs" style={ds.link}>{shortId(job.id)} ({job.status})</Link> : dash },
    { label: 'Current Step', value: `${run.current_step_id ?? '—'}${run.current_step_index !== null ? ` (#${run.current_step_index})` : ''}` },
    { label: 'Retry Count', value: run.retry_count },
    { label: 'Started', value: formatDate(run.started_at) },
    { label: 'Completed', value: formatDate(runEndedAt) },
    { label: 'Duration', value: runDuration },
    { label: 'Recovery Available', value: triggerStatus.recovery_available ? `yes${triggerStatus.recommended_action ? ` (${triggerStatus.recommended_action})` : ''}` : 'no' },
    { label: 'Task', value: taskId ? <Link href={`/tasks/${taskId}`} style={ds.link}>{shortId(taskId)}</Link> : dash },
    { label: 'Work Packet', value: wpId ? <Link href={`/work-packets/${wpId}`} style={ds.link}>{shortId(wpId)}</Link> : dash },
    { label: 'Latest Execution', value: latestLog ? <><code>{latestLog.event_type}</code> — {latestLog.summary ?? '—'} <span style={{ color: '#9ca3af' }}>({formatDate(latestLog.occurred_at)})</span></> : dash, full: true },
    ...(run.status === 'failed' && run.error_message
      ? [{ label: 'Latest Error', value: <span style={{ color: '#dc2626', wordBreak: 'break-word' }}>{run.error_message}</span>, full: true }] as MetaItem[]
      : []),
  ] : []

  return (
    <div style={ds.page}>
      <EntityHeader
        title="Request Detail"
        backHref="/requests"
        backLabel="← Requests"
        actions={<span style={badge(workflowStatus.color)}>workflow: {workflowStatus.label}</span>}
        right={context.role}
      />

      <div style={ds.section}>
        <h2 style={ds.h2}>Request</h2>
        <MetaGrid items={requestFields} />
      </div>

      {/* Latest Workflow summary (Sprint 5.11) */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Latest Workflow</h2>
        {!run ? (
          <div style={ds.empty}>
            {job ? `A workflow job is ${job.status}; no run row yet.` : 'No workflow has run for this request yet.'}
          </div>
        ) : (
          <>
            {outcomeLine && (
              <p style={{ fontSize: 13, color: outcomeLine.color, margin: '0 0 12px', wordBreak: 'break-word' }}>
                {outcomeLine.text}
              </p>
            )}
            <MetaGrid items={runFields} />
          </>
        )}
      </div>

      {/* Workflow Recovery (Sprint 5.11) — reuses the existing recovery API */}
      <div id="recovery" style={ds.section}>
        <h2 style={ds.h2}>Workflow Recovery</h2>
        <RequestWorkflowRecovery
          runId={run?.id ?? null}
          eligibility={triggerStatus.eligibility}
          canRecover={roleAllowed}
          recommendedAction={triggerStatus.recommended_action}
        />
      </div>

      {/* Workflow Actions (Sprint 5.9 / polished 5.10) */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Workflow Actions</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
          Request fields above are this request&apos;s stored values. Inputs supplied here are used to
          run <code>request_to_task</code>; any missing department/project you choose are saved back onto the request.
        </p>
        <div>
          <div style={{ ...ds.label, marginBottom: 6 }}>Latest Trigger Reason</div>
          <div style={{ ...ds.val, marginBottom: 12 }}>
            {latestLog
              ? <>{latestLog.summary ?? '—'} <span style={{ color: '#9ca3af' }}>({formatDate(latestLog.occurred_at)})</span></>
              : <span style={ds.empty}>no trigger recorded yet</span>}
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

      {/* Recovery History (Sprint 5.11) — workflow_runs lineage, newest first.
          Bespoke table kept intentionally (lineage columns don't fit RelatedList). */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Recovery History ({triggerStatus.recent_runs.length})</h2>
        {triggerStatus.recent_runs.length === 0 ? (
          <div style={ds.empty}>No workflow runs for this request yet.</div>
        ) : (
          <table style={tbl.table}>
            <thead>
              <tr>
                <th style={tbl.th}>Run</th>
                <th style={tbl.th}>Parent</th>
                <th style={tbl.th}>Action</th>
                <th style={tbl.th}>Retries</th>
                <th style={tbl.th}>Status</th>
                <th style={tbl.th}>Started</th>
                <th style={tbl.th}>Ended</th>
              </tr>
            </thead>
            <tbody>
              {triggerStatus.recent_runs.map(r => (
                <tr key={r.id}>
                  <td style={tbl.td}><Link href={`/workflow-runs/${r.id}`} style={ds.link}>{shortId(r.id)}</Link></td>
                  <td style={tbl.td}>
                    {r.parent_run_id
                      ? <Link href={`/workflow-runs/${r.parent_run_id}`} style={ds.link}>{shortId(r.parent_run_id)}</Link>
                      : <span style={ds.empty}>—</span>}
                  </td>
                  <td style={tbl.td}><code>{deriveAction(r.parent_run_id, r.retry_count)}</code></td>
                  <td style={tbl.td}>{r.retry_count}</td>
                  <td style={tbl.td}>
                    <span style={badge(RUN_STATUS_COLOR[r.status as WorkflowRunStatus] ?? '#6b7280')}>{r.status}</span>
                  </td>
                  <td style={tbl.td}>{formatDate(r.started_at)}</td>
                  <td style={tbl.td}>{formatDate(r.completed_at ?? r.failed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// Page-specific table styles for the lineage history (not a RelatedList shape).
const tbl: Record<string, React.CSSProperties> = {
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:    { textAlign: 'left', padding: '7px 10px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151', background: '#f9fafb' },
  td:    { padding: '7px 10px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' },
}
