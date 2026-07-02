// Sprint 6.1 — AI Execution MVP types.
// AI is a governed workflow step (see docs/sprint-6-0-ai-execution-blueprint.md):
// it produces validated, structured DRAFT output only. It never approves,
// delivers, or mutates governed state.

export type AiPromptId = 'REQUEST_SUMMARIZER' | 'WORK_PACKET_SUMMARIZER'

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

// ── Prompt Evaluation Framework (Sprint 7.8) ──
// Offline, deterministic, DB-free evaluation of a prompt VERSION before it is
// activated. Each case pairs an input with a mock-safe candidate output; the
// runner validates that output against the version's schema and scores it. No
// live provider call is required — this exercises the version's contract + rubric
// so a new/changed version can be judged before `active_version` moves to it.

export type AiPromptEvalStatus = 'passed' | 'partial' | 'failed'

// A single scoring breakdown for one case.
export interface AiPromptEvalScore {
  schema_valid: boolean          // candidate passed validateAiOutput
  required_fields_present: boolean
  completeness: number           // 0..1 — fraction of expected_fields present & non-empty
  risk_level_valid: boolean      // candidate risk_level within schema enum (if applicable)
  next_steps_present: boolean    // recommended_next_steps non-empty (if applicable)
  score: number                  // 0..1 aggregate
}

// One evaluation case: a representative, mock-safe input + expected model output.
export interface AiPromptEvalCase {
  id: string
  description: string
  input_payload: Record<string, unknown>       // variables that would be sent to the prompt
  candidate_output: Record<string, unknown>     // mock-safe representative model output to score
  expected_fields: string[]                     // fields that must be present & non-empty
  notes?: string
}

// The result of scoring one case against a prompt version.
export interface AiPromptEvalResult {
  case_id: string
  prompt_id: AiPromptId
  prompt_version_id: AiPromptVersionId
  status: AiPromptEvalStatus
  score: AiPromptEvalScore
  errors: string[]               // schema validation errors, if any
  notes: string
}

// A named suite of cases bound to a specific prompt version.
export interface AiPromptEvalSuite {
  id: string
  prompt_id: AiPromptId
  prompt_version_id: AiPromptVersionId
  description: string
  pass_threshold: number         // min aggregate score for a case to pass (0..1)
  cases: AiPromptEvalCase[]
}

