import type { SupabaseClient } from '@supabase/supabase-js'

// Sprint 6.2 — read-only AI observability helpers.
// All queries run through the caller's RLS-bound SSR client (never service-role).
// AI telemetry sources:
//   execution_logs   actor='agent:ai', metadata.phase ∈ started|completed|failed
//   runtime_metrics  metric_category='agent_performance', metric_name ai_*
//   workflow_runs    workflow_id='request_ai_summary'
//   outputs          status='draft' (AI workflows produce drafts)

export interface AiMetricSummary {
  executions: number
  success: number
  failed: number
  avg_latency_ms: number | null
  total_tokens: number
  estimated_cost_usd: number
  // Telemetry upgrade (Sprint 6.3)
  agent_activity_count: number
  last_agent_activity_at: string | null
  provider_mode: 'mock' | 'live' | 'unknown'
}

export interface AiErrorRow {
  id: string; summary: string | null; occurred_at: string; metadata: Record<string, unknown>
}

export interface AiLogRow {
  id: string; event_type: string; summary: string | null; status: string
  occurred_at: string; metadata: Record<string, unknown>
}
export interface AiRunRow {
  id: string; status: string; started_at: string | null
  completed_at: string | null; failed_at: string | null; current_step_id: string | null
}
export interface AiOutputRow {
  id: string; title: string; output_type: string; status: string; produced_at: string
}

export async function getAiMetricSummary(supabase: SupabaseClient): Promise<AiMetricSummary> {
  const [startedRes, completedRes, failedRes, metricsRes, agentActRes, latestCompletedRes] = await Promise.all([
    supabase.from('execution_logs').select('*', { count: 'exact', head: true })
      .eq('actor', 'agent:ai').filter('metadata->>phase', 'eq', 'started'),
    supabase.from('execution_logs').select('*', { count: 'exact', head: true })
      .eq('actor', 'agent:ai').filter('metadata->>phase', 'eq', 'completed'),
    supabase.from('execution_logs').select('*', { count: 'exact', head: true })
      .eq('actor', 'agent:ai').filter('metadata->>phase', 'eq', 'failed'),
    supabase.from('runtime_metrics').select('metric_name, value_int, value_float')
      .eq('metric_category', 'agent_performance')
      .order('recorded_at', { ascending: false }).limit(5000),
    // agent_activity count + latest (AI tool calls only)
    supabase.from('agent_activity').select('occurred_at', { count: 'exact' })
      .like('tool_name', 'ai:%').order('occurred_at', { ascending: false }).limit(1),
    // most recent completed AI log → infer provider mode
    supabase.from('execution_logs').select('metadata')
      .eq('actor', 'agent:ai').filter('metadata->>phase', 'eq', 'completed')
      .order('occurred_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const metrics = (metricsRes.data ?? []) as { metric_name: string; value_int: number | null; value_float: number | null }[]
  let totalTokens = 0
  let estCost = 0
  const latencies: number[] = []
  for (const m of metrics) {
    if (m.metric_name === 'ai_total_tokens' && m.value_int != null) totalTokens += m.value_int
    else if (m.metric_name === 'ai_estimated_cost_usd' && m.value_float != null) estCost += m.value_float
    else if (m.metric_name === 'ai_latency_ms' && m.value_int != null) latencies.push(m.value_int)
  }
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null

  const lastActivity = ((agentActRes.data ?? []) as { occurred_at: string }[])[0]?.occurred_at ?? null
  const latestMeta = (latestCompletedRes.data?.metadata ?? null) as Record<string, unknown> | null
  let providerMode: 'mock' | 'live' | 'unknown' = 'unknown'
  if (latestMeta) {
    if (latestMeta.provider_mode === 'mock' || latestMeta.provider_mode === 'live') providerMode = latestMeta.provider_mode
    else if (typeof latestMeta.mocked === 'boolean') providerMode = latestMeta.mocked ? 'mock' : 'live'
  }

  return {
    executions:        startedRes.count ?? 0,
    success:           completedRes.count ?? 0,
    failed:            failedRes.count ?? 0,
    avg_latency_ms:    avgLatency,
    total_tokens:      totalTokens,
    estimated_cost_usd: Math.round(estCost * 1e6) / 1e6,
    agent_activity_count:   agentActRes.count ?? 0,
    last_agent_activity_at: lastActivity,
    provider_mode:          providerMode,
  }
}

export async function getRecentAiErrors(supabase: SupabaseClient, limit = 10): Promise<AiErrorRow[]> {
  const { data } = await supabase.from('execution_logs')
    .select('id, summary, occurred_at, metadata')
    .eq('actor', 'agent:ai').eq('status', 'flagged')
    .order('occurred_at', { ascending: false }).limit(limit)
  return (data ?? []) as unknown as AiErrorRow[]
}

export async function getRecentAiExecutionLogs(supabase: SupabaseClient, limit = 20): Promise<AiLogRow[]> {
  const { data } = await supabase.from('execution_logs')
    .select('id, event_type, summary, status, occurred_at, metadata')
    .eq('actor', 'agent:ai')
    .order('occurred_at', { ascending: false }).limit(limit)
  return (data ?? []) as unknown as AiLogRow[]
}

export async function getRecentAiWorkflowRuns(supabase: SupabaseClient, limit = 20): Promise<AiRunRow[]> {
  const { data } = await supabase.from('workflow_runs')
    .select('id, status, started_at, completed_at, failed_at, current_step_id')
    .eq('workflow_id', 'request_ai_summary')
    .order('created_at', { ascending: false }).limit(limit)
  return (data ?? []) as unknown as AiRunRow[]
}

// Recent draft outputs — AI workflows create drafts (no direct AI flag on the
// row, so this is the best RLS-safe proxy; non-AI drafts may also appear).
export async function getRecentAiDraftOutputs(supabase: SupabaseClient, limit = 20): Promise<AiOutputRow[]> {
  const { data } = await supabase.from('outputs')
    .select('id, title, output_type, status, produced_at')
    .eq('status', 'draft')
    .order('produced_at', { ascending: false }).limit(limit)
  return (data ?? []) as unknown as AiOutputRow[]
}
