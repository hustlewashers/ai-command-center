import { NextRequest, NextResponse } from 'next/server'
import { enqueue } from '@/lib/jobs/enqueue'
import { getServiceClient } from '@/lib/supabase/service'
import { getProviderConfig } from '@/lib/ai/provider-config'

// Dev-only endpoint (Sprint 6.3) — hard-blocked in production. Not linked in nav.
// Enqueues request_ai_summary to exercise the LIVE OpenAI provider path.
//
// Body (optional):
//   { "force_live": true, "task_id"?: string, "intent"?: string }
//
// Provider mode:
//   - OPENAI_API_KEY set   → live call (real provider)
//   - OPENAI_API_KEY unset → deterministic mock (request_ai_summary still runs).
//     With force_live=true and no key, this endpoint returns a clear 400 rather
//     than silently running the mock.

const TEST_ORG_ID  = '4f63c864-15af-4d3c-9996-6eebf96220c9'
const TEST_DEPT_ID = '20a566b7-1e1c-4efe-81de-d094fe27ddac'
const TEST_PROJ_ID = '0a473572-7a02-4cca-b6df-092c2ba65e8c'
const TEST_USER_ID = '8f8c8b47-6232-4e3e-a046-fd438599675c'
const TEST_TASK_ID = 'dcd5469c-5e3e-4660-b780-c9d7f64e1007'

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const secret = request.headers.get('x-worker-secret')
  if (!secret || secret !== process.env.WORKER_RUN_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Provider config echo (Sprint 8.0) — never includes the key itself.
  const cfg = getProviderConfig()
  const hasKey = cfg.has_key
  const providerMode = cfg.mode
  const providerConfig = {
    mode: cfg.mode,
    has_key: cfg.has_key,
    model_override: cfg.model_override,
    timeout_ms: cfg.timeout_ms,
    max_retries: cfg.max_retries,
    allow_mock_fallback: cfg.allow_mock_fallback,
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const forceLive = body.force_live === true

    if (forceLive && !hasKey) {
      return NextResponse.json({
        error: 'force_live requested but OPENAI_API_KEY is not set',
        error_type: 'configuration_error',
        hint: 'Set OPENAI_API_KEY in .env.local to test the live provider, or omit force_live to use the mock.',
        provider_mode: 'mock',
        provider_config: providerConfig,
      }, { status: 400 })
    }

    const taskId = typeof body.task_id === 'string' ? body.task_id : TEST_TASK_ID
    const intent = typeof body.intent === 'string' ? body.intent
      : 'Live smoke test: summarize this operational request and recommend next steps. Include a risk level and confidence.'

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
          title:           'AI live smoke-test draft',
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
    return NextResponse.json({
      job: data,
      provider_mode: providerMode,
      provider_config: providerConfig,
      note: hasKey
        ? 'OPENAI_API_KEY present — call_ai will use the live provider. Run POST /api/worker/run to execute.'
        : 'OPENAI_API_KEY absent — call_ai will use the deterministic mock. Run POST /api/worker/run to execute.',
    }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
