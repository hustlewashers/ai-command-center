import { getServiceClient } from '@/lib/supabase/service'
import type { EnqueueOptions } from '@/types/jobs'

export async function enqueue(opts: EnqueueOptions): Promise<string> {
  const svc = getServiceClient()
  const { data, error } = await svc
    .from('background_jobs')
    .insert({
      organization_id:        opts.organization_id,
      job_type:               opts.job_type,
      payload:                opts.payload,
      status:                 'queued',
      priority:               opts.priority ?? 5,
      max_retries:            opts.max_retries ?? 3,
      retry_count:            0,
      scheduled_for:          opts.scheduled_for ?? null,
      related_task_id:        opts.related_task_id ?? null,
      related_request_id:     opts.related_request_id ?? null,
      related_work_packet_id: opts.related_work_packet_id ?? null,
      created_by_user_id:     opts.created_by_user_id ?? null,
      parent_schedule_id:     opts.parent_schedule_id ?? null,
    })
    .select('id')
    .single()

  if (error) throw new Error(`enqueue failed: ${error.message}`)
  return (data as { id: string }).id
}
