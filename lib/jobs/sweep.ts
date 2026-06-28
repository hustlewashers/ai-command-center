import { getServiceClient } from '@/lib/supabase/service'

const STALE_MINUTES = 10

export async function sweep(): Promise<number> {
  const svc = getServiceClient()
  const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString()

  // Find jobs stuck in processing longer than the stale threshold
  const { data: stale, error: fetchErr } = await svc
    .from('background_jobs')
    .select('id, organization_id, job_type, payload, retry_count, max_retries')
    .eq('status', 'processing')
    .lt('updated_at', staleThreshold)

  if (fetchErr) throw new Error(`sweep fetch failed: ${fetchErr.message}`)
  if (!stale || stale.length === 0) return 0

  type StaleRow = {
    id: string
    organization_id: string
    job_type: string
    payload: Record<string, unknown>
    retry_count: number
    max_retries: number
  }

  const rows = stale as StaleRow[]
  const exhausted = rows.filter(j => j.retry_count >= j.max_retries)
  const reclaimable = rows.filter(j => j.retry_count < j.max_retries)

  // Reset reclaimable jobs back to queued so a worker can re-claim them.
  // started_at must be nulled to satisfy the started_at_status_check constraint.
  if (reclaimable.length > 0) {
    const { error } = await svc
      .from('background_jobs')
      .update({ status: 'queued', started_at: null })
      .in('id', reclaimable.map(j => j.id))
    if (error) throw new Error(`sweep reset failed: ${error.message}`)
  }

  // Exhaust jobs that have already used all retries — mark failed + create DLQ entry.
  for (const job of exhausted) {
    const now = new Date().toISOString()

    const { error: failErr } = await svc
      .from('background_jobs')
      .update({
        status: 'failed',
        last_error: 'Job exhausted all retries without completing (swept as stale)',
        completed_at: now,
      })
      .eq('id', job.id)
    if (failErr) throw new Error(`sweep fail update error for ${job.id}: ${failErr.message}`)

    const { error: dlqErr } = await svc
      .from('dead_letter_queue')
      .insert({
        organization_id:   job.organization_id,
        job_id:            job.id,
        job_type:          job.job_type,
        original_payload:  job.payload,
        error_summary:     'Job exhausted all retries without completing',
        retry_count:       job.retry_count,
        resolution_status: 'pending_review',
      })
    if (dlqErr) throw new Error(`sweep DLQ insert error for ${job.id}: ${dlqErr.message}`)
  }

  return rows.length
}
