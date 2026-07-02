import { listAiPlans } from './plans'
import { listAiAgents } from './agents'
import { listAiSkills } from './skills'
import { listAiCapabilities } from './capabilities'
import { listAiWorkflows } from './workflows'
import { listAiWorkflowTemplates } from './workflow-templates'
import { listPrompts, getActivePromptVersion } from './prompts'

// Sprint 7.7 — AI Registry Graph Read Model.
//
// A serializable node/edge graph of the AI registry stack for visual traceability
// (plan → agent → skill → capability → template → workflow → prompt →
// prompt version). Read-model / diagnostics ONLY — no execution, no external graph
// library. The UI renders it as simple text/tables.

export type RegistryNodeKind =
  | 'plan' | 'agent' | 'skill' | 'capability'
  | 'template' | 'workflow' | 'prompt' | 'prompt_version'

export interface RegistryGraphNode {
  id: string          // namespaced, e.g. 'plan:request_summary_review_plan'
  label: string       // the bare registry id
  kind: RegistryNodeKind
  status: string
}

export interface RegistryGraphEdge {
  from: string        // node id
  to: string          // node id
  label: string       // relationship, e.g. 'composes', 'realizes', 'uses'
}

export interface RegistryGraph {
  nodes: RegistryGraphNode[]
  edges: RegistryGraphEdge[]
}

const nid = (kind: RegistryNodeKind, id: string) => `${kind}:${id}`

export function buildAiRegistryGraph(): RegistryGraph {
  const nodes: RegistryGraphNode[] = []
  const edges: RegistryGraphEdge[] = []
  const seen = new Set<string>()

  function addNode(kind: RegistryNodeKind, id: string, status: string): string {
    const nodeId = nid(kind, id)
    if (!seen.has(nodeId)) {
      seen.add(nodeId)
      nodes.push({ id: nodeId, label: id, kind, status })
    }
    return nodeId
  }
  function addEdge(from: string, to: string, label: string): void {
    edges.push({ from, to, label })
  }

  // Register every node first so isolated items still appear.
  for (const p of listAiPlans()) addNode('plan', p.id, p.status)
  for (const a of listAiAgents()) addNode('agent', a.id, a.status)
  for (const sk of listAiSkills()) addNode('skill', sk.id, sk.status)
  for (const c of listAiCapabilities()) addNode('capability', c.id, c.status)
  for (const t of listAiWorkflowTemplates()) addNode('template', t.id, t.status)
  for (const w of listAiWorkflows()) addNode('workflow', w.id, w.status)
  for (const entry of listPrompts()) {
    addNode('prompt', entry.id, getActivePromptVersion(entry.id)?.status ?? 'unknown')
    for (const v of entry.versions) addNode('prompt_version', v.version_id, v.status)
  }

  // Edges, top-down through the stack.
  for (const p of listAiPlans()) {
    const from = nid('plan', p.id)
    for (const id of p.allowed_agent_ids) addEdge(from, nid('agent', id), 'composes')
    // Fall back to skill/workflow edges when a plan names no agents.
    if (p.allowed_agent_ids.length === 0) {
      for (const id of p.allowed_skill_ids) addEdge(from, nid('skill', id), 'uses')
      for (const id of p.allowed_workflow_ids) addEdge(from, nid('workflow', id), 'uses')
    }
  }
  for (const a of listAiAgents()) {
    const from = nid('agent', a.id)
    for (const id of a.allowed_skill_ids) addEdge(from, nid('skill', id), 'composes')
    for (const id of a.allowed_capability_ids) addEdge(from, nid('capability', id), 'uses')
    for (const id of a.allowed_workflow_ids) addEdge(from, nid('workflow', id), 'invokes')
  }
  for (const sk of listAiSkills()) {
    const from = nid('skill', sk.id)
    if (sk.default_capability_id) addEdge(from, nid('capability', sk.default_capability_id), 'serves')
  }
  for (const c of listAiCapabilities()) {
    const from = nid('capability', c.id)
    if (c.default_template_id) addEdge(from, nid('template', c.default_template_id), 'instantiates')
    if (c.default_prompt_id) addEdge(from, nid('prompt', c.default_prompt_id), 'uses')
  }
  for (const w of listAiWorkflows()) {
    const from = nid('workflow', w.id)
    if (w.capability_id) addEdge(nid('capability', w.capability_id), from, 'realized_by')
    if (w.template_id) addEdge(from, nid('template', w.template_id), 'follows')
    addEdge(from, nid('prompt', w.prompt_id), 'runs')
  }
  for (const entry of listPrompts()) {
    const active = getActivePromptVersion(entry.id)
    if (active) addEdge(nid('prompt', entry.id), nid('prompt_version', active.version_id), 'active_version')
  }

  return { nodes, edges }
}

// The canonical active chain, top→bottom, for the stack-map display. Each entry
// is a resolved node (or null if a link is broken — surfaced by the integrity
// validator). This is intentionally the single "golden path" through the stack.
export interface RegistryStackRow {
  kind: RegistryNodeKind
  id: string | null
  status: string | null
}

export function activeRequestSummaryChain(): RegistryStackRow[] {
  const plan = listAiPlans().find(p => p.id === 'request_summary_review_plan') ?? null
  const agent = listAiAgents().find(a => a.id === 'request_summary_assistant') ?? null
  const skill = listAiSkills().find(s => s.id === 'summarize_request') ?? null
  const capability = listAiCapabilities().find(c => c.id === 'request_summarization') ?? null
  const template = listAiWorkflowTemplates().find(t => t.id === 'ai_draft_output_from_entity') ?? null
  const workflow = listAiWorkflows().find(w => w.id === 'request_ai_summary') ?? null
  const promptVersion = getActivePromptVersion('REQUEST_SUMMARIZER') ?? null

  return [
    { kind: 'plan',           id: plan?.id ?? null,            status: plan?.status ?? null },
    { kind: 'agent',          id: agent?.id ?? null,           status: agent?.status ?? null },
    { kind: 'skill',          id: skill?.id ?? null,           status: skill?.status ?? null },
    { kind: 'capability',     id: capability?.id ?? null,      status: capability?.status ?? null },
    { kind: 'template',       id: template?.id ?? null,        status: template?.status ?? null },
    { kind: 'workflow',       id: workflow?.id ?? null,        status: workflow?.status ?? null },
    { kind: 'prompt',         id: 'REQUEST_SUMMARIZER',        status: promptVersion ? 'active' : null },
    { kind: 'prompt_version', id: promptVersion?.version_id ?? null, status: promptVersion?.status ?? null },
  ]
}
