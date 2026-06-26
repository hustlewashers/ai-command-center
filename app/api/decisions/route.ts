import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validateCreateBody } from '@/lib/decisions/validate'

const SELECT_COLS = [
  'id', 'organization_id', 'task_id', 'summary', 'rationale',
  'decided_by_user_id', 'decided_at', 'status', 'created_at', 'updated_at',
].join(', ')

// GET /api/decisions
// Returns all RLS-visible decisions for the caller.
// Visibility is derived through the parent task — there is no department_id on decisions.
// Agents see only decisions on tasks assigned to them (G7 §6).
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('decisions')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}

// POST /api/decisions
// Records a decision at 'proposed' (or 'pending_approval'). organization_id is
// JWT-derived; decided_by_user_id is self-pinned from context; decided_at is
// DB-defaulted (not client-supplied).
//
// INSERT policy (013 decisions_insert_task_scope) admits
//   {org_admin, department_lead, department_member} only (G7 §7):
//   - Agents cannot create decisions — explicit forbidden at Layer 4.
//   - read_only cannot create decisions — explicit forbidden at Layer 4.
//   - Initial status restricted to {proposed, pending_approval} by RLS WITH CHECK;
//     Layer 4 gives the typed error before the DB fires (G7 §18).
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'agent') {
      throw createError('forbidden', 'agent role cannot create decisions')
    }
    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot create decisions')
    }

    const body = await request.json().catch(() => null)
    const validated = validateCreateBody(body)

    const { data, error } = await supabase
      .from('decisions')
      .insert({
        organization_id:    context.organizationId, // always context — never client
        decided_by_user_id: context.userId,          // self-pin (G7 §3, §7)
        // decided_at: omitted — DB defaults to now() (NOT NULL, G7 §3)
        task_id:   validated.task_id,
        summary:   validated.summary,
        rationale: validated.rationale,
        status:    validated.status,
      })
      .select(SELECT_COLS)
      .single()

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      if (error.code === '23503') throw createError('validation', 'The task_id does not exist or is not accessible')
      // 42501: INSERT role/dept/status WITH CHECK failed (agent, read_only, cross-dept task, bad status)
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission — check task ownership, department, and role')
      throw new Error(error.message)
    }

    return ok(data, 201)
  } catch (err) {
    return errorResponse(err)
  }
}
