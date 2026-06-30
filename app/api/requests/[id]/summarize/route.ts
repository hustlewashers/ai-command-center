import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { triggerRequestAiSummary } from '@/lib/workflows/triggers'

type RouteParams = { params: Promise<{ id: string }> }

// POST /api/requests/:id/summarize  (Sprint 6.4)
// Manually starts the request_ai_summary workflow for a request.
//
// Trust model (orchestration only — no direct AI/output/approval writes here):
//   1. resolveUserContext authenticates.
//   2. RLS visibility gate: request fetched through the RLS client first.
//   3. Role gate: org_admin / department_lead may summarize any visible request;
//      a department_member may summarize only a request they submitted; read_only
//      is forbidden.
//   4. triggerRequestAiSummary (service-role) validates, de-duplicates, enqueues.
export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const ctx = await resolveUserContext(supabase)

    if (ctx.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot start AI summaries')
    }

    const { data: visible, error: visErr } = await supabase
      .from('requests')
      .select('id, submitted_by_user_id')
      .eq('id', id)
      .maybeSingle()

    if (visErr) throw createError('internal', visErr.message)
    if (!visible) throw createError('not_found', 'Request not found')
    const req = visible as { id: string; submitted_by_user_id: string | null }

    const allowed =
      ctx.role === 'org_admin' ||
      ctx.role === 'department_lead' ||
      (ctx.role === 'department_member' && req.submitted_by_user_id === ctx.userId)

    if (!allowed) {
      throw createError('forbidden', 'Your role cannot start an AI summary for this request')
    }

    const result = await triggerRequestAiSummary(id, ctx)
    return ok(result)
  } catch (err) {
    return errorResponse(err)
  }
}
