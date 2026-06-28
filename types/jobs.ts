export type JobType =
  | 'workflow_step'
  | 'approval_notification'
  | 'scheduled_trigger'
  | 'webhook_emit'
  | 'output_delivery'
  | 'dead_letter_retry'
  | 'knowledge_sync'
  | 'other'

export type JobStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'retrying'

export interface BackgroundJob {
  id: string
  organization_id: string
  job_type: JobType
  status: JobStatus
  payload: Record<string, unknown>
  priority: number
  retry_count: number
  max_retries: number
  last_error: string | null
  scheduled_for: string | null
  started_at: string | null
  completed_at: string | null
  parent_schedule_id: string | null
  related_task_id: string | null
  related_request_id: string | null
  related_work_packet_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
}

export interface DeadLetterEntry {
  id: string
  organization_id: string
  job_id: string
  job_type: JobType
  original_payload: Record<string, unknown>
  error_summary: string
  error_detail: Record<string, unknown> | null
  retry_count: number
  resolution_status: 'pending_review' | 'requeued' | 'discarded' | 'escalated'
  resolved_by_user_id: string | null
  resolved_at: string | null
  resolution_note: string | null
  failed_at: string
  created_at: string
}

export interface ApprovalNotificationPayload {
  approval_id: string
  subject_type: string
  subject_id: string
  category: string
  trigger_reason?: string | null
  requested_by_user_id: string
}

export interface DeadLetterRetryPayload {
  dlq_entry_id: string
  original_job_type: JobType
  original_payload: Record<string, unknown>
  original_organization_id: string
}

export interface EnqueueOptions {
  job_type: JobType
  payload: Record<string, unknown>
  organization_id: string
  priority?: number
  max_retries?: number
  scheduled_for?: string | null
  related_task_id?: string | null
  related_request_id?: string | null
  related_work_packet_id?: string | null
  created_by_user_id?: string | null
  parent_schedule_id?: string | null
}
