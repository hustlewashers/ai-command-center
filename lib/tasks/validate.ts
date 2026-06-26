import { createError } from '@/lib/errors'
import type { TaskStatus, TaskPriority, CreateTaskBody, PatchTaskBody } from '@/types/tasks'
import { VALID_TASK_TRANSITIONS, VALID_INITIAL_STATUSES } from '@/types/tasks'

const VALID_STATUSES: TaskStatus[] = ['backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled']
const VALID_PRIORITIES: TaskPriority[] = ['low', 'normal', 'high', 'critical']

function validateUuidOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') {
    throw createError('validation', `"${field}" must be a UUID string or null`)
  }
  return value
}

export function validateCreateBody(body: unknown): CreateTaskBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  if (!b.title || typeof b.title !== 'string' || b.title.trim().length === 0) {
    throw createError('validation', '"title" is required and must be a non-empty string')
  }

  if (!b.project_id || typeof b.project_id !== 'string') {
    throw createError('validation', '"project_id" is required and must be a UUID string')
  }

  if (!b.department_id || typeof b.department_id !== 'string') {
    throw createError('validation', '"department_id" is required and must be a UUID string')
  }

  const priority = (b.priority ?? 'normal') as TaskPriority
  if (!VALID_PRIORITIES.includes(priority)) {
    throw createError('validation', `"priority" must be one of: ${VALID_PRIORITIES.join(', ')}`)
  }

  const status = (b.status ?? 'backlog') as TaskStatus
  if (!VALID_STATUSES.includes(status)) {
    throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
  }
  if (!VALID_INITIAL_STATUSES.includes(status)) {
    throw createError('validation', `Initial status must be one of: ${VALID_INITIAL_STATUSES.join(', ')}`)
  }

  return {
    title:               (b.title as string).trim(),
    project_id:          b.project_id as string,
    department_id:       b.department_id as string,
    priority,
    status,
    request_id:          validateUuidOrNull(b.request_id, 'request_id'),
    work_packet_id:      validateUuidOrNull(b.work_packet_id, 'work_packet_id'),
    workflow_id:         validateUuidOrNull(b.workflow_id, 'workflow_id'),
    tool_profile_id:     validateUuidOrNull(b.tool_profile_id, 'tool_profile_id'),
    assigned_to_user_id: validateUuidOrNull(b.assigned_to_user_id, 'assigned_to_user_id'),
  }
}

export function validatePatchBody(body: unknown): PatchTaskBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  const patch: PatchTaskBody = {}

  if ('title' in b) {
    if (typeof b.title !== 'string' || b.title.trim().length === 0) {
      throw createError('validation', '"title" must be a non-empty string')
    }
    patch.title = (b.title as string).trim()
  }

  if ('priority' in b) {
    if (!VALID_PRIORITIES.includes(b.priority as TaskPriority)) {
      throw createError('validation', `"priority" must be one of: ${VALID_PRIORITIES.join(', ')}`)
    }
    patch.priority = b.priority as TaskPriority
  }

  if ('status' in b) {
    if (!VALID_STATUSES.includes(b.status as TaskStatus)) {
      throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
    }
    patch.status = b.status as TaskStatus
  }

  if ('assigned_to_user_id' in b) {
    patch.assigned_to_user_id = validateUuidOrNull(b.assigned_to_user_id, 'assigned_to_user_id')
  }

  if ('request_id' in b) {
    patch.request_id = validateUuidOrNull(b.request_id, 'request_id')
  }

  if ('work_packet_id' in b) {
    patch.work_packet_id = validateUuidOrNull(b.work_packet_id, 'work_packet_id')
  }

  if ('workflow_id' in b) {
    patch.workflow_id = validateUuidOrNull(b.workflow_id, 'workflow_id')
  }

  if ('tool_profile_id' in b) {
    patch.tool_profile_id = validateUuidOrNull(b.tool_profile_id, 'tool_profile_id')
  }

  return patch
}

export function validateTaskStatusTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed = VALID_TASK_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw createError(
      'conflict',
      `Cannot transition task from "${from}" to "${to}". Allowed: ${allowed.length ? allowed.join(', ') : 'none (terminal state)'}`,
    )
  }
}
