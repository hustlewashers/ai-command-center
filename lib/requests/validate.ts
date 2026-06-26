import { createError } from '@/lib/errors'
import type { RequestSource, RequestStatus, CreateRequestBody, PatchRequestBody } from '@/types/requests'
import { VALID_TRANSITIONS } from '@/types/requests'

const VALID_SOURCES: RequestSource[] = ['human', 'automation', 'webhook', 'scheduled_job']
const VALID_STATUSES: RequestStatus[] = ['received', 'triaged', 'in_progress', 'completed', 'rejected', 'cancelled']

export function validateCreateBody(body: unknown): CreateRequestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  if (!b.intent || typeof b.intent !== 'string' || b.intent.trim().length === 0) {
    throw createError('validation', '"intent" is required and must be a non-empty string')
  }

  if (b.source !== undefined && !VALID_SOURCES.includes(b.source as RequestSource)) {
    throw createError('validation', `"source" must be one of: ${VALID_SOURCES.join(', ')}`)
  }

  if (b.metadata !== undefined && (typeof b.metadata !== 'object' || Array.isArray(b.metadata) || b.metadata === null)) {
    throw createError('validation', '"metadata" must be a JSON object')
  }

  if (b.routed_department_id !== undefined && b.routed_department_id !== null && typeof b.routed_department_id !== 'string') {
    throw createError('validation', '"routed_department_id" must be a UUID string or null')
  }

  if (b.project_id !== undefined && b.project_id !== null && typeof b.project_id !== 'string') {
    throw createError('validation', '"project_id" must be a UUID string or null')
  }

  return {
    intent: (b.intent as string).trim(),
    source: (b.source as RequestSource) ?? 'human',
    routed_department_id: (b.routed_department_id as string | null) ?? null,
    project_id: (b.project_id as string | null) ?? null,
    metadata: (b.metadata as Record<string, unknown>) ?? {},
  }
}

export function validatePatchBody(body: unknown): PatchRequestBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>
  const patch: PatchRequestBody = {}

  if ('intent' in b) {
    if (typeof b.intent !== 'string' || b.intent.trim().length === 0) {
      throw createError('validation', '"intent" must be a non-empty string')
    }
    patch.intent = (b.intent as string).trim()
  }

  if ('status' in b) {
    if (!VALID_STATUSES.includes(b.status as RequestStatus)) {
      throw createError('validation', `"status" must be one of: ${VALID_STATUSES.join(', ')}`)
    }
    patch.status = b.status as RequestStatus
  }

  if ('metadata' in b) {
    if (typeof b.metadata !== 'object' || Array.isArray(b.metadata) || b.metadata === null) {
      throw createError('validation', '"metadata" must be a JSON object')
    }
    patch.metadata = b.metadata as Record<string, unknown>
  }

  if ('routed_department_id' in b) {
    if (b.routed_department_id !== null && typeof b.routed_department_id !== 'string') {
      throw createError('validation', '"routed_department_id" must be a UUID string or null')
    }
    patch.routed_department_id = b.routed_department_id as string | null
  }

  if ('project_id' in b) {
    if (b.project_id !== null && typeof b.project_id !== 'string') {
      throw createError('validation', '"project_id" must be a UUID string or null')
    }
    patch.project_id = b.project_id as string | null
  }

  return patch
}

export function validateStatusTransition(from: RequestStatus, to: RequestStatus): void {
  const allowed = VALID_TRANSITIONS[from]
  if (!allowed.includes(to)) {
    throw createError(
      'conflict',
      `Cannot transition request from "${from}" to "${to}". Allowed: ${allowed.length ? allowed.join(', ') : 'none (terminal state)'}`,
    )
  }
}
