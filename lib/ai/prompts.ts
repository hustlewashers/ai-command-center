import type {
  AiPromptDefinition,
  AiPromptId,
  AiPromptRegistryEntry,
  AiPromptVersionDefinition,
} from '@/types/ai'

// In-code prompt registry (Sprint 6.1 → versioned in Sprint 7.2).
// Mirrors lib/workflows/registry.ts. No DB-backed prompts yet.
//
// A prompt id (e.g. 'REQUEST_SUMMARIZER') is a STABLE ALIAS; its behavior is
// pinned to a specific VERSION. `active_version` is the version call_ai uses.
// A version is NEVER edited in place once shipped — add a new version and move
// `active_version`, marking the old one `deprecated` (see
// docs/sprint-7-2-prompt-versioning.md).

const REGISTRY: Record<AiPromptId, AiPromptRegistryEntry> = {
  REQUEST_SUMMARIZER: {
    id: 'REQUEST_SUMMARIZER',
    active_version: 1,
    versions: [
      {
        id:         'REQUEST_SUMMARIZER',
        prompt_id:  'REQUEST_SUMMARIZER',
        version:    1,
        version_id: 'REQUEST_SUMMARIZER@v1',
        status:     'active',
        released_at: '2026-06-01',
        change_note: 'Initial version: structured DRAFT request summary for human review.',
        purpose: 'Summarize an incoming request into a structured DRAFT output for human review.',
        model:   'gpt-5.5',
        low:     true,
        system_prompt: [
          'You are a careful operations assistant inside a governed workflow runtime.',
          'You produce DRAFT content only. You never approve, reject, deliver, or finalize anything.',
          'You never take or recommend irreversible actions; a human reviews everything you produce.',
          'Summarize the provided request faithfully. Do not invent facts not present in the input.',
          '',
          'Return ONLY a single JSON object — no prose, no markdown, no code fences — with EXACTLY these fields:',
          '{',
          '  "title": string,                       // short title for the draft summary',
          '  "summary": string,                     // concise plain-text summary of the request',
          '  "recommended_next_steps": string[],    // 1-5 suggested follow-up actions (suggestions only)',
          '  "risk_level": "low" | "medium" | "high",',
          '  "confidence": number                   // 0..1, your confidence in this summary',
          '}',
        ].join('\n'),
        output_schema: {
          title:                  { type: 'string',  required: true,  max_len: 200 },
          summary:                { type: 'string',  required: true,  max_len: 4000 },
          recommended_next_steps: { type: 'string[]', required: true },
          risk_level:             { type: 'enum',    required: true, enum: ['low', 'medium', 'high'] },
          confidence:             { type: 'number',  required: true },
        },
      },
    ],
  },

  WORK_PACKET_SUMMARIZER: {
    id: 'WORK_PACKET_SUMMARIZER',
    active_version: 1,
    versions: [
      {
        id:         'WORK_PACKET_SUMMARIZER',
        prompt_id:  'WORK_PACKET_SUMMARIZER',
        version:    1,
        version_id: 'WORK_PACKET_SUMMARIZER@v1',
        status:     'active',
        released_at: '2026-07-02',
        change_note: 'Initial version: structured DRAFT work-packet summary for human review.',
        purpose: 'Summarize a governed work packet into a structured DRAFT output for human review.',
        model:   'gpt-5.5',
        low:     true,
        system_prompt: [
          'You are a careful operations assistant inside a governed workflow runtime.',
          'You produce DRAFT content only. You never approve, reject, deliver, or finalize anything.',
          'You never take or recommend irreversible actions; a human reviews everything you produce.',
          'Summarize the provided work packet faithfully using its title, objective, and scope if present.',
          'Do not invent facts not present in the input. Include practical, concrete next steps.',
          '',
          'Return ONLY a single JSON object — no prose, no markdown, no code fences — with EXACTLY these fields:',
          '{',
          '  "title": string,                       // short title for the draft summary',
          '  "summary": string,                     // concise plain-text summary of the work packet',
          '  "recommended_next_steps": string[],    // 1-5 practical follow-up actions (suggestions only)',
          '  "risk_level": "low" | "medium" | "high",',
          '  "confidence": number                   // 0..1, your confidence in this summary',
          '}',
        ].join('\n'),
        output_schema: {
          title:                  { type: 'string',  required: true,  max_len: 200 },
          summary:                { type: 'string',  required: true,  max_len: 4000 },
          recommended_next_steps: { type: 'string[]', required: true },
          risk_level:             { type: 'enum',    required: true, enum: ['low', 'medium', 'high'] },
          confidence:             { type: 'number',  required: true },
        },
      },
    ],
  },
}

// ── Registry accessors ──

// All prompt registry entries (alias + active version + versions).
export function listPrompts(): AiPromptRegistryEntry[] {
  return Object.values(REGISTRY)
}

// The registry entry for a prompt id.
export function getPromptEntry(id: string): AiPromptRegistryEntry | undefined {
  return REGISTRY[id as AiPromptId]
}

// Every version across every prompt (flat), for listing/audit.
export function listPromptVersions(): AiPromptVersionDefinition[] {
  return Object.values(REGISTRY).flatMap(e => e.versions)
}

// A specific version. Omit `version` to get the active version.
export function getPromptVersion(id: string, version?: number): AiPromptVersionDefinition | undefined {
  const entry = REGISTRY[id as AiPromptId]
  if (!entry) return undefined
  const target = version ?? entry.active_version
  return entry.versions.find(v => v.version === target)
}

// The active version of a prompt.
export function getActivePromptVersion(id: string): AiPromptVersionDefinition | undefined {
  const entry = REGISTRY[id as AiPromptId]
  if (!entry) return undefined
  return entry.versions.find(v => v.version === entry.active_version)
}

// Compatibility wrapper (Sprint 6.1 signature): returns the EXECUTABLE active
// prompt definition. AiPromptVersionDefinition is a superset of
// AiPromptDefinition, so existing callers (router, provider, validator) are
// unchanged. Returning the version definition also exposes version_id/status to
// callers that want provenance.
export function getPrompt(id: AiPromptId): AiPromptDefinition | undefined {
  return getActivePromptVersion(id)
}
