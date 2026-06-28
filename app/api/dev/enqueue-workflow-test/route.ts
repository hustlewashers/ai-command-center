import { NextRequest, NextResponse } from 'next/server'
import { enqueue } from '@/lib/jobs/enqueue'
import { getServiceClient } from '@/lib/supabase/service'

// Dev-only endpoint — hard-blocked in production.
// Enqueues a workflow_step job for the request_to_task workflow so the worker
// can be manually exercised end-to-end in a dev/staging environment.

const TEST_ORG_ID  = '4f63c864-15af-4d3c-9996-6eebf96220c9'
const TEST_DEPT_ID = '20a566b7-1e1c-4efe-81de-d094fe27ddac'
const TEST_PROJ_ID = '0a473572-7a02-4cca-b6df-092c2ba65e8c'
const TEST_USER_ID = '8f8c8b47-6232-4e3e-a046-fd438599675c'

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  const secret = request.headers.get('x-worker-secret')
  if (!secret || secret !== process.env.WORKER_RUN_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const jobId = await enqueue({
      job_type:        'workflow_step',
      organization_id: TEST_ORG_ID,
      payload: {
        workflow_id: 'request_to_task',
        inputs: {
          organization_id: TEST_ORG_ID,
          department_id:   TEST_DEPT_ID,
          project_id:      TEST_PROJ_ID,
          created_by:      TEST_USER_ID,
          title:           'Runtime-created workflow task test',
        },
      },
      priority:    5,
      max_retries: 3,
    })

    const svc = getServiceClient()
    const { data, error } = await svc
      .from('background_jobs')
      .select('id, job_type, status, priority, retry_count, max_retries, payload, created_at')
      .eq('id', jobId)
      .single()

    if (error) throw new Error(`fetch after enqueue failed: ${error.message}`)
    return NextResponse.json({ job: data }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
