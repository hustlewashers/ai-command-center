import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validatePatchBody, validateWorkPacketStatusTransition } from '@/lib/work-packets/validate'
import type { WorkPacketStatus } from '@/types/work-packets'

type RouteParams = { params: Promise<{ id: string }> }

const SELECT_COLS = [
  'id', 'organization_id', 'title', 'objective', 'scope', 'acceptance_criteria',
  'department_id', 'parent_type', 'parent_id', 'priority', 'constraints',
  'approval_required_before_start', 'author_user_id', 'status', 'created_at', 'updated_at',
].join(', ')

// GET /api/work-packets/:id
// Returns the work packet if visible under RLS (dept-scoped SELECT).
// Agents have no SELECT policy on work_packets → always not_found (G4 §6).
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('work_packets')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) throw createError('not_found', 'Work packet not found')
    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}

// PATCH /api/work-packets/:id
// Updates allowed spec fields: title, objective, scope, acceptance_criteria, constraints,
//   priority, approval_required_before_start, status.
//
// Forbidden fields (organization_id, department_id, parent_type, parent_id, author_user_id,
//   created_at, updated_at, deleted_at) are never accepted.
//
// UPDATE policy excludes department_member, read_only, and agent:
//   - read_only: explicit forbidden (Layer 4)
//   - department_member / agent: 0 rows from UPDATE → not_found (RLS handles it, G4 §7)
//
// Status transition rules (G4 §5, Layer 4):
//   - Transition must be in the documented state machine.
//   - → pending_approval: only when approval_required_before_start = true.
//   - → in_execution + gate armed: requires an approved Category B work_packet
//       approval (subject_type='work_packet', category='b', status='approved') (G5 §16).
//   - → in_execution + gate disarmed: allowed directly from ready (Category C).
//
// 0-row UPDATE → not_found: covers non-existent rows, soft-deleted rows,
//   and RLS USING clause exclusions (member/agent/cross-dept) — all resolve to
//   not_found with no existence leak (G4 §21, §10).
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot modify work packets')
    }

    const body = await request.json().catch(() => null)
    const patch = validatePatchBody(body)

    if (Object.keys(patch).length === 0) {
      throw createError('validation', 'At least one field is required for update')
    }

    // Status transition validation requires the current row's status and gate flag.
    // We fetch before the UPDATE so we can give a precise error before hitting the DB.
    if (patch.status !== undefined) {
      const { data: current, error: fetchErr } = await supabase
        .from('work_packets')
        .select('status, approval_required_before_start')
        .eq('id', id)
        .maybeSingle()

      if (fetchErr) throw new Error(fetchErr.message)
      if (!current) throw createError('not_found', 'Work packet not found')

      const currentStatus = current.status as WorkPacketStatus
      const gateArmed: boolean = current.approval_required_before_start

      // Basic machine check — is this transition in the allowed set?
      validateWorkPacketStatusTransition(currentStatus, patch.status)

      // Gate condition: → pending_approval is only valid when the gate is armed (G4 §5).
      if (patch.status === 'pending_approval' && !gateArmed) {
        throw createError(
          'conflict',
          'Cannot move to pending_approval when approval_required_before_start is false — there is no start gate to open',
        )
      }

      // Approval gate: → in_execution while gate is armed (G4 §5, §19.6, Layer 5).
      // Requires an approved Category B work_packet approval (G5 §16).
      if (patch.status === 'in_execution' && gateArmed) {
        const { data: gateApprovals, error: gateErr } = await supabase
          .from('approvals')
          .select('id')
          .eq('subject_type', 'work_packet')
          .eq('subject_id', id)
          .eq('category', 'b')
          .eq('status', 'approved')
          .limit(1)

        if (gateErr) throw new Error(gateErr.message)

        if (!gateApprovals || gateApprovals.length === 0) {
          throw createError(
            'approval_required',
            'This work packet requires a Category B approval before starting execution. Obtain an approved work_packet approval first.',
          )
        }
      }
    }

    const { data: rows, error } = await supabase
      .from('work_packets')
      .update(patch)
      .eq('id', id)
      .select(SELECT_COLS)

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      if (error.code === '23503') throw createError('validation', 'One or more referenced IDs do not exist or are not accessible')
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission to update this work packet')
      throw new Error(error.message)
    }

    // 0 rows: row does not exist, is soft-deleted, or RLS USING excluded the actor
    // (department_member, agent, cross-dept lead). All → not_found (G4 §10, §21).
    if (!rows || rows.length === 0) {
      throw createError('not_found', 'Work packet not found')
    }

    return ok(rows[0])
  } catch (err) {
    return errorResponse(err)
  }
}
