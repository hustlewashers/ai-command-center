import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validatePatchBody, validateBlockerTransition } from '@/lib/blockers/validate'
import type { BlockerStatus } from '@/types/blockers'

type RouteParams = { params: Promise<{ id: string }> }

const SELECT_COLS = [
  'id', 'organization_id', 'department_id',
  'description', 'blocked_entity_type', 'blocked_entity_id',
  'severity', 'reported_by_user_id', 'assigned_to_user_id',
  'resolution_note', 'status', 'created_at', 'updated_at',
].join(', ')

// GET /api/blockers/:id
// Returns the blocker if visible under RLS (blockers_select_department_scope).
// Agents only see blockers on their assigned tasks or linked work_packets.
// All other invisible/deleted/cross-dept cases → not_found (no existence leak, G8 §20).
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('blockers')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) throw createError('not_found', 'Blocker not found')
    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}

// PATCH /api/blockers/:id
// Updates allowed fields: description, severity, status, resolution_note, assigned_to_user_id.
//
// Forbidden fields (organization_id, department_id, blocked_entity_type, blocked_entity_id,
//   reported_by_user_id, created_at, updated_at, deleted_at) are never accepted from client.
//
// UPDATE policy (blockers_update_department_scope, 013) admits {org_admin, dept_lead, dept_member}.
// Agents and read_only are excluded at Layer 4 before the DB is touched (G8 §7).
//
// Layer 4 application rules:
//   1. Status transition validity per the documented state machine (G8 §5 / sprint 1.9 machine).
//   2. won_t_fix is restricted to org_admin and dept_lead (G8 §7, §12):
//      dept_member attempting won_t_fix → forbidden (DB permits it; application narrows).
//   3. resolution_note is required (non-empty) when transitioning to resolved or won_t_fix (G8 §10).
//   4. won_t_fix → open requires an approved Category B Decision on the associated task (G8 §12):
//      - task blocker: task_id = blocker.blocked_entity_id
//      - work_packet blocker: find task where tasks.work_packet_id = blocked_entity_id
//      Query: decisions where task_id matches AND status='approved',
//             then approvals where subject_type='decision' AND category='b' AND status='approved'.
//
// 0-row UPDATE → not_found: covers non-existent, soft-deleted, and cross-dept rows (G8 §20).
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'agent') {
      throw createError('forbidden', 'agent role cannot modify blockers')
    }
    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot modify blockers')
    }

    const body = await request.json().catch(() => null)
    const patch = validatePatchBody(body)

    if (Object.keys(patch).length === 0) {
      throw createError('validation', 'At least one field is required for update')
    }

    if (patch.status !== undefined) {
      // Fetch current state for transition validation and gate checks.
      const { data: current, error: fetchErr } = await supabase
        .from('blockers')
        .select('status, blocked_entity_type, blocked_entity_id')
        .eq('id', id)
        .maybeSingle()

      if (fetchErr) throw new Error(fetchErr.message)
      if (!current) throw createError('not_found', 'Blocker not found')

      const currentStatus = current.status as BlockerStatus

      // State machine validation (G8 §5, sprint 1.9 machine).
      validateBlockerTransition(currentStatus, patch.status)

      // won_t_fix authority gate (G8 §7, §12, Layer 4):
      // Only org_admin and dept_lead may mark a blocker won_t_fix.
      // The DB permits dept_member; the application narrows this.
      if (patch.status === 'won_t_fix' && context.role === 'department_member') {
        throw createError(
          'forbidden',
          'Only org_admin or department_lead may mark a blocker as won_t_fix',
        )
      }

      // resolution_note is required when closing a blocker (G8 §10, §19, Layer 4).
      // The DB does not enforce this; the application does.
      if (patch.status === 'resolved' || patch.status === 'won_t_fix') {
        const noteValue = patch.resolution_note ?? null
        if (!noteValue || noteValue.trim().length === 0) {
          throw createError(
            'validation',
            `"resolution_note" is required when transitioning to "${patch.status}"`,
          )
        }
      }

      // won_t_fix → open override gate (G8 §12, Layer 5):
      // Reopening a won_t_fix blocker requires an approved Category B Decision
      // on the task associated with this blocker.
      //
      // Task derivation (G8 §13, §14):
      //   blocked_entity_type='task'        → task_id = blocked_entity_id (direct)
      //   blocked_entity_type='work_packet' → find task where work_packet_id = blocked_entity_id
      //
      // Check: decisions WHERE task_id=<task_id> AND status='approved'
      //        + approvals WHERE subject_type='decision' AND subject_id IN (decision_ids)
      //                      AND category='b' AND status='approved'
      if (currentStatus === 'won_t_fix' && patch.status === 'open') {
        let taskId: string | null = null

        if (current.blocked_entity_type === 'task') {
          taskId = current.blocked_entity_id
        } else {
          // work_packet blocker: derive associated task via tasks.work_packet_id
          const { data: taskRow, error: taskErr } = await supabase
            .from('tasks')
            .select('id')
            .eq('work_packet_id', current.blocked_entity_id)
            .limit(1)

          if (taskErr) throw new Error(taskErr.message)
          taskId = taskRow?.[0]?.id ?? null
        }

        if (!taskId) {
          throw createError(
            'approval_required',
            'Cannot reopen a won_t_fix blocker: no associated task found. ' +
            'Create an approved Category B Decision for the related task first.',
          )
        }

        // Find approved decisions for this task.
        const { data: approvedDecisions, error: decErr } = await supabase
          .from('decisions')
          .select('id')
          .eq('task_id', taskId)
          .eq('status', 'approved')

        if (decErr) throw new Error(decErr.message)

        if (!approvedDecisions || approvedDecisions.length === 0) {
          throw createError(
            'approval_required',
            'Reopening a won_t_fix blocker requires an approved Category B Decision ' +
            'for the associated task. Create a decision (task_id=<task_id>, status=pending_approval), ' +
            'create a Category B approval for it, resolve the approval as approved, ' +
            'then retry.',
          )
        }

        // Check for an approved Category B approval on those decisions.
        const decisionIds = approvedDecisions.map((d: { id: string }) => d.id)
        const { data: gateApprovals, error: gateErr } = await supabase
          .from('approvals')
          .select('id')
          .eq('subject_type', 'decision')
          .in('subject_id', decisionIds)
          .eq('category', 'b')
          .eq('status', 'approved')
          .limit(1)

        if (gateErr) throw new Error(gateErr.message)

        if (!gateApprovals || gateApprovals.length === 0) {
          throw createError(
            'approval_required',
            'Reopening a won_t_fix blocker requires an approved Category B Decision ' +
            'for the associated task. The decision must first be approved via a ' +
            'Category B approval (subject_type=\'decision\', category=\'b\').',
          )
        }
      }
    }

    const { data: rows, error } = await supabase
      .from('blockers')
      .update(patch)
      .eq('id', id)
      .select(SELECT_COLS)

    if (error) {
      // 23514: check constraint — empty description, bad severity/status enum
      if (error.code === '23514') throw createError('validation', error.message)
      // 23503: FK — assigned_to_user_id references non-existent/inactive user
      if (error.code === '23503') throw createError('validation', 'Referenced entity does not exist or is not accessible')
      // 42501: RLS USING failed (cross-dept, agent, read_only — all already blocked above)
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission to update this blocker')
      throw new Error(error.message)
    }

    // 0 rows: non-existent, soft-deleted, or cross-dept (RLS USING excluded the actor).
    // All map to not_found — no existence leak (G8 §20).
    if (!rows || rows.length === 0) {
      throw createError('not_found', 'Blocker not found')
    }

    return ok(rows[0])
  } catch (err) {
    return errorResponse(err)
  }
}
