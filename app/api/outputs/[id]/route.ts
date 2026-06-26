import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validatePatchBody, validateOutputStatusTransition } from '@/lib/outputs/validate'
import type { OutputStatus } from '@/types/outputs'

type RouteParams = { params: Promise<{ id: string }> }

const SELECT_COLS = [
  'id', 'organization_id', 'department_id', 'task_id', 'project_id',
  'title', 'output_type', 'content', 'storage_path',
  'created_by_user_id', 'status', 'produced_at', 'delivered_at',
  'created_at', 'updated_at',
].join(', ')

// GET /api/outputs/:id
// Returns the output if visible under RLS (outputs_select_department_scope).
// Cross-dept, deleted, or agent-unassigned outputs → not_found (G6 §9).
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('outputs')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) throw createError('not_found', 'Output not found')
    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}

// PATCH /api/outputs/:id
// Updates allowed fields: title, output_type, content, storage_path, status.
//
// Forbidden fields (organization_id, department_id, task_id, project_id,
//   created_by_user_id, produced_at, delivered_at, created_at, updated_at, deleted_at)
//   are never accepted from the client.
//
// UPDATE policy (016 outputs_update_department_scope) admits {org_admin, dept_lead, dept_member}.
// Agents and read_only are excluded at Layer 4 before the DB is touched.
// Unlike work_packets (G4), department_member CAN update outputs (G6 §7).
//
// Status transition rules (G6 §5, Layer 4):
//   - Transition must be in the documented state machine.
//   - approved → delivered: requires an approved Category A output-approval
//       (subject_type='output', subject_id=output.id, category='a', status='approved').
//       The DB enforces delivered_at IS NOT NULL when status='delivered'; the API sets it.
//
// 0-row UPDATE → not_found: covers non-existent rows, soft-deleted rows, and all
//   RLS USING exclusions (agent, read_only, cross-dept). No existence leak (G6 §7).
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'agent') {
      throw createError('forbidden', 'agent role cannot modify outputs')
    }
    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot modify outputs')
    }

    const body = await request.json().catch(() => null)
    const patch = validatePatchBody(body)

    if (Object.keys(patch).length === 0) {
      throw createError('validation', 'At least one field is required for update')
    }

    // Status transition validation requires the current row's status.
    // We fetch before the UPDATE to give a precise error and run the delivery gate.
    let deliveredAt: string | undefined
    if (patch.status !== undefined) {
      const { data: current, error: fetchErr } = await supabase
        .from('outputs')
        .select('status')
        .eq('id', id)
        .maybeSingle()

      if (fetchErr) throw new Error(fetchErr.message)
      if (!current) throw createError('not_found', 'Output not found')

      const currentStatus = current.status as OutputStatus

      // Basic state machine check (G6 §5).
      validateOutputStatusTransition(currentStatus, patch.status)

      // Delivery gate (G6 §12, §13, Layer 5):
      // approved → delivered requires an approved Category A output-approval.
      // The DB will also enforce delivered_at IS NOT NULL (23514) if we omit it —
      // we set it here so the DB constraint never fires in normal flow.
      if (patch.status === 'delivered') {
        const { data: gateApprovals, error: gateErr } = await supabase
          .from('approvals')
          .select('id')
          .eq('subject_type', 'output')
          .eq('subject_id', id)
          .eq('category', 'a')
          .eq('status', 'approved')
          .limit(1)

        if (gateErr) throw new Error(gateErr.message)

        if (!gateApprovals || gateApprovals.length === 0) {
          throw createError(
            'approval_required',
            'This output requires an approved Category A output-approval before delivery. ' +
            'Create an approval (subject_type=\'output\', category=\'a\') and resolve it as approved first.',
          )
        }

        // Gate passed — set delivered_at server-side. DB check constraint requires this.
        deliveredAt = new Date().toISOString()
      }
    }

    // Build the actual update payload. delivered_at is only added when transitioning to delivered.
    const updatePayload: Record<string, unknown> = { ...patch }
    if (deliveredAt !== undefined) {
      updatePayload.delivered_at = deliveredAt
    }

    const { data: rows, error } = await supabase
      .from('outputs')
      .update(updatePayload)
      .eq('id', id)
      .select(SELECT_COLS)

    if (error) {
      // 23514: check constraint — empty title, bad enum, or delivered without delivered_at
      if (error.code === '23514') throw createError('validation', error.message)
      // 23503: FK — reference to non-existent or inaccessible entity
      if (error.code === '23503') throw createError('validation', 'Referenced entity does not exist or is not accessible')
      // 42501: RLS USING failed (cross-dept, deleted, agent/read_only — all already blocked above)
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission to update this output')
      throw new Error(error.message)
    }

    // 0 rows: non-existent, soft-deleted, or cross-dept (RLS USING excluded the actor).
    // All map to not_found — no existence leak (G6 §7).
    if (!rows || rows.length === 0) {
      throw createError('not_found', 'Output not found')
    }

    return ok(rows[0])
  } catch (err) {
    return errorResponse(err)
  }
}
