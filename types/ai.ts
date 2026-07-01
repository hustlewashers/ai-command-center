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
// This is the EXECUTABLE shape consumed by the router, provider, and validator.
export interface AiPromptDefinition {
  id: AiPromptId
  version: number
  purpose: string
  model: string                                 // e.g. 'gpt-5.5'
  low: boolean                                  // low-reasoning/effort flag
  system_prompt: string
  output_schema: Record<string, AiSchemaField>
}

// ── Prompt Versioning (Sprint 7.2) ──
// A prompt id is a STABLE ALIAS (e.g. 'REQUEST_SUMMARIZER'); its behavior is
// pinned to a specific VERSION. Each output can then be traced to the exact
// prompt version that produced it. Still in-code only — no DB-backed prompts.

export type AiPromptAlias = AiPromptId                 // stable prompt id / alias
export type AiPromptVersionId = string                 // e.g. 'REQUEST_SUMMARIZER@v1'
export type AiPromptVersionStatus = 'active' | 'deprecated' | 'experimental'

// A single versioned prompt. Superset of AiPromptDefinition (so it remains
// directly executable) plus version provenance. Never edited in place once
// shipped — add a new version instead.
export interface AiPromptVersionDefinition extends AiPromptDefinition {
  prompt_id: AiPromptId
  version_id: AiPromptVersionId
  status: AiPromptVersionStatus
  released_at: string                                  // ISO date string
  change_note: string
  replaced_by?: AiPromptVersionId                      // set when superseded
  deprecated_at?: string                               // ISO date string
}

// A prompt alias and all its versions, with which version is active.
export interface AiPromptRegistryEntry {
  id: AiPromptId
  active_version: number                               // the version call_ai uses
  versions: AiPromptVersionDefinition[]
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
  template_id?: AiWorkflowTemplateId   // Sprint 7.1 — template this workflow follows
  capability_id?: AiCapabilityId       // Sprint 7.3 — capability this workflow realizes
}

// ── AI Capability Registry (Sprint 7.3) ──
// A reusable layer BETWEEN prompts and workflows describing WHAT the AI does
// (summarize, classify, recommend, assess risk, …) independent of any single
// prompt or runtime workflow. Workflows reference a capability so purpose,
// governance intent, output expectations, and evaluation metadata are declared
// once and reused. Registry / read-model only — capabilities NEVER execute, hold
// no privilege, register no prompt, and create no runtime workflow.

export type AiCapabilityId =
  | 'request_summarization'
  | 'risk_assessment'
  | 'action_recommendation'
  | 'classification'

export type AiCapabilityCategory =
  | 'summarization'
  | 'classification'
  | 'recommendation'
  | 'extraction'
  | 'prioritization'
  | 'risk_assessment'
  | 'routing'
  | 'comparison'

// active  → backed by a registered, working AI workflow.
// planned → declared intent only; no prompt or runtime workflow yet.
// retired → kept for provenance; no longer offered.
export type AiCapabilityStatus = 'active' | 'planned' | 'retired'

// What a capability's instantiations produce (a draft awaiting approval in MVP).
export interface AiCapabilityOutputContract {
  type: 'output'
  output_type: string
  status: 'draft'
  expected_fields: string[]   // fields downstream/reviewers can expect (documentation)
}

// Governance intent restated per capability. Declarative — the runtime + RLS
// enforce the actual gates; this documents and cannot loosen them.
export interface AiCapabilityGovernancePolicy {
  approval_required: boolean
  human_review_required: boolean
  draft_only: boolean
  may_mutate_governed_state: false   // always false — AI proposes, humans dispose
}

export interface AiCapabilityDefinition {
  id: AiCapabilityId
  name: string
  category: AiCapabilityCategory
  purpose: string
  description: string
  supported_target_entities: AiWorkflowTargetEntity[]
  default_prompt_id: AiPromptId | null      // null → no prompt registered yet (planned)
  default_template_id: AiWorkflowTemplateId | null
  output_contract: AiCapabilityOutputContract
  governance_policy: AiCapabilityGovernancePolicy
  evaluation_signals: string[]              // signals to judge quality (e.g. confidence, approval_rate)
  allowed_actions: string[]                 // what an instantiation MAY do (draft/propose only)
  forbidden_actions: string[]               // what it may NEVER do
  status: AiCapabilityStatus
  default_skill_id?: AiSkillId              // Sprint 7.4 — skill this capability composes
}

// ── AI Skill Registry (Sprint 7.4) ──
// The most granular reusable layer: a SKILL is a single reusable AI operation
// (summarize, classify, extract, recommend, …) that capabilities compose and
// future agents will orchestrate. Where a capability names WHAT the AI does for a
// business purpose, a skill names the underlying OPERATION independent of purpose.
// Registry / read-model only — skills NEVER execute, hold no privilege, register
// no prompt, and create no runtime workflow.

export type AiSkillId =
  | 'summarize_request'
  | 'classify_entity'
  | 'assess_entity_risk'
  | 'recommend_next_action'
  | 'extract_entity_facts'

export type AiSkillCategory =
  | 'summarize'
  | 'classify'
  | 'extract'
  | 'recommend'
  | 'compare'
  | 'prioritize'
  | 'assess_risk'
  | 'route'

// active  → composed by an active capability with a registered prompt/workflow.
// planned → declared operation only; no prompt or runtime workflow yet.
// retired → kept for provenance; no longer offered.
export type AiSkillStatus = 'active' | 'planned' | 'retired'

// A declared input on a skill (name + whether the model may see it).
export interface AiSkillInput {
  key: string
  description: string
  sensitive?: boolean   // true → must NOT be whitelisted into a prompt
}

