import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import type { WorkflowRunSummary, WorkflowRunStatus } from '@/types/workflow-runs'

const RUN_LIST_COLS = [
  'id', 'organization_id', 'workflow_id', 'workflow_version',
  'background_job_id', 'parent_run_id', 'status',
  'trigger_type', 'trigger_entity_type', 'trigger_entity_id',
  'started_at', 'completed_at', 'failed_at',
  'current_step_id', 'current_step_index',
  'retry_count', 'error_message',
  'created_at', 'updated_at',
].join(', ')

const STATUS_COLOR: Record<WorkflowRunStatus, string> = {
  pending:   '#6b7280',
  running:   '#2563eb',
  completed: '#16a34a',
  failed:    '#dc2626',
  cancelled: '#9ca3af',
  resuming:  '#d97706',
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function durationStr(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return '—'
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

const VALID_STATUSES: WorkflowRunStatus[] =
  ['pending', 'running', 'completed', 'failed', 'cancelled', 'resuming']

export default async function WorkflowRunsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const supabase = await createClient()
  let context
  try {
    context = await resolveUserContext(supabase)
  } catch {
    redirect('/login')
  }

  const sp = await searchParams
  const statusFilter = (VALID_STATUSES as string[]).includes(sp.status ?? '')
    ? (sp.status as WorkflowRunStatus)
    : null

  let runsQuery = supabase.from('workflow_runs').select(RUN_LIST_COLS)
    .order('created_at', { ascending: false }).limit(100)
  if (statusFilter) runsQuery = runsQuery.eq('status', statusFilter)

  const [
    runsRes,
    pendingRes, runningRes, completedRes,
    failedRes, cancelledRes, resumingRes,
  ] = await Promise.all([
    runsQuery,
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'running'),
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'cancelled'),
    supabase.from('workflow_runs').select('*', { count: 'exact', head: true }).eq('status', 'resuming'),
  ])

  const runs = (runsRes.data ?? []) as unknown as WorkflowRunSummary[]

  const summaryCards = [
    { label: 'Pending',   status: 'pending'   as const, value: pendingRes.count   ?? 0, color: STATUS_COLOR.pending   },
    { label: 'Running',   status: 'running'   as const, value: runningRes.count   ?? 0, color: STATUS_COLOR.running   },
    { label: 'Completed', status: 'completed' as const, value: completedRes.count ?? 0, color: STATUS_COLOR.completed },
    { label: 'Failed',    status: 'failed'    as const, value: failedRes.count    ?? 0, color: STATUS_COLOR.failed    },
    { label: 'Cancelled', status: 'cancelled' as const, value: cancelledRes.count ?? 0, color: STATUS_COLOR.cancelled },
    { label: 'Resuming',  status: 'resuming'  as const, value: resumingRes.count  ?? 0, color: STATUS_COLOR.resuming  },
  ]

  const s = {
    page:      { padding: '24px', fontFamily: 'monospace', maxWidth: 1400 } as React.CSSProperties,
    header:    { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 } as React.CSSProperties,
    h1:        { fontSize: 20, fontWeight: 700, margin: 0 } as React.CSSProperties,
    back:      { fontSize: 13, color: '#6b7280', textDecoration: 'none' } as React.CSSProperties,
    cards:     { display: 'flex', gap: 12, flexWrap: 'wrap' as const, marginBottom: 24 } as React.CSSProperties,
    card:      { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 18px', minWidth: 80 } as React.CSSProperties,
    cardVal:   { fontSize: 24, fontWeight: 700, lineHeight: 1 } as React.CSSProperties,
    cardLabel: { fontSize: 11, color: '#6b7280', marginTop: 4 } as React.CSSProperties,
    table:     { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 } as React.CSSProperties,
    th:        { textAlign: 'left' as const, padding: '8px 12px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151' } as React.CSSProperties,
    td:        { padding: '8px 12px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' as const } as React.CSSProperties,
    empty:     { padding: 32, textAlign: 'center' as const, color: '#9ca3af' } as React.CSSProperties,
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/" style={s.back}>← Home</Link>
        <h1 style={s.h1}>Workflow Runs</h1>
        {statusFilter && (
          <span style={{ fontSize: 12, color: '#374151' }}>
            filtered: <b>{statusFilter}</b>{' '}
            <Link href="/workflow-runs" style={{ color: '#2563eb', textDecoration: 'none' }}>clear</Link>
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      <div style={s.cards}>
        {summaryCards.map(c => (
          <Link
            key={c.label}
            href={`/workflow-runs?status=${c.status}`}
            style={{ ...s.card, textDecoration: 'none', color: 'inherit', outline: statusFilter === c.status ? `2px solid ${c.color}` : 'none' }}
          >
            <div style={{ ...s.cardVal, color: c.color }}>{c.value}</div>
            <div style={s.cardLabel}>{c.label}</div>
          </Link>
        ))}
      </div>

      {runsRes.error && (
        <p style={{ color: '#dc2626', marginBottom: 16 }}>
          Failed to load workflow runs: {runsRes.error.message}
        </p>
      )}

      {runs.length === 0 ? (
        <div style={s.empty}>No workflow runs found.</div>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Run ID</th>
              <th style={s.th}>Workflow</th>
              <th style={s.th}>Status</th>
              <th style={s.th}>Current Step</th>
              <th style={s.th}>Trigger</th>
              <th style={s.th}>Started</th>
              <th style={s.th}>Ended</th>
              <th style={s.th}>Duration</th>
              <th style={s.th}>Job</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(run => {
              const endedAt = run.completed_at ?? run.failed_at
              const badgeStyle: React.CSSProperties = {
                display: 'inline-block', padding: '2px 8px', borderRadius: 4,
                fontSize: 11, fontWeight: 700, color: '#fff',
                background: STATUS_COLOR[run.status] ?? '#6b7280',
              }
              return (
                <tr key={run.id}>
                  <td style={s.td}>
                    <Link
                      href={`/workflow-runs/${run.id}`}
                      style={{ color: '#2563eb', textDecoration: 'none' }}
                    >
                      {run.id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td style={s.td}><code>{run.workflow_id}</code></td>
                  <td style={s.td}><span style={badgeStyle}>{run.status}</span></td>
                  <td style={s.td}>{run.current_step_id ?? '—'}</td>
                  <td style={s.td}>
                    {run.trigger_entity_type
                      ? (
                        <>
                          <code>{run.trigger_entity_type}</code>
                          {' '}
                          <code style={{ color: '#9ca3af' }}>
                            {run.trigger_entity_id ? run.trigger_entity_id.slice(0, 8) + '…' : ''}
                          </code>
                        </>
                      )
                      : (run.trigger_type ?? '—')
                    }
                  </td>
                  <td style={s.td}>{fmt(run.started_at)}</td>
                  <td style={s.td}>{fmt(endedAt)}</td>
                  <td style={s.td}>{durationStr(run.started_at, endedAt)}</td>
                  <td style={s.td}>
                    {run.background_job_id
                      ? (
                        <Link href="/background-jobs" style={{ color: '#6b7280', fontSize: 12 }}>
                          {run.background_job_id.slice(0, 8)}…
                        </Link>
                      )
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
  )
}
