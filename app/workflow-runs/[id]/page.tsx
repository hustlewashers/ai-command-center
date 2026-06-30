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
import { EntityHeader, MetaGrid, TraceLinks, JsonPreview, ds } from '@/components/detail'
import type { MetaItem } from '@/components/detail'
import { formatMs, jsonPreview, shortId } from '@/lib/ui/format'
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

// Page-specific: this diagnostic page shows SECONDS precision (the shared
// formatDate omits seconds), so it keeps its own timestamp formatter.
function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
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

  // AI step highlighting (Sprint 6.2): call_ai steps + token/latency from the
  // agent:ai 'completed' execution log (output_payload carries prompt/model/confidence).
  const aiSteps = steps.filter(st => st.step_type === 'call_ai')
  const aiCompletedLog = logs.find(l =>
    l.actor === 'agent:ai' && (l.metadata as Record<string, unknown> | null)?.['phase'] === 'completed')
  const aiLogMeta = (aiCompletedLog?.metadata ?? {}) as Record<string, unknown>

  const runFields: MetaItem[] = [
    { label: 'Run ID', value: <code style={{ wordBreak: 'break-all' }}>{run.id}</code> },
    { label: 'Workflow', value: <code>{run.workflow_id}</code> },
    { label: 'Version', value: run.workflow_version },
    { label: 'Status', value: <span style={runBadge}>{run.status}</span> },
    { label: 'Started', value: fmt(run.started_at) },
    { label: 'Ended', value: fmt(endedAt) },
    { label: 'Duration', value: totalMs !== null ? formatMs(totalMs) : '—' },
    { label: 'Current Step', value: `${run.current_step_id ?? '—'}${run.current_step_index !== null ? ` (#${run.current_step_index})` : ''}` },
    { label: 'Retry Count', value: run.retry_count },
    { label: 'Trigger Type', value: run.trigger_type ?? '—' },
    { label: 'Trigger Entity', value: run.trigger_entity_type
        ? <><code>{run.trigger_entity_type}</code> <code style={{ color: '#9ca3af', fontSize: 11 }}>{run.trigger_entity_id ?? '—'}</code></>
        : '—' },
    { label: 'Background Job', value: run.background_job_id ? <Link href="/background-jobs" style={ds.link}>{shortId(run.background_job_id, 16)}</Link> : '—' },
    ...(run.parent_run_id ? [{ label: 'Parent Run', value: <Link href={`/workflow-runs/${run.parent_run_id}`} style={ds.link}>{shortId(run.parent_run_id, 16)}</Link> }] as MetaItem[] : []),
    { label: 'Created', value: fmt(run.created_at) },
  ]

  return (
    <div style={{ ...ds.page, maxWidth: 1200 }}>
      <EntityHeader
        title="Run Detail"
        backHref="/workflow-runs"
        backLabel="← Workflow Runs"
        actions={<span style={runBadge}>{run.status}</span>}
        right={context.role}
      />

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
        <h2 style={ds.h2}>Run Summary</h2>
        <MetaGrid items={runFields} />
      </div>

      {/* Linked entities from accumulated (TraceLinks; renders nothing if none) */}
      {(linkedTaskId || linkedWpId) && (
        <div style={{ ...s.section, display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ ...ds.h2, margin: 0 }}>Linked Entities</h2>
          <TraceLinks links={[
            { type: 'task', id: linkedTaskId },
            { type: 'work_packet', id: linkedWpId },
          ]} />
        </div>
      )}

      {/* Step Timeline — bespoke table kept intentionally (per-step diagnostics) */}
      <div style={s.section}>
        <h2 style={ds.h2}>Step Timeline ({steps.length} step{steps.length !== 1 ? 's' : ''})</h2>
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
                const isAi = step.step_type === 'call_ai'
                return (
                  <tr key={step.id} style={isAi ? { background: '#eff6ff' } : undefined}>
                    <td style={s.td}>{step.step_index}</td>
                    <td style={s.td}><code>{step.step_id}</code></td>
                    <td style={s.td}>
                      <code>{step.step_type}</code>
                      {isAi && <span style={{ marginLeft: 6, background: '#2563eb', color: '#fff', borderRadius: 3, padding: '1px 5px', fontSize: 10, fontWeight: 700 }}>AI</span>}
                    </td>
                    <td style={s.td}><span style={stepBadge}>{step.status}</span></td>
                    <td style={s.td}>{formatMs(step.duration_ms)}</td>
                    <td style={s.td}>{fmt(step.started_at)}</td>
                    <td style={s.td}>{fmt(step.completed_at)}</td>
                    <td style={s.td}>{step.retry_count}</td>
                    <td style={s.td}>
                      {step.output_payload && Object.keys(step.output_payload).length > 0
                        ? <pre style={s.pre}>{jsonPreview(step.output_payload, 400)}</pre>
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

      {/* AI Step Detail (Sprint 6.2) — only when a call_ai step exists */}
      {aiSteps.map(step => {
        const op = (step.output_payload ?? {}) as Record<string, unknown>
        const aiResult = (op['ai_result'] ?? {}) as Record<string, unknown>
        const aiFields: MetaItem[] = [
          { label: 'Step', value: <code>{step.step_id}</code> },
          { label: 'Status', value: step.status },
          { label: 'Prompt', value: <code>{(op['prompt_id'] as string) ?? '—'}</code> },
          { label: 'Model', value: <code>{(op['model'] as string) ?? '—'}</code> },
          { label: 'Confidence', value: typeof op['confidence'] === 'number' ? String(op['confidence']) : '—' },
          { label: 'Risk Level', value: <code>{(aiResult['risk_level'] as string) ?? '—'}</code> },
          { label: 'Total Tokens', value: typeof aiLogMeta['total_tokens'] === 'number' ? (aiLogMeta['total_tokens'] as number).toLocaleString() : '—' },
          { label: 'Latency', value: typeof aiLogMeta['latency_ms'] === 'number' ? formatMs(aiLogMeta['latency_ms'] as number) : '—' },
          { label: 'Validation', value: Object.keys(aiResult).length > 0 ? 'passed (schema-validated)' : '—' },
          { label: 'Mocked', value: aiLogMeta['mocked'] === true ? 'yes (no OPENAI_API_KEY)' : 'no' },
        ]
        return (
          <div key={step.id} style={s.section}>
            <h2 style={ds.h2}>AI Step Detail — {step.step_id}</h2>
            <MetaGrid items={aiFields} />
            <div style={{ marginTop: 12 }}>
              <div style={{ ...ds.label, marginBottom: 4 }}>AI Result (validated)</div>
              <JsonPreview value={aiResult} max={1200} />
            </div>
          </div>
        )
      })}

      {/* Execution Logs — bespoke table kept intentionally */}
      <div style={s.section}>
        <h2 style={ds.h2}>Execution Logs ({logs.length})</h2>
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

// Page-specific styles: wider section spacing + the two bespoke diagnostic tables.
const s: Record<string, React.CSSProperties> = {
  section: { marginBottom: 28 },
  errBox:  { background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 14px', marginBottom: 20 },
  errMsg:  { color: '#dc2626', fontSize: 13, margin: 0, wordBreak: 'break-all' },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:      { textAlign: 'left', padding: '7px 10px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151', background: '#f9fafb' },
  td:      { padding: '7px 10px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' },
  pre:     { margin: 0, fontSize: 11, background: '#f3f4f6', padding: '4px 6px', borderRadius: 3, maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
  empty:   { padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 13 },
}
