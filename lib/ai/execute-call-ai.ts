import { getServiceClient } from '@/lib/supabase/service'
import { createError } from '@/lib/errors'
import { getPrompt } from './prompts'
import { routeModel, estimateCost } from './router'
import { runAiProvider } from './provider'
import { validateAiOutput } from './contract'
import type { AiExecutionOutput, AiPromptId } from '@/types/ai'
import type { WorkflowExecutionContext } from '@/types/workflows'

// Sprint 6.1 — executes one governed AI step.
//
// Loads the prompt → routes the model → calls the provider → validates the
// structured output → records execution_logs (started/completed/failed),
// agent_activity (best-effort, non-fatal), and runtime_metrics (non-fatal) →
// returns the validated output. It writes NO business records and performs NO
// governed transition — only logging/telemetry plus the returned draft payload.

function logContextId(ctx: WorkflowExecutionContext): string {
  return (ctx.job_id as string | null | undefined) ?? ctx.organization_id
}

export async function executeCallAi(
  promptId: AiPromptId,
  variables: Record<string, unknown>,
  ctx: WorkflowExecutionContext,
): Promise<AiExecutionOutput> {
  const svc = getServiceClient()
  const contextId = logContextId(ctx)

  const prompt = getPrompt(promptId)
  if (!prompt) throw createError('validation', `Unknown AI prompt id: '${promptId}'`)
  const route = routeModel(promptId)

  // Build the user message from the whitelisted variables only.
  const userMessage = 'Summarize the following request as instructed.\n\n'
    + Object.entries(variables)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n')

  // ── AI started ──
  await svc.from('execution_logs').insert({
    organization_id: ctx.organization_id,
    event_type:      'tool_call',
    actor:           'agent:ai',
    summary:         `AI step started: ${promptId} (${route.model})`,
    context_type:    'workflow',
    context_id:      contextId,
    metadata:        { phase: 'started', prompt_id: promptId, prompt_version: prompt.version, model: route.model },
    status:          'recorded',
  })

  // ── Provider call + validation ──
  let provider
  try {
    provider = await runAiProvider({
      model: route.model,
      low: route.low,
      system: prompt.system_prompt,
      user: userMessage,
      max_output_tokens: 1024,
      mock_seed: variables,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    await logFailure(svc, ctx, contextId, promptId, route.model, `provider: ${reason}`)
    throw new Error(`call_ai provider failed (${promptId}): ${reason}`)
  }

  const validation = validateAiOutput(prompt, provider.raw_text)
  if (!validation.ok || !validation.value) {
    const reason = `invalid output: ${validation.errors.join('; ')}`
    await logFailure(svc, ctx, contextId, promptId, route.model, reason)
    throw createError('validation', `call_ai output failed validation (${promptId}): ${validation.errors.join('; ')}`)
  }
  const aiResult = validation.value
  const confidence = typeof aiResult.confidence === 'number' ? aiResult.confidence : null
  const estimated_cost = estimateCost(route, provider.usage.prompt_tokens, provider.usage.completion_tokens)

  // ── AI completed (metadata only — never prompt/output content) ──
  await svc.from('execution_logs').insert({
    organization_id: ctx.organization_id,
    event_type:      'tool_call',
    actor:           'agent:ai',
    summary:         `AI step completed: ${promptId} (${route.model})`,
    context_type:    'workflow',
    context_id:      contextId,
    metadata: {
      phase: 'completed', prompt_id: promptId, model: route.model,
      prompt_tokens: provider.usage.prompt_tokens,
      completion_tokens: provider.usage.completion_tokens,
      total_tokens: provider.usage.total_tokens,
      latency_ms: provider.latency_ms,
      estimated_cost, confidence, mocked: provider.mocked,
    },
    status: 'recorded',
  })

  // ── agent_activity (best-effort; never fails the step — TASK 6) ──
  await recordAgentActivity(svc, ctx, promptId, route.model, provider, estimated_cost)

  // ── runtime_metrics (non-fatal) ──
  await recordAiMetrics(svc, ctx, provider, estimated_cost)

  return {
    ai_result: aiResult,
    prompt_id: promptId,
    model: route.model,
    confidence,
    usage: provider.usage,
    latency_ms: provider.latency_ms,
    estimated_cost,
    mocked: provider.mocked,
  }
}

type Svc = ReturnType<typeof getServiceClient>

async function logFailure(
  svc: Svc, ctx: WorkflowExecutionContext, contextId: string,
  promptId: string, model: string, reason: string,
): Promise<void> {
  const { error } = await svc.from('execution_logs').insert({
    organization_id: ctx.organization_id,
    event_type:      'error',
    actor:           'agent:ai',
    summary:         `AI step failed: ${promptId} — ${reason}`,
    context_type:    'workflow',
    context_id:      contextId,
    metadata:        { phase: 'failed', prompt_id: promptId, model, error: reason },
    status:          'flagged',
  })
  if (error) console.warn('[call_ai] failure log write failed:', error.message)
}

// agent_activity requires NOT-NULL agent_user_id + session_id. There is no
// agent-session table seeded yet, so this is best-effort: resolve an agent user
// if one exists, use/synthesize a session id, and never let a failure here
// break the workflow (TASK 6).
async function recordAgentActivity(
  svc: Svc, ctx: WorkflowExecutionContext,
  promptId: string, model: string,
  provider: { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; latency_ms: number; mocked: boolean },
  estimatedCost: number,
): Promise<void> {
  try {
    let agentUserId = (ctx.agent_user_id as string | undefined) ?? null
    if (!agentUserId) {
      const { data } = await svc.from('users').select('id')
        .eq('organization_id', ctx.organization_id).eq('role', 'agent').limit(1).maybeSingle()
      agentUserId = (data as { id: string } | null)?.id ?? null
    }
    if (!agentUserId) {
      console.warn('[call_ai] no agent user in org — skipping agent_activity (non-fatal)')
      return
    }
    const sessionId = (ctx.session_id as string | undefined) ?? crypto.randomUUID()

    const { error } = await svc.from('agent_activity').insert({
      organization_id: ctx.organization_id,
      agent_user_id:   agentUserId,
      session_id:      sessionId,
      task_id:         (ctx.task_id as string | undefined) ?? null,
      activity_type:   'tool_call',
      tool_name:       `ai:${model}`,
      summary:         `call_ai ${promptId}`,
      metadata: {
        prompt_id: promptId, model,
        prompt_tokens: provider.usage.prompt_tokens,
        completion_tokens: provider.usage.completion_tokens,
        total_tokens: provider.usage.total_tokens,
        latency_ms: provider.latency_ms,
        estimated_cost: estimatedCost, mocked: provider.mocked,
      },
      duration_ms: provider.latency_ms,
      status: 'completed',
    })
    if (error) console.warn('[call_ai] agent_activity write failed (non-fatal):', error.message)
  } catch (err) {
    console.warn('[call_ai] agent_activity recording errored (non-fatal):', err instanceof Error ? err.message : String(err))
  }
}

// runtime_metrics: tokens (int), latency (int), cost (float). XOR per row.
async function recordAiMetrics(
  svc: Svc, ctx: WorkflowExecutionContext,
  provider: { usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }; latency_ms: number },
  estimatedCost: number,
): Promise<void> {
  const now = new Date()
  const ws = new Date(now.getTime() - Math.max(provider.latency_ms, 1)).toISOString()
  const we = now.toISOString()
  const dimId = (ctx.job_id as string | undefined) ?? ctx.organization_id
  const base = {
    organization_id: ctx.organization_id,
    metric_category: 'agent_performance',
    dimension_type:  'workflow_job',
    dimension_id:    dimId,
    department_id:   (ctx.department_id as string | undefined) ?? null,
    window_start:    ws,
    window_end:      we,
  }
  const rows = [
    { ...base, metric_name: 'ai_prompt_tokens',      unit: 'tokens', value_int: provider.usage.prompt_tokens,     value_float: null },
    { ...base, metric_name: 'ai_completion_tokens',  unit: 'tokens', value_int: provider.usage.completion_tokens, value_float: null },
    { ...base, metric_name: 'ai_total_tokens',       unit: 'tokens', value_int: provider.usage.total_tokens,      value_float: null },
    { ...base, metric_name: 'ai_latency_ms',         unit: 'ms',     value_int: provider.latency_ms,              value_float: null },
    { ...base, metric_name: 'ai_estimated_cost_usd', unit: 'usd',    value_int: null,                             value_float: estimatedCost },
  ]
  const { error } = await svc.from('runtime_metrics').insert(rows)
  if (error) console.warn('[call_ai] runtime_metrics write failed (non-fatal):', error.message)
}
