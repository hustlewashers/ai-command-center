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
  getAiProviderHealth,
  getAiRetrievalUsage,
} from '@/lib/ai/metrics'
import { listKnowledgeSources } from '@/lib/ai/knowledge-sources'
import { listRetrievalPolicies } from '@/lib/ai/retrieval-policies'
import { listPrompts, listPromptVersions, getActivePromptVersion } from '@/lib/ai/prompts'
import { listAiWorkflows } from '@/lib/ai/workflows'
import { listAiWorkflowTemplates } from '@/lib/ai/workflow-templates'
import { listAiCapabilities } from '@/lib/ai/capabilities'
import { listAiSkills } from '@/lib/ai/skills'
import { listAiAgents } from '@/lib/ai/agents'
import { listAiPlans } from '@/lib/ai/plans'
import { validateAiRegistry } from '@/lib/ai/registry-integrity'
import { activeRequestSummaryChain } from '@/lib/ai/registry-graph'
import { runAllPromptEvalSuites } from '@/lib/ai/evals/run'

// Sprint 6.2 — AI Operations. RLS-safe reads only (SSR client, never service-role).
export default async function AiOperationsPage() {
  const supabase = await createClient()
  let context
  try {
    context = await resolveUserContext(supabase)
  } catch {
    redirect('/login')
  }

  const [summary, logs, runs, outputs, errors, providerHealth, retrievalUsage] = await Promise.all([
    getAiMetricSummary(supabase),
    getRecentAiExecutionLogs(supabase, 20),
    getRecentAiWorkflowRuns(supabase, 20),
    getRecentAiDraftOutputs(supabase, 20),
    getRecentAiErrors(supabase, 10),
    getAiProviderHealth(supabase),
    getAiRetrievalUsage(supabase),
  ])
  const knowledgeSources = listKnowledgeSources()
  const retrievalPolicies = listRetrievalPolicies()
  const prompts = listPrompts()
  const promptVersions = listPromptVersions()
  const aiWorkflows = listAiWorkflows()
  const aiTemplates = listAiWorkflowTemplates()
  const aiCapabilities = listAiCapabilities()
  const aiSkills = listAiSkills()
  const aiAgents = listAiAgents()
  const aiPlans = listAiPlans()
  const integrity = validateAiRegistry()
  const stackChain = activeRequestSummaryChain()
  const evalSuites = runAllPromptEvalSuites()

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

      {/* Provider Health (Sprint 8.0) — read-only, from AI execution logs */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Provider Health</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-block', padding: '3px 12px', borderRadius: 4, fontSize: 12, fontWeight: 700, color: '#fff',
            background: providerHealth.status === 'healthy' ? '#16a34a'
              : providerHealth.status === 'degraded' ? '#d97706'
              : providerHealth.status === 'unavailable' ? '#dc2626'
              : '#9ca3af' }}>{providerHealth.status}</span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            provider <code>{providerHealth.provider_id}</code> · mode <code>{providerHealth.mode}</code>
          </span>
        </div>
        <div style={s.cards}>
          {[
            { label: 'Executions', value: String(providerHealth.executions), color: '#2563eb' },
            { label: 'Failures', value: String(providerHealth.failures), color: providerHealth.failures > 0 ? '#dc2626' : '#6b7280' },
            { label: 'Fallbacks', value: String(providerHealth.fallback_count), color: providerHealth.fallback_count > 0 ? '#d97706' : '#6b7280' },
            { label: 'Avg Latency', value: providerHealth.avg_latency_ms !== null ? formatMs(providerHealth.avg_latency_ms) : '—', color: '#0891b2' },
            { label: 'Last Success', value: providerHealth.last_success_at ? formatDate(providerHealth.last_success_at) : '—', color: '#16a34a' },
            { label: 'Last Failure', value: providerHealth.last_failure_at ? formatDate(providerHealth.last_failure_at) : '—', color: '#dc2626' },
            { label: 'Common Error', value: providerHealth.common_error_type ?? '—', color: '#b45309' },
          ].map(c => (
            <div key={c.label} style={s.card}>
              <div style={{ ...s.cardVal, color: c.color, fontSize: 16 }}>{c.value}</div>
              <div style={s.cardLabel}>{c.label}</div>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 11, color: '#6b7280', margin: '8px 0 0' }}>
          Derived from recent AI execution logs. In production, disable mock fallback (<code>AI_ALLOW_MOCK_FALLBACK=false</code>)
          so provider failures fail closed and appear here as failures rather than silent fallbacks.
        </p>
      </div>

      {/* AI Retrieval (Sprint 8.1) — governed, read-only foundation */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Retrieval</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
          Governed, org-scoped, read-only context injection. No cross-org or global search; retrieval writes nothing
          and never bypasses approvals. If retrieval is empty or fails, the workflow continues without context.
        </p>
        <div style={s.cards}>
          {[
            { label: 'Runs w/ Retrieval', value: String(retrievalUsage.executions_with_retrieval), color: '#2563eb' },
            { label: 'Total Chunks', value: String(retrievalUsage.total_chunks), color: '#0891b2' },
            { label: 'Total Citations', value: String(retrievalUsage.total_citations), color: '#7c3aed' },
            { label: 'Warnings', value: String(retrievalUsage.warning_count), color: retrievalUsage.warning_count > 0 ? '#d97706' : '#6b7280' },
            { label: 'Last Retrieval', value: retrievalUsage.last_retrieval_at ? formatDate(retrievalUsage.last_retrieval_at) : '—', color: '#16a34a' },
          ].map(c => (
            <div key={c.label} style={s.card}>
              <div style={{ ...s.cardVal, color: c.color, fontSize: 16 }}>{c.value}</div>
              <div style={s.cardLabel}>{c.label}</div>
            </div>
          ))}
        </div>

        <h3 style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: '14px 0 6px' }}>Retrieval Policies ({retrievalPolicies.length})</h3>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Policy ID</th><th style={s.th}>Same Org</th><th style={s.th}>Prefer Dept</th>
            <th style={s.th}>Prefer Project</th><th style={s.th}>Max Chunks</th><th style={s.th}>Global Search</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {retrievalPolicies.map(p => (
              <tr key={p.id}>
                <td style={s.td}><code>{p.id}</code></td>
                <td style={s.td}>{p.same_org_only ? 'yes' : 'no'}</td>
                <td style={s.td}>{p.prefer_same_department ? 'yes' : 'no'}</td>
                <td style={s.td}>{p.prefer_same_project ? 'yes' : 'no'}</td>
                <td style={s.td}>{p.max_chunks}</td>
                <td style={s.td}>{p.forbid_global_search ? 'forbidden' : 'allowed'}</td>
                <td style={s.td}><StatusBadge status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        <h3 style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: '14px 0 6px' }}>Knowledge Sources ({knowledgeSources.length})</h3>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Source ID</th><th style={s.th}>Entity</th><th style={s.th}>Supported Scope</th>
            <th style={s.th}>Searchable Fields</th><th style={s.th}>Citation Fields</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {knowledgeSources.map(k => (
              <tr key={k.id}>
                <td style={s.td}><code>{k.id}</code></td>
                <td style={s.td}><code>{k.entity_type}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{k.supported_scope.join(', ')}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{k.searchable_fields.join(', ')}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{k.citation_fields.join(', ')}</code></td>
                <td style={s.td}><StatusBadge status={k.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* AI Registry Integrity (Sprint 7.7) — read-only diagnostics */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Registry Integrity</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{
            display: 'inline-block', padding: '3px 12px', borderRadius: 4, fontSize: 12, fontWeight: 700, color: '#fff',
            background: integrity.ok ? '#16a34a' : '#dc2626',
          }}>
            {integrity.ok ? 'OK' : `${integrity.errors.length} error${integrity.errors.length !== 1 ? 's' : ''}`}
          </span>
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            checked {formatDate(integrity.checked_at)} · {integrity.warnings.length} warning{integrity.warnings.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div style={{ fontSize: 12, color: '#374151', marginBottom: 12 }}>
          {integrity.counts.plans} plans · {integrity.counts.agents} agents · {integrity.counts.skills} skills ·{' '}
          {integrity.counts.capabilities} capabilities · {integrity.counts.templates} templates ·{' '}
          {integrity.counts.workflows} workflows · {integrity.counts.prompts} prompts ·{' '}
          {integrity.counts.prompt_versions} prompt versions
        </div>

        {integrity.errors.length === 0 ? (
          <div style={{ fontSize: 13, color: '#16a34a', marginBottom: 12 }}>Registry integrity checks passed.</div>
        ) : (
          <table style={s.table}>
            <thead><tr><th style={s.th}>Code</th><th style={s.th}>Source</th><th style={s.th}>Error</th></tr></thead>
            <tbody>
              {integrity.errors.map((e, i) => (
                <tr key={i}>
                  <td style={s.td}><code>{e.code}</code></td>
                  <td style={s.td}><code style={{ fontSize: 11 }}>{e.from}</code></td>
                  <td style={{ ...s.td, maxWidth: 520, wordBreak: 'break-word', color: '#dc2626' }}>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {integrity.warnings.length > 0 && (
          <>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: '14px 0 6px' }}>Warnings ({integrity.warnings.length})</h3>
            <table style={s.table}>
              <thead><tr><th style={s.th}>Code</th><th style={s.th}>Source</th><th style={s.th}>Warning</th></tr></thead>
              <tbody>
                {integrity.warnings.map((w, i) => (
                  <tr key={i}>
                    <td style={s.td}><code>{w.code}</code></td>
                    <td style={s.td}><code style={{ fontSize: 11 }}>{w.from}</code></td>
                    <td style={{ ...s.td, maxWidth: 520, wordBreak: 'break-word', color: '#b45309' }}>{w.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* AI Registry Stack Map (Sprint 7.7) — active request-summary golden path */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Registry Stack Map</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
          The active request-summary chain, top to bottom: Plan → Agent → Skill → Capability → Template → Workflow → Prompt → Prompt Version.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12 }}>
          {stackChain.map((row, i) => (
            <span key={row.kind} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 10px', background: '#f9fafb' }}>
                <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#9ca3af' }}>{row.kind.replace('_', ' ')}</span>
                <code style={{ fontSize: 12, color: row.id ? '#111827' : '#dc2626' }}>{row.id ?? 'MISSING'}</code>
                {row.status && <span style={{ fontSize: 10, color: row.status === 'active' ? '#16a34a' : '#d97706' }}>{row.status}</span>}
              </span>
              {i < stackChain.length - 1 && <span style={{ color: '#9ca3af', fontWeight: 700 }}>→</span>}
            </span>
          ))}
        </div>
      </div>

      {/* Prompt Evaluation (Sprint 7.8) — offline, deterministic, read-only */}
      <div style={ds.section}>
        <h2 style={ds.h2}>Prompt Evaluation</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 10px' }}>
          Offline, deterministic evaluation of prompt versions against golden cases (no live provider, no writes).
          <strong> A prompt version should not be activated until its eval suite passes.</strong> Moving a prompt&apos;s
          <code> active_version</code> to a new version is a manual step gated on a passing suite — evaluation never
          activates anything automatically.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Suite</th><th style={s.th}>Prompt</th><th style={s.th}>Version</th>
            <th style={s.th}>Cases</th><th style={s.th}>Passed</th><th style={s.th}>Failed</th>
            <th style={s.th}>Avg Score</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {evalSuites.map(su => (
              <tr key={su.suite_id}>
                <td style={s.td}><code>{su.suite_id}</code></td>
                <td style={s.td}><code>{su.prompt_id}</code></td>
                <td style={s.td}><code>{su.prompt_version_id}</code></td>
                <td style={s.td}>{su.total}</td>
                <td style={{ ...s.td, color: '#16a34a' }}>{su.passed}</td>
                <td style={{ ...s.td, color: su.failed > 0 ? '#dc2626' : '#6b7280' }}>{su.failed}</td>
                <td style={s.td}>{su.average_score.toFixed(2)}</td>
                <td style={s.td}>
                  <span style={{
                    display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, color: '#fff',
                    background: su.status === 'passed' ? '#16a34a' : su.status === 'partial' ? '#d97706' : '#dc2626',
                  }}>{su.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

      {/* AI Plan Registry (Sprint 7.6) — governed sequences, NON-EXECUTABLE metadata */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Plan Registry ({aiPlans.length} in-code)</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          Governed, ordered sequences composing agents, skills, capabilities, and workflows with human-review
          checkpoints. <strong>Plans do not execute yet — they are read-only metadata.</strong> They orchestrate
          nothing, register no prompt, and cannot bypass approvals or auto-deliver. <code>planned</code> plans have
          incomplete chains.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Plan ID</th><th style={s.th}>Name</th><th style={s.th}>Category</th>
            <th style={s.th}>Purpose</th><th style={s.th}>Target Entities</th><th style={s.th}>Steps</th>
            <th style={s.th}>Agents</th><th style={s.th}>Skills</th><th style={s.th}>Capabilities</th><th style={s.th}>Workflows</th>
            <th style={s.th}>Governance</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiPlans.map(p => (
              <tr key={p.id}>
                <td style={s.td}><code>{p.id}</code></td>
                <td style={s.td}>{p.name}</td>
                <td style={s.td}><code>{p.category}</code></td>
                <td style={{ ...s.td, maxWidth: 220 }}>{p.purpose}</td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{p.target_entities.length > 0 ? p.target_entities.join(', ') : 'none'}</code></td>
                <td style={s.td}>{p.steps.length}</td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{p.allowed_agent_ids.length > 0 ? p.allowed_agent_ids.join(', ') : '—'}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{p.allowed_skill_ids.length > 0 ? p.allowed_skill_ids.join(', ') : '—'}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{p.allowed_capability_ids.length > 0 ? p.allowed_capability_ids.join(', ') : '—'}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{p.allowed_workflow_ids.length > 0 ? p.allowed_workflow_ids.join(', ') : '—'}</code></td>
                <td style={s.td}>{p.governance_policy.requires_human_approval ? 'approval-gated' : 'none'}, non-executable</td>
                <td style={s.td}><StatusBadge status={p.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* AI Agent Registry (Sprint 7.5) — governed roles, NON-EXECUTABLE metadata */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Agent Registry ({aiAgents.length} in-code)</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          Governed roles that may <em>eventually</em> compose skills, capabilities, and workflows.
          <strong> Agents do not act autonomously yet — they are read-only metadata.</strong> They execute
          nothing, register no prompt, and cannot bypass approvals or auto-deliver. <code>planned</code> agents
          have incomplete chains.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Agent ID</th><th style={s.th}>Name</th><th style={s.th}>Category</th>
            <th style={s.th}>Purpose</th><th style={s.th}>Scope</th>
            <th style={s.th}>Allowed Skills</th><th style={s.th}>Allowed Capabilities</th><th style={s.th}>Allowed Workflows</th>
            <th style={s.th}>Supported Plans</th><th style={s.th}>Governance</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiAgents.map(a => (
              <tr key={a.id}>
                <td style={s.td}><code>{a.id}</code></td>
                <td style={s.td}>{a.name}</td>
                <td style={s.td}><code>{a.category}</code></td>
                <td style={{ ...s.td, maxWidth: 220 }}>{a.purpose}</td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{a.scope.target_entities.length > 0 ? a.scope.target_entities.join(', ') : 'none'}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{a.allowed_skill_ids.length > 0 ? a.allowed_skill_ids.join(', ') : '—'}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{a.allowed_capability_ids.length > 0 ? a.allowed_capability_ids.join(', ') : '—'}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{a.allowed_workflow_ids.length > 0 ? a.allowed_workflow_ids.join(', ') : '—'}</code></td>
                <td style={s.td}>{a.supported_plan_ids && a.supported_plan_ids.length > 0 ? <code style={{ fontSize: 11 }}>{a.supported_plan_ids.join(', ')}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>
                  {a.governance_policy.requires_human_approval ? 'approval-gated' : 'none'}
                  {', non-executable'}
                </td>
                <td style={s.td}><StatusBadge status={a.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* AI Skill Registry (Sprint 7.4) — reusable AI operations, read-only */}
      <div style={ds.section}>
        <h2 style={ds.h2}>AI Skill Registry ({aiSkills.length} in-code)</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 8px' }}>
          Reusable AI operations that capabilities compose and future agents will orchestrate. Metadata only —
          skills never execute, register no prompt, and cannot bypass approvals or auto-deliver. <code>planned</code>
          skills have no prompt or runtime workflow yet.
        </p>
        <table style={s.table}>
          <thead><tr>
            <th style={s.th}>Skill ID</th><th style={s.th}>Name</th><th style={s.th}>Category</th>
            <th style={s.th}>Default Capability</th><th style={s.th}>Default Prompt</th><th style={s.th}>Supported Agents</th>
            <th style={s.th}>Input Entities</th><th style={s.th}>Output Types</th><th style={s.th}>Governance</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiSkills.map(sk => (
              <tr key={sk.id}>
                <td style={s.td}><code>{sk.id}</code></td>
                <td style={s.td}>{sk.name}</td>
                <td style={s.td}><code>{sk.category}</code></td>
                <td style={s.td}>{sk.default_capability_id ? <code>{sk.default_capability_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>{sk.default_prompt_id ? <code>{sk.default_prompt_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>{sk.supported_agent_ids && sk.supported_agent_ids.length > 0 ? <code style={{ fontSize: 11 }}>{sk.supported_agent_ids.join(', ')}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{sk.supported_input_entities.join(', ')}</code></td>
                <td style={s.td}><code style={{ fontSize: 11 }}>{sk.supported_output_types.join(', ')}</code></td>
                <td style={s.td}>{sk.governance_policy.approval_required ? 'approval + human review' : 'none'}{sk.governance_policy.draft_only ? ', draft-only' : ''}</td>
                <td style={s.td}><StatusBadge status={sk.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
            <th style={s.th}>Default Skill</th><th style={s.th}>Default Prompt</th><th style={s.th}>Default Template</th>
            <th style={s.th}>Supported Agents</th><th style={s.th}>Governance</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiCapabilities.map(c => (
              <tr key={c.id}>
                <td style={s.td}><code>{c.id}</code></td>
                <td style={s.td}>{c.name}</td>
                <td style={s.td}><code>{c.category}</code></td>
                <td style={s.td}>{c.default_skill_id ? <code>{c.default_skill_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>{c.default_prompt_id ? <code>{c.default_prompt_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>{c.default_template_id ? <code>{c.default_template_id}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>{c.supported_agent_ids && c.supported_agent_ids.length > 0 ? <code style={{ fontSize: 11 }}>{c.supported_agent_ids.join(', ')}</code> : <span style={ds.empty}>—</span>}</td>
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
            <th style={s.th}>AI Workflow ID</th><th style={s.th}>Plans</th><th style={s.th}>Agent</th>
            <th style={s.th}>Capability</th><th style={s.th}>Template</th><th style={s.th}>Runtime Workflow</th>
            <th style={s.th}>Prompt</th><th style={s.th}>Approval</th><th style={s.th}>Status</th>
          </tr></thead>
          <tbody>
            {aiWorkflows.map(w => (
              <tr key={w.id}>
                <td style={s.td}><code>{w.id}</code></td>
                <td style={s.td}>{w.supported_plan_ids && w.supported_plan_ids.length > 0 ? <code style={{ fontSize: 11 }}>{w.supported_plan_ids.join(', ')}</code> : <span style={ds.empty}>—</span>}</td>
                <td style={s.td}>{w.agent_id ? <code>{w.agent_id}</code> : <span style={ds.empty}>—</span>}</td>
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
