import { createError } from '@/lib/errors'
import type {
  BlockerEntityType,
  BlockerSeverity,
  BlockerStatus,
  CreateBlockerBody,
  PatchBlockerBody,
} from '@/types/blockers'
import { VALID_BLOCKER_TRANSITIONS } from '@/types/blockers'

const VALID_ENTITY_TYPES: BlockerEntityType[] = ['task', 'work_packet']
const VALID_SEVERITIES: BlockerSeverity[] = ['low', 'medium', 'high', 'critical']
const VALID_STATUSES: BlockerStatus[] = [
  'open', 'investigating', 'pending_external', 'resolved', 'won_t_fix',
]

export function validateCreateBody(body: unknown): CreateBlockerBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  if (!b.department_id || typeof b.department_id !== 'string') {
    throw createError('validation', '"department_id" is required and must be a UUID string')
  }

  if (!b.description || typeof b.description !== 'string' || b.description.trim().length === 0) {
    throw createError('validation', '"description" is required and must be a non-empty string')
  }

  // Project blockers are not supported by the deployed DB schema (G8 §2).
  // Surface a clear error before the DB write so the caller gets a typed response.
  if ((b.blocked_entity_type as string) === 'project') {
    throw createError(
      'validation',
      '"blocked_entity_type" value "project" is not supported — the deployed schema only admits "task" or "work_packet"',
    )
  }

  if (!b.blocked_entity_type || !VALID_ENTITY_TYPES.includes(b.blocked_entity_type as BlockerEntityType)) {
    throw createError('validation', `"blocked_entity_type" is required and must be one of: ${VALID_ENTITY_TYPES.join(', ')}`)
  }

  if (!b.blocked_entity_id || typeof b.blocked_entity_id !== 'string') {
    throw createError('validation', '"blocked_entity_id" is required and must be a UUID string')
  }

  const severity = (b.severity ?? 'medium') as BlockerSeverity
  if (!VALID_SEVERITIES.includes(severity)) {
    throw createError('validation', `"severity" must be one of: ${VALID_SEVERITIES.join(', ')}`)
  }

  const assignedTo = b.assigned_to_user_id ?? null
  if (assignedTo !== null && typeof assignedTo !== 'string') {
    throw createError('validation', '"assigned_to_user_id" must be a UUID string or null')
  }

  return {
    department_id:      b.department_id as string,
    description:        (b.description as string).trim(),
    blocked_entity_type: b.blocked_entity_type as BlockerEntityType,
    blocked_entity_id:  b.blocked_entity_id as string,
    severity,
    assigned_to_user_id: assignedTo as string | null,
  }
}

export function validatePatchBody(body: unknown): PatchBlockerBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  const patch: PatchBlockerBody = {}

  if ('description' in b) {
    if (typeof b.description !== 'string' || b.description.trim().length === 0) {
      throw createError('validation', '"description" must be a non-empty string')
    }
    patch.description = (b.description as string).trim()
  }

  if ('severity' in b) {
    if (!VALID_SEVERITIES.includes(b.severity as BlockerSeverity)) {
      throw createError('validation', `"severity" must be one of: ${VALID_SEVERITIES.join(', ')}`)
    }
    patch.severity = b.severity as BlockerSeverity
  }

  if ('status' in b) {
    if (!VALID_STATUSES.includes(b.status as BlockerStatus)) {
      throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
    }
    patch.status = b.status as BlockerStatus
  }

  if ('resolution_note' in b) {
    if (b.resolution_note !== null && (typeof b.resolution_note !== 'string' || b.resolution_note.trim().length === 0)) {
      throw createError('validation', '"resolution_note" must be a non-empty string or null')
    }
    patch.resolution_note = b.resolution_note === null ? null : (b.resolution_note as string).trim()
  }

  if ('assigned_to_user_id' in b) {
    if (b.assigned_to_user_id !== null && typeof b.assigned_to_user_id !== 'string') {
      throw createError('validation', '"assigned_to_user_id" must be a UUID string or null')
    }
    patch.assigned_to_user_id = b.assigned_to_user_id as string | null
  }

  return patch
}

// Validates that a status transition is in the state machine's allowed set (G8 §5).
// The won_t_fix → open Category B Decision gate is enforced by the route handler, not here.
export function validateBlockerTransition(from: BlockerStatus, to: BlockerStatus): void {
  const allowed = VALID_BLOCKER_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw createError(
      'conflict',
      `Cannot transition blocker from "${from}" to "${to}". Allowed: ${
        allowed.length ? allowed.join(', ') : 'none (no valid transitions from this status)'
      }`,
    )
  }
}
