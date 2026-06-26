import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

// GET /api/smoke/tasks
// Smoke read: verifies RLS-backed SELECT on public.tasks.
// Policies `tasks_select_dept_scope` + `tasks_select_agent_assigned` (migration 009)
// scope results to the caller's department (or assigned tasks for agents).
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('tasks')
      .select('id, title, status, department_id, created_at')
      .order('created_at', { ascending: false })
      .limit(10)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}
