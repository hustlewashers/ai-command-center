import { getServiceClient } from '@/lib/supabase/service'
import { enqueue } from '@/lib/jobs/enqueue'
import type { BackgroundJob } from '@/types/jobs'

export async function handleScheduledTrigger(job: BackgroundJob): Promise<void> {
  const svc = getServiceClient()
  const now = new Date().toISOString()

  let scheduleName = '(no schedule linked)'
  let scheduleJobType: string | null = null
  let schedulePayload: Record<string, unknown> = {}

  // Load the parent schedule if one is linked
  if (job.parent_schedule_id) {
    const { data: schedule, error } = await svc
      .from('scheduled_tasks')
      .select('id, name, job_type, payload_template, status')
      .eq('id', job.parent_schedule_id)
      .single()

    if (error) {
      console.warn(`[scheduled-trigger] could not load schedule ${job.parent_schedule_id}: ${error.message}`)
    } else if (schedule) {
      scheduleName    = (schedule as Record<string, unknown>)['name'] as string
      scheduleJobType = (schedule as Record<string, unknown>)['job_type'] as string
      schedulePayload = ((schedule as Record<string, unknown>)['payload_template'] as Record<string, unknown>) ?? {}

      // Record that this schedule fired
      await svc
        .from('scheduled_tasks')
        .update({ last_run_at: now })
        .eq('id', job.parent_schedule_id)
    }
  }

  // Write execution log
  const { error: logErr } = await svc.from('execution_logs').insert({
    organization_id: job.organization_id,
    event_type:      'state_change',
    actor:           'worker:scheduled-trigger',
    summary:         `Scheduled trigger fired: ${scheduleName}`,
    context_type:    'workflow',
    context_id:      job.parent_schedule_id ?? job.id,
    metadata: {
      job_id:             job.id,
      parent_schedule_id: job.parent_schedule_id ?? null,
      schedule_name:      scheduleName,
      schedule_job_type:  scheduleJobType,
    },
    status: 'recorded',
  })
  if (logErr) throw new Error(`execution_log write failed: ${logErr.message}`)

  // Enqueue the scheduled job type if the schedule has a non-self, non-empty target
  const noFollowUp = !scheduleJobType
    || scheduleJobType === 'scheduled_trigger'
    || Object.keys(schedulePayload).length === 0

  if (!noFollowUp && scheduleJobType) {
    await enqueue({
      job_type:           scheduleJobType as BackgroundJob['job_type'],
      payload:            { ...schedulePayload, triggered_by_job_id: job.id },
      organization_id:    job.organization_id,
      priority:           job.priority,
      parent_schedule_id: job.parent_schedule_id,
    })
  }
}
