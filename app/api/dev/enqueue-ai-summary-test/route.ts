import { NextRequest, NextResponse } from 'next/server'
import { enqueue } from '@/lib/jobs/enqueue'
import { getServiceClient } from '@/lib/supabase/service'

// Dev-only endpoint — hard-blocked in production. Not linked in nav.
// Enqueues a workflow_step job for the request_ai_summary workflow so the
// governed AI step can be exercised end-to-end via the worker.
//
// If OPENAI_API_KEY is unset (typical in dev), the provider returns a
// deterministic mock so the run still completes.

const TEST_ORG_ID  = '4f63c864-15af-4d3c-9996-6eebf96220c9'
const TEST_DEPT_ID = '20a566b7-1e1c-4efe-81de-d094fe27ddac'
const TEST_PROJ_ID = '0a473572-7a02-4cca-b6df-092c2ba65e8c'
const TEST_USER_ID = '8f8c8b47-6232-4e3e-a046-fd438599675c'
// A real task in the test project/department (created by request_to_task in 5.8);
// required because outputs.task_id is NOT NULL.
const TEST_TASK_ID = 'dcd5469c-5e3e-4660-b780-c9d7f64e1007'

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const secret = request.headers.get('x-worker-secret')
  if (!secret || secret !== process.env.WORKER_RUN_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    // Optional overrides from the body (e.g. a real task_id/intent).
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const taskId = typeof body.task_id === 'string' ? body.task_id : TEST_TASK_ID
    const intent = typeof body.intent === 'string' ? body.intent
      : 'Customer requests a quarterly performance report including a risk assessment and recommended next steps for the operations team.'

    const jobId = await enqueue({
      job_type:        'workflow_step',
      organization_id: TEST_ORG_ID,
      payload: {
        workflow_id: 'request_ai_summary',
        inputs: {
          organization_id: TEST_ORG_ID,
          department_id:   TEST_DEPT_ID,
          project_id:      TEST_PROJ_ID,
          created_by:      TEST_USER_ID,
          task_id:         taskId,
          title:           'AI summary draft',
          intent,
        },
      },
      priority:    5,
      max_retries: 3,
    })

    const svc = getServiceClient()
    const { data, error } = await svc
      .from('background_jobs')
      .select('id, job_type, status, priority, payload, created_at')
      .eq('id', jobId)
      .single()

    if (error) throw new Error(`fetch after enqueue failed: ${error.message}`)
    return NextResponse.json({ job: data }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
