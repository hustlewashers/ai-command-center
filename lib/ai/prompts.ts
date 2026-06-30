import type { AiPromptDefinition, AiPromptId } from '@/types/ai'

// In-code prompt registry (Sprint 6.1). Mirrors lib/workflows/registry.ts.
// No DB-backed prompts yet. Prompts are versioned by their `version` field and
// are never edited in place once referenced by a shipped workflow.

const PROMPTS: Record<AiPromptId, AiPromptDefinition> = {
  REQUEST_SUMMARIZER: {
    id:      'REQUEST_SUMMARIZER',
    version: 1,
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
}

export function getPrompt(id: AiPromptId): AiPromptDefinition | undefined {
  return PROMPTS[id]
}

export function listPrompts(): AiPromptDefinition[] {
  return Object.values(PROMPTS)
}
