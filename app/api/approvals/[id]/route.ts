import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validatePatchBody } from '@/lib/approvals/validate'

type RouteParams = { params: Promise<{ id: string }> }

const SELECT_COLS = [
  'id', 'organization_id', 'department_id',
  'subject_type', 'subject_id',
  'category', 'trigger_reason',
  'requested_by_user_id', 'approver_user_id', 'approver_role',
  'status', 'decided_at', 'decision_note', 'expires_at',
  'created_at', 'updated_at',
].join(', ')

// GET /api/approvals/:id
// Returns the approval if visible under RLS (approvals_select_department_scope).
// Cross-dept or agent-invisible subject → not_found (G5 §19).
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('approvals')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) throw createError('not_found', 'Approval not found')
    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}

// PATCH /api/approvals/:id
// Resolves a pending approval. Only status + decision_note are accepted.
// All other fields (organization_id, department_id, subject_*, category, etc.) are
// immutable after creation — approvals are append-once, resolve-once (G5 §11).
//
// UPDATE policy (017 approvals_update_approver_scope) (G5 §8):
//   USING: status='pending'  →  already-resolved returns 0 rows → not_found
//   Allowed actors: org_admin or dept_lead in approval's department.
//   WITH CHECK: status ∈ {approved, rejected, withdrawn}; decided_at NOT NULL.
//
//   Layer 4 role checks:
//   - read_only: explicit forbidden (visible but cannot resolve; G5 §23)
//   - department_member, agent: 0 rows from USING → not_found (RLS handles it)
//
// decided_at is ALWAYS set by this handler on resolution — never accepted from
// the client. The DB paired invariant (`(status='pending' AND decided_at IS NULL)
// OR (status<>'pending' AND decided_at IS NOT NULL)`) is satisfied this way (G5 §4).
//
// 0-row UPDATE → not_found: covers non-existent rows, already-resolved approvals
// (USING status='pending' filter), and RLS USING exclusions (member/agent/cross-dept).
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot resolve approvals')
    }

    const body = await request.json().catch(() => null)
    const patch = validatePatchBody(body)

    // Build the update payload.
    // decided_at is set here — satisfies the DB paired invariant (G5 §4).
    // The client never supplies decided_at.
    const updatePayload: Record<string, unknown> = {
      status:     patch.status,
      decided_at: new Date().toISOString(),
    }
    if ('decision_note' in patch) {
      updatePayload.decision_note = patch.decision_note
    }

    const { data: rows, error } = await supabase
      .from('approvals')
      .update(updatePayload)
      .eq('id', id)
      .select(SELECT_COLS)

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      // 42501: WITH CHECK denied (target status not in allowed set, or missing decided_at).
      // Should not reach here under normal operation — validatePatchBody prevents it.
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission to resolve this approval')
      throw new Error(error.message)
    }

    // 0 rows: non-existent, already-resolved (USING requires status='pending'),
    // or RLS USING excluded the actor (member, agent, cross-dept lead). All → not_found (G5 §19).
    if (!rows || rows.length === 0) {
      throw createError('not_found', 'Approval not found or is not in a resolvable state')
    }

    return ok(rows[0])
  } catch (err) {
    return errorResponse(err)
  }
}
