import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validatePatchBody, validateStatusTransition } from '@/lib/requests/validate'
import type { RequestStatus } from '@/types/requests'

type RouteParams = { params: Promise<{ id: string }> }

const SELECT_COLS = 'id, organization_id, source, intent, status, submitted_at, submitted_by_user_id, routed_department_id, project_id, metadata, created_at, updated_at'

// GET /api/requests/:id
// Returns the request if visible to the caller under RLS (org-wide SELECT).
// Out-of-org or deleted → not_found (no existence leak).
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('requests')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) throw createError('not_found', 'Request not found')
    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}

// PATCH /api/requests/:id
// Updates allowed mutable fields: intent, routed_department_id, project_id, metadata, status.
// Forbidden fields (organization_id, submitted_by_user_id, source, submitted_at,
//   created_at, updated_at, deleted_at) are never accepted — not even silently ignored.
//
// Status transition is validated against the documented lifecycle (G2 §4–5)
//   before the UPDATE is issued, using the org-wide SELECT to read current status.
// If 0 rows are updated (RLS USING clause filtered the actor out), → not_found.
//   This applies whether the row doesn't exist at all or the actor lacks UPDATE rights —
//   both resolve to not_found to avoid leaking update-permission existence.
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const body = await request.json().catch(() => null)
    const patch = validatePatchBody(body)

    if (Object.keys(patch).length === 0) {
      throw createError('validation', 'At least one field is required for update')
    }

    // Validate status transition before issuing the UPDATE.
    // We use the org-wide SELECT (which every org member can reach) to read current status.
    // If the row is invisible here, it is either deleted or cross-org → not_found.
    if (patch.status !== undefined) {
      const { data: current, error: fetchErr } = await supabase
        .from('requests')
        .select('status')
        .eq('id', id)
        .maybeSingle()

      if (fetchErr) throw new Error(fetchErr.message)
      if (!current) throw createError('not_found', 'Request not found')

      validateStatusTransition(current.status as RequestStatus, patch.status)
    }

    const { data: rows, error } = await supabase
      .from('requests')
      .update(patch)
      .eq('id', id)
      .select(SELECT_COLS)

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      throw new Error(error.message)
    }

    // 0 rows: UPDATE USING clause filtered the actor out, or row no longer exists.
    // Both → not_found (no existence leak for update-permission differences).
    if (!rows || rows.length === 0) {
      throw createError('not_found', 'Request not found')
    }

    return ok(rows[0])
  } catch (err) {
    return errorResponse(err)
  }
}
