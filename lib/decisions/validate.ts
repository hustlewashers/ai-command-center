import { createError } from '@/lib/errors'
import type { DecisionStatus, CreateDecisionBody, PatchDecisionBody } from '@/types/decisions'
import { VALID_DECISION_TRANSITIONS, VALID_INSERT_STATUSES } from '@/types/decisions'

const VALID_STATUSES: DecisionStatus[] = [
  'proposed', 'confirmed', 'pending_approval', 'approved', 'rejected', 'superseded',
]

export function validateCreateBody(body: unknown): CreateDecisionBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  if (!b.task_id || typeof b.task_id !== 'string') {
    throw createError('validation', '"task_id" is required and must be a UUID string')
  }

  if (!b.summary || typeof b.summary !== 'string' || b.summary.trim().length === 0) {
    throw createError('validation', '"summary" is required and must be a non-empty string')
  }

  if (!b.rationale || typeof b.rationale !== 'string' || b.rationale.trim().length === 0) {
    throw createError('validation', '"rationale" is required and must be a non-empty string')
  }

  const status = (b.status ?? 'proposed') as DecisionStatus
  if (!VALID_STATUSES.includes(status)) {
    throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
  }
  // Layer 4: mirror the RLS insert-status floor with a typed error (G7 §7, §18).
  if (!VALID_INSERT_STATUSES.includes(status)) {
    throw createError(
      'validation',
      `Initial status must be one of: ${VALID_INSERT_STATUSES.join(', ')}. ` +
      `Reaching "${status}" requires a lead-authority update after creation.`,
    )
  }

  return {
    task_id:  b.task_id as string,
    summary:  (b.summary as string).trim(),
    rationale: (b.rationale as string).trim(),
    status,
  }
}

export function validatePatchBody(body: unknown): PatchDecisionBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  const patch: PatchDecisionBody = {}

  if ('summary' in b) {
    if (typeof b.summary !== 'string' || b.summary.trim().length === 0) {
      throw createError('validation', '"summary" must be a non-empty string')
    }
    patch.summary = (b.summary as string).trim()
  }

  if ('rationale' in b) {
    if (typeof b.rationale !== 'string' || b.rationale.trim().length === 0) {
      throw createError('validation', '"rationale" must be a non-empty string')
    }
    patch.rationale = (b.rationale as string).trim()
  }

  if ('status' in b) {
    if (!VALID_STATUSES.includes(b.status as DecisionStatus)) {
      throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
    }
    patch.status = b.status as DecisionStatus
  }

  return patch
}

// Validates that a status transition is in the documented state machine (G7 §5).
// The approval gate (pending_approval → approved requires resolved Category B) is
// enforced by the route handler after this check, not here.
export function validateDecisionStatusTransition(
  from: DecisionStatus,
  to: DecisionStatus,
): void {
  const allowed = VALID_DECISION_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw createError(
      'conflict',
      `Cannot transition decision from "${from}" to "${to}". Allowed: ${
        allowed.length ? allowed.join(', ') : 'none (terminal state)'
      }`,
    )
  }
}