// The aggregate outcome of running a suite (returned by the runner).
export interface AiPromptEvalSuiteResult {
  suite_id: string
  prompt_id: AiPromptId
  prompt_version_id: AiPromptVersionId
  total: number
  passed: number
  failed: number
  average_score: number
  status: AiPromptEvalStatus     // passed only when every case passes
  results: AiPromptEvalResult[]
  ran_at: string
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

// ── Provider Hardening (Sprint 8.0) ──
// Production-readiness types for the single AI egress point: which provider was
// used, in what mode, how many attempts, and how a failure was classified. The
// governed workflow model is unchanged — a provider failure fails the call_ai
// step normally (recoverable) and never bypasses an approval.

export type AiProviderId = 'openai' | 'mock'

// Health of a provider as inferred from telemetry.
export type AiProviderStatus = 'healthy' | 'degraded' | 'unavailable' | 'disabled' | 'unknown'

// live     → real provider call succeeded.
// mock     → deterministic mock was used by configuration (no key / AI_PROVIDER_MODE=mock).
// fallback → a live call was attempted, failed, and the mock was used as a fallback.
export type AiProviderMode = 'live' | 'mock' | 'fallback'

// Structured error classification for a failed provider attempt.
export type AiProviderErrorType =
  | 'auth_error'
  | 'rate_limited'
  | 'timeout'
  | 'server_error'
  | 'invalid_response'
  | 'configuration_error'
  | 'unknown'

export interface AiProviderError {
  type: AiProviderErrorType
  message: string
  status?: number       // HTTP status when applicable
  retryable: boolean
}

// Resolved provider configuration (from env, per call — server-only).
export interface AiProviderConfig {
  provider_id: AiProviderId       // which provider the config targets
  mode: 'live' | 'mock'           // configured default mode (fallback is a runtime outcome)
  has_key: boolean
  model_override: string | null   // OPENAI_MODEL, if set
  timeout_ms: number
  max_retries: number
  allow_mock_fallback: boolean
}

// One attempt against a provider within a single call.
export interface AiProviderAttempt {
  attempt: number                 // 1-based
  provider_id: AiProviderId
  ok: boolean
  status?: number
  error_type?: AiProviderErrorType
  latency_ms: number
}

// Raw result from the provider (text expected to be JSON for the schema).
// Extended in Sprint 8.0 with provider provenance — additive, back-compatible.
export interface AiProviderResult {
  raw_text: string
  usage: AiUsage
  model: string
  latency_ms: number
  mocked: boolean
  // Provider hardening provenance (Sprint 8.0):
  provider_id: AiProviderId
  provider_mode: AiProviderMode
  fallback_used: boolean
  attempts: AiProviderAttempt[]
  retry_count: number             // attempts beyond the first against the live provider
  timeout_ms: number
  model_used: string
  error_type?: AiProviderErrorType // last live error type when a fallback was used
}

// Aggregate provider health for the AI Operations panel (read-only telemetry).
export interface AiProviderHealthSummary {
  provider_id: AiProviderId
  mode: AiProviderMode | 'unknown'
  status: AiProviderStatus
  executions: number
  failures: number
  fallback_count: number
  avg_latency_ms: number | null
  last_success_at: string | null
  last_failure_at: string | null
  common_error_type: AiProviderErrorType | null
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

export type AiWorkflowId = 'request_ai_summary' | 'work_packet_ai_summary'

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
  trigger_entity_type: 'request' | 'work_packet'   // what entity this AI workflow runs against
  required_inputs: string[]        // whitelisted inputs the workflow needs
  output_target: AiWorkflowOutputTarget
  approval_required: boolean       // whether a human approval gate is opened
  readiness: AiWorkflowReadinessRequirements
  status: AiWorkflowStatus
  template_id?: AiWorkflowTemplateId   // Sprint 7.1 — template this workflow follows
  capability_id?: AiCapabilityId       // Sprint 7.3 — capability this workflow realizes
  agent_id?: AiAgentId                 // Sprint 7.5 — agent that composes this workflow
  supported_plan_ids?: AiPlanId[]      // Sprint 7.6 — plans that compose this workflow
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
  | 'work_packet_summarization'
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
  supported_agent_ids?: AiAgentId[]         // Sprint 7.5 — agents that may use this capability
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
  | 'summarize_work_packet'
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
  supported_agent_ids?: AiAgentId[]   // Sprint 7.5 — agents that may compose this skill
}

// ── AI Agent Registry (Sprint 7.5) ──
// The top of the registry stack: an AGENT is a governed ROLE that may EVENTUALLY
// compose skills, capabilities, and workflows toward a goal. This sprint is
// read-model / metadata ONLY — agents are NON-EXECUTABLE. They act autonomously
// NOWHERE: they hold no privilege, run no workflow, register no prompt, and do
// not orchestrate anything. The registry defines the governed roles that a future
// agent-execution sprint could bring to life under the same draft-only, human-
// approval-gated guarantees.

export type AiAgentId =
  | 'request_summary_assistant'
  | 'work_packet_summary_assistant'
  | 'risk_review_analyst'
  | 'action_recommendation_advisor'
  | 'operations_monitor'

export type AiAgentCategory =
  | 'assistant'
  | 'analyst'
  | 'reviewer'
  | 'router'
  | 'planner'
  | 'operator'
  | 'monitor'

// active  → the agent's composed chain (skills/capability/workflow) is registered
//           and working, even though the agent itself does not yet execute.
// planned → declared role only; parts of its chain may not exist yet.
// retired → kept for provenance; no longer offered.
export type AiAgentStatus = 'active' | 'planned' | 'retired'

// The bounded surface an agent is permitted to operate over (documentation of
// intent; nothing here grants execution in this sprint).
export interface AiAgentScope {
  target_entities: AiWorkflowTargetEntity[]
  description: string
}

// Governance intent restated per agent. Declarative — the runtime + RLS enforce
// the actual gates; this documents and cannot loosen them. For Sprint 7.5 the
// execution-bearing flags are hard-false.
export interface AiAgentGovernancePolicy {
  requires_human_approval: boolean
  may_create_drafts: boolean
  may_execute_workflows: false        // always false this sprint — agents are non-executable
  may_mutate_governed_state: false    // always false — AI proposes, humans dispose
  may_deliver_outputs: false          // always false — no auto-delivery
  requires_audit_logging: boolean
}

export interface AiAgentDefinition {
  id: AiAgentId
  name: string
  category: AiAgentCategory
  purpose: string
  description: string
  scope: AiAgentScope
  allowed_skill_ids: AiSkillId[]
  allowed_capability_ids: AiCapabilityId[]
  allowed_workflow_ids: AiWorkflowId[]
  default_prompt_ids: AiPromptId[]
  governance_policy: AiAgentGovernancePolicy
  evaluation_signals: string[]
  allowed_actions: string[]
  forbidden_actions: string[]
  status: AiAgentStatus
  supported_plan_ids?: AiPlanId[]     // Sprint 7.6 — plans that may compose this agent
}

// ── AI Plan Registry (Sprint 7.6) ──
// The capstone of the registry stack: a PLAN is a governed, ordered SEQUENCE of
// steps that composes agents, skills, capabilities, and workflows toward a
// multi-step outcome — with explicit human-review / approval checkpoints between
// governed steps. This sprint is read-model / metadata ONLY — plans are
// NON-EXECUTABLE. They orchestrate NOTHING, run no workflow, register no prompt,
// and hold no privilege. The registry defines the governed sequences a future
// orchestration sprint could execute under the same draft-only, human-approval-
// gated guarantees.

export type AiPlanId =
  | 'request_summary_review_plan'
  | 'work_packet_summary_review_plan'
  | 'request_risk_triage_plan'
  | 'action_recommendation_plan'
  | 'operations_monitoring_plan'

export type AiPlanCategory =
  | 'review'
  | 'triage'
  | 'analysis'
  | 'reporting'
  | 'recommendation'
  | 'monitoring'
  | 'routing'

// active  → the plan's composed chain is registered and working, even though the
//           plan itself does not yet execute.
// planned → declared sequence only; parts of its chain may not exist yet.
// retired → kept for provenance; no longer offered.
export type AiPlanStatus = 'active' | 'planned' | 'retired'

// The kind of a single plan step. `approval_checkpoint` / `human_review` are the
// governed gates between AI steps — a plan is a sequence of proposals punctuated
// by human decisions, never a chain of autonomous actions.
export type AiPlanStepKind =
  | 'agent'
  | 'skill'
  | 'capability'
  | 'workflow'
  | 'approval_checkpoint'
  | 'human_review'

export interface AiPlanStepDefinition {
  step_id: string
  label: string
  kind: AiPlanStepKind
  agent_id?: AiAgentId
  skill_id?: AiSkillId
  capability_id?: AiCapabilityId
  workflow_id?: AiWorkflowId
  required: boolean
  approval_required: boolean
  description: string
  output_contract?: AiSkillOutputContract   // expected draft shape, when the step produces one
}

// Governance intent restated per plan. Declarative — the runtime + RLS enforce
// the actual gates; this documents and cannot loosen them. For Sprint 7.6 the
// execution-bearing flags are hard-false.
export interface AiPlanGovernancePolicy {
  requires_human_approval: boolean
  may_create_drafts: boolean
  may_execute_workflows: false        // always false this sprint — plans are non-executable
  may_mutate_governed_state: false    // always false — AI proposes, humans dispose
  may_deliver_outputs: false          // always false — no auto-delivery
  requires_audit_logging: boolean
}

export interface AiPlanDefinition {
  id: AiPlanId
  name: string
  category: AiPlanCategory
  purpose: string
  description: string
  target_entities: AiWorkflowTargetEntity[]
  steps: AiPlanStepDefinition[]
  allowed_agent_ids: AiAgentId[]
  allowed_skill_ids: AiSkillId[]
  allowed_capability_ids: AiCapabilityId[]
  allowed_workflow_ids: AiWorkflowId[]
  governance_policy: AiPlanGovernancePolicy
  evaluation_signals: string[]
  allowed_actions: string[]
  forbidden_actions: string[]
  status: AiPlanStatus
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
  // Provider hardening provenance (Sprint 8.0):
  provider_id: AiProviderId
  provider_mode: AiProviderMode
  fallback_used: boolean
  attempts_count: number
  retry_count: number
  timeout_ms: number
  model_used: string
  error_type?: AiProviderErrorType     // last live error type when a fallback occurred
}
