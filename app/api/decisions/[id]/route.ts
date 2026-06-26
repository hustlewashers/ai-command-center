import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validatePatchBody, validateDecisionStatusTransition } from '@/lib/decisions/validate'
import type { DecisionStatus } from '@/types/decisions'
import { COMMITTED_STATUSES } from '@/types/decisions'

type RouteParams = { params: Promise<{ id: string }> }

const SELECT_COLS = [
  'id', 'organization_id', 'task_id', 'summary', 'rationale',
  'decided_by_user_id', 'decided_at', 'status', 'created_at', 'updated_at',
].join(', ')

// GET /api/decisions/:id
// Returns the decision if visible under RLS (decisions_select_task_scope).
// Visibility is through the parent task — cross-dept or agent-unassigned → not_found (G7 §6).
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('decisions')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) throw createError('not_found', 'Decision not found')
    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}

// PATCH /api/decisions/:id
// Updates allowed fields: summary, rationale, status.
//
// Forbidden fields (organization_id, task_id, decided_by_user_id, decided_at,
//   created_at, updated_at, deleted_at) are never accepted.
//
// UPDATE policy (013 decisions_update_lead_scope) admits only {org_admin, dept_lead}
//   via task department. department_member, read_only, agent → 0 rows (G7 §7, §10):
//   - read_only: explicit forbidden (Layer 4)
//   - department_member / agent: 0 rows → not_found (RLS handles it)
//
// Layer 4 rules:
//   1. Committed-decision edit guard (G7 §10):
//      Editing summary/rationale on a confirmed or approved decision is refused.
//      In-place rewrites of committed governance records are forbidden; use supersede.
//   2. Status transition validation (G7 §5):
//      Only the documented machine transitions are accepted.
//   3. Approval gate (G7 §11, Layer 5):
//      pending_approval → approved requires a resolved Category B approvals row
//      (subject_type='decision', subject_id=decision.id, category='b', status='approved').
//
// 0-row UPDATE → not_found: covers non-existent rows, soft-deleted rows, and all
//   RLS USING exclusions (member/agent/cross-dept). No existence leak (G7 §19, §10).
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot modify decisions')
    }

    const body = await request.json().catch(() => null)
    const patch = validatePatchBody(body)

    if (Object.keys(patch).length === 0) {
      throw createError('validation', 'At least one field is required for update')
    }

    const needsCurrentStatus =
      patch.status !== undefined ||
      patch.summary !== undefined ||
      patch.rationale !== undefined

    if (needsCurrentStatus) {
      const { data: current, error: fetchErr } = await supabase
        .from('decisions')
        .select('status')
        .eq('id', id)
        .maybeSingle()

      if (fetchErr) throw new Error(fetchErr.message)
      if (!current) throw createError('not_found', 'Decision not found')

      const currentStatus = current.status as DecisionStatus

      // Committed-decision edit guard (G7 §10):
      // A confirmed or approved decision's summary/rationale must not be rewritten in place.
      // The governance record is immutable at that point; changes require a superseding decision.
      const editingSubstance = patch.summary !== undefined || patch.rationale !== undefined
      if (editingSubstance && COMMITTED_STATUSES.includes(currentStatus)) {
        throw createError(
          'conflict',
          `Cannot edit summary or rationale of a "${currentStatus}" decision. ` +
          'Create a new superseding decision instead (status → superseded, then propose the revised decision).',
        )
      }

      if (patch.status !== undefined) {
        // Basic machine check — is this transition in the allowed set?
        validateDecisionStatusTransition(currentStatus, patch.status)

        // Approval gate (G7 §11, Layer 5):
        // pending_approval → approved requires a resolved Category B approvals row
        // with subject_type='decision' and status='approved' (G5 §18).
        if (currentStatus === 'pending_approval' && patch.status === 'approved') {
          const { data: gateApprovals, error: gateErr } = await supabase
            .from('approvals')
            .select('id')
            .eq('subject_type', 'decision')
            .eq('subject_id', id)
            .eq('category', 'b')
            .eq('status', 'approved')
            .limit(1)

          if (gateErr) throw new Error(gateErr.message)

          if (!gateApprovals || gateApprovals.length === 0) {
            throw createError(
              'approval_required',
              'This decision requires a resolved Category B approval before it can be approved. ' +
              'Obtain an approved decision-approval (subject_type=\'decision\') first.',
            )
          }
        }
      }
    }

    const { data: rows, error } = await supabase
      .from('decisions')
      .update(patch)
      .eq('id', id)
      .select(SELECT_COLS)

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      if (error.code === '23503') throw createError('validation', 'Referenced entity does not exist or is not accessible')
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission to update this decision')
      throw new Error(error.message)
    }

    // 0 rows: non-existent, soft-deleted, or RLS USING excluded the actor
    // (department_member, agent, cross-dept lead). All → not_found (G7 §10, §19).
    if (!rows || rows.length === 0) {
      throw createError('not_found', 'Decision not found')
    }

    return ok(rows[0])
  } catch (err) {
    return errorResponse(err)
  }
}
