import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import type {
  WorkflowRunRow,
  WorkflowStepRunRow,
  WorkflowRunStatus,
  WorkflowStepRunStatus,
} from '@/types/workflow-runs'
import type { ExecutionLogRow } from '@/types/execution-logs'
import { getRecoveryEligibility } from '@/lib/workflows/recovery'
import WorkflowRecoveryActions from './WorkflowRecoveryActions'

const RECOVERY_ROLES = new Set(['org_admin', 'department_lead'])

const RUN_DETAIL_COLS = [
  'id', 'organization_id', 'workflow_id', 'workflow_version',
  'background_job_id', 'parent_run_id', 'status',
  'trigger_type', 'trigger_entity_type', 'trigger_entity_id',
  'inputs', 'accumulated',
  'started_at', 'completed_at', 'failed_at',
  'current_step_id', 'current_step_index',
  'retry_count', 'error_message',
  'created_at', 'updated_at',
].join(', ')

const STEP_COLS = [
  'id', 'organization_id', 'workflow_run_id',
  'step_id', 'step_index', 'step_type', 'status',
  'started_at', 'completed_at', 'duration_ms',
  'retry_count', 'input_payload', 'output_payload', 'error_message',
  'created_at',
].join(', ')

const LOG_COLS = [
  'id', 'organization_id', 'event_type', 'actor',
  'occurred_at', 'summary', 'context_type', 'context_id',
  'metadata', 'status', 'created_at',
].join(', ')

const RUN_STATUS_COLOR: Record<WorkflowRunStatus, string> = {
  pending:   '#6b7280',
  running:   '#2563eb',
  completed: '#16a34a',
  failed:    '#dc2626',
  cancelled: '#9ca3af',
  resuming:  '#d97706',
}

