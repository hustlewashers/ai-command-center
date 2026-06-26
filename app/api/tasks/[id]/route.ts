import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validatePatchBody, validateTaskStatusTransition } from '@/lib/tasks/validate'
import type { TaskStatus } from '@/types/tasks'
import { TERMINAL_TASK_STATUSES } from '@/types/tasks'

type RouteParams = { params: Promise<{ id: string }> }

const SELECT_COLS = 'id, organization_id, title, project_id, department_id, request_id, work_packet_id, workflow_id, tool_profile_id, priority, assigned_to_user_id, created_by, status, created_at, updated_at'

// GET /api/tasks/:id
// Returns the task if visible to the caller under RLS (dept-scoped SELECT).
// Out-of-dept, unassigned-agent, or deleted → not_found (no existence leak).
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('tasks')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) throw createError('not_found', 'Task not found')
    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}

// PATCH /api/tasks/:id
// Updates allowed mutable fields: title, priority, status, assigned_to_user_id,
//   request_id, work_packet_id, workflow_id, tool_profile_id.
//
// Forbidden fields (organization_id, project_id, department_id, created_by,
//   created_at, updated_at, deleted_at) are never accepted.
//
// Status transitions are validated against the documented lifecycle (G3 §5)
//   before the UPDATE is issued, using the RLS-scoped SELECT to read current status.
//
// done/cancelled: requires org_admin or department_lead (G3 §22.8–22.9).
//   department_member → forbidden.
//   agent → not_found (RLS UPDATE policy excludes agents — 0 rows returned).
//
// 0-row UPDATE: covers non-existent rows, deleted rows, and RLS USING filtering.
//   All cases → not_found (no existence leak for permission differences, G3 §24).
export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot modify tasks')
    }

    const body = await request.json().catch(() => null)
    const patch = validatePatchBody(body)

    if (Object.keys(patch).length === 0) {
      throw createError('validation', 'At least one field is required for update')
    }

    // Terminal-state authority check (G3 §22.8–22.9):
    // Only org_admin or department_lead may drive a task to done or cancelled.
    if (patch.status !== undefined && TERMINAL_TASK_STATUSES.includes(patch.status)) {
      if (context.role === 'department_member') {
        throw createError(
          'forbidden',
          `Only org_admin or department_lead can mark a task as "${patch.status}"`,
        )
      }
    }

    // Validate status transition before issuing the UPDATE.
    // The RLS-scoped SELECT reveals only tasks the caller can see.
    // If the row is invisible here (wrong dept, deleted, unassigned agent) → not_found.
    if (patch.status !== undefined) {
      const { data: current, error: fetchErr } = await supabase
        .from('tasks')
        .select('status')
        .eq('id', id)
        .maybeSingle()

      if (fetchErr) throw new Error(fetchErr.message)
      if (!current) throw createError('not_found', 'Task not found')

      validateTaskStatusTransition(current.status as TaskStatus, patch.status)
    }

    const { data: rows, error } = await supabase
      .from('tasks')
      .update(patch)
      .eq('id', id)
      .select(SELECT_COLS)

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      if (error.code === '23503') throw createError('validation', 'One or more referenced IDs do not exist or are not accessible')
      throw new Error(error.message)
    }

    // 0 rows: row does not exist, is soft-deleted, or RLS USING filtered the actor out.
    // All cases → not_found (no existence leak for update-permission differences, G3 §24).
    if (!rows || rows.length === 0) {
      throw createError('not_found', 'Task not found')
    }

    return ok(rows[0])
  } catch (err) {
    return errorResponse(err)
  }
}
