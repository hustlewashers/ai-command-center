export type RequestSource = 'human' | 'automation' | 'webhook' | 'scheduled_job'

export type RequestStatus =
  | 'received'
  | 'triaged'
  | 'in_progress'
  | 'completed'
  | 'rejected'
  | 'cancelled'

export interface RequestRow {
  id: string
  organization_id: string
  source: RequestSource
  intent: string
  submitted_at: string
  submitted_by_user_id: string | null
  routed_department_id: string | null
  project_id: string | null
  metadata: Record<string, unknown>
  status: RequestStatus
  created_at: string
  updated_at: string
}

// Latest workflow state attached to a request by GET /api/requests (Sprint 5.10).
export interface RequestWorkflowState {
  run_id: string
  workflow_id: string
  status: string
}

export type RequestAiSummarySignal =
  | 'ready'
  | 'needs_task'
  | 'missing_inputs'
  | 'running'
  | 'draft_ready'
  | 'failed'
  | 'none'

// Latest request_ai_summary state (Sprint 6.5 list signal).
export interface RequestAiSummaryState {
  run_id: string | null
  status: string | null
  signal: RequestAiSummarySignal
  reason: string
}

export interface RequestRowWithWorkflow extends RequestRow {
  workflow: RequestWorkflowState | null
  ai_summary: RequestAiSummaryState | null
}

export interface CreateRequestBody {
  intent: string
  source: RequestSource
  routed_department_id: string | null
  project_id: string | null
  metadata: Record<string, unknown>
}

export interface PatchRequestBody {
  intent?: string
  routed_department_id?: string | null
  project_id?: string | null
  metadata?: Record<string, unknown>
  status?: RequestStatus
}

// Status transitions permitted by the documented lifecycle (G2 §4–5).
// Terminal states have empty arrays — no outbound transitions.
export const VALID_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  received:    ['triaged', 'rejected', 'cancelled'],
  triaged:     ['in_progress', 'rejected', 'cancelled'],
  in_progress: ['completed', 'rejected', 'cancelled'],
  completed:   [],
  rejected:    [],
  cancelled:   [],
}