// What a skill's invocations produce (a draft awaiting approval in MVP).
export interface AiSkillOutputContract {
  type: 'output'
  output_type: string
  status: 'draft'
  expected_fields: string[]
}

// Governance intent restated per skill. Declarative — the runtime + RLS enforce
// the actual gates; this documents and cannot loosen them.
export interface AiSkillGovernancePolicy {
  approval_required: boolean
  human_review_required: boolean
  draft_only: boolean
  may_mutate_governed_state: false   // always false — AI proposes, humans dispose
}

export interface AiSkillDefinition {
  id: AiSkillId
  name: string
  category: AiSkillCategory
  purpose: string
  description: string
  supported_input_entities: AiWorkflowTargetEntity[]
  supported_output_types: string[]
  default_capability_id: AiCapabilityId | null   // capability this skill serves (null if generic)
  default_prompt_id: AiPromptId | null           // null → no prompt registered yet (planned)
  required_inputs: AiSkillInput[]
  optional_inputs: AiSkillInput[]
  output_contract: AiSkillOutputContract
  governance_policy: AiSkillGovernancePolicy
  evaluation_signals: string[]
  allowed_actions: string[]
  forbidden_actions: string[]
  status: AiSkillStatus
}

// ── AI Workflow Template Layer (Sprint 7.1) ──
// A reusable BLUEPRINT layer above the AI workflow registry. A template captures
// the repeatable shape of a class of governed AI workflows (draft-from-entity,
// classification-with-review, recommendation-with-approval) so future workflows
// can be declared consistently without re-deriving output target, approval policy,
// readiness policy, and governance boundaries each time. Templates are pure
// serializable metadata / read-model + documentation — they NEVER execute, hold
// no privilege, register no prompt, and create no runtime workflow.

export type AiWorkflowTemplateId =
  | 'ai_draft_output_from_entity'
  | 'ai_classification_with_review'
  | 'ai_recommendation_with_approval'

// Entities a template's instantiations may run against.
export type AiWorkflowTargetEntity =
  | 'request' | 'task' | 'work_packet' | 'decision' | 'output' | 'project'

// A declared input on a template (name + whether the model may see it).
export interface AiWorkflowTemplateInput {
  key: string
  description: string
  sensitive?: boolean   // true → must NOT be whitelisted into a prompt
}

// The kind of governed artifact a template's instantiations produce. Always a
// DRAFT in MVP — templates cannot declare a delivered/approved output.
export interface AiWorkflowTemplateOutputTarget {
  type: 'output'
  output_type: string
  status: 'draft'
}

// Approval policy for a template. `required: true` for every governed template;
// `must_precede_governed_change` documents that no governed transition may occur
// before a human resolves the approval.
export interface AiWorkflowTemplateApprovalPolicy {
  required: boolean
  approver_role: string
  must_precede_governed_change: boolean
}

// Default readiness policy a template recommends for its instantiations. Reuses
// the same requirement flags the readiness evaluator consumes.
export type AiWorkflowTemplateReadinessPolicy = AiWorkflowReadinessRequirements

export type AiWorkflowTemplateStatus = 'active' | 'experimental' | 'disabled'

export interface AiWorkflowTemplateDefinition {
  id: AiWorkflowTemplateId
  name: string
  purpose: string
  category: 'draft' | 'classification' | 'recommendation'
  supported_target_entities: AiWorkflowTargetEntity[]
  default_prompt_id: AiPromptId | null      // null → a prompt must be supplied per instantiation
  default_output_target: AiWorkflowTemplateOutputTarget
  default_approval_policy: AiWorkflowTemplateApprovalPolicy
  default_readiness_policy: AiWorkflowTemplateReadinessPolicy
  required_inputs: AiWorkflowTemplateInput[]
  optional_inputs: AiWorkflowTemplateInput[]
  governed_actions_allowed: string[]        // what an instantiation MAY do (draft/propose only)
  forbidden_actions: string[]               // what it may NEVER do (deliver, approve, transition…)
  status: AiWorkflowTemplateStatus
}

// A concrete plan for instantiating an AI workflow from a template. Read-model
// only in Sprint 7.1 — describes what a future registration would look like; it
// does not register anything or execute.
export interface AiWorkflowTemplateInstantiationPlan {
  template_id: AiWorkflowTemplateId
  ai_workflow_id: string            // proposed AI workflow id
  runtime_workflow_id: string       // proposed runtime workflow id (must be built separately)
  prompt_id: AiPromptId | null      // prompt to use (must be registered separately)
  trigger_entity_type: AiWorkflowTargetEntity
  required_inputs: string[]
  output_target: AiWorkflowTemplateOutputTarget
  approval_required: boolean
  readiness: AiWorkflowReadinessRequirements
  notes?: string
}

// Final, validated output of a call_ai step.
export interface AiExecutionOutput {
  ai_result: Record<string, unknown>   // schema-validated structured output
  prompt_id: AiPromptId
  prompt_version: number               // Sprint 7.2 — version used
  prompt_version_id: AiPromptVersionId // Sprint 7.2 — e.g. 'REQUEST_SUMMARIZER@v1'
  model: string
  low: boolean                         // Sprint 7.2 — low-effort flag actually used
  confidence: number | null
  validation_status: 'passed'          // Sprint 7.2 — reached only after schema validation
  output_schema_fields: string[]       // Sprint 7.2 — validated schema field names
  usage: AiUsage
  latency_ms: number
  estimated_cost: number               // USD, estimate
  mocked: boolean
}
