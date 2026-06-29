import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'
import {
  retryWorkflowRun,
  resumeWorkflowRun,
  restartWorkflowRun,
  cancelWorkflowRun,
} from '@/lib/workflows/recovery'
import { isWorkflowRecoveryAction } from '@/types/workflow-recovery'
import type { WorkflowRecoveryAction, WorkflowRecoveryResult } from '@/types/workflow-recovery'
import type { UserContext } from '@/types/api'

type RouteParams = { params: Promise<{ id: string }> }

// Roles permitted to perform recovery actions.
// department_member and read_only are intentionally excluded.
const RECOVERY_ROLES = new Set<UserContext['role']>(['org_admin', 'department_lead'])

const ACTION_DISPATCH: Record<
  WorkflowRecoveryAction,
  (runId: string, ctx: UserContext) => Promise<WorkflowRecoveryResult>
> = {
  retry:   retryWorkflowRun,
  resume:  resumeWorkflowRun,
  restart: restartWorkflowRun,
  cancel:  cancelWorkflowRun,
}

// POST /api/workflow-runs/:id/recovery
// Body: { "action": "retry" | "resume" | "restart" | "cancel" }
//
// Trust model:
//   1. resolveUserContext authenticates the caller and yields their role.
//   2. Role gate: only org_admin / department_lead may recover.
//   3. RLS visibility gate: the run is fetched through the RLS-bound SSR client
//      first. If the caller can't see it, maybeSingle() returns null and we
//      respond not_found (no existence leak across orgs/departments).
//   4. The recovery helper (service-role) performs the state change / enqueue.
//
// Recovery routes only REQUEST work — retry/resume/restart enqueue a
// workflow_step job for the worker to execute; cancel flips status. No workflow
// step is executed inside this request, and no business record is mutated here.
export async function POST(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const ctx = await resolveUserContext(supabase)

    // ── Role gate ──────────────────────────────────────────────────────────────
    if (!RECOVERY_ROLES.has(ctx.role)) {
      throw createError('forbidden', 'Your role cannot perform workflow recovery actions')
    }

    // ── Parse + validate body ──────────────────────────────────────────────────
    let body: unknown
    try {
      body = await request.json()
    } catch {
      throw createError('validation', 'Request body must be valid JSON')
    }
    const action = (body as { action?: unknown } | null)?.action
    if (!isWorkflowRecoveryAction(action)) {
      throw createError('validation',
        "action must be one of: 'retry', 'resume', 'restart', 'cancel'")
    }

    // ── RLS visibility gate ────────────────────────────────────────────────────
    // Confirm the caller can see this run before any service-role work runs.
    const { data: visibleRun, error: visErr } = await supabase
      .from('workflow_runs')
      .select('id, status')
      .eq('id', id)
      .maybeSingle()

    if (visErr) throw createError('internal', visErr.message)
    if (!visibleRun) throw createError('not_found', 'Workflow run not found')

    // ── Perform recovery (service-role helper) ─────────────────────────────────
    const result = await ACTION_DISPATCH[action](id, ctx)
    return ok(result)
  } catch (err) {
    return errorResponse(err)
  }
}
