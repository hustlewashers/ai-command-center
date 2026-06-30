import { getPrompt } from './prompts'
import { createError } from '@/lib/errors'
import type { AiModelRoute, AiPromptId } from '@/types/ai'

// Static model routing (Sprint 6.1). No dynamic/auto selection, no failover.
// A prompt's model comes from its definition; pricing constants live here so
// cost is computable locally (estimate only — no billing API).

// Per-1K-token USD estimates. Update when real pricing is known.
const PRICING: Record<string, { input_per_1k: number; output_per_1k: number }> = {
  'gpt-5.5': { input_per_1k: 0.01, output_per_1k: 0.03 },
}
const DEFAULT_PRICING = { input_per_1k: 0.01, output_per_1k: 0.03 }

export function routeModel(promptId: AiPromptId): AiModelRoute {
  const prompt = getPrompt(promptId)
  if (!prompt) throw createError('validation', `Unknown AI prompt id: '${promptId}'`)

  const pricing = PRICING[prompt.model] ?? DEFAULT_PRICING
  return {
    prompt_id:           prompt.id,
    model:               prompt.model,
    low:                 prompt.low,
    price_input_per_1k:  pricing.input_per_1k,
    price_output_per_1k: pricing.output_per_1k,
  }
}

// USD cost estimate from token usage and the route's pricing.
export function estimateCost(route: AiModelRoute, promptTokens: number, completionTokens: number): number {
  const cost = (promptTokens / 1000) * route.price_input_per_1k
    + (completionTokens / 1000) * route.price_output_per_1k
  return Math.round(cost * 1e6) / 1e6   // round to 6 dp
}
