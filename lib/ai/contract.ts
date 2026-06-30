import type { AiPromptDefinition, AiValidationResult } from '@/types/ai'

// Structured-output validation (Sprint 6.1). No external libraries.
// Parses provider text as JSON and checks it against the prompt's output_schema:
// required fields present, primitive types correct, enums valid, max_len enforced,
// string[] is an array of strings, number is a finite number. Unknown fields are
// dropped (not errored). Returns a structured result; the caller fails the step
// on `ok === false`.

export function validateAiOutput(
  prompt: AiPromptDefinition,
  value: unknown,
): AiValidationResult {
  const errors: string[] = []

  // 1. Parse to an object.
  let obj: Record<string, unknown>
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value) as Record<string, unknown>
    } catch {
      return { ok: false, value: null, errors: ['output is not valid JSON'] }
    }
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    obj = value as Record<string, unknown>
  } else {
    return { ok: false, value: null, errors: ['output is not a JSON object'] }
  }

  // 2. Validate each declared field; build a clean object with only schema fields.
  const clean: Record<string, unknown> = {}

  for (const [field, schema] of Object.entries(prompt.output_schema)) {
    const present = Object.prototype.hasOwnProperty.call(obj, field) && obj[field] !== null && obj[field] !== undefined
    if (!present) {
      if (schema.required) errors.push(`missing required field '${field}'`)
      continue
    }
    const v = obj[field]

    switch (schema.type) {
      case 'string': {
        if (typeof v !== 'string') { errors.push(`field '${field}' must be a string`); break }
        clean[field] = schema.max_len !== undefined && v.length > schema.max_len ? v.slice(0, schema.max_len) : v
        break
      }
      case 'number': {
        if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`field '${field}' must be a finite number`); break }
        clean[field] = v
        break
      }
      case 'boolean': {
        if (typeof v !== 'boolean') { errors.push(`field '${field}' must be a boolean`); break }
        clean[field] = v
        break
      }
      case 'string[]': {
        if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
          errors.push(`field '${field}' must be an array of strings`); break
        }
        clean[field] = v
        break
      }
      case 'enum': {
        if (typeof v !== 'string' || !(schema.enum ?? []).includes(v)) {
          errors.push(`field '${field}' must be one of: ${(schema.enum ?? []).join(', ')}`); break
        }
        clean[field] = v
        break
      }
    }
  }

  if (errors.length > 0) return { ok: false, value: null, errors }
  return { ok: true, value: clean, errors: [] }
}
