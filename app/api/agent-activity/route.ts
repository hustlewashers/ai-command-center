import { type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

const SELECT_COLS = [
  'id', 'organization_id', 'agent_user_id',
  'task_id', 'work_packet_id', 'execution_log_id', 'session_id',
  'activity_type', 'summary', 'metadata', 'status',
  'created_at',
].join(', ')

// GET /api/agent-activity
// Returns RLS-visible agent activity rows, newest first.
// Optional query params: status, activity_type, task_id
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { searchParams } = request.nextUrl
    const status        = searchParams.get('status')
    const activityType  = searchParams.get('activity_type')
    const taskId        = searchParams.get('task_id')

    let query = supabase
      .from('agent_activity')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (status)       query = query.eq('status', status)
    if (activityType) query = query.eq('activity_type', activityType)
    if (taskId)       query = query.eq('task_id', taskId)

    const { data, error } = await query
    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}
