import type { SupabaseClient } from '@supabase/supabase-js'
import { aiRuntimeWorkflowIds } from '@/lib/ai/workflows'

// Sprint 6.6 — shared, read-only read model for AI draft review context.
//
// Centralizes the "is this thing an AI-generated draft, and if so, what did the
// governed request_ai_summary run record about it?" question so the request,
// output, and approval detail pages all render the same provenance without each
// re-deriving it. It is strictly read-only, uses the RLS-bound client passed in
// from the page (NEVER service-role), and returns PARTIAL context — never throws —
// when a related row is hidden by RLS. is_ai is true ONLY when a request_ai_summary
// workflow_run is actually found linked to the entity, so provenance is never
// invented.

export interface AiDraftReviewContext {
  is_ai: boolean
  workflow_run: { id: string; status: string } | null
  ai_step_id: string | null
  prompt_id: string | null
  prompt_version: number | null
  prompt_version_id: string | null
  model: string | null
  confidence: number | null
  risk_level: string | null
  recommended_next_steps: string[] | null
  summary: string | null
  title: string | null
  output: { id: string; title: string; status: string; output_type: string | null } | null
  approval: { id: string; status: string; trigger_reason: string | null } | null
  request: { id: string; intent: string | null } | null
}

export interface AiDraftReviewOptions {
  request_id?: string
  output_id?: string
  approval_id?: string
  workflow_run_id?: string
}

type RunRow = {
  id: string
  status: string
  accumulated: Record<string, unknown> | null
  trigger_entity_id: string | null
}

