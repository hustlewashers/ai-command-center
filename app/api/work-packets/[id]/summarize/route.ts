import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import { triggerWorkPacketAiSummary } from '@/lib/workflows/triggers'
import {
  WORK_PACKET_AI_SUMMARY_WORKFLOW_ID,
  getWorkPacketAiSummaryReadiness,
  type WorkPacketAiSummaryReadiness,
} from '@/lib/workflows/readiness/work-packet-summary'

type RouteParams = { params: Promise<{ id: string }> }

type WpAiSummaryTriggerResponse = {
  triggered: boolean
  deduped: boolean
  workflow_id: typeof WORK_PACKET_AI_SUMMARY_WORKFLOW_ID
  background_job_id: string | null
  workflow_run_id: string | null
  reason: string
  readiness: WorkPacketAiSummaryReadiness
}

function response(fields: Omit<WpAiSummaryTriggerResponse, 'workflow_id'>): WpAiSummaryTriggerResponse {
  return { workflow_id: WORK_PACKET_AI_SUMMARY_WORKFLOW_ID, ...fields }
}

// POST /api/work-packets/:id/summarize  (Sprint 7.9)
// Manually starts the work_packet_ai_summary workflow for a work packet.
//
// Trust model (orchestration only — no direct AI/output/approval writes here):
//   1. resolveUserContext authenticates.
//   2. RLS visibility gate: work packet fetched through the RLS client first.
//   3. Role gate: org_admin / department_lead may summarize any visible work
//      packet; a department_member may summarize only one they authored;
//      read_only is forbidden.
//   4. triggerWorkPacketAiSummary (service-role) validates, de-duplicates, enqueues.
export async function POST(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const ctx = await resolveUserContext(supabase)

    if (ctx.role === 'read_only') {
      throw createError('forbidden', 'read_only role cannot start AI summaries')
    }

    const { data: visible, error: visErr } = await supabase
      .from('work_packets')
      .select('id, author_user_id')
      .eq('id', id)
      .maybeSingle()

    if (visErr) throw createError('internal', visErr.message)
    if (!visible) throw createError('not_found', 'Work packet not found')
    const wp = visible as { id: string; author_user_id: string | null }

    const allowed =
      ctx.role === 'org_admin' ||
      ctx.role === 'department_lead' ||
      (ctx.role === 'department_member' && wp.author_user_id === ctx.userId)

    if (!allowed) {
      throw createError('forbidden', 'Your role cannot start an AI summary for this work packet')
    }

    const readiness = await getWorkPacketAiSummaryReadiness(supabase, id, ctx)
    if (!readiness) throw createError('not_found', 'Work packet not found')

    if (!readiness.can_trigger) {
      return ok(response({
        triggered: false,
        deduped: readiness.status === 'active',
        background_job_id: readiness.background_job_id,
        workflow_run_id: readiness.workflow_run_id,
        reason: readiness.reason,
        readiness,
      }))
    }

    const result = await triggerWorkPacketAiSummary(id, ctx)
    const postReadiness = (await getWorkPacketAiSummaryReadiness(supabase, id, ctx)) ?? readiness

    const readinessAfter: WorkPacketAiSummaryReadiness =
      result.triggered || result.deduped
        ? {
            ...postReadiness,
            status: 'active',
            can_trigger: false,
            reason: result.reason,
            blockers: [result.workflow_run_id ? 'active_run_exists' : 'active_job_exists'],
            background_job_id: result.background_job_id,
            workflow_run_id: result.workflow_run_id,
            recommended_action: 'wait_for_ai_summary',
          }
        : { ...postReadiness, status: 'blocked', can_trigger: false, reason: result.reason }

    return ok(response({
      triggered: result.triggered,
      deduped: result.deduped,
      background_job_id: result.background_job_id,
      workflow_run_id: result.workflow_run_id,
      reason: result.reason,
      readiness: readinessAfter,
    }))
  } catch (err) {
    return errorResponse(err)
  }
}
