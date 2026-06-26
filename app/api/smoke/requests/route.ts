import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

// GET /api/smoke/requests
// Smoke read: verifies RLS-backed SELECT on public.requests.
// Policy `requests_select_org_members` (migration 009) scopes to the caller's org.
// Returns at most 10 rows — shape proof only, not a paginated list endpoint.
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('requests')
      .select('id, source, intent, status, submitted_at, submitted_by_user_id, routed_department_id, project_id')
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}
