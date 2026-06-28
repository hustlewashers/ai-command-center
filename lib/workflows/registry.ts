import type { WorkflowDefinition } from '@/types/workflows'

// In-code workflow registry.
// Mirrors the shape of future DB-backed workflow definitions so the executor
// stays generic and the registry can be migrated to a table later.

const WORKFLOWS: Record<string, WorkflowDefinition> = {
  request_to_task: {
    id:          'request_to_task',
    name:        'Request → Task',
    description: 'Turns an incoming request into a task and work packet scaffold.',
    steps: [
      {
        id:   'log_start',
        type: 'write_execution_log',
        params: { message: 'Workflow started: request_to_task' },
      },
      {
        id:   'create_task_1',
        type: 'create_task',
      },
      {
        id:   'create_wp_1',
        type: 'create_work_packet',
      },
      {
        id:   'log_complete',
        type: 'write_execution_log',
        params: { message: 'Workflow completed: request_to_task' },
      },
      {
        id:   'complete',
        type: 'complete',
      },
    ],
  },
}

export function getWorkflow(id: string): WorkflowDefinition | undefined {
  return WORKFLOWS[id]
}

export function listWorkflows(): WorkflowDefinition[] {
  return Object.values(WORKFLOWS)
}
