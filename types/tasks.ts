export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'in_progress'
  | 'blocked'
  | 'in_review'
  | 'done'
  | 'cancelled'

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical'

export interface TaskRow {
  id: string
  organization_id: string
  title: string
  project_id: string
  department_id: string
  request_id: string | null
  work_packet_id: string | null
  workflow_id: string | null
  tool_profile_id: string | null
  priority: TaskPriority
  assigned_to_user_id: string | null
  created_by: string
  status: TaskStatus
  created_at: string
  updated_at: string
}

export interface CreateTaskBody {
  title: string
  project_id: string
  department_id: string
  priority: TaskPriority
  status: TaskStatus
  request_id: string | null
  work_packet_id: string | null
  workflow_id: string | null
  tool_profile_id: string | null
  assigned_to_user_id: string | null
}

export interface PatchTaskBody {
  title?: string
  priority?: TaskPriority
  status?: TaskStatus
  assigned_to_user_id?: string | null
  request_id?: string | null
  work_packet_id?: string | null
  workflow_id?: string | null
  tool_profile_id?: string | null
}

// Status transitions permitted by the documented lifecycle (G3 §5).
// Terminal states have empty arrays — no outbound transitions.
// Any non-terminal → cancelled is covered by including 'cancelled' in every non-terminal list.
export const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog:     ['ready', 'in_progress', 'cancelled'],
  ready:       ['in_progress', 'cancelled'],
  in_progress: ['blocked', 'in_review', 'cancelled'],
  blocked:     ['in_progress', 'cancelled'],
  in_review:   ['in_progress', 'done', 'cancelled'],
  done:        [],
  cancelled:   [],
}

export const TERMINAL_TASK_STATUSES: TaskStatus[] = ['done', 'cancelled']

// Only these statuses are permitted when creating a task (G3 §8, §22.1).
export const VALID_INITIAL_STATUSES: TaskStatus[] = ['backlog', 'ready']
