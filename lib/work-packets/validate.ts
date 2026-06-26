import { createError } from '@/lib/errors'
import type {
  WorkPacketStatus,
  WorkPacketPriority,
  WorkPacketParentType,
  CreateWorkPacketBody,
  PatchWorkPacketBody,
} from '@/types/work-packets'
import { VALID_WORK_PACKET_TRANSITIONS, VALID_INITIAL_WP_STATUSES } from '@/types/work-packets'

const VALID_STATUSES: WorkPacketStatus[] = [
  'draft', 'ready', 'pending_approval', 'in_execution', 'accepted', 'superseded', 'cancelled',
]
const VALID_PRIORITIES: WorkPacketPriority[] = ['low', 'normal', 'high', 'critical']
const VALID_PARENT_TYPES: WorkPacketParentType[] = ['task', 'project']

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw createError('validation', `"${field}" must be a JSON object`)
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw createError('validation', `"${field}" must be a JSON object, not an array or primitive`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw createError('validation', `"${field}" must be a JSON array`)
  }
  return value
}

export function validateCreateBody(body: unknown): CreateWorkPacketBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  if (!b.title || typeof b.title !== 'string' || b.title.trim().length === 0) {
    throw createError('validation', '"title" is required and must be a non-empty string')
  }

  if (!b.objective || typeof b.objective !== 'string' || b.objective.trim().length === 0) {
    throw createError('validation', '"objective" is required and must be a non-empty string')
  }

  if (!b.department_id || typeof b.department_id !== 'string') {
    throw createError('validation', '"department_id" is required and must be a UUID string')
  }

  if (!b.parent_type || !VALID_PARENT_TYPES.includes(b.parent_type as WorkPacketParentType)) {
    throw createError('validation', `"parent_type" is required and must be one of: ${VALID_PARENT_TYPES.join(', ')}`)
  }

  if (!b.parent_id || typeof b.parent_id !== 'string') {
    throw createError('validation', '"parent_id" is required and must be a UUID string')
  }

  const priority = (b.priority ?? 'normal') as WorkPacketPriority
  if (!VALID_PRIORITIES.includes(priority)) {
    throw createError('validation', `"priority" must be one of: ${VALID_PRIORITIES.join(', ')}`)
  }

  const status = (b.status ?? 'draft') as WorkPacketStatus
  if (!VALID_STATUSES.includes(status)) {
    throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
  }
  if (!VALID_INITIAL_WP_STATUSES.includes(status)) {
    throw createError('validation', `Initial status must be one of: ${VALID_INITIAL_WP_STATUSES.join(', ')}`)
  }

  const approvalRequired = b.approval_required_before_start ?? false
  if (typeof approvalRequired !== 'boolean') {
    throw createError('validation', '"approval_required_before_start" must be a boolean')
  }

  // Shape-validate the JSON fields (DB also enforces these via check constraints).
  const scope = b.scope !== undefined ? requireObject(b.scope, 'scope') : {}
  const acceptance_criteria = b.acceptance_criteria !== undefined ? requireArray(b.acceptance_criteria, 'acceptance_criteria') : []
  const constraints = b.constraints !== undefined ? requireObject(b.constraints, 'constraints') : {}

  return {
    title:                        (b.title as string).trim(),
    objective:                    (b.objective as string).trim(),
    department_id:                b.department_id as string,
    parent_type:                  b.parent_type as WorkPacketParentType,
    parent_id:                    b.parent_id as string,
    priority,
    status,
    approval_required_before_start: approvalRequired as boolean,
    scope,
    acceptance_criteria,
    constraints,
  }
}

export function validatePatchBody(body: unknown): PatchWorkPacketBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  const patch: PatchWorkPacketBody = {}

  if ('title' in b) {
    if (typeof b.title !== 'string' || b.title.trim().length === 0) {
      throw createError('validation', '"title" must be a non-empty string')
    }
    patch.title = (b.title as string).trim()
  }

  if ('objective' in b) {
    if (typeof b.objective !== 'string' || b.objective.trim().length === 0) {
      throw createError('validation', '"objective" must be a non-empty string')
    }
    patch.objective = (b.objective as string).trim()
  }

  if ('priority' in b) {
    if (!VALID_PRIORITIES.includes(b.priority as WorkPacketPriority)) {
      throw createError('validation', `"priority" must be one of: ${VALID_PRIORITIES.join(', ')}`)
    }
    patch.priority = b.priority as WorkPacketPriority
  }

  if ('status' in b) {
    if (!VALID_STATUSES.includes(b.status as WorkPacketStatus)) {
      throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
    }
    patch.status = b.status as WorkPacketStatus
  }

  if ('scope' in b) {
    patch.scope = requireObject(b.scope, 'scope')
  }

  if ('acceptance_criteria' in b) {
    patch.acceptance_criteria = requireArray(b.acceptance_criteria, 'acceptance_criteria')
  }

  if ('constraints' in b) {
    patch.constraints = requireObject(b.constraints, 'constraints')
  }

  if ('approval_required_before_start' in b) {
    if (typeof b.approval_required_before_start !== 'boolean') {
      throw createError('validation', '"approval_required_before_start" must be a boolean')
    }
    patch.approval_required_before_start = b.approval_required_before_start
  }

  return patch
}

// Validates that a status transition is in the state machine's allowed set (G4 §5).
// Conditional gate rules (approval_required_before_start) are checked by the route handler.
export function validateWorkPacketStatusTransition(
  from: WorkPacketStatus,
  to: WorkPacketStatus,
): void {
  const allowed = VALID_WORK_PACKET_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw createError(
      'conflict',
      `Cannot transition work packet from "${from}" to "${to}". Allowed: ${
        allowed.length ? allowed.join(', ') : 'none (terminal state)'
      }`,
    )
  }
}
