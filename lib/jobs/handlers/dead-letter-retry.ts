import { getServiceClient } from '@/lib/supabase/service'
import { enqueue } from '@/lib/jobs/enqueue'
import type { BackgroundJob, DeadLetterRetryPayload } from '@/types/jobs'

export async function handleDeadLetterRetry(job: BackgroundJob): Promise<void> {
  const payload = job.payload as Partial<DeadLetterRetryPayload>

  if (!payload.dlq_entry_id) throw new Error('dlq_entry_id is required in payload')
  if (!payload.original_job_type) throw new Error('original_job_type is required in payload')
  if (!payload.original_payload) throw new Error('original_payload is required in payload')

  const orgId = payload.original_organization_id ?? job.organization_id

  // Re-enqueue the original job with a fresh retry budget
  await enqueue({
    job_type:        payload.original_job_type,
    payload:         payload.original_payload,
    organization_id: orgId,
    priority:        job.priority,
    max_retries:     3,
  })

  // Mark the DLQ entry as resolved.
  // resolved_at is required by dead_letter_queue_resolved_status_check when status != pending_review.
  const svc = getServiceClient()
  const { error } = await svc
    .from('dead_letter_queue')
    .update({
      resolution_status: 'requeued',
      resolved_at:       new Date().toISOString(),
      resolution_note:   `Re-enqueued by dead_letter_retry job ${job.id}`,
    })
    .eq('id', payload.dlq_entry_id)

  if (error) throw new Error(`DLQ resolution update failed: ${error.message}`)
}