const EMPTY: AiDraftReviewContext = {
  is_ai: false,
  workflow_run: null,
  ai_step_id: null,
  prompt_id: null,
  prompt_version: null,
  prompt_version_id: null,
  model: null,
  confidence: null,
  risk_level: null,
  recommended_next_steps: null,
  summary: null,
  title: null,
  output: null,
  approval: null,
  request: null,
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export async function getAiDraftReviewContext(
  supabase: SupabaseClient,
  opts: AiDraftReviewOptions,
): Promise<AiDraftReviewContext> {
  let outputId = opts.output_id ?? null
  let approvalRow: { id: string; status: string; trigger_reason: string | null } | null = null

  // Approval entry point: resolve its subject before looking for a run.
  if (opts.approval_id) {
    const { data } = await supabase
      .from('approvals')
      .select('id, status, trigger_reason, subject_type, subject_id')
      .eq('id', opts.approval_id)
      .maybeSingle()
    if (data) {
      approvalRow = { id: data.id as string, status: data.status as string, trigger_reason: (data.trigger_reason as string | null) ?? null }
      if (data.subject_type === 'output' && typeof data.subject_id === 'string') {
        outputId = data.subject_id
      } else {
        // The approval is not about an output — it cannot be an AI draft review.
        return { ...EMPTY, approval: approvalRow }
      }
    }
  }

  // Resolve the governed request_ai_summary run for this entity.
  const run = await resolveRun(supabase, opts, outputId)
  if (!run) {
    // No AI run found → conservatively NOT AI. Preserve any approval row we fetched.
    return { ...EMPTY, approval: approvalRow }
  }

  const acc = (run.accumulated ?? {}) as Record<string, unknown>
  outputId = outputId ?? str(acc.output_id)
  const accApprovalId = str(acc.approval_id)
  const requestId = run.trigger_entity_id

  // The call_ai step's output_payload is the authoritative AI result; fall back
  // to the run's accumulated state if the step row is hidden by RLS.
  const { data: stepData } = await supabase
    .from('workflow_step_runs')
    .select('step_id, output_payload')
    .eq('workflow_run_id', run.id)
    .eq('step_type', 'call_ai')
    .order('step_index', { ascending: true })
    .limit(1)
    .maybeSingle()

  const stepOut = ((stepData?.output_payload ?? {}) as Record<string, unknown>)
  const aiResult = ((stepOut.ai_result ?? acc.ai_result) ?? null) as Record<string, unknown> | null

  const promptId = str(stepOut.prompt_id) ?? str(acc.prompt_id)
  const promptVersion = num(stepOut.prompt_version) ?? num(acc.prompt_version)
  const promptVersionId = str(stepOut.prompt_version_id) ?? str(acc.prompt_version_id)
  const model = str(stepOut.model) ?? str(acc.model)
  const confidence =
    num(stepOut.confidence) ?? num(acc.confidence) ?? (aiResult ? num(aiResult.confidence) : null)

  // Fetch output / approval / request in parallel — each null-safe on RLS-hidden rows.
  const [outRes, apprRes, reqRes] = await Promise.all([
    outputId
      ? supabase.from('outputs').select('id, title, status, output_type').eq('id', outputId).maybeSingle()
      : Promise.resolve({ data: null }),
    approvalRow
      ? Promise.resolve({ data: null })
      : accApprovalId
        ? supabase.from('approvals').select('id, status, trigger_reason').eq('id', accApprovalId).maybeSingle()
        : outputId
          ? supabase
              .from('approvals')
              .select('id, status, trigger_reason')
              .eq('subject_type', 'output')
              .eq('subject_id', outputId)
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null }),
    requestId
      ? supabase.from('requests').select('id, intent').eq('id', requestId).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const outData = outRes.data as { id: string; title: string; status: string; output_type: string | null } | null
  const apprData = apprRes.data as { id: string; status: string; trigger_reason: string | null } | null
  const reqData = reqRes.data as { id: string; intent: string | null } | null

  return {
    is_ai: true,
    workflow_run: { id: run.id, status: run.status },
    ai_step_id: str(stepData?.step_id) ?? null,
    prompt_id: promptId,
    prompt_version: promptVersion,
    prompt_version_id: promptVersionId,
    model,
    confidence,
    risk_level: aiResult ? str(aiResult.risk_level) : null,
    recommended_next_steps:
      aiResult && Array.isArray(aiResult.recommended_next_steps)
        ? (aiResult.recommended_next_steps as unknown[]).filter((s): s is string => typeof s === 'string')
        : null,
    summary: aiResult ? str(aiResult.summary) : null,
    title: aiResult ? str(aiResult.title) : null,
    output: outData ? { id: outData.id, title: outData.title, status: outData.status, output_type: outData.output_type ?? null } : null,
    approval: approvalRow ?? (apprData ? { id: apprData.id, status: apprData.status, trigger_reason: apprData.trigger_reason ?? null } : null),
    request: reqData ? { id: reqData.id, intent: reqData.intent ?? null } : null,
  }
}

async function resolveRun(
  supabase: SupabaseClient,
  opts: AiDraftReviewOptions,
  outputId: string | null,
): Promise<RunRow | null> {
  const cols = 'id, status, accumulated, trigger_entity_id'
  // Any registered governed AI workflow counts — not just request_ai_summary — so
  // new AI workflows are recognized without editing this read model.
  const aiWorkflowIds = aiRuntimeWorkflowIds()

  if (opts.workflow_run_id) {
    const { data } = await supabase
      .from('workflow_runs')
      .select(cols)
      .eq('id', opts.workflow_run_id)
      .in('workflow_id', aiWorkflowIds)
      .maybeSingle()
    return (data ?? null) as unknown as RunRow | null
  }

  if (opts.request_id) {
    const { data } = await supabase
      .from('workflow_runs')
      .select(cols)
      .in('workflow_id', aiWorkflowIds)
      .eq('trigger_entity_type', 'request')
      .eq('trigger_entity_id', opts.request_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data ?? null) as unknown as RunRow | null
  }

  if (outputId) {
    const { data } = await supabase
      .from('workflow_runs')
      .select(cols)
      .in('workflow_id', aiWorkflowIds)
      .filter('accumulated->>output_id', 'eq', outputId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    return (data ?? null) as unknown as RunRow | null
  }

  return null
}
