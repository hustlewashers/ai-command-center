import { createError } from '@/lib/errors'
import type { OutputType, OutputStatus, CreateOutputBody, PatchOutputBody } from '@/types/outputs'
import { VALID_OUTPUT_TRANSITIONS, VALID_INSERT_STATUSES } from '@/types/outputs'

const VALID_TYPES: OutputType[] = ['report', 'artifact', 'message', 'data', 'other']
const VALID_STATUSES: OutputStatus[] = [
  'draft', 'in_review', 'approved', 'delivered', 'superseded', 'rejected',
]

export function validateCreateBody(body: unknown): CreateOutputBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  if (!b.title || typeof b.title !== 'string' || b.title.trim().length === 0) {
    throw createError('validation', '"title" is required and must be a non-empty string')
  }

  if (!b.output_type || !VALID_TYPES.includes(b.output_type as OutputType)) {
    throw createError('validation', `"output_type" is required and must be one of: ${VALID_TYPES.join(', ')}`)
  }

  if (!b.department_id || typeof b.department_id !== 'string') {
    throw createError('validation', '"department_id" is required and must be a UUID string')
  }

  if (!b.task_id || typeof b.task_id !== 'string') {
    throw createError('validation', '"task_id" is required and must be a UUID string')
  }

  if (!b.project_id || typeof b.project_id !== 'string') {
    throw createError('validation', '"project_id" is required and must be a UUID string')
  }

  // content is required unless storage_path is provided (G6 §8).
  const hasContent = b.content && typeof b.content === 'string' && b.content.trim().length > 0
  const hasPath = b.storage_path && typeof b.storage_path === 'string' && b.storage_path.trim().length > 0
  if (!hasContent && !hasPath) {
    throw createError('validation', '"content" is required unless "storage_path" is provided')
  }

  const status = (b.status ?? 'draft') as OutputStatus
  if (!VALID_STATUSES.includes(status)) {
    throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
  }
  if (!VALID_INSERT_STATUSES.includes(status)) {
    throw createError(
      'validation',
      `Initial status must be one of: ${VALID_INSERT_STATUSES.join(', ')}. ` +
      `Reaching "${status}" requires an update after creation.`,
    )
  }

  return {
    title:        (b.title as string).trim(),
    output_type:  b.output_type as OutputType,
    content:      hasContent ? (b.content as string).trim() : null,
    storage_path: hasPath ? (b.storage_path as string).trim() : null,
    department_id: b.department_id as string,
    task_id:      b.task_id as string,
    project_id:   b.project_id as string,
    status,
  }
}

export function validatePatchBody(body: unknown): PatchOutputBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  const patch: PatchOutputBody = {}

  if ('title' in b) {
    if (typeof b.title !== 'string' || b.title.trim().length === 0) {
      throw createError('validation', '"title" must be a non-empty string')
    }
    patch.title = (b.title as string).trim()
  }

  if ('output_type' in b) {
    if (!VALID_TYPES.includes(b.output_type as OutputType)) {
      throw createError('validation', `"output_type" must be one of: ${VALID_TYPES.join(', ')}`)
    }
    patch.output_type = b.output_type as OutputType
  }

  if ('content' in b) {
    if (b.content !== null && (typeof b.content !== 'string' || b.content.trim().length === 0)) {
      throw createError('validation', '"content" must be a non-empty string or null')
    }
    patch.content = b.content === null ? null : (b.content as string).trim()
  }

  if ('storage_path' in b) {
    if (b.storage_path !== null && (typeof b.storage_path !== 'string' || b.storage_path.trim().length === 0)) {
      throw createError('validation', '"storage_path" must be a non-empty string or null')
    }
    patch.storage_path = b.storage_path === null ? null : (b.storage_path as string).trim()
  }

  if ('status' in b) {
    if (!VALID_STATUSES.includes(b.status as OutputStatus)) {
      throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
    }
    patch.status = b.status as OutputStatus
  }

  return patch
}

// Validates that a status transition is in the documented state machine (G6 §5).
// The Category A delivery gate (approved → delivered requires an approved output-approval)
// is enforced by the route handler after this check, not here.
export function validateOutputStatusTransition(from: OutputStatus, to: OutputStatus): void {
  const allowed = VALID_OUTPUT_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw createError(
      'conflict',
      `Cannot transition output from "${from}" to "${to}". Allowed: ${
        allowed.length ? allowed.join(', ') : 'none (terminal state)'
      }`,
    )
  }
}
