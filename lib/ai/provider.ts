import type { AiProviderResult } from '@/types/ai'

// Single AI egress point (Sprint 6.1).
// SERVER ONLY — NEVER import this from client components or NEXT_PUBLIC paths.
// The API key (OPENAI_API_KEY) is read here and is never returned, logged, or
// persisted (same discipline as lib/supabase/service.ts).
//
// If OPENAI_API_KEY is set → call the OpenAI Responses API.
// If it is missing:
//   - development/test → return a deterministic mock so the workflow is runnable
//   - production       → throw (fail closed; never silently fabricate)

interface ProviderInput {
  model: string
  low: boolean
  system: string
  user: string
  max_output_tokens?: number
  // Used only to shape the deterministic mock so output passes schema validation.
  mock_seed?: Record<string, unknown>
}

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

export async function runAiProvider(input: ProviderInput): Promise<AiProviderResult> {
  const key = process.env.OPENAI_API_KEY
  const startedAt = Date.now()

  if (!key) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('OPENAI_API_KEY is not set — AI provider unavailable in production')
    }
    return mockResult(input, startedAt)
  }

  // ── Real call: OpenAI Responses API (fetch — no SDK dependency) ──
  const body: Record<string, unknown> = {
    model: input.model,
    input: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    max_output_tokens: input.max_output_tokens ?? 1024,
  }
  // Low-effort reasoning when requested (ignored by models that don't support it).
  if (input.low) body.reasoning = { effort: 'low' }

  let res: Response
  try {
    res = await fetch(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`AI provider request failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!res.ok) {
    // Do not include the request body (could contain prompt content) in the error.
    const detail = await res.text().catch(() => '')
    throw new Error(`AI provider returned ${res.status}: ${detail.slice(0, 300)}`)
  }

  const json = await res.json() as OpenAiResponse
  const text = extractText(json)
  const usage = json.usage ?? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }

  return {
    raw_text: text,
    usage: {
      prompt_tokens:     usage.input_tokens ?? 0,
      completion_tokens: usage.output_tokens ?? 0,
      total_tokens:      usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
    },
    model: input.model,
    latency_ms: Date.now() - startedAt,
    mocked: false,
  }
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

// Deterministic dev/test mock — shaped to satisfy REQUEST_SUMMARIZER's schema.
function mockResult(input: ProviderInput, startedAt: number): AiProviderResult {
  const intent = typeof input.mock_seed?.intent === 'string' ? input.mock_seed.intent : ''
  const title = `Summary: ${intent ? intent.slice(0, 60) : 'request'}`
  const payload = {
    title,
    summary: `Draft AI summary (mock — OPENAI_API_KEY not set). Request intent: ${intent || '(none provided)'}.`,
    recommended_next_steps: [
      'Review the request details',
      'Route to the appropriate department lead',
      'Create execution tasks if approved',
    ],
    risk_level: 'low',
    confidence: 0.5,
  }
  const raw = JSON.stringify(payload)
  // Rough token estimate for the mock (≈4 chars/token).
  const promptTokens = Math.ceil((input.system.length + input.user.length) / 4)
  const completionTokens = Math.ceil(raw.length / 4)
  return {
    raw_text: raw,
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    model: input.model,
    latency_ms: Date.now() - startedAt,
    mocked: true,
  }
}
