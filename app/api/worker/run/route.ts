import { NextRequest, NextResponse } from 'next/server'
import { sweep } from '@/lib/jobs/sweep'
import { claimBatch } from '@/lib/jobs/claim'
import { dispatch } from '@/lib/jobs/dispatch'
import { recordWorkerMetrics, queryQueueStats } from '@/lib/jobs/metrics'

export const runtime = 'nodejs'

// POST /api/worker/run
// Triggered by an external scheduler (cron, Vercel Cron, etc.).
// Must include the x-worker-secret header matching WORKER_RUN_SECRET env var.
// Runs sweep → claim → dispatch in one invocation.
export async function POST(request: NextRequest) {
  const secret = request.headers.get('x-worker-secret')
  if (!secret || secret !== process.env.WORKER_RUN_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const runStart = new Date()
  console.log('[worker/run] started')

  try {
    const swept = await sweep()
    const jobs  = await claimBatch()

    console.log(`[worker/run] claimed=${jobs.length} swept=${swept}`)

    const results = await Promise.allSettled(jobs.map(job => dispatch(job)))

    const succeeded = results.filter(r => r.status === 'fulfilled').length
    const failed    = results.filter(r => r.status === 'rejected').length
    const errors    = results
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map(r => r.reason instanceof Error ? r.reason.message : String(r.reason))

    const runEnd      = new Date()
    const durationMs  = runEnd.getTime() - runStart.getTime()

    console.log(`[worker/run] done succeeded=${succeeded} failed=${failed} duration=${durationMs}ms`)

    // Write runtime metrics per unique org that had jobs this run.
    // Skipped if no jobs were claimed (no org context available).
    const orgIds = [...new Set(jobs.map(j => j.organization_id))]
    for (const orgId of orgIds) {
      const { queueDepth, dlqSize } = await queryQueueStats(orgId)
      await recordWorkerMetrics(orgId, runStart, runEnd, [
        { name: 'worker_run_completed', value: 1,          unit: 'count' },
        { name: 'jobs_claimed',         value: jobs.length, unit: 'count' },
        { name: 'jobs_succeeded',       value: succeeded,   unit: 'count' },
        { name: 'jobs_failed',          value: failed,      unit: 'count' },
        { name: 'jobs_swept',           value: swept,       unit: 'count' },
        { name: 'queue_depth',          value: queueDepth,  unit: 'count' },
        { name: 'dlq_size',             value: dlqSize,     unit: 'count' },
        { name: 'worker_duration_ms',   value: durationMs,  unit: 'ms'    },
      ])
    }

    return NextResponse.json({
      swept,
      claimed:   jobs.length,
      succeeded,
      failed,
      duration_ms: durationMs,
      errors: errors.length > 0 ? errors : undefined,
    })
  } catch (err) {
    console.error('[worker/run] unhandled error:', err)
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
