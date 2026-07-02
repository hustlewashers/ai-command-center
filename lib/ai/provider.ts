import type {
  AiProviderResult,
  AiProviderAttempt,
  AiProviderErrorType,
  AiProviderMode,
} from '@/types/ai'
import { getProviderConfig } from './provider-config'

// Single AI egress point (Sprint 6.1 → hardened in Sprint 8.0).
// SERVER ONLY — NEVER import from client components or NEXT_PUBLIC paths.
// The API key (OPENAI_API_KEY) is read here and is never returned, logged, or
// persisted (same discipline as lib/supabase/service.ts).
//
// Hardening (Sprint 8.0):
//   • per-attempt timeout via AbortController,
//   • bounded retries for transient failures (408/409/429/500/502/503/504 + timeout/network),
//   • structured error classification,
//   • optional mock fallback (AI_ALLOW_MOCK_FALLBACK) — fail-closed otherwise,
//   • attempt history + provider provenance on the result.
// The governed model is unchanged: a terminal failure THROWS, so the call_ai step
// fails normally and the run stays recoverable. Nothing here bypasses approval.

interface ProviderInput {
  model: string
  low: boolean
  system: string
  user: string
  max_output_tokens?: number
  mock_seed?: Record<string, unknown>
}

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])

// Thrown on a terminal provider failure (no fallback). Carries the structured type.
export class AiProviderCallError extends Error {
  type: AiProviderErrorType
  status?: number
  attempts: AiProviderAttempt[]
  constructor(type: AiProviderErrorType, message: string, attempts: AiProviderAttempt[], status?: number) {
    super(message)
    this.name = 'AiProviderCallError'
    this.type = type
    this.status = status
    this.attempts = attempts
  }
}

function classifyStatus(status: number): AiProviderErrorType {
  if (status === 401 || status === 403) return 'auth_error'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server_error'
  if (status === 400 || status === 404 || status === 422) return 'configuration_error'
  return 'unknown'
}

function isRetryable(errorType: AiProviderErrorType, status?: number): boolean {
  if (status !== undefined) return RETRYABLE_STATUS.has(status)
  return errorType === 'timeout' || errorType === 'server_error'
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function runAiProvider(input: ProviderInput): Promise<AiProviderResult> {
  const config = getProviderConfig()
  const attempts: AiProviderAttempt[] = []

  // Configured mock mode → deterministic mock, no live attempt.
  if (config.mode === 'mock') {
    return mockResult(input, config.timeout_ms, 'mock', false, attempts, undefined)
  }

  // Live mode requested but no key: configuration error (fall back if allowed).
  if (!config.has_key) {
    const attempt: AiProviderAttempt = { attempt: 1, provider_id: 'openai', ok: false, error_type: 'configuration_error', latency_ms: 0 }
    attempts.push(attempt)
    if (config.allow_mock_fallback) {
      return mockResult(input, config.timeout_ms, 'fallback', true, attempts, 'configuration_error')
    }
    throw new AiProviderCallError('configuration_error', 'AI_PROVIDER_MODE=live but OPENAI_API_KEY is not set', attempts)
  }

  const model = config.model_override ?? input.model
  const maxAttempts = config.max_retries + 1
  let lastType: AiProviderErrorType = 'unknown'
  let lastStatus: number | undefined
  let lastMessage = 'provider call failed'

  for (let i = 1; i <= maxAttempts; i++) {
    const startedAt = Date.now()
    try {
      const result = await liveCall(input, model, config.timeout_ms)
      attempts.push({ attempt: i, provider_id: 'openai', ok: true, status: 200, latency_ms: Date.now() - startedAt })
      return {
        ...result,
        provider_id: 'openai',
        provider_mode: 'live',
        fallback_used: false,
        attempts,
        retry_count: i - 1,
        timeout_ms: config.timeout_ms,
        model_used: model,
      }
    } catch (err) {
      const { type, status, message } = normalizeError(err)
      attempts.push({ attempt: i, provider_id: 'openai', ok: false, status, error_type: type, latency_ms: Date.now() - startedAt })
      lastType = type; lastStatus = status; lastMessage = message
      if (i < maxAttempts && isRetryable(type, status)) {
        await sleep(Math.min(250 * 2 ** (i - 1), 2000))
        continue
      }
      break
    }
  }

  // All live attempts exhausted.
  if (config.allow_mock_fallback) {
    return mockResult(input, config.timeout_ms, 'fallback', true, attempts, lastType)
  }
  throw new AiProviderCallError(lastType, `AI provider failed after ${attempts.length} attempt(s): ${lastMessage}`, attempts, lastStatus)
}

// ── One live attempt (timeout-bounded). Throws on any failure. ──
async function liveCall(
  input: ProviderInput, model: string, timeoutMs: number,
): Promise<Omit<AiProviderResult, 'provider_id' | 'provider_mode' | 'fallback_used' | 'attempts' | 'retry_count' | 'timeout_ms' | 'model_used'>> {
  const key = process.env.OPENAI_API_KEY as string
  const startedAt = Date.now()

  const body: Record<string, unknown> = {
    model,
    input: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    max_output_tokens: input.max_output_tokens ?? 1024,
  }
  if (input.low) body.reasoning = { effort: 'low' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new AiProviderCallError('timeout', `AI provider timed out after ${timeoutMs}ms`, [])
    }
    throw new AiProviderCallError('server_error', `AI provider request failed: ${err instanceof Error ? err.message : String(err)}`, [])
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new AiProviderCallError(classifyStatus(res.status), `AI provider returned ${res.status}: ${detail.slice(0, 300)}`, [], res.status)
  }

  let json: OpenAiResponse
  try {
    json = await res.json() as OpenAiResponse
  } catch {
    throw new AiProviderCallError('invalid_response', 'AI provider returned a non-JSON response body', [])
  }

  const text = extractText(json)
  if (!text || text.trim().length === 0) {
    throw new AiProviderCallError('invalid_response', 'AI provider returned an empty response (no output text)', [])
  }
  const usage = json.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

  return {
    raw_text: text,
    usage: {
      prompt_tokens:     usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens:      usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
    },
    model,
    latency_ms: Date.now() - startedAt,
    mocked: false,
  }
}

