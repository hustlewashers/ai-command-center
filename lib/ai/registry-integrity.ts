import { listAiPlans } from './plans'
import { listAiAgents, getAiAgent } from './agents'
import { listAiSkills, getAiSkill } from './skills'
import { listAiCapabilities, getAiCapability } from './capabilities'
import { listAiWorkflows, getAiWorkflow } from './workflows'
import { listAiWorkflowTemplates, getAiWorkflowTemplate } from './workflow-templates'
import { listPrompts, getPromptEntry, getActivePromptVersion } from './prompts'
import { getWorkflow } from '@/lib/workflows/registry'

// Sprint 7.7 — AI Registry Integrity Validator.
//
// Read-model / diagnostics ONLY. Cross-checks every reference in the AI registry
// stack (plan → agent → skill → capability → template → workflow → prompt →
// prompt version) so a dangling or governance-violating link is caught as a
// visible ERROR or WARNING instead of silently drifting. Executes nothing and
// mutates nothing.

export interface RegistryIntegrityIssue {
  code: string
  from: string          // "kind:id" that owns the reference
  message: string
}

export interface RegistryIntegrityCounts {
  plans: number
  agents: number
  skills: number
  capabilities: number
  templates: number
  workflows: number
  prompts: number
  prompt_versions: number
}

export interface RegistryIntegrityReport {
  ok: boolean
  errors: RegistryIntegrityIssue[]
  warnings: RegistryIntegrityIssue[]
  counts: RegistryIntegrityCounts
  checked_at: string
}

function err(list: RegistryIntegrityIssue[], code: string, from: string, message: string): void {
  list.push({ code, from, message })
}

