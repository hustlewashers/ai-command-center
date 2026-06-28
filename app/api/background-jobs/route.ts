import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

const SELECT_COLS = [
  'id', 'organization_id', 'job_type', 'status',
  'priority', 'retry_count', 'max_retries', 'last_error',
  'scheduled_for', 'started_at', 'completed_at',
  'related_task_id', 'related_request_id', 'related_work_packet_id',
  'created_by_user_id', 'created_at', 'updated_at',
].join(', ')

// GET /api/background-jobs
// Returns RLS-visible background jobs for the caller.
// org_admin: all jobs in the org.
// department_lead / department_member: jobs related to their department's tasks/work_packets.
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('background_jobs')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}
