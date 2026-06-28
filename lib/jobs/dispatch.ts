import { getServiceClient } from '@/lib/supabase/service'
import { handleApprovalNotification } from './handlers/approval-notification'
import { handleDeadLetterRetry } from './handlers/dead-letter-retry'
import { handleScheduledTrigger } from './handlers/scheduled-trigger'
import { handleNoOp } from './handlers/no-op'
import type { BackgroundJob } from '@/types/jobs'

export async function dispatch(job: BackgroundJob): Promise<void> {
  const svc = getServiceClient()

  try {
    switch (job.job_type) {
      case 'approval_notification':
        await handleApprovalNotification(job)
        break
      case 'dead_letter_retry':
        await handleDeadLetterRetry(job)
        break
      case 'scheduled_trigger':
        await handleScheduledTrigger(job)
        break
      case 'other':
        await handleNoOp(job)
        break
      default:
        throw new Error(`No handler registered for job_type: ${job.job_type}`)
    }

    // Clear last_error on success so stale error messages don't persist
    await svc
      .from('background_jobs')
      .update({
        status:       'completed',
        completed_at: new Date().toISOString(),
        last_error:   null,
      })
      .eq('id', job.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const nextRetryCount = job.retry_count + 1

    if (nextRetryCount > job.max_retries) {
      // All retries exhausted — mark failed and create DLQ entry
      await svc
        .from('background_jobs')
        .update({
          status:       'failed',
          last_error:   message,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)

      await svc.from('dead_letter_queue').insert({
        organization_id:   job.organization_id,
        job_id:            job.id,
        job_type:          job.job_type,
        original_payload:  job.payload,
        error_summary:     message.slice(0, 500),
        error_detail:      {
          message,
          stack: err instanceof Error ? (err.stack ?? null) : null,
        },
        retry_count:       job.retry_count,
        resolution_status: 'pending_review',
      })
    } else {
      // Schedule retry with exponential back-off: min(30 * 2^retry_count, 3600) seconds
      const backoffSecs  = Math.min(30 * Math.pow(2, job.retry_count), 3600)
      const scheduledFor = new Date(Date.now() + backoffSecs * 1000).toISOString()

      await svc
        .from('background_jobs')
        .update({
          status:        'retrying',
          retry_count:   nextRetryCount,
          last_error:    message,
          scheduled_for: scheduledFor,
        })
        .eq('id', job.id)
    }

    throw err
  }
}
