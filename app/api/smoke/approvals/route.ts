import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

// GET /api/smoke/approvals
// Smoke read: verifies RLS-backed SELECT on public.approvals.
// Policy `approvals_select_department_scope` (migration 013) scopes to the
// caller's department; org_admin sees all approvals in the org.
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('approvals')
      .select('id, status, category, department_id, created_at')
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}
