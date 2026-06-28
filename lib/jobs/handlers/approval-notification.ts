import { getServiceClient } from '@/lib/supabase/service'
import type { BackgroundJob, ApprovalNotificationPayload } from '@/types/jobs'

export async function handleApprovalNotification(job: BackgroundJob): Promise<void> {
  const payload = job.payload as Partial<ApprovalNotificationPayload>

  if (!payload.approval_id)  throw new Error('approval_id is required in payload')
  if (!payload.subject_type) throw new Error('subject_type is required in payload')
  if (!payload.category)     throw new Error('category is required in payload')

  // context_type must be one of ('request', 'task', 'workflow')
  const contextType = payload.subject_type === 'task'    ? 'task'
                    : payload.subject_type === 'request' ? 'request'
                    : 'workflow'

  const svc = getServiceClient()

  // Write execution_log — primary obligation; throw on failure
  const { data: logRow, error: logErr } = await svc
    .from('execution_logs')
    .insert({
      organization_id: job.organization_id,
      event_type:      'note',
      actor:           'worker:approval-notification',
      summary:         `Approval notification queued: ${payload.category} approval on ${payload.subject_type} (id=${payload.approval_id})`,
      context_type:    contextType,
      context_id:      payload.approval_id,
      metadata: {
        job_id:         job.id,
        approval_id:    payload.approval_id,
        subject_type:   payload.subject_type,
        subject_id:     payload.subject_id   ?? null,
        category:       payload.category,
        trigger_reason: payload.trigger_reason ?? null,
      },
      status: 'recorded',
    })
    .select('id')
    .single()

  if (logErr) throw new Error(`execution_log write failed: ${logErr.message}`)

  // Write agent_activity if the payload supplies enough context.
  // requested_by_user_id must be a valid users.id (FK) — wrap non-fatally.
  if (payload.requested_by_user_id) {
    const taskId       = payload.subject_type === 'task'        ? payload.subject_id : null
    const workPacketId = payload.subject_type === 'work_packet' ? payload.subject_id : null
    const execLogId    = (logRow as Record<string, unknown> | null)?.['id'] as string | null ?? null

    const { error: actErr } = await svc.from('agent_activity').insert({
      organization_id:  job.organization_id,
      agent_user_id:    payload.requested_by_user_id,
      session_id:       job.id,          // job ID serves as session boundary; no FK on session_id
      activity_type:    'approval_requested',
      summary:          `Approval notification processed: ${payload.category} approval ${payload.approval_id}`,
      metadata: {
        job_id:      job.id,
        approval_id: payload.approval_id,
        category:    payload.category,
      },
      task_id:          taskId       ?? null,
      work_packet_id:   workPacketId ?? null,
      execution_log_id: execLogId,
      status:           'completed',
    })

    if (actErr) {
      // Non-fatal: agent_activity is supplementary; don't fail the job for a missing user FK
      console.warn(`[approval-notification] agent_activity write skipped: ${actErr.message}`)
    }
  }
}
