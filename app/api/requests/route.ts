import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { validateCreateBody } from '@/lib/requests/validate'
import { triggerRequestWorkflow } from '@/lib/workflows/triggers'

const SELECT_COLS = 'id, organization_id, source, intent, status, submitted_at, submitted_by_user_id, routed_department_id, project_id, metadata, created_at, updated_at'

// GET /api/requests
// Returns all RLS-visible requests for the caller's org (org-wide SELECT per 009).
// read_only callers see requests but cannot create them.
//
// Each request is annotated with its latest workflow state (Sprint 5.10) via a
// single batched workflow_runs query (no N+1). Runs the caller can't see under
// RLS simply resolve to workflow=null.
export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('requests')
      .select(SELECT_COLS)
      .order('created_at', { ascending: false })
      .limit(100)

    if (error) throw new Error(error.message)
    const requests = (data ?? []) as { id: string }[]

    // Batch: latest run per request (newest first → first seen per id wins).
    // From the same fetch we also derive the latest request_ai_summary run per
    // request (Sprint 6.4) — no extra query.
    let workflowByRequest: Record<string, { run_id: string; workflow_id: string; status: string }> = {}
    let aiByRequest: Record<string, { run_id: string; status: string }> = {}
    if (requests.length > 0) {
      const { data: runs } = await supabase
        .from('workflow_runs')
        .select('id, workflow_id, status, trigger_entity_id, created_at')
        .eq('trigger_entity_type', 'request')
        .in('trigger_entity_id', requests.map(r => r.id))
        .order('created_at', { ascending: false })

      const seen = new Set<string>()
      const seenAi = new Set<string>()
      const map: typeof workflowByRequest = {}
      const aiMap: typeof aiByRequest = {}
      for (const run of (runs ?? []) as { id: string; workflow_id: string; status: string; trigger_entity_id: string }[]) {
        if (!seen.has(run.trigger_entity_id)) {
          seen.add(run.trigger_entity_id)
          map[run.trigger_entity_id] = { run_id: run.id, workflow_id: run.workflow_id, status: run.status }
        }
        if (run.workflow_id === 'request_ai_summary' && !seenAi.has(run.trigger_entity_id)) {
          seenAi.add(run.trigger_entity_id)
          aiMap[run.trigger_entity_id] = { run_id: run.id, status: run.status }
        }
      }
      workflowByRequest = map
      aiByRequest = aiMap
    }

    const annotated = requests.map(r => ({
      ...r,
      workflow: workflowByRequest[r.id] ?? null,
      ai_summary: aiByRequest[r.id] ?? null,
    }))
    return ok(annotated)
  } catch (err) {
    return errorResponse(err)
  }
}

// POST /api/requests
// Creates a new request at status='received'.
// organization_id and submitted_by_user_id are always derived from context — never client-supplied.
// status is always forced to 'received' — client cannot set initial status.
// read_only: forbidden (org-wide SELECT makes requests visible to them, so they know
//   requests exist — this is a visible-but-not-permitted action, not an existence leak).
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot create requests')
    }

    const body = await request.json().catch(() => null)
    const validated = validateCreateBody(body)

    const { data, error } = await supabase
      .from('requests')
      .insert({
        organization_id:      context.organizationId, // always context — never client
        submitted_by_user_id: context.userId,         // self-pin
        status:               'received',             // always received on create
        source:               validated.source,
        intent:               validated.intent,
        routed_department_id: validated.routed_department_id,
        project_id:           validated.project_id,
        metadata:             validated.metadata,
      })
      .select(SELECT_COLS)
      .single()

    if (error) {
      if (error.code === '23514') throw createError('validation', error.message)
      throw new Error(error.message)
    }

    // Live workflow trigger (Sprint 5.8): enqueue request_to_task AFTER the
    // request is durably persisted. Non-fatal — a trigger failure must never
    // roll back or fail the request creation itself.
    let workflow: Awaited<ReturnType<typeof triggerRequestWorkflow>> | null = null
    try {
      workflow = await triggerRequestWorkflow((data as { id: string }).id, context)
    } catch (triggerErr) {
      console.warn('[requests] workflow trigger failed (request still created):',
        triggerErr instanceof Error ? triggerErr.message : String(triggerErr))
    }

    return ok({ ...(data as Record<string, unknown>), workflow }, 201)
  } catch (err) {
    return errorResponse(err)
  }
}
