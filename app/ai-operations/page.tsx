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
import { listPrompts, listPromptVersions, getActivePromptVersion } from '@/lib/ai/prompts'
import { listAiWorkflows } from '@/lib/ai/workflows'
import { listAiWorkflowTemplates } from '@/lib/ai/workflow-templates'
import { listAiCapabilities } from '@/lib/ai/capabilities'

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
  const promptVersions = listPromptVersions()
  const aiWorkflows = listAiWorkflows()
  const aiTemplates = listAiWorkflowTemplates()
  const aiCapabilities = listAiCapabilities()

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

      {/* AI Capability Registry (Sprint 7.3) — what the AI does, read-only */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Capability Registry ({aiCapabilities.length} in-code)</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          What the AI does, independent of any single prompt or workflow. Metadata only — capabilities never
          execute, register no prompt, and cannot bypass approvals or auto-deliver. <code>planned</code> capabilities
          have no prompt or runtime workflow yet.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Capability ID</th><th style={s.th}>Name</th><th style={s.th}>Category</th>
            <th style={s.th}>Purpose</th><th style={s.th}>Default Prompt</th><th style={s.th}>Default Template</th>
            <th style={s.th}>Target Entities</th><th style={s.th}>Governance</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiCapabilities.map(c => (
              <tr key={c.id}>
                <td style={s.td}><code>{c.id}</code></td>
                <td style={s.td}>{c.name}</td>
                <td style={s.td}><code>{c.category}</code></td>
                <td style={{ ...s.td, maxWidth: 260 }}>{c.purpose}</td>
                <td style={s.td}>{c.default_prompt_id ? <code>{c.default_prompt_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>{c.default_template_id ? <code>{c.default_template_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{c.supported_target_entities.join(', ')}</code></td>
                <td style={s.td}>{c.governance_policy.approval_required ? 'approval + human review' : 'none'}{c.governance_policy.draft_only ? ', draft-only' : ''}</td>
                <td style={s.td}><StatusBadge status={c.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* AI Workflow Templates (Sprint 7.1) — reusable blueprints, read-only */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Workflow Templates ({aiTemplates.length} in-code)</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          Reusable blueprints for governed AI workflows. Metadata only — templates never execute,
          register no prompt, and cannot bypass approvals or auto-deliver. <code>experimental</code> templates
          have no prompt or runtime workflow yet.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Template ID</th><th style={s.th}>Name</th><th style={s.th}>Category</th>
            <th style={s.th}>Purpose</th><th style={s.th}>Target Entities</th>
            <th style={s.th}>Default Output</th><th style={s.th}>Approval</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiTemplates.map(t => (
              <tr key={t.id}>
                <td style={s.td}><code>{t.id}</code></td>
                <td style={s.td}>{t.name}</td>
                <td style={s.td}><code>{t.category}</code></td>
                <td style={{ ...s.td, maxWidth: 280 }}>{t.purpose}</td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{t.supported_target_entities.join(', ')}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{t.default_output_target.output_type} ({t.default_output_target.status})</code></td>
                <td style={s.td}>{t.default_approval_policy.required ? `yes (${t.default_approval_policy.approver_role})` : 'no'}</td>
                <td style={s.td}><StatusBadge status={t.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* AI Workflow Registry (Sprint 7.0) — in-code coordination layer, read-only */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Workflow Registry ({aiWorkflows.length} in-code)</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          Governed AI workflows. Metadata only — execution is owned by the runtime workflow registry;
          every workflow with <code>approval required = yes</code> opens a pending human approval and never auto-delivers.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>AI Workflow ID</th><th style={s.th}>Capability</th><th style={s.th}>Template</th>
            <th style={s.th}>Runtime Workflow</th><th style={s.th}>Prompt</th>
            <th style={s.th}>Approval</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiWorkflows.map(w => (
              <tr key={w.id}>
                <td style={s.td}><code>{w.id}</code></td>
                <td style={s.td}>{w.capability_id ? <code>{w.capability_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>{w.template_id ? <code>{w.template_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}><code>{w.runtime_workflow_id}</code></td>
                <td style={s.td}><code>{w.prompt_id}</code></td>
                <td style={s.td}>{w.approval_required ? 'yes' : 'no'}</td>
                <td style={s.td}><StatusBadge status={w.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Prompt registry (Sprint 7.2) — in-code, versioned, read-only. One row
          per prompt id showing its ACTIVE version. */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Prompt Registry ({prompts.length} in-code)</h2>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Prompt ID</th><th style={s.th}>Active Version</th><th style={s.th}>Model</th>
            <th style={s.th}>Low</th><th style={s.th}>Purpose</th><th style={s.th}>Schema Fields</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {prompts.map(entry => {
              const active = getActivePromptVersion(entry.id)
              return (
                <tr key={entry.id}>
                  <td style={s.td}><code>{entry.id}</code></td>
                  <td style={s.td}><code>{active?.version_id ?? `v${entry.active_version}`}</code></td>
                  <td style={s.td}><code>{active?.model ?? '—'}</code></td>
                  <td style={s.td}>{active ? (active.low ? 'yes' : 'no') : '—'}</td>
                  <td style={{ ...s.td, maxWidth: 320 }}>{active?.purpose ?? '—'}</td>
                  <td style={s.td}><code style={{ fontSize: 11 }}>{active ? Object.keys(active.output_schema).join(', ') : '—'}</code></td>
                  <td style={s.td}>{active ? <StatusBadge status={active.status} /> : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Prompt versions (Sprint 7.2) — every version across all prompts, read-only */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Prompt Versions ({promptVersions.length})</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          Full version history. A prompt id is a stable alias; each AI output is traceable to its version id.
          Versions are append-only — never edited in place once shipped.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Prompt ID</th><th style={s.th}>Version</th><th style={s.th}>Version ID</th>
            <th style={s.th}>Status</th><th style={s.th}>Model</th><th style={s.th}>Low</th>
            <th style={s.th}>Change Note</th><th style={s.th}>Released</th><th style={s.th}>Replaced By</th>
          </tr></thead>
          <tbody>
            {promptVersions.map(v => (
              <tr key={v.version_id}>
                <td style={s.td}><code>{v.prompt_id}</code></td>
                <td style={s.td}>v{v.version}</td>
                <td style={s.td}><code>{v.version_id}</code></td>
                <td style={s.td}><StatusBadge status={v.status} /></td>
                <td style={s.td}><code>{v.model}</code></td>
                <td style={s.td}>{v.low ? 'yes' : 'no'}</td>
                <td style={{ ...s.td, maxWidth: 300 }}>{v.change_note}</td>
                <td style={s.td}>{v.released_at}</td>
                <td style={s.td}>{v.replaced_by ? <code>{v.replaced_by}</code> : <span style={ds.empty}>—</span>}</td>
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
