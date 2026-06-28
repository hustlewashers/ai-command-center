import { getServiceClient } from '@/lib/supabase/service'

type MetricUnit = 'count' | 'ms' | 'seconds' | 'percent' | 'bytes' | 'rate_per_min'

interface MetricInput {
  name: string
  value: number
  unit: MetricUnit
}

// Writes a batch of runtime_health metrics for one organization.
// Non-fatal: logs on failure rather than throwing, so metrics never break a worker run.
export async function recordWorkerMetrics(
  organizationId: string,
  windowStart: Date,
  windowEnd: Date,
  metrics: MetricInput[]
): Promise<void> {
  if (metrics.length === 0) return

  const ws = windowStart.toISOString()
  // Guarantee window_end > window_start (required by DB constraint)
  const we = windowEnd.getTime() > windowStart.getTime()
    ? windowEnd.toISOString()
    : new Date(windowStart.getTime() + 1).toISOString()

  const rows = metrics.map(m => ({
    organization_id: organizationId,
    metric_name:     m.name,
    metric_category: 'runtime_health',
    dimension_type:  'org',
    dimension_id:    organizationId,
    value_int:       Math.round(m.value),  // all worker metrics are integer counts / ms
    value_float:     null,                 // must be exactly one of value_int / value_float (XOR constraint)
    unit:            m.unit,
    window_start:    ws,
    window_end:      we,
  }))

  const svc = getServiceClient()
  const { error } = await svc.from('runtime_metrics').insert(rows)
  if (error) {
    console.error('[metrics] write failed:', error.message)
  }
}

// Returns current queue depth and pending DLQ count for one organization.
export async function queryQueueStats(
  organizationId: string
): Promise<{ queueDepth: number; dlqSize: number }> {
  const svc = getServiceClient()
  const [qRes, dRes] = await Promise.all([
    svc.from('background_jobs')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .in('status', ['queued', 'retrying']),
    svc.from('dead_letter_queue')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('resolution_status', 'pending_review'),
  ])
  return {
    queueDepth: qRes.count ?? 0,
    dlqSize:    dRes.count ?? 0,
  }
}
