import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validateCreateBody } from '@/lib/approvals/validate'

const SELECT_COLS = [
  'id', 'organization_id', 'department_id',
  'subject_type', 'subject_id',
  'category', 'trigger_reason',
  'requested_by_user_id', 'approver_user_id', 'approver_role',
  'status', 'decided_at', 'decision_note', 'expires_at',
  'created_at', 'updated_at',
].join(', ')

// GET /api/approvals
// Returns all RLS-visible approvals for the caller.
// Visibility scope (G5 §8):
//   - org_admin: all approvals in the organization
//   - dept_lead / dept_member / read_only: own-department approvals
//   - agent: approvals on tasks assigned to the agent (no work_packet approvals)
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('approvals')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}

// POST /api/approvals
// Creates a pending approval. organization_id and requested_by_user_id are
// derived from the caller's context — never accepted from the client.
// status is always forced to 'pending'; decided_at is omitted (DB default null).
//
// INSERT policy (017 approvals_insert_department_scope) admits
//   {org_admin, department_lead, department_member} with category ∈ {a,b} (G5 §8):
//   - agent → forbidden (explicit Layer 4)
//   - read_only → forbidden (explicit Layer 4)
//   - category 'c' → validation error at Layer 4 (RLS would return 42501)
//
// subject_id has no DB FK. RLS EXISTS validates subject existence + department
// co-tenancy. A non-existent or cross-dept subject_id returns 42501 → forbidden.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'agent') {
      throw createError('forbidden', 'agent role cannot create approvals')
    }
    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot create approvals')
    }

    const body = await request.json().catch(() => null)
    const validated = validateCreateBody(body)

    const { data, error } = await supabase
      .from('approvals')
      .insert({
        organization_id:      context.organizationId, // always context — never client
        requested_by_user_id: context.userId,          // self-pin (G5 §3, §9)
        // status: omitted — DB default 'pending' (G5 §3); client value ignored
        // decided_at: omitted — DB default null; paired invariant: null ↔ pending (G5 §4)
        department_id:  validated.department_id,
        subject_type:   validated.subject_type,
        subject_id:     validated.subject_id,
        category:       validated.category,
        trigger_reason: validated.trigger_reason,
        approver_role:  validated.approver_role,
        ...(validated.approver_user_id !== undefined && { approver_user_id: validated.approver_user_id }),
        ...(validated.expires_at !== undefined && { expires_at: validated.expires_at }),
      })
      .select(SELECT_COLS)
      .single()

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      if (error.code === '23503') throw createError('validation', 'Referenced entity does not exist or is not accessible')
      // 42501: RLS WITH CHECK denied INSERT (bad category, bad status, cross-dept subject, role exclusion)
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission — verify department ownership, subject co-tenancy, and category')
      throw new Error(error.message)
    }

    return ok(data, 201)
  } catch (err) {
    return errorResponse(err)
  }
}
