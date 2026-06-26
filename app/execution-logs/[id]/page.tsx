import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { StatusBadge } from '@/components/ui'
import type { ExecutionLogRow } from '@/types/execution-logs'
import type { AgentActivityRow } from '@/types/agent-activity'

type Props = { params: Promise<{ id: string }> }

const LOG_COLS = [
  'id', 'organization_id', 'event_type', 'actor',
  'occurred_at', 'summary', 'context_type', 'context_id',
  'metadata', 'status', 'created_at',
].join(', ')

const ACTIVITY_COLS = 'id, activity_type, summary, status, agent_user_id, created_at'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s.field}>
      <dt style={s.dt}>{label}</dt>
      <dd style={s.dd}>{children}</dd>
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return <p style={s.muted}>{label}</p>
}

export default async function ExecutionLogDetailPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()

  let ctx = null
  try { ctx = await resolveUserContext(supabase) } catch { /* unauthenticated */ }
  if (!ctx) redirect('/login')

  const [logResult, activityResult] = await Promise.all([
    supabase.from('execution_logs').select(LOG_COLS).eq('id', id).maybeSingle(),
    supabase.from('agent_activity').select(ACTIVITY_COLS)
      .eq('execution_log_id', id)
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const log      = logResult.data as ExecutionLogRow | null
  const activity = (activityResult.data ?? []) as AgentActivityRow[]

  if (!log) notFound()

  const contextHref =
    log.context_type === 'task'    ? `/tasks` :
    log.context_type === 'request' ? `/requests` : null

  return (
    <main style={s.main}>
      <div style={s.breadcrumb}>
        <Link href="/execution-logs" style={s.breadcrumbLink}>← Execution Logs</Link>
      </div>

      <h1 style={s.h1}>Execution Log</h1>
      <p style={s.subhead}><code>{log.id}</code></p>

      {/* Core fields */}
      <section style={s.section}>
        <h2 style={s.h2}>Log Entry</h2>
        <dl style={s.dl}>
          <Field label="status"><StatusBadge status={log.status} /></Field>
          <Field label="event_type"><code>{log.event_type}</code></Field>
          <Field label="summary">{log.summary}</Field>
          <Field label="actor"><code>{log.actor}</code></Field>
          <Field label="context_type"><code>{log.context_type}</code></Field>
          <Field label="context_id">
            <code title={log.context_id}>{log.context_id}</code>
            {contextHref && (
              <Link href={`${contextHref}?id=${log.context_id}`} style={s.entityLink}>
                View {log.context_type} →
              </Link>
            )}
          </Field>
          <Field label="occurred_at">
            {new Date(log.occurred_at).toLocaleString()} <span style={s.muted}>({log.occurred_at})</span>
          </Field>
          <Field label="created_at">
            {new Date(log.created_at).toLocaleString()}
          </Field>
          <Field label="organization_id"><code>{log.organization_id}</code></Field>
        </dl>
      </section>

      {/* Metadata JSON */}
      <section style={s.section}>
        <h2 style={s.h2}>Metadata</h2>
        {Object.keys(log.metadata ?? {}).length === 0 ? (
          <p style={s.muted}>No metadata.</p>
        ) : (
          <pre style={s.pre}>{JSON.stringify(log.metadata, null, 2)}</pre>
        )}
      </section>

      {/* Related Agent Activity */}
      <section style={s.section}>
        <h2 style={s.h2}>Related Agent Activity</h2>
        {activity.length === 0 ? (
          <Empty label="No agent activity linked to this execution log." />
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                {['type', 'summary', 'status', 'agent', 'created'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {activity.map(a => (
                <tr key={a.id}>
                  <td style={s.td}><code>{a.activity_type}</code></td>
                  <td style={{ ...s.td, maxWidth: '300px' }}>{a.summary}</td>
                  <td style={s.td}><StatusBadge status={a.status} /></td>
                  <td style={s.td}>
                    <code title={a.agent_user_id ?? ''}>
                      {a.agent_user_id ? a.agent_user_id.slice(0, 8) + '…' : '—'}
                    </code>
                  </td>
                  <td style={s.td}>{new Date(a.created_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}

const s: Record<string, React.CSSProperties> = {
  main:         { fontFamily: 'monospace', padding: '2rem', maxWidth: '900px' },
  breadcrumb:   { marginBottom: '1rem' },
  breadcrumbLink:{ color: '#555', textDecoration: 'none', fontSize: '0.8rem' },
  h1:           { margin: '0 0 0.25rem', fontSize: '1.4rem' },
  subhead:      { margin: '0 0 1.5rem', color: '#666', fontSize: '0.8rem' },
  h2:           { margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 'bold' },
  section:      { marginBottom: '2rem' },
  dl:           { display: 'flex', flexDirection: 'column', gap: '0.5rem', margin: 0 },
  field:        { display: 'grid', gridTemplateColumns: '140px 1fr', gap: '0.5rem', padding: '0.3rem 0', borderBottom: '1px solid #f0f0f0' },
  dt:           { color: '#888', fontSize: '0.78rem', paddingTop: '0.1rem' },
  dd:           { margin: 0, fontSize: '0.85rem', wordBreak: 'break-word' },
  entityLink:   { marginLeft: '0.75rem', color: '#0066cc', fontSize: '0.78rem', textDecoration: 'none' },
  pre:          { background: '#f8f8f8', border: '1px solid #eee', padding: '1rem', overflowX: 'auto', fontSize: '0.78rem', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  muted:        { color: '#888', fontSize: '0.8rem', margin: 0 },
  table:        { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  th:           { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' },
  td:           { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word' },
}
