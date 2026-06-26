import { createError } from '@/lib/errors'
import type { CreateApprovalBody, PatchApprovalBody, ApprovalSubjectType } from '@/types/approvals'

const VALID_SUBJECT_TYPES: ApprovalSubjectType[] = ['task', 'work_packet', 'decision', 'output']

// category 'c' exists in the DB enum but is blocked by RLS INSERT/UPDATE WITH CHECK (017).
// Validate at Layer 4 to give a typed validation error rather than a raw 42501 (G5 §4).
const ALLOWED_INSERT_CATEGORIES = ['a', 'b'] as const

// The only resolution statuses reachable via authenticated PATCH (G5 §6, §12).
// 'expired' is system/service-role only; 'pending' has no return path.
const ALLOWED_RESOLUTION_STATUSES = ['approved', 'rejected', 'withdrawn'] as const
type ResolutionStatus = typeof ALLOWED_RESOLUTION_STATUSES[number]

export function validateCreateBody(body: unknown): CreateApprovalBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  if (!b.subject_type || !VALID_SUBJECT_TYPES.includes(b.subject_type as ApprovalSubjectType)) {
    throw createError(
      'validation',
      `"subject_type" is required and must be one of: ${VALID_SUBJECT_TYPES.join(', ')}`,
    )
  }

  if (!b.subject_id || typeof b.subject_id !== 'string' || b.subject_id.trim().length === 0) {
    throw createError('validation', '"subject_id" is required and must be a non-empty UUID string')
  }

  if (!b.category || !ALLOWED_INSERT_CATEGORIES.includes(b.category as 'a' | 'b')) {
    throw createError(
      'validation',
      '"category" is required and must be "a" or "b" (category c cannot be created via API)',
    )
  }

  if (!b.trigger_reason || typeof b.trigger_reason !== 'string' || b.trigger_reason.trim().length === 0) {
    throw createError('validation', '"trigger_reason" is required and must be a non-empty string')
  }

  if (!b.department_id || typeof b.department_id !== 'string' || b.department_id.trim().length === 0) {
    throw createError('validation', '"department_id" is required and must be a non-empty UUID string')
  }

  if (!b.approver_role || typeof b.approver_role !== 'string' || b.approver_role.trim().length === 0) {
    throw createError('validation', '"approver_role" is required and must be a non-empty string')
  }

  const validated: CreateApprovalBody = {
    subject_type:   b.subject_type as ApprovalSubjectType,
    subject_id:     (b.subject_id as string).trim(),
    category:       b.category as 'a' | 'b',
    trigger_reason: (b.trigger_reason as string).trim(),
    department_id:  (b.department_id as string).trim(),
    approver_role:  (b.approver_role as string).trim(),
  }

  if ('approver_user_id' in b) {
    if (b.approver_user_id !== null && typeof b.approver_user_id !== 'string') {
      throw createError('validation', '"approver_user_id" must be a UUID string or null')
    }
    validated.approver_user_id = b.approver_user_id as string | null
  }

  if ('expires_at' in b) {
    if (b.expires_at !== null && typeof b.expires_at !== 'string') {
      throw createError('validation', '"expires_at" must be an ISO 8601 timestamp string or null')
    }
    validated.expires_at = b.expires_at as string | null
  }

  return validated
}

export function validatePatchBody(body: unknown): PatchApprovalBody & { status: ResolutionStatus } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError('validation', 'Request body must be a JSON object')
  }
  const b = body as Record<string, unknown>

  // 'status' is required — approvals have exactly one mutable operation: pending → resolved.
  // The RLS USING clause enforces the pending precondition; Layer 4 validates the target.
  if (!('status' in b)) {
    throw createError(
      'validation',
      '"status" is required for approval resolution. ' +
      `Must be one of: ${ALLOWED_RESOLUTION_STATUSES.join(', ')}`,
    )
  }

  // Explicit block for 'expired' before the general enum check (G5 §12).
  // This gives a clear error message rather than the generic enum rejection below.
  if (b.status === 'expired') {
    throw createError(
      'validation',
      '"expired" status is set by the system only (e.g. a sweep job). ' +
      `Use one of: ${ALLOWED_RESOLUTION_STATUSES.join(', ')}`,
    )
  }

  if (!ALLOWED_RESOLUTION_STATUSES.includes(b.status as ResolutionStatus)) {
    throw createError(
      'validation',
      `"status" must be one of: ${ALLOWED_RESOLUTION_STATUSES.join(', ')}`,
    )
  }

  const patch: PatchApprovalBody & { status: ResolutionStatus } = {
    status: b.status as ResolutionStatus,
  }

  if ('decision_note' in b) {
    if (b.decision_note !== null && typeof b.decision_note !== 'string') {
      throw createError('validation', '"decision_note" must be a string or null')
    }
    patch.decision_note = b.decision_note as string | null
  }

  return patch
}
