export type WorkflowStepType =
  | 'write_execution_log'
  | 'create_task'
  | 'create_work_packet'
  | 'create_output'
  | 'request_approval'
  | 'complete'
  | 'call_ai'

export interface WorkflowStepDefinition {
  id: string
  type: WorkflowStepType
  params?: Record<string, unknown>
}

// Entity kinds that can trigger a workflow (Sprint 5.8). Mirrors
// execution_logs.context_type / workflow_runs.trigger_entity_type vocabulary.
export type WorkflowTriggerEntityType = 'request' | 'task' | 'approval'

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
  // Which business entities may trigger this workflow. A definition with no
  // triggers can still be enqueued directly (e.g. dev/manual) but is not
  // reachable from a business-action trigger. Kept in code for now.
  triggers?: WorkflowTriggerEntityType[]
  steps: WorkflowStepDefinition[]
}

// Inputs provided by the job payload. accumulated holds outputs from prior steps.
export interface WorkflowExecutionContext {
  organization_id: string
  job_id?: string | null            // set by handler; used as execution_log context_id
  department_id?: string | null
  project_id?: string | null
  request_id?: string | null
  created_by?: string | null        // user id — used as tasks.created_by / work_packets.author_user_id
  title?: string | null
  [key: string]: unknown
}

export interface WorkflowStepResult {
  step_id: string
  type: WorkflowStepType
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export interface WorkflowExecutionResult {
  workflow_id: string
  workflow_run_id: string
  completed_steps: WorkflowStepResult[]
  failed_step?: WorkflowStepResult
  success: boolean
  accumulated: Record<string, unknown>
}
