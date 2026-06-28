import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { listWorkflows } from '@/lib/workflows/registry'
import type { JobStatus } from '@/types/jobs'

const JOB_COLS = [
  'id', 'job_type', 'status', 'priority',
  'retry_count', 'max_retries', 'last_error',
  'scheduled_for', 'started_at', 'completed_at',
  'created_at',
].join(', ')

type JobRow = {
  id: string
  job_type: string
  status: JobStatus
  priority: number
  retry_count: number
  max_retries: number
  last_error: string | null
  scheduled_for: string | null
  started_at: string | null
  completed_at: string | null
  created_at: string
}

type MetricRow = {
  value_int: number | null
  recorded_at: string
}

const STATUS_COLOR: Record<JobStatus, string> = {
  queued:     '#6b7280',
  processing: '#2563eb',
  completed:  '#16a34a',
  failed:     '#dc2626',
  cancelled:  '#9ca3af',
  retrying:   '#d97706',
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const s = {
  page:      { padding: '24px', fontFamily: 'monospace', maxWidth: 1200 } as React.CSSProperties,
  header:    { display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20 } as React.CSSProperties,
  h1:        { fontSize: 20, fontWeight: 700, margin: 0 } as React.CSSProperties,
  back:      { fontSize: 13, color: '#6b7280', textDecoration: 'none' } as React.CSSProperties,
  cards:     { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 } as React.CSSProperties,
  card:      { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 18px', minWidth: 90 } as React.CSSProperties,
  cardVal:   { fontSize: 24, fontWeight: 700, lineHeight: 1 } as React.CSSProperties,
  cardLabel: { fontSize: 11, color: '#6b7280', marginTop: 4 } as React.CSSProperties,
  table:     { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th:        { textAlign: 'left' as const, padding: '8px 12px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151' },
  td:        { padding: '8px 12px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' as const },
  badge:     (status: JobStatus): React.CSSProperties => ({
    display: 'inline-block', padding: '2px 8px', borderRadius: 4,
    fontSize: 11, fontWeight: 700, color: '#fff',
    background: STATUS_COLOR[status] ?? '#6b7280',
  }),
  errText:   { color: '#dc2626', fontSize: 12, maxWidth: 300, wordBreak: 'break-all' as const },
  empty:     { padding: 32, textAlign: 'center' as const, color: '#9ca3af' },
}

const workflows = listWorkflows()

export default async function BackgroundJobsPage() {
  const supabase = await createClient()

  let context
  try {
    context = await resolveUserContext(supabase)
  } catch {
    redirect('/login')
  }

  // Run all queries in parallel
  const [
    jobsRes,
    queuedRes, processingRes, retryingRes,
    completedRes, failedRes, cancelledRes,
    dlqRes, lastRunRes,
  ] = await Promise.all([
    supabase.from('background_jobs').select(JOB_COLS).order('created_at', { ascending: false }).limit(100),
    supabase.from('background_jobs').select('*', { count: 'exact', head: true }).eq('status', 'queued'),
    supabase.from('background_jobs').select('*', { count: 'exact', head: true }).eq('status', 'processing'),
    supabase.from('background_jobs').select('*', { count: 'exact', head: true }).eq('status', 'retrying'),
    supabase.from('background_jobs').select('*', { count: 'exact', head: true }).eq('status', 'completed'),
    supabase.from('background_jobs').select('*', { count: 'exact', head: true }).eq('status', 'failed'),
    supabase.from('background_jobs').select('*', { count: 'exact', head: true }).eq('status', 'cancelled'),
    supabase.from('dead_letter_queue').select('*', { count: 'exact', head: true }).eq('resolution_status', 'pending_review'),
    supabase.from('runtime_metrics').select('value_int, recorded_at')
      .eq('metric_name', 'worker_run_completed')
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const jobs: JobRow[] = jobsRes.error ? [] : ((jobsRes.data ?? []) as unknown as JobRow[])
  const lastRun = lastRunRes.data as MetricRow | null

  const counts = {
    queued:     queuedRes.count     ?? 0,
    processing: processingRes.count ?? 0,
    retrying:   retryingRes.count   ?? 0,
    completed:  completedRes.count  ?? 0,
    failed:     failedRes.count     ?? 0,
    cancelled:  cancelledRes.count  ?? 0,
    dlq:        dlqRes.count        ?? 0,
  }

  const summaryCards: { label: string; value: string | number; color: string }[] = [
    { label: 'Queued',     value: counts.queued,     color: '#6b7280' },
    { label: 'Processing', value: counts.processing, color: '#2563eb' },
    { label: 'Retrying',   value: counts.retrying,   color: '#d97706' },
    { label: 'Completed',  value: counts.completed,  color: '#16a34a' },
    { label: 'Failed',     value: counts.failed,     color: '#dc2626' },
    { label: 'Cancelled',  value: counts.cancelled,  color: '#9ca3af' },
    { label: 'DLQ',        value: counts.dlq,        color: '#7c3aed' },
    ...(lastRun ? [{ label: 'Last Run', value: fmt(lastRun.recorded_at), color: '#374151' }] : []),
  ]

  return (
    <div style={s.page}>
      <div style={s.header}>
        <Link href="/" style={s.back}>← Home</Link>
        <h1 style={s.h1}>Background Jobs</h1>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {context.role}
        </span>
      </div>

      {/* Runtime summary cards */}
      <div style={s.cards}>
        {summaryCards.map(c => (
          <div key={c.label} style={s.card}>
            <div style={{ ...s.cardVal, color: c.color }}>{c.value}</div>
            <div style={s.cardLabel}>{c.label}</div>
          </div>
        ))}
      </div>

      {jobsRes.error && (
        <p style={{ color: '#dc2626', marginBottom: 16 }}>
          Failed to load jobs: {jobsRes.error.message}
        </p>
      )}

      {/* In-code workflow registry */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 10 }}>
          Workflow Registry ({workflows.length} in-code)
        </h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' as const }}>
          {workflows.map(wf => (
            <div key={wf.id} style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '10px 14px', minWidth: 220 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d' }}>{wf.name}</div>
              <div style={{ fontSize: 11, color: '#6b7280', margin: '3px 0' }}>{wf.id}</div>
              <div style={{ fontSize: 12, color: '#374151' }}>{wf.description}</div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{wf.steps.length} steps</div>
            </div>
          ))}
        </div>
      </div>

      {jobs.length === 0 ? (
        <div style={s.empty}>No background jobs found.</div>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>ID</th>
              <th style={s.th}>Type</th>
              <th style={s.th}>Status</th>
              <th style={s.th}>Priority</th>
              <th style={s.th}>Retries</th>
              <th style={s.th}>Scheduled</th>
              <th style={s.th}>Started</th>
              <th style={s.th}>Completed</th>
              <th style={s.th}>Created</th>
              <th style={s.th}>Last Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => (
              <tr key={job.id}>
                <td style={s.td}>{job.id.slice(0, 8)}…</td>
                <td style={s.td}>{job.job_type}</td>
                <td style={s.td}>
                  <span style={s.badge(job.status)}>{job.status}</span>
                </td>
                <td style={s.td}>{job.priority}</td>
                <td style={s.td}>{job.retry_count}/{job.max_retries}</td>
                <td style={s.td}>{fmt(job.scheduled_for)}</td>
                <td style={s.td}>{fmt(job.started_at)}</td>
                <td style={s.td}>{fmt(job.completed_at)}</td>
                <td style={s.td}>{fmt(job.created_at)}</td>
                <td style={s.td}>
                  {job.last_error && (
                    <span style={s.errText}>{job.last_error.slice(0, 120)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