function normalizeError(err: unknown): { type: AiProviderErrorType; status?: number; message: string } {
  if (err instanceof AiProviderCallError) return { type: err.type, status: err.status, message: err.message }
  const message = err instanceof Error ? err.message : String(err)
  return { type: 'unknown', message }
}

// ── OpenAI Responses API shapes (minimal, defensive) ──
interface OpenAiResponse {
  output_text?: string
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}

function extractText(json: OpenAiResponse): string {
  if (typeof json.output_text === 'string' && json.output_text.length > 0) return json.output_text
  const parts: string[] = []
  for (const item of json.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string') parts.push(c.text)
    }
  }
  return parts.join('')
}

// Deterministic dev/test mock — shaped to satisfy the summarizer schema.
// Preserved unchanged in behavior; now carries provider provenance so a fallback
// is visible in telemetry.
function mockResult(
  input: ProviderInput,
  timeoutMs: number,
  mode: AiProviderMode,
  fallbackUsed: boolean,
  attempts: AiProviderAttempt[],
  errorType: AiProviderErrorType | undefined,
): AiProviderResult {
  const startedAt = Date.now()
  const seedText = typeof input.mock_seed?.intent === 'string' ? input.mock_seed.intent
    : typeof input.mock_seed?.title === 'string' ? input.mock_seed.title
    : ''
  const title = `Summary: ${seedText ? seedText.slice(0, 60) : 'draft'}`
  const payload = {
    title,
    summary: `Draft AI summary (mock${fallbackUsed ? ' fallback' : ''}). Source: ${seedText || '(none provided)'}.`,
    recommended_next_steps: [
      'Review the details',
      'Route to the appropriate department lead',
      'Create execution tasks if approved',
    ],
    risk_level: 'low',
    confidence: 0.5,
  }
  const raw = JSON.stringify(payload)
  const promptTokens = Math.ceil((input.system.length + input.user.length) / 4)
  const completionTokens = Math.ceil(raw.length / 4)
  attempts.push({ attempt: attempts.length + 1, provider_id: 'mock', ok: true, latency_ms: Date.now() - startedAt })
  return {
    raw_text: raw,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    model: input.model,
    latency_ms: Date.now() - startedAt,
    mocked: true,
    provider_id: 'mock',
    provider_mode: mode,
    fallback_used: fallbackUsed,
    attempts,
    retry_count: attempts.filter(a => a.provider_id === 'openai').length > 0 ? attempts.filter(a => a.provider_id === 'openai').length - 1 : 0,
    timeout_ms: timeoutMs,
    model_used: input.model,
    error_type: errorType,
  }
}
