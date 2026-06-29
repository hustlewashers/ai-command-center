import type { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'
import type { WorkflowRunSummary } from '@/types/workflow-runs'

// Excludes inputs and accumulated — both are large JSONB not needed for list views.
const RUN_LIST_COLS = [
  'id', 'organization_id', 'workflow_id', 'workflow_version',
  'background_job_id', 'parent_run_id', 'status',
  'trigger_type', 'trigger_entity_type', 'trigger_entity_id',
  'started_at', 'completed_at', 'failed_at',
  'current_step_id', 'current_step_index',
  'retry_count', 'error_message',
  'created_at', 'updated_at',
].join(', ')

// GET /api/workflow-runs
// Returns RLS-visible workflow runs for the caller's organization, newest first.
//
// org_admin: all runs in the org.
// department_lead / department_member / read_only: runs triggered by their
//   department's tasks or requests (enforced by RLS policy from migration 023).
//
// Optional query params (all combinable):
//   status              — filter by run status (pending|running|completed|failed|cancelled|resuming)
//   workflow_id         — filter by workflow definition id (e.g. 'request_to_task')
//   background_job_id   — filter by the originating background job UUID
//   trigger_entity_type — filter by trigger entity type (e.g. 'task', 'request')
//   trigger_entity_id   — filter by trigger entity UUID
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { searchParams }  = request.nextUrl
    const status            = searchParams.get('status')
    const workflowId        = searchParams.get('workflow_id')
    const backgroundJobId   = searchParams.get('background_job_id')
    const triggerEntityType = searchParams.get('trigger_entity_type')
    const triggerEntityId   = searchParams.get('trigger_entity_id')

    let query = supabase
      .from('workflow_runs')
      .select(RUN_LIST_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (status)            query = query.eq('status', status)
    if (workflowId)        query = query.eq('workflow_id', workflowId)
    if (backgroundJobId)   query = query.eq('background_job_id', backgroundJobId)
    if (triggerEntityType) query = query.eq('trigger_entity_type', triggerEntityType)
    if (triggerEntityId)   query = query.eq('trigger_entity_id', triggerEntityId)

    const { data, error } = await query
    if (error) throw new Error(error.message)
    return ok((data ?? []) as unknown as WorkflowRunSummary[])
  } catch (err) {
    return errorResponse(err)
  }
}
