import { NextRequest, NextResponse } from 'next/server'
import { enqueue } from '@/lib/jobs/enqueue'
import { getServiceClient } from '@/lib/supabase/service'

// Dev-only endpoint — hard-blocked in production.
// Enqueues a safe no-op job (job_type='other') for manual worker testing.
// Protected by the same x-worker-secret header used by the worker itself.

const TEST_ORG_ID = '4f63c864-15af-4d3c-9996-6eebf96220c9'

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
      job_type:        'other',
      organization_id: TEST_ORG_ID,
      payload: {
        source:      'dev-test',
        purpose:     'verify worker no-op handler',
        created_by:  'manual-sprint-5.3-test',
      },
      priority:    5,
      max_retries: 3,
    })

    // Fetch the full row so the caller can see the initial state
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