const STEP_STATUS_COLOR: Record<WorkflowStepRunStatus, string> = {
  pending:   '#6b7280',
  running:   '#2563eb',
  completed: '#16a34a',
  failed:    '#dc2626',
  skipped:   '#9ca3af',
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function durationStr(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function jsonPreview(obj: Record<string, unknown> | null): string {
  if (!obj || Object.keys(obj).length === 0) return '{}'
  const str = JSON.stringify(obj, null, 2)
  return str.length > 400 ? str.slice(0, 400) + '\n…' : str
}

export default async function WorkflowRunDetailPage({
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

  const [runRes, stepsRes, logsRes] = await Promise.all([
    supabase.from('workflow_runs').select(RUN_DETAIL_COLS).eq('id', id).maybeSingle(),
    supabase.from('workflow_step_runs').select(STEP_COLS)
      .eq('workflow_run_id', id)
      .order('step_index', { ascending: true })
      .order('retry_count', { ascending: true }),
    supabase.from('execution_logs').select(LOG_COLS)
      .filter('metadata->>workflow_run_id', 'eq', id)
      .order('occurred_at', { ascending: true })
      .limit(50),
  ])

  if (!runRes.data) notFound()

  const run    = runRes.data  as unknown as WorkflowRunRow
  const steps  = (stepsRes.data ?? []) as unknown as WorkflowStepRunRow[]
  const logs   = logsRes.error ? [] : (logsRes.data ?? []) as unknown as ExecutionLogRow[]

  const endedAt  = run.completed_at ?? run.failed_at
  const totalMs  = run.started_at && endedAt
    ? new Date(endedAt).getTime() - new Date(run.started_at).getTime()
    : null

  const acc          = run.accumulated ?? {}
  const linkedTaskId = typeof acc.task_id === 'string' ? acc.task_id : null
  const linkedWpId   = typeof acc.work_packet_id === 'string' ? acc.work_packet_id : null

  // Recovery affordances (Sprint 5.7). Eligibility is computed from run state;
  // role gates whether the buttons are actionable (the API enforces it too).
  const eligibility = getRecoveryEligibility(run)
  const canRecover  = RECOVERY_ROLES.has(context.role)

  const runBadge: React.CSSProperties = {
    display: 'inline-block', padding: '3px 10px', borderRadius: 4,
    fontSize: 12, fontWeight: 700, color: '#fff',
    background: RUN_STATUS_COLOR[run.status] ?? '#6b7280',
  }

  const s = {
    page:      { padding: '24px', fontFamily: 'monospace', maxWidth: 1200 } as React.CSSProperties,
    header:    { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' as const } as React.CSSProperties,
    h1:        { fontSize: 20, fontWeight: 700, margin: 0 } as React.CSSProperties,
    back:      { fontSize: 13, color: '#6b7280', textDecoration: 'none' } as React.CSSProperties,
    section:   { marginBottom: 28 } as React.CSSProperties,
    sectionH:  { fontSize: 14, fontWeight: 700, color: '#374151', margin: '0 0 10px' } as React.CSSProperties,
    metaGrid:  { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 16 } as React.CSSProperties,
    metaLabel: { fontSize: 11, color: '#6b7280', marginBottom: 2 } as React.CSSProperties,
    metaVal:   { fontSize: 13 } as React.CSSProperties,
    errBox:    { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', marginBottom: 20 } as React.CSSProperties,
    errMsg:    { color: '#dc2626', fontSize: 13, margin: 0, wordBreak: 'break-all' as const } as React.CSSProperties,
    table:     { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 } as React.CSSProperties,
    th:        { textAlign: 'left' as const, padding: '7px 10px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151', background: '#f9fafb' } as React.CSSProperties,
    td:        { padding: '7px 10px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' as const } as React.CSSProperties,
    pre:       { margin: 0, fontSize: 11, background: '#f3f4f6', padding: '4px 6px', borderRadius: 3, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-all' as const } as React.CSSProperties,
    empty:     { padding: 20, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 } as React.CSSProperties,
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/workflow-runs" style={s.back}>← Workflow Runs</Link>
        <h1 style={s.h1}>Run Detail</h1>
        <span style={runBadge}>{run.status}</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      {run.error_message && (
        <div style={s.errBox}>
          <p style={s.errMsg}><strong>Error:</strong> {run.error_message}</p>
        </div>
      )}

      {/* Recovery actions (Sprint 5.7) */}
      <WorkflowRecoveryActions
        runId={run.id}
        eligibility={eligibility}
        canRecover={canRecover}
      />

      {/* Run Summary */}
      <div style={s.section}>
        <h2 style={s.sectionH}>Run Summary</h2>
        <div style={s.metaGrid}>
          <div>
            <div style={s.metaLabel}>Run ID</div>
            <div style={{ ...s.metaVal, wordBreak: 'break-all' }}><code>{run.id}</code></div>
          </div>
          <div>
            <div style={s.metaLabel}>Workflow</div>
            <div style={s.metaVal}><code>{run.workflow_id}</code></div>
          </div>
          <div>
            <div style={s.metaLabel}>Version</div>
            <div style={s.metaVal}>{run.workflow_version}</div>
          </div>
          <div>
            <div style={s.metaLabel}>Status</div>
            <div style={s.metaVal}><span style={runBadge}>{run.status}</span></div>
          </div>
          <div>
            <div style={s.metaLabel}>Started</div>
            <div style={s.metaVal}>{fmt(run.started_at)}</div>
          </div>
          <div>
            <div style={s.metaLabel}>Ended</div>
            <div style={s.metaVal}>{fmt(endedAt)}</div>
          </div>
          <div>
            <div style={s.metaLabel}>Duration</div>
            <div style={s.metaVal}>{totalMs !== null ? durationStr(totalMs) : '—'}</div>
          </div>
          <div>
            <div style={s.metaLabel}>Current Step</div>
            <div style={s.metaVal}>
              {run.current_step_id ?? '—'}
              {run.current_step_index !== null ? ` (#${run.current_step_index})` : ''}
            </div>
          </div>
          <div>
            <div style={s.metaLabel}>Retry Count</div>
            <div style={s.metaVal}>{run.retry_count}</div>
          </div>
          <div>
            <div style={s.metaLabel}>Trigger Type</div>
            <div style={s.metaVal}>{run.trigger_type ?? '—'}</div>
          </div>
          <div>
            <div style={s.metaLabel}>Trigger Entity</div>
            <div style={s.metaVal}>
              {run.trigger_entity_type
                ? (
                  <>
                    <code>{run.trigger_entity_type}</code>
                    {' '}
                    <code style={{ color: '#9ca3af', fontSize: 11 }}>{run.trigger_entity_id ?? '—'}</code>
                  </>
                )
                : '—'
              }
            </div>
          </div>
          <div>
            <div style={s.metaLabel}>Background Job</div>
            <div style={s.metaVal}>
              {run.background_job_id
                ? <Link href="/background-jobs" style={{ color: '#2563eb' }}>{run.background_job_id.slice(0, 16)}…</Link>
                : '—'
              }
            </div>
          </div>
          {run.parent_run_id && (
            <div>
              <div style={s.metaLabel}>Parent Run</div>
              <div style={s.metaVal}>
                <Link href={`/workflow-runs/${run.parent_run_id}`} style={{ color: '#2563eb' }}>
                  {run.parent_run_id.slice(0, 16)}…
                </Link>
              </div>
            </div>
          )}
          <div>
            <div style={s.metaLabel}>Created</div>
            <div style={s.metaVal}>{fmt(run.created_at)}</div>
          </div>
        </div>
      </div>

      {/* Linked entities from accumulated */}
      {(linkedTaskId || linkedWpId) && (
        <div style={{ ...s.section, display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ ...s.sectionH, margin: 0 }}>Linked Entities</h2>
          {linkedTaskId && (
            <Link
              href={`/tasks/${linkedTaskId}`}
              style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '4px 10px', fontSize: 12, color: '#2563eb', textDecoration: 'none' }}
            >
              Task {linkedTaskId.slice(0, 8)}…
            </Link>
          )}
          {linkedWpId && (
            <Link
              href={`/work-packets/${linkedWpId}`}
              style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '4px 10px', fontSize: 12, color: '#16a34a', textDecoration: 'none' }}
            >
              Work Packet {linkedWpId.slice(0, 8)}…
            </Link>
          )}
        </div>
      )}

      {/* Step Timeline */}
      <div style={s.section}>
        <h2 style={s.sectionH}>Step Timeline ({steps.length} step{steps.length !== 1 ? 's' : ''})</h2>
        {steps.length === 0 ? (
          <div style={s.empty}>No step runs recorded.</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>#</th>
                <th style={s.th}>Step ID</th>
                <th style={s.th}>Type</th>
                <th style={s.th}>Status</th>
                <th style={s.th}>Duration</th>
                <th style={s.th}>Started</th>
                <th style={s.th}>Completed</th>
                <th style={s.th}>Retries</th>
                <th style={s.th}>Output</th>
                <th style={s.th}>Error</th>
              </tr>
            </thead>
            <tbody>
              {steps.map(step => {
                const stepBadge: React.CSSProperties = {
                  display: 'inline-block', padding: '2px 7px', borderRadius: 4,
                  fontSize: 11, fontWeight: 700, color: '#fff',
                  background: STEP_STATUS_COLOR[step.status] ?? '#6b7280',
                }
                return (
                  <tr key={step.id}>
                    <td style={s.td}>{step.step_index}</td>
                    <td style={s.td}><code>{step.step_id}</code></td>
                    <td style={s.td}><code>{step.step_type}</code></td>
                    <td style={s.td}><span style={stepBadge}>{step.status}</span></td>
                    <td style={s.td}>{durationStr(step.duration_ms)}</td>
                    <td style={s.td}>{fmt(step.started_at)}</td>
                    <td style={s.td}>{fmt(step.completed_at)}</td>
                    <td style={s.td}>{step.retry_count}</td>
                    <td style={s.td}>
                      {step.output_payload && Object.keys(step.output_payload).length > 0
                        ? <pre style={s.pre}>{jsonPreview(step.output_payload)}</pre>
                        : '—'
                      }
                    </td>
                    <td style={{ ...s.td, maxWidth: 200 }}>
                      {step.error_message
                        ? <span style={{ color: '#dc2626', fontSize: 11, wordBreak: 'break-word' }}>{step.error_message.slice(0, 150)}</span>
                        : '—'
                      }
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Execution Logs */}
      <div style={s.section}>
        <h2 style={s.sectionH}>Execution Logs ({logs.length})</h2>
        {logsRes.error && (
          <p style={{ color: '#6b7280', fontSize: 12, marginBottom: 8 }}>
            Note: log filter unavailable — {logsRes.error.message}
          </p>
        )}
        {logs.length === 0 ? (
          <div style={s.empty}>No execution logs linked to this run.</div>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Time</th>
                <th style={s.th}>Event</th>
                <th style={s.th}>Actor</th>
                <th style={s.th}>Summary</th>
                <th style={s.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id}>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}>{fmt(log.occurred_at)}</td>
                  <td style={s.td}><code>{log.event_type}</code></td>
                  <td style={{ ...s.td, whiteSpace: 'nowrap' }}><code style={{ fontSize: 11 }}>{log.actor}</code></td>
                  <td style={{ ...s.td, maxWidth: 420, wordBreak: 'break-word' }}>{log.summary ?? '—'}</td>
                  <td style={s.td}><code style={{ fontSize: 11 }}>{log.status}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
