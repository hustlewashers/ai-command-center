import type { AiProviderConfig } from '@/types/ai'

// Sprint 8.0 — AI provider configuration (server-only).
//
// Resolves provider settings from environment variables each call. Read ONLY on
// the server (same discipline as the API key). Nothing here is a secret except
// the key, which is never returned by these helpers.
//
// Env:
//   OPENAI_API_KEY         — the provider key (presence toggles live vs mock).
//   OPENAI_MODEL           — optional model override; falls back to the prompt's model.
//   OPENAI_TIMEOUT_MS      — per-attempt timeout (default 30000).
//   OPENAI_MAX_RETRIES     — retries for transient failures (default 2).
//   AI_PROVIDER_MODE       — 'live' | 'mock'; default live if a key exists, else mock.
//   AI_ALLOW_MOCK_FALLBACK — 'true' | 'false'; default true in dev, false in prod.

const DEFAULT_TIMEOUT_MS = 30000
const DEFAULT_MAX_RETRIES = 2

function hasKey(): boolean {
  const k = process.env.OPENAI_API_KEY
  return !!(k && k.trim().length > 0)
}

function parseIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function parseBoolEnv(name: string): boolean | null {
  const raw = process.env[name]
  if (raw === undefined) return null
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return null
}

export function getProviderConfig(): AiProviderConfig {
  const keyPresent = hasKey()
  const isProd = process.env.NODE_ENV === 'production'

  // Configured default mode: explicit AI_PROVIDER_MODE wins, else live-if-key.
  const modeEnv = (process.env.AI_PROVIDER_MODE ?? '').trim().toLowerCase()
  const mode: 'live' | 'mock' =
    modeEnv === 'live' ? 'live'
    : modeEnv === 'mock' ? 'mock'
    : keyPresent ? 'live' : 'mock'

  // Fallback allowance: explicit env wins, else dev=true / prod=false.
  const allowEnv = parseBoolEnv('AI_ALLOW_MOCK_FALLBACK')
  const allow_mock_fallback = allowEnv !== null ? allowEnv : !isProd

  const modelOverride = process.env.OPENAI_MODEL?.trim()

  return {
    provider_id: 'openai',
    mode,
    has_key: keyPresent,
    model_override: modelOverride && modelOverride.length > 0 ? modelOverride : null,
    timeout_ms: parseIntEnv('OPENAI_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1000, 300000),
    max_retries: parseIntEnv('OPENAI_MAX_RETRIES', DEFAULT_MAX_RETRIES, 0, 6),
    allow_mock_fallback,
  }
}
