export type AgentActivityStatus = 'completed' | 'failed' | 'skipped' | 'flagged'

export interface AgentActivityRow {
  id: string
  organization_id: string
  agent_user_id: string | null
  task_id: string | null
  work_packet_id: string | null
  execution_log_id: string | null
  session_id: string | null
  activity_type: string
  summary: string
  metadata: Record<string, unknown>
  status: AgentActivityStatus
  created_at: string
}
