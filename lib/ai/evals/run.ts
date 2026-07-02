import type {
  AiPromptEvalCase,
  AiPromptEvalResult,
  AiPromptEvalScore,
  AiPromptEvalStatus,
  AiPromptEvalSuite,
  AiPromptEvalSuiteResult,
  AiPromptVersionDefinition,
} from '@/types/ai'
import { listPromptVersions } from '../prompts'
import { validateAiOutput } from '../contract'
import { REQUEST_SUMMARIZER_V1_SUITE } from './request-summarizer'

// Sprint 7.8 — Prompt Evaluation Runner.
//
// Deterministic, DB-free, provider-free. For each case it validates the case's
// mock-safe candidate output against the prompt VERSION's structured-output
// schema (the same validateAiOutput used at runtime), then scores completeness,
// required-field presence, risk-level validity, and next-steps presence. It makes
// NO network call and writes NOTHING — it exercises the version's contract + rubric
// so a version can be judged before activation.

// All registered eval suites (add new suites here).
const SUITES: AiPromptEvalSuite[] = [
  REQUEST_SUMMARIZER_V1_SUITE,
]

export function listPromptEvalSuites(): AiPromptEvalSuite[] {
  return SUITES
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'boolean') return true
  return false
}

function resolveVersion(versionId: string): AiPromptVersionDefinition | undefined {
  return listPromptVersions().find(v => v.version_id === versionId)
}

function scoreCase(
  version: AiPromptVersionDefinition,
  evalCase: AiPromptEvalCase,
): { score: AiPromptEvalScore; errors: string[] } {
  const schema = version.output_schema
  const candidate = evalCase.candidate_output

  // 1. Schema validation (same validator as the runtime call_ai step).
  const validation = validateAiOutput(version, candidate)
  const schema_valid = validation.ok

  // 2. Required schema fields present in the validated value.
  const requiredFields = Object.entries(schema).filter(([, f]) => f.required).map(([k]) => k)
  const validated = validation.value ?? {}
  const required_fields_present = requiredFields.every(f => isNonEmpty(validated[f]))

  // 3. Completeness: fraction of expected_fields present & non-empty in candidate.
  const expected = evalCase.expected_fields
  const presentCount = expected.filter(f => isNonEmpty(candidate[f])).length
  const completeness = expected.length === 0 ? 1 : presentCount / expected.length

  // 4. risk_level validity — only scored when the schema declares a risk_level enum.
  const riskField = schema['risk_level']
  const risk_applies = !!riskField && riskField.type === 'enum'
  const risk_level_valid = risk_applies
    ? typeof candidate['risk_level'] === 'string' && (riskField.enum ?? []).includes(candidate['risk_level'] as string)
    : true

  // 5. next-steps presence — only scored when the schema declares the field.
  const nextField = schema['recommended_next_steps']
  const next_applies = !!nextField
  const next_steps_present = next_applies
    ? Array.isArray(candidate['recommended_next_steps']) && (candidate['recommended_next_steps'] as unknown[]).length > 0
    : true

  // Aggregate: average of the applicable components, gated on schema validity.
  const components: number[] = [completeness, required_fields_present ? 1 : 0]
  if (risk_applies) components.push(risk_level_valid ? 1 : 0)
  if (next_applies) components.push(next_steps_present ? 1 : 0)
  const raw = components.reduce((a, b) => a + b, 0) / components.length
  const score = schema_valid ? raw : 0

  return {
    score: { schema_valid, required_fields_present, completeness, risk_level_valid, next_steps_present, score },
    errors: validation.errors,
  }
}

function caseStatus(score: AiPromptEvalScore, threshold: number): AiPromptEvalStatus {
  if (score.schema_valid && score.required_fields_present && score.score >= threshold) return 'passed'
  if (score.score > 0) return 'partial'
  return 'failed'
}

export function runPromptEvalSuite(suite: AiPromptEvalSuite): AiPromptEvalSuiteResult {
  const ran_at = new Date().toISOString()
  const version = resolveVersion(suite.prompt_version_id)

  // If the version can't be resolved, the whole suite fails cleanly (no throw).
  if (!version) {
    const results: AiPromptEvalResult[] = suite.cases.map(c => ({
      case_id: c.id,
      prompt_id: suite.prompt_id,
      prompt_version_id: suite.prompt_version_id,
      status: 'failed' as AiPromptEvalStatus,
      score: { schema_valid: false, required_fields_present: false, completeness: 0, risk_level_valid: false, next_steps_present: false, score: 0 },
      errors: [`Prompt version '${suite.prompt_version_id}' not found in registry`],
      notes: 'Version unresolved — cannot evaluate.',
    }))
    return {
      suite_id: suite.id, prompt_id: suite.prompt_id, prompt_version_id: suite.prompt_version_id,
      total: results.length, passed: 0, failed: results.length, average_score: 0,
      status: 'failed', results, ran_at,
    }
  }

  const results: AiPromptEvalResult[] = suite.cases.map(c => {
    const { score, errors } = scoreCase(version, c)
    const status = caseStatus(score, suite.pass_threshold)
    return {
      case_id: c.id,
      prompt_id: suite.prompt_id,
      prompt_version_id: suite.prompt_version_id,
      status,
      score,
      errors,
      notes: status === 'passed'
        ? 'Candidate valid and complete.'
        : errors.length > 0 ? `Validation issues: ${errors.join('; ')}` : 'Below pass threshold.',
    }
  })

  const passed = results.filter(r => r.status === 'passed').length
  const failed = results.length - passed
  const average_score = results.length === 0 ? 0
    : results.reduce((a, r) => a + r.score.score, 0) / results.length
  const status: AiPromptEvalStatus = failed === 0 ? 'passed' : (passed > 0 ? 'partial' : 'failed')

  return {
    suite_id: suite.id,
    prompt_id: suite.prompt_id,
    prompt_version_id: suite.prompt_version_id,
    total: results.length,
    passed,
    failed,
    average_score,
    status,
    results,
    ran_at,
  }
}

// Run every registered suite (used by the AI Operations panel).
export function runAllPromptEvalSuites(): AiPromptEvalSuiteResult[] {
  return SUITES.map(runPromptEvalSuite)
}
