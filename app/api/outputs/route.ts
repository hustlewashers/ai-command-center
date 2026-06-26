import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validateCreateBody } from '@/lib/outputs/validate'

const SELECT_COLS = [
  'id', 'organization_id', 'department_id', 'task_id', 'project_id',
  'title', 'output_type', 'content', 'storage_path',
  'created_by_user_id', 'status', 'produced_at', 'delivered_at',
  'created_at', 'updated_at',
].join(', ')

// GET /api/outputs
// Returns all RLS-visible outputs for the caller.
// Visibility rules (outputs_select_department_scope, 016):
//   org_admin → all org outputs; dept_lead/member/read_only → department-scoped;
//   agent → only outputs of tasks assigned to them (G6 §6).
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('outputs')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}

// POST /api/outputs
// Creates an output at 'draft', pinned to a task/project/department.
// organization_id and created_by_user_id are JWT-derived; never client-supplied.
//
// INSERT policy (016 outputs_insert_department_scope) admits
//   {org_admin, department_lead, department_member} only (G6 §7):
//   - Agents cannot create outputs (no agent INSERT path; Layer 4 explicit block).
//   - read_only cannot create outputs (Layer 4 explicit block).
//   - RLS requires department_id/project_id alignment with the parent task.
//
// content or storage_path must be supplied (G6 §8); if neither is provided → validation error.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'agent') {
      throw createError('forbidden', 'agent role cannot create outputs')
    }
    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot create outputs')
    }

    const body = await request.json().catch(() => null)
    const validated = validateCreateBody(body)

    const { data, error } = await supabase
      .from('outputs')
      .insert({
        organization_id:    context.organizationId, // JWT-derived, never from client
        created_by_user_id: context.userId,          // self-pinned (G6 §8)
        // produced_at: omitted — DB defaults to now()
        title:        validated.title,
        output_type:  validated.output_type,
        content:      validated.content ?? null,
        storage_path: validated.storage_path ?? null,
        department_id: validated.department_id,
        task_id:      validated.task_id,
        project_id:   validated.project_id,
        status:       validated.status,
      })
      .select(SELECT_COLS)
      .single()

    if (error) {
      // 23514: check constraint (empty title, bad output_type, delivered_at invariant)
      if (error.code === '23514') throw createError('validation', error.message)
      // 23503: FK violated — task_id/project_id/department_id does not exist or is inaccessible
      if (error.code === '23503') throw createError('validation', 'One or more referenced IDs do not exist or are not accessible')
      // 42501: INSERT RLS WITH CHECK failed — role exclusion, cross-dept task, dept mismatch
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission — check department, task alignment, and role')
      throw new Error(error.message)
    }

    return ok(data, 201)
  } catch (err) {
    return errorResponse(err)
  }
}
