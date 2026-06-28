import { getServiceClient } from '@/lib/supabase/service'
import { handleApprovalNotification } from './handlers/approval-notification'
import { handleDeadLetterRetry } from './handlers/dead-letter-retry'
import { handleScheduledTrigger } from './handlers/scheduled-trigger'
import { handleWorkflowStep } from './handlers/workflow-step'
import { handleNoOp } from './handlers/no-op'
import type { BackgroundJob, JobType } from '@/types/jobs'

type JobHandler = (job: BackgroundJob) => Promise<void>

// Registry pattern: add new handlers here. Job types absent from this map are
// handled gracefully as logged no-ops (not failed) so unimplemented types don't
// accumulate DLQ entries.
const registry: Partial<Record<JobType, JobHandler>> = {
  other:                 handleNoOp,
  approval_notification: handleApprovalNotification,
  scheduled_trigger:     handleScheduledTrigger,
  dead_letter_retry:     handleDeadLetterRetry,
  workflow_step:         handleWorkflowStep,
}

export async function dispatch(job: BackgroundJob): Promise<void> {
  const svc = getServiceClient()
  const now = () => new Date().toISOString()

  const handler = registry[job.job_type]

  // No handler registered: log intent and complete gracefully.
  // Unimplemented types (webhook_emit, output_delivery, knowledge_sync) are
  // expected — don't retry and don't create DLQ noise.
  if (!handler) {
    await svc.from('execution_logs').insert({
      organization_id: job.organization_id,
      event_type:      'note',
      actor:           'worker:dispatcher',
      summary:         `Job type '${job.job_type}' has no registered handler — completed as informational no-op`,
      context_type:    'workflow',
      context_id:      job.organization_id,
      metadata:        { job_id: job.id, job_type: job.job_type, payload: job.payload },
      status:          'recorded',
    })
    await svc.from('background_jobs').update({
      status:       'completed',
      completed_at: now(),
      last_error:   null,
    }).eq('id', job.id)
    return
  }

  try {
    await handler(job)

    // Clear last_error on success so stale error messages don't persist
    await svc.from('background_jobs').update({
      status:       'completed',
      completed_at: now(),
      last_error:   null,
    }).eq('id', job.id)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const nextRetryCount = job.retry_count + 1

    if (nextRetryCount > job.max_retries) {
      // All retries exhausted — mark failed and create DLQ entry
      await svc.from('background_jobs').update({
        status:       'failed',
        last_error:   message,
        completed_at: now(),
      }).eq('id', job.id)

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

      await svc.from('background_jobs').update({
        status:        'retrying',
        retry_count:   nextRetryCount,
        last_error:    message,
        scheduled_for: scheduledFor,
      }).eq('id', job.id)
    }

    throw err
  }
}
