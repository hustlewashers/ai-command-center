import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validateCreateBody } from '@/lib/blockers/validate'

const SELECT_COLS = [
  'id', 'organization_id', 'department_id',
  'description', 'blocked_entity_type', 'blocked_entity_id',
  'severity', 'reported_by_user_id', 'assigned_to_user_id',
  'resolution_note', 'status', 'created_at', 'updated_at',
].join(', ')

// GET /api/blockers
// Returns all RLS-visible blockers for the caller.
// Visibility rules (blockers_select_department_scope, 013):
//   org_admin → all org blockers; dept_lead/member/read_only → dept-scoped;
//   agent → only blockers on their assigned task, or work_packets linked to their assigned task (G8 §6).
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('blockers')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}

// POST /api/blockers
// Creates a blocker at status='open', pinned to a task or work_packet.
// organization_id and reported_by_user_id are JWT-derived; never client-supplied.
//
// INSERT policy (blockers_insert_department_scope, 013) enforces:
//   - status='open' at INSERT (the only valid initial status, G8 §4).
//   - reported_by_user_id = current_user_id() (self-pin; RESTRICT FK).
//   - Blocked entity must belong to the same department_id.
//   - Agent and read_only excluded (Layer 4 explicit block + RLS).
//
// 'project' as blocked_entity_type is explicitly rejected before the DB write
// because the DB CHECK gives an opaque constraint error; Layer 4 surfaces a typed one (G8 §19).
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'agent') {
      throw createError('forbidden', 'agent role cannot create blockers — emit agent_activity(error_raised) instead')
    }
    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot create blockers')
    }

    const body = await request.json().catch(() => null)
    const validated = validateCreateBody(body)

    const { data, error } = await supabase
      .from('blockers')
      .insert({
        organization_id:    context.organizationId, // JWT-derived, never from client
        reported_by_user_id: context.userId,         // self-pinned (G8 §8, RESTRICT FK)
        department_id:       validated.department_id,
        description:         validated.description,
        blocked_entity_type: validated.blocked_entity_type,
        blocked_entity_id:   validated.blocked_entity_id,
        severity:            validated.severity,
        assigned_to_user_id: validated.assigned_to_user_id ?? null,
        // status: omitted — DB defaults to 'open'; RLS WITH CHECK enforces it
      })
      .select(SELECT_COLS)
      .single()

    if (error) {
      // 23514: check constraint — empty description, bad entity type, bad severity/status
      if (error.code === '23514') throw createError('validation', error.message)
      // 23503: FK — department_id/assigned_to_user_id does not exist or is inaccessible
      if (error.code === '23503') throw createError('validation', 'One or more referenced IDs do not exist or are not accessible')
      // 42501: RLS WITH CHECK failed — role exclusion, entity not in dept, inactive assignee
      if (error.code === '42501') throw createError('forbidden', 'Insufficient permission — check department, entity alignment, and role')
      throw new Error(error.message)
    }

    return ok(data, 201)
  } catch (err) {
    return errorResponse(err)
  }
}
