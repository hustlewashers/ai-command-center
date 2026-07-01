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

// ── AI Workflow Definition Layer (Sprint 7.0) ──
// A coordination / read-model layer describing each governed AI workflow: which
// prompt it uses, which runtime workflow (in lib/workflows/registry.ts) actually
// executes it, what inputs it needs, whether it requires human approval, and its
// readiness requirements. This does NOT execute workflows — the runtime registry
// still owns execution. It centralizes the metadata that UI + readiness read.

export type AiWorkflowId = 'request_ai_summary'

// Declarative readiness requirements for an AI workflow. The readiness evaluator
// reads these flags rather than hardcoding them, so a new AI workflow can declare
// its own gating without a new evaluator.
export interface AiWorkflowReadinessRequirements {
  require_project: boolean
  require_department: boolean
  require_linked_task: boolean
  block_active_run: boolean       // block while a run is pending/running/resuming
  block_active_job: boolean       // block while a job is queued/processing/retrying
  block_failed: boolean           // block (recover instead) when the latest run failed
  block_completed: boolean        // block (review instead) when a run already completed
}

// What an AI workflow ultimately produces (a draft awaiting approval in MVP).
export interface AiWorkflowOutputTarget {
  type: 'output'
  output_type: string
  status: 'draft'
}

export type AiWorkflowStatus = 'active' | 'experimental' | 'disabled'

export interface AiWorkflowDefinition {
  id: AiWorkflowId                 // AI workflow id (coordination layer)
  name: string
  purpose: string
  prompt_id: AiPromptId            // prompt driving the call_ai step
  runtime_workflow_id: string      // workflow id executed by lib/workflows/registry.ts
  trigger_entity_type: 'request'   // what entity this AI workflow runs against
  required_inputs: string[]        // whitelisted inputs the workflow needs
  output_target: AiWorkflowOutputTarget
  approval_required: boolean       // whether a human approval gate is opened
  readiness: AiWorkflowReadinessRequirements
  status: AiWorkflowStatus
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
