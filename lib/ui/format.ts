// Shared formatting helpers for detail pages (Sprint 5.15).
// Pure functions, no dependencies. Safe in Server and Client Components.
//
// These centralize the small formatters that every detail page had been
// re-declaring (fmt / durationStr / short / jsonPreview), so behavior stays
// identical across pages and lives in one place.

// Compact local datetime, e.g. "Jun 29, 02:18 PM". Null/empty → em dash.
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// Format a millisecond span as ms / s / m. Null → em dash.
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

// Duration between two ISO timestamps. Either missing → em dash.
export function formatDuration(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string {
  if (!startedAt || !endedAt) return '—'
  return formatMs(new Date(endedAt).getTime() - new Date(startedAt).getTime())
}

// Truncated UUID, e.g. "dcd5469c…". Null → em dash.
export function shortId(uuid: string | null | undefined, len = 8): string {
  return uuid ? uuid.slice(0, len) + '…' : '—'
}

// Coalesce to string and optionally truncate. Never throws on null.
export function safeText(value: string | null | undefined, max?: number): string {
  const s = value ?? ''
  return max !== undefined && s.length > max ? s.slice(0, max) : s
}

// Pretty-print JSON with a length cap. Null/undefined → empty string.
export function jsonPreview(value: unknown, max = 600): string {
  if (value === null || value === undefined) return ''
  let str: string
  try {
    str = JSON.stringify(value, null, 2)
  } catch {
    str = String(value)
  }
  if (str === undefined) return ''
  return str.length > max ? str.slice(0, max) + '\n…' : str
}