export function validateAiRegistry(): RegistryIntegrityReport {
  const errors: RegistryIntegrityIssue[] = []
  const warnings: RegistryIntegrityIssue[] = []

  const plans = listAiPlans()
  const agents = listAiAgents()
  const skills = listAiSkills()
  const capabilities = listAiCapabilities()
  const templates = listAiWorkflowTemplates()
  const workflows = listAiWorkflows()
  const prompts = listPrompts()
  const promptVersions = prompts.flatMap(p => p.versions)

  const isActive = (status: string) => status === 'active'

  // ── Prompts: each entry must resolve an active version ──
  for (const entry of prompts) {
    const active = getActivePromptVersion(entry.id)
    if (!active) {
      err(errors, 'prompt_active_version_missing', `prompt:${entry.id}`,
        `Prompt '${entry.id}' active_version ${entry.active_version} has no matching version.`)
    }
  }

  // ── Templates: an active template's default prompt (if named) must exist ──
  for (const t of templates) {
    if (t.default_prompt_id && !getPromptEntry(t.default_prompt_id)) {
      err(isActive(t.status) ? errors : warnings, 'template_prompt_missing', `template:${t.id}`,
        `Template '${t.id}' default_prompt_id '${t.default_prompt_id}' is not a registered prompt.`)
    }
    if (t.default_prompt_id === null && t.status === 'active') {
      err(errors, 'active_template_no_prompt', `template:${t.id}`,
        `Active template '${t.id}' has no default prompt.`)
    }
  }

  // ── Skills → capabilities / prompts / agents ──
  for (const sk of skills) {
    if (sk.default_capability_id && !getAiCapability(sk.default_capability_id)) {
      err(errors, 'skill_capability_missing', `skill:${sk.id}`,
        `Skill '${sk.id}' default_capability_id '${sk.default_capability_id}' does not exist.`)
    }
    if (sk.default_prompt_id) {
      if (!getPromptEntry(sk.default_prompt_id)) {
        err(errors, 'skill_prompt_missing', `skill:${sk.id}`,
          `Skill '${sk.id}' default_prompt_id '${sk.default_prompt_id}' is not a registered prompt.`)
      }
    } else if (isActive(sk.status)) {
      err(errors, 'active_skill_no_prompt', `skill:${sk.id}`,
        `Active skill '${sk.id}' has no default prompt.`)
    } else {
      warnings.push({ code: 'planned_skill_no_prompt', from: `skill:${sk.id}`,
        message: `Planned skill '${sk.id}' has no prompt yet.` })
    }
    for (const aId of sk.supported_agent_ids ?? []) {
      if (!getAiAgent(aId)) err(errors, 'skill_agent_missing', `skill:${sk.id}`, `Skill '${sk.id}' references unknown agent '${aId}'.`)
    }
  }

  // ── Capabilities → skills / prompts / templates / agents ──
  for (const c of capabilities) {
    if (c.default_skill_id && !getAiSkill(c.default_skill_id)) {
      err(errors, 'capability_skill_missing', `capability:${c.id}`,
        `Capability '${c.id}' default_skill_id '${c.default_skill_id}' does not exist.`)
    }
    if (c.default_template_id && !getAiWorkflowTemplate(c.default_template_id)) {
      err(errors, 'capability_template_missing', `capability:${c.id}`,
        `Capability '${c.id}' default_template_id '${c.default_template_id}' does not exist.`)
    }
    if (c.default_prompt_id) {
      if (!getPromptEntry(c.default_prompt_id)) {
        err(errors, 'capability_prompt_missing', `capability:${c.id}`,
          `Capability '${c.id}' default_prompt_id '${c.default_prompt_id}' is not a registered prompt.`)
      }
    } else if (isActive(c.status)) {
      err(errors, 'active_capability_no_prompt', `capability:${c.id}`,
        `Active capability '${c.id}' has no default prompt.`)
    } else {
      warnings.push({ code: 'planned_capability_no_prompt', from: `capability:${c.id}`,
        message: `Planned capability '${c.id}' has no prompt yet.` })
    }
    for (const aId of c.supported_agent_ids ?? []) {
      if (!getAiAgent(aId)) err(errors, 'capability_agent_missing', `capability:${c.id}`, `Capability '${c.id}' references unknown agent '${aId}'.`)
    }
    // Active capability should not depend on a planned/inactive skill.
    if (isActive(c.status) && c.default_skill_id) {
      const sk = getAiSkill(c.default_skill_id)
      if (sk && !isActive(sk.status)) {
        err(errors, 'active_capability_planned_skill', `capability:${c.id}`,
          `Active capability '${c.id}' depends on non-active skill '${sk.id}' (${sk.status}).`)
      }
    }
  }

  // ── Workflows → agent / capability / template / prompt / runtime workflow ──
  for (const w of workflows) {
    if (!getPromptEntry(w.prompt_id)) {
      err(errors, 'workflow_prompt_missing', `workflow:${w.id}`,
        `Workflow '${w.id}' prompt_id '${w.prompt_id}' is not a registered prompt.`)
    } else if (isActive(w.status) && !getActivePromptVersion(w.prompt_id)) {
      err(errors, 'active_workflow_no_prompt_version', `workflow:${w.id}`,
        `Active workflow '${w.id}' prompt '${w.prompt_id}' has no active version.`)
    }
    if (!getWorkflow(w.runtime_workflow_id)) {
      err(errors, 'workflow_runtime_missing', `workflow:${w.id}`,
        `Workflow '${w.id}' runtime_workflow_id '${w.runtime_workflow_id}' is not in the runtime registry.`)
    }
    if (w.capability_id && !getAiCapability(w.capability_id)) {
      err(errors, 'workflow_capability_missing', `workflow:${w.id}`,
        `Workflow '${w.id}' capability_id '${w.capability_id}' does not exist.`)
    }
    if (w.template_id && !getAiWorkflowTemplate(w.template_id)) {
      err(errors, 'workflow_template_missing', `workflow:${w.id}`,
        `Workflow '${w.id}' template_id '${w.template_id}' does not exist.`)
    }
    if (w.agent_id && !getAiAgent(w.agent_id)) {
      err(errors, 'workflow_agent_missing', `workflow:${w.id}`,
        `Workflow '${w.id}' agent_id '${w.agent_id}' does not exist.`)
    }
  }

  // ── Agents → skills / capabilities / workflows ──
  for (const a of agents) {
    for (const id of a.allowed_skill_ids) if (!getAiSkill(id)) err(errors, 'agent_skill_missing', `agent:${a.id}`, `Agent '${a.id}' references unknown skill '${id}'.`)
    for (const id of a.allowed_capability_ids) if (!getAiCapability(id)) err(errors, 'agent_capability_missing', `agent:${a.id}`, `Agent '${a.id}' references unknown capability '${id}'.`)
    for (const id of a.allowed_workflow_ids) if (!getAiWorkflow(id)) err(errors, 'agent_workflow_missing', `agent:${a.id}`, `Agent '${a.id}' references unknown workflow '${id}'.`)
    for (const id of a.default_prompt_ids) if (!getPromptEntry(id)) err(errors, 'agent_prompt_missing', `agent:${a.id}`, `Agent '${a.id}' references unknown prompt '${id}'.`)
    // Governance invariant: agents must remain non-executable this sprint.
    if (a.governance_policy.may_execute_workflows || a.governance_policy.may_mutate_governed_state || a.governance_policy.may_deliver_outputs) {
      err(errors, 'agent_governance_violation', `agent:${a.id}`, `Agent '${a.id}' has an execution-bearing governance flag set true.`)
    }
    // Active agent should reference at least one active workflow.
    if (isActive(a.status) && a.allowed_workflow_ids.length > 0) {
      const anyActive = a.allowed_workflow_ids.some(id => getAiWorkflow(id)?.status === 'active')
      if (!anyActive) err(errors, 'active_agent_no_active_workflow', `agent:${a.id}`, `Active agent '${a.id}' references no active workflow.`)
    }
  }

  // ── Plans → agents / skills / capabilities / workflows ──
  for (const p of plans) {
    for (const id of p.allowed_agent_ids) if (!getAiAgent(id)) err(errors, 'plan_agent_missing', `plan:${p.id}`, `Plan '${p.id}' references unknown agent '${id}'.`)
    for (const id of p.allowed_skill_ids) if (!getAiSkill(id)) err(errors, 'plan_skill_missing', `plan:${p.id}`, `Plan '${p.id}' references unknown skill '${id}'.`)
    for (const id of p.allowed_capability_ids) if (!getAiCapability(id)) err(errors, 'plan_capability_missing', `plan:${p.id}`, `Plan '${p.id}' references unknown capability '${id}'.`)
    for (const id of p.allowed_workflow_ids) if (!getAiWorkflow(id)) err(errors, 'plan_workflow_missing', `plan:${p.id}`, `Plan '${p.id}' references unknown workflow '${id}'.`)

    // Per-step reference checks.
    for (const step of p.steps) {
      if (step.agent_id && !getAiAgent(step.agent_id)) err(errors, 'plan_step_agent_missing', `plan:${p.id}:${step.step_id}`, `Plan step '${step.step_id}' references unknown agent '${step.agent_id}'.`)
      if (step.skill_id && !getAiSkill(step.skill_id)) err(errors, 'plan_step_skill_missing', `plan:${p.id}:${step.step_id}`, `Plan step '${step.step_id}' references unknown skill '${step.skill_id}'.`)
      if (step.capability_id && !getAiCapability(step.capability_id)) err(errors, 'plan_step_capability_missing', `plan:${p.id}:${step.step_id}`, `Plan step '${step.step_id}' references unknown capability '${step.capability_id}'.`)
      if (step.workflow_id && !getAiWorkflow(step.workflow_id)) err(errors, 'plan_step_workflow_missing', `plan:${p.id}:${step.step_id}`, `Plan step '${step.step_id}' references unknown workflow '${step.workflow_id}'.`)
    }

    // Governance: an active plan MUST contain a human-review / approval checkpoint.
    if (isActive(p.status)) {
      const hasGate = p.steps.some(st => st.kind === 'approval_checkpoint' || st.kind === 'human_review')
      if (!hasGate) {
        err(errors, 'active_plan_no_human_review', `plan:${p.id}`,
          `Active plan '${p.id}' has no human-review / approval checkpoint step.`)
      }
    }
    // Governance invariant: plans must remain non-executable this sprint.
    if (p.governance_policy.may_execute_workflows || p.governance_policy.may_mutate_governed_state || p.governance_policy.may_deliver_outputs) {
      err(errors, 'plan_governance_violation', `plan:${p.id}`, `Plan '${p.id}' has an execution-bearing governance flag set true.`)
    }
    // Active plan should not depend on a planned/inactive workflow.
    if (isActive(p.status)) {
      for (const id of p.allowed_workflow_ids) {
        const w = getAiWorkflow(id)
        if (w && !isActive(w.status)) {
          err(errors, 'active_plan_planned_workflow', `plan:${p.id}`,
            `Active plan '${p.id}' depends on non-active workflow '${id}' (${w.status}).`)
        }
      }
    }
  }

  const counts: RegistryIntegrityCounts = {
    plans: plans.length,
    agents: agents.length,
    skills: skills.length,
    capabilities: capabilities.length,
    templates: templates.length,
    workflows: workflows.length,
    prompts: prompts.length,
    prompt_versions: promptVersions.length,
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    counts,
    checked_at: new Date().toISOString(),
  }
}
