import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validateCreateBody } from '@/lib/work-packets/validate'

const SELECT_COLS = [
  'id', 'organization_id', 'title', 'objective', 'scope', 'acceptance_criteria',
  'department_id', 'parent_type', 'parent_id', 'priority', 'constraints',
  'approval_required_before_start', 'author_user_id', 'status', 'created_at', 'updated_at',
].join(', ')

// GET /api/work-packets
// Returns all RLS-visible work packets for the caller.
// Visibility is department-scoped for human roles.
// Agents have NO SELECT policy on work_packets — they receive an empty list (G4 §6).
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('work_packets')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}

// POST /api/work-packets
// Creates a new work packet. organization_id and author_user_id are always derived from context.
// Initial status constrained to 'draft' or 'ready' (Layer 4 — G4 §19.1).
// Agents cannot create work packets (G4 §6, §14). read_only cannot create.
// department_member CAN create (INSERT policy includes members — G4 §7).
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'agent') {
      throw createError('forbidden', 'agent role cannot create work packets')
    }
    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot create work packets')
    }

    const body = await request.json().catch(() => null)
    const validated = validateCreateBody(body)

    const { data, error } = await supabase
      .from('work_packets')
      .insert({
        organization_id:              context.organizationId, // always context — never client
        author_user_id:               context.userId,         // self-pin (G4 §7)
        title:                        validated.title,
        objective:                    validated.objective,
        department_id:                validated.department_id,
        parent_type:                  validated.parent_type,
        parent_id:                    validated.parent_id,
        priority:                     validated.priority,
        status:                       validated.status,
        approval_required_before_start: validated.approval_required_before_start,
        scope:                        validated.scope,
        acceptance_criteria:          validated.acceptance_criteria,
        constraints:                  validated.constraints,
      })
      .select(SELECT_COLS)
      .single()

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      if (error.code === '23503') throw createError('validation', 'One or more referenced IDs do not exist or are not accessible')
      // RLS rejection: 42501 = insufficient privilege (role excluded, cross-dept, parent mismatch)
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission — check department, parent, and role constraints')
      throw new Error(error.message)
    }

    return ok(data, 201)
  } catch (err) {
    return errorResponse(err)
  }
}
