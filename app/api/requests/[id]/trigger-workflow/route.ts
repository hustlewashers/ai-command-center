import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { triggerRequestWorkflow, type RequestTriggerOverrides } from '@/lib/workflows/triggers'
import type { UserContext } from '@/types/api'

type RouteParams = { params: Promise<{ id: string }> }

// Roles allowed to manually start a workflow.
const TRIGGER_ROLES = new Set<UserContext['role']>(['org_admin', 'department_lead'])

// POST /api/requests/:id/trigger-workflow
// Manually starts request_to_task for a request (Sprint 5.9).
//
// Trust model:
//   1. resolveUserContext authenticates and yields the caller's role.
//   2. Role gate: only org_admin / department_lead may manually trigger.
//   3. RLS visibility gate: the request is fetched through the RLS-bound SSR
//      client first — if the caller can't see it, → not_found (no leak).
//   4. triggerRequestWorkflow (service-role) validates, de-duplicates, and
//      enqueues. This route never executes a workflow step.
//
// Optional body: { workflow_id?, project_id?, department_id? }
//   Supplied project_id / department_id are used as workflow inputs (validated
//   org-owned by the trigger). Absent → request / context defaults (Sprint 5.8).
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const ctx = await resolveUserContext(supabase)

    if (!TRIGGER_ROLES.has(ctx.role)) {
      throw createError('forbidden', 'Your role cannot manually start workflows')
    }

    // RLS visibility gate — confirm the caller can see this request.
    const { data: visible, error: visErr } = await supabase
      .from('requests')
      .select('id, routed_department_id, project_id')
      .eq('id', id)
      .maybeSingle()

    if (visErr) throw createError('internal', visErr.message)
    if (!visible) throw createError('not_found', 'Request not found')
    const current = visible as { id: string; routed_department_id: string | null; project_id: string | null }

    // Optional overrides (all fields optional; bad types are ignored, not fatal)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const overrides: RequestTriggerOverrides = {}
    if (typeof body.workflow_id === 'string')  overrides.workflowId   = body.workflow_id
    if (typeof body.project_id === 'string')   overrides.projectId    = body.project_id
    if (typeof body.department_id === 'string') overrides.departmentId = body.department_id

    // The trigger validates overrides (org-ownership) and enqueues/dedups/skips.
    const result = await triggerRequestWorkflow(id, ctx, overrides)

    // TASK 1: persist the validated overrides onto the request when it was
    // actually started/reused — but only fill MISSING fields, never clobber an
    // existing routing. Done via the RLS client (operator's own update rights);
    // non-fatal so the workflow result still returns if the patch is denied.
    let persisted: Record<string, string> | null = null
    if (result.triggered || result.deduped) {
      const patch: Record<string, string> = {}
      if (overrides.departmentId && !current.routed_department_id) patch.routed_department_id = overrides.departmentId
      if (overrides.projectId    && !current.project_id)           patch.project_id           = overrides.projectId
      if (Object.keys(patch).length > 0) {
        // .select() so we can tell a real write from an RLS-filtered no-op
        // (e.g. a non-submitter lead on an unrouted request) — both non-fatal.
        const { data: updated, error: patchErr } = await supabase
          .from('requests').update(patch).eq('id', id).select('id')
        if (patchErr) console.warn('[trigger-workflow] persist overrides failed (non-fatal):', patchErr.message)
        else if (updated && updated.length > 0) persisted = patch
      }
    }

    return ok({ ...result, persisted })
  } catch (err) {
    return errorResponse(err)
  }
}
