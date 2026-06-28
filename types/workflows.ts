export type WorkflowStepType =
  | 'write_execution_log'
  | 'create_task'
  | 'create_work_packet'
  | 'create_output'
  | 'request_approval'
  | 'complete'

export interface WorkflowStepDefinition {
  id: string
  type: WorkflowStepType
  params?: Record<string, unknown>
}

export interface WorkflowDefinition {
  id: string
  name: string
  description: string
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
  completed_steps: WorkflowStepResult[]
  failed_step?: WorkflowStepResult
  success: boolean
  accumulated: Record<string, unknown>
}
