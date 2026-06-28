import { getServiceClient } from '@/lib/supabase/service'
import type { BackgroundJob } from '@/types/jobs'

// Safe no-op handler for job_type='other'.
// Writes a single execution_log entry and returns success.
// Makes no external calls, creates no entities, triggers no approvals.
export async function handleNoOp(job: BackgroundJob): Promise<void> {
  const svc = getServiceClient()
  const { error } = await svc.from('execution_logs').insert({
    organization_id: job.organization_id,
    event_type:      'note',
    actor:           'worker:no-op',
    summary:         `No-op job processed (job_type=other, id=${job.id})`,
    context_type:    'workflow',
    context_id:      job.id,
    metadata: {
      job_id:   job.id,
      job_type: job.job_type,
      payload:  job.payload,
    },
    status: 'recorded',
  })

  if (error) throw new Error(`no-op execution_log write failed: ${error.message}`)
}
