// Sprint 6.1 — AI Execution MVP types.
// AI is a governed workflow step (see docs/sprint-6-0-ai-execution-blueprint.md):
// it produces validated, structured DRAFT output only. It never approves,
// delivers, or mutates governed state.

export type AiPromptId = 'REQUEST_SUMMARIZER'

export type AiFieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'enum'

// One field in a prompt's structured-output contract.
export interface AiSchemaField {
  type: AiFieldType
  required: boolean
  enum?: readonly string[]   // only for type 'enum'
  max_len?: number           // only for type 'string'
}

// In-code prompt definition. Versioned; never edited in place once shipped.
export interface AiPromptDefinition {
  id: AiPromptId
  version: number
  purpose: string
  model: string                                 // e.g. 'gpt-5.5'
  low: boolean                                  // low-reasoning/effort flag
  system_prompt: string
  output_schema: Record<string, AiSchemaField>
}

// Static routing decision derived from a prompt definition.
export interface AiModelRoute {
  prompt_id: AiPromptId
  model: string
  low: boolean
  price_input_per_1k: number   // USD, estimate only
  price_output_per_1k: number  // USD, estimate only
}

// Whitelisted inputs handed to a single AI execution.
export interface AiExecutionInput {
  prompt_id: AiPromptId
  variables: Record<string, unknown>
}

export interface AiUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

// Raw result from the provider (text expected to be JSON for the schema).
export interface AiProviderResult {
  raw_text: string
  usage: AiUsage
  model: string
  latency_ms: number
  mocked: boolean
}

// Result of validating provider text against a prompt's output_schema.
export interface AiValidationResult {
  ok: boolean
  value: Record<string, unknown> | null
  errors: string[]
}

// Final, validated output of a call_ai step.
export interface AiExecutionOutput {
  ai_result: Record<string, unknown>   // schema-validated structured output
  prompt_id: AiPromptId
  model: string
  confidence: number | null
  usage: AiUsage
  latency_ms: number
  estimated_cost: number               // USD, estimate
  mocked: boolean
}
