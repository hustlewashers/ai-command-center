import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validateCreateBody } from '@/lib/tasks/validate'

const SELECT_COLS = 'id, organization_id, title, project_id, department_id, request_id, work_packet_id, workflow_id, tool_profile_id, priority, assigned_to_user_id, created_by, status, created_at, updated_at'

// GET /api/tasks
// Returns all RLS-visible tasks for the caller.
// Visibility is department-scoped for human roles; assignment-gated for agents.
// No application-level filter is added — RLS enforces the correct scope (G3 §7).
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('tasks')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}

// POST /api/tasks
// Creates a new task. organization_id and created_by are always derived from context.
// Initial status is constrained to 'backlog' or 'ready' (Layer 4 — G3 §22.1).
// Agents cannot create tasks (G3 §3, §8). read_only cannot create tasks.
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'agent') {
      throw createError('forbidden', 'agent role cannot create tasks')
    }
    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot create tasks')
    }

    const body = await request.json().catch(() => null)
    const validated = validateCreateBody(body)

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        organization_id:     context.organizationId, // always context — never client
        created_by:          context.userId,          // self-pin (G3 §6)
        title:               validated.title,
        project_id:          validated.project_id,
        department_id:       validated.department_id,
        priority:            validated.priority,
        status:              validated.status,
        request_id:          validated.request_id,
        work_packet_id:      validated.work_packet_id,
        workflow_id:         validated.workflow_id,
        tool_profile_id:     validated.tool_profile_id,
        assigned_to_user_id: validated.assigned_to_user_id,
      })
      .select(SELECT_COLS)
      .single()

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      if (error.code === '23503') throw createError('validation', 'One or more referenced IDs do not exist or are not accessible')
      throw new Error(error.message)
    }

    return ok(data, 201)
  } catch (err) {
    return errorResponse(err)
  }
}
