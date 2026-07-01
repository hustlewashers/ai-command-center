import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { StatusBadge } from '@/components/ui'
import { ds } from '@/components/detail'
import { formatDate, formatMs, shortId, safeText } from '@/lib/ui/format'
import {
  getAiMetricSummary,
  getRecentAiExecutionLogs,
  getRecentAiWorkflowRuns,
  getRecentAiDraftOutputs,
  getRecentAiErrors,
} from '@/lib/ai/metrics'
import { listPrompts } from '@/lib/ai/prompts'
import { listAiWorkflows } from '@/lib/ai/workflows'

// Sprint 6.2 — AI Operations. RLS-safe reads only (SSR client, never service-role).
export default async function AiOperationsPage() {
  const supabase = await createClient()
  let context
  try {
    context = await resolveUserContext(supabase)
  } catch {
    redirect('/login')
  }

  const [summary, logs, runs, outputs, errors] = await Promise.all([
    getAiMetricSummary(supabase),
    getRecentAiExecutionLogs(supabase, 20),
    getRecentAiWorkflowRuns(supabase, 20),
    getRecentAiDraftOutputs(supabase, 20),
    getRecentAiErrors(supabase, 10),
  ])
  const prompts = listPrompts()
  const aiWorkflows = listAiWorkflows()

  const cards = [
    { label: 'Executions', value: String(summary.executions), color: '#2563eb' },
    { label: 'Succeeded',  value: String(summary.success),    color: '#16a34a' },
    { label: 'Failed',     value: String(summary.failed),     color: '#dc2626' },
    { label: 'Avg Latency', value: summary.avg_latency_ms !== null ? formatMs(summary.avg_latency_ms) : '—', color: '#6b7280' },
    { label: 'Total Tokens', value: summary.total_tokens.toLocaleString(), color: '#7c3aed' },
    { label: 'Est. Cost', value: `$${summary.estimated_cost_usd.toFixed(4)}`, color: '#b45309' },
    { label: 'Provider', value: summary.provider_mode, color: summary.provider_mode === 'live' ? '#16a34a' : summary.provider_mode === 'mock' ? '#d97706' : '#9ca3af' },
    { label: 'Agent Activity', value: `${summary.agent_activity_count}${summary.last_agent_activity_at ? ` · ${formatDate(summary.last_agent_activity_at)}` : ''}`, color: '#0891b2' },
  ]

  return (
    <div style={{ ...ds.page, maxWidth: 1200 }}>
      <div style={s.header}>
        <Link href="/" style={ds.back}>← Home</Link>
        <h1 style={ds.h1}>AI Operations</h1>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{context.role}</span>
      </div>

      {/* Metric cards */}
      <div style={s.cards}>
        {cards.map(c => (
          <div key={c.label} style={s.card}>
            <div style={{ ...s.cardVal, color: c.color }}>{c.value}</div>
            <div style={s.cardLabel}>{c.label}</div>
          </div>
        ))}
      </div>

      {/* Latest AI errors (Sprint 6.3) */}
      {errors.length > 0 && (
        <div style={ds.section}>
          <h2 style={ds.h2}>Latest AI Errors ({errors.length})</h2>
          <table style={s.table}>
            <thead><tr>
              <th style={s.th}>Time</th><th style={s.th}>Prompt</th><th style={s.th}>Error</th>
            </tr></thead>
            <tbody>
              {errors.map(e => {
                const m = e.metadata ?? {}
                return (
                  <tr key={e.id}>
                    <td style={{ ...s.td, whiteSpace: 'nowrap' }}>{formatDate(e.occurred_at)}</td>
                    <td style={s.td}><code>{(m.prompt_id as string) ?? '—'}</code></td>
                    <td style={{ ...s.td, maxWidth: 520, wordBreak: 'break-word', color: '#dc2626' }}>
                      {safeText((m.error as string) ?? e.summary, 200)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* AI Workflow Registry (Sprint 7.0) — in-code coordination layer, read-only */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Workflow Registry ({aiWorkflows.length} in-code)</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          Governed AI workflows. Metadata only — execution is owned by the runtime workflow registry;
          every workflow with <code>approval required = yes</code> opens a pending human approval and never auto-delivers.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>AI Workflow ID</th><th style={s.th}>Runtime Workflow</th><th style={s.th}>Prompt</th>
            <th style={s.th}>Purpose</th><th style={s.th}>Required Inputs</th>
            <th style={s.th}>Approval</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiWorkflows.map(w => (
              <tr key={w.id}>
                <td style={s.td}><code>{w.id}</code></td>
                <td style={s.td}><code>{w.runtime_workflow_id}</code></td>
                <td style={s.td}><code>{w.prompt_id}</code></td>
                <td style={{ ...s.td, maxWidth: 300 }}>{w.purpose}</td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{w.required_inputs.join(', ')}</code></td>
                <td style={s.td}>{w.approval_required ? 'yes' : 'no'}</td>
                <td style={s.td}><StatusBadge status={w.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Prompt registry (TASK 6) — in-code, read-only */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Prompt Registry ({prompts.length} in-code)</h2>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Prompt ID</th><th style={s.th}>Version</th><th style={s.th}>Model</th>
            <th style={s.th}>Low</th><th style={s.th}>Purpose</th><th style={s.th}>Schema Fields</th>
          </tr></thead>
          <tbody>
            {prompts.map(p => (
              <tr key={p.id}>
                <td style={s.td}><code>{p.id}</code></td>
                <td style={s.td}>v{p.version}</td>
                <td style={s.td}><code>{p.model}</code></td>
                <td style={s.td}>{p.low ? 'yes' : 'no'}</td>
                <td style={{ ...s.td, maxWidth: 320 }}>{p.purpose}</td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{Object.keys(p.output_schema).join(', ')}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Recent AI workflow runs */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Recent AI Workflow Runs ({runs.length})</h2>
        {runs.length === 0 ? <div style={ds.empty}>No AI workflow runs yet.</div> : (
          <table style={s.table}>
            <thead><tr>
              <th style={s.th}>Run</th><th style={s.th}>Status</th><th style={s.th}>Current Step</th>
              <th style={s.th}>Started</th><th style={s.th}>Ended</th>
            </tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id}>
                  <td style={s.td}><Link href={`/workflow-runs/${r.id}`} style={ds.link}>{shortId(r.id)}</Link></td>
                  <td style={s.td}><StatusBadge status={r.status} /></td>
                  <td style={s.td}>{r.current_step_id ?? '—'}</td>
                  <td style={s.td}>{formatDate(r.started_at)}</td>
                  <td style={s.td}>{formatDate(r.completed_at ?? r.failed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent AI execution logs */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Recent AI Execution Logs ({logs.length})</h2>
        {logs.length === 0 ? <div style={ds.empty}>No AI execution logs yet.</div> : (
          <table style={s.table}>
            <thead><tr>
              <th style={s.th}>Time</th><th style={s.th}>Phase</th><th style={s.th}>Event</th>
              <th style={s.th}>Summary</th><th style={s.th}>Tokens</th><th style={s.th}>Latency</th>
            </tr></thead>
            <tbody>
              {logs.map(l => {
                const m = l.metadata ?? {}
                const tokens = typeof m.total_tokens === 'number' ? m.total_tokens : null
                const latency = typeof m.latency_ms === 'number' ? m.latency_ms : null
                return (
                  <tr key={l.id}>
                    <td style={{ ...s.td, whiteSpace: 'nowrap' }}>{formatDate(l.occurred_at)}</td>
                    <td style={s.td}><code>{(m.phase as string) ?? '—'}</code></td>
                    <td style={s.td}><code>{l.event_type}</code></td>
                    <td style={{ ...s.td, maxWidth: 380, wordBreak: 'break-word' }}>{safeText(l.summary, 100)}</td>
                    <td style={s.td}>{tokens !== null ? tokens.toLocaleString() : '—'}</td>
                    <td style={s.td}>{latency !== null ? formatMs(latency) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Recent draft outputs */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Recent Draft Outputs (AI-related when linked) ({outputs.length})</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          Draft outputs awaiting human approval. This list is a broad proxy and may include drafts not
          produced by an AI step — open an output to confirm AI provenance.
        </p>
        {outputs.length === 0 ? <div style={ds.empty}>No draft outputs.</div> : (
          <table style={s.table}>
            <thead><tr>
              <th style={s.th}>Output</th><th style={s.th}>Title</th><th style={s.th}>Type</th>
              <th style={s.th}>Status</th><th style={s.th}>Produced</th>
            </tr></thead>
            <tbody>
              {outputs.map(o => (
                <tr key={o.id}>
                  <td style={s.td}><Link href={`/outputs/${o.id}`} style={ds.link}>{shortId(o.id)}</Link></td>
                  <td style={{ ...s.td, maxWidth: 320 }}>{safeText(o.title, 80)}</td>
                  <td style={s.td}><code>{o.output_type}</code></td>
                  <td style={s.td}><StatusBadge status={o.status} /></td>
                  <td style={s.td}>{formatDate(o.produced_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  header:    { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
  cards:     { display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 },
  card:      { background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '12px 18px', minWidth: 110 },
  cardVal:   { fontSize: 22, fontWeight: 700, lineHeight: 1 },
  cardLabel: { fontSize: 11, color: '#6b7280', marginTop: 4 },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:        { textAlign: 'left', padding: '7px 10px', borderBottom: '2px solid #e5e7eb', fontWeight: 600, color: '#374151', background: '#f9fafb' },
  td:        { padding: '7px 10px', borderBottom: '1px solid #f3f4f6', verticalAlign: 'top' },
}
