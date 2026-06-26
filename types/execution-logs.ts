export type ExecutionLogEventType =
  | 'tool_call'
  | 'state_change'
  | 'error'
  | 'note'
  | 'approval_action'

export type ExecutionLogContextType = 'request' | 'task' | 'workflow'

export type ExecutionLogStatus = 'recorded' | 'flagged' | 'reviewed' | 'corrected'

export interface ExecutionLogRow {
  id: string
  organization_id: string
  event_type: ExecutionLogEventType
  actor: string
  occurred_at: string
  summary: string
  context_type: ExecutionLogContextType
  context_id: string
  metadata: Record<string, unknown>
  status: ExecutionLogStatus
  created_at: string
}
