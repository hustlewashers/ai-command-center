import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

// GET /api/smoke/blockers
// Smoke read: verifies RLS-backed SELECT on public.blockers.
// Policy `blockers_select_department_scope` (migration 013) scopes to the
// caller's department; org_admin sees all blockers in the org.
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('blockers')
      .select('id, description, blocked_entity_type, blocked_entity_id, severity, status, reported_by_user_id, assigned_to_user_id, created_at')
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}
