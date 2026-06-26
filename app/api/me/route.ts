import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

// GET /api/me
// Returns the resolved platform context for the authenticated caller.
// All four context values (userId, organizationId, departmentId, role) are derived
// exclusively from public.users via private.* helpers — never from client-supplied input.
export async function GET() {
  try {
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)
    return ok(context)
  } catch (err) {
    return errorResponse(err)
  }
}
