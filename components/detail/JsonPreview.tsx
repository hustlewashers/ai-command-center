import { jsonPreview } from '@/lib/ui/format'
import { ds } from './styles'

// Pretty-printed, length-capped JSON with a safe null/undefined fallback.
// Use for content previews, payloads, accumulated dicts, etc.
export function JsonPreview({
  value, max = 600, emptyLabel = '—',
}: {
  value: unknown
  max?: number
  emptyLabel?: string
}) {
  const str = jsonPreview(value, max)
  if (!str) return <span style={ds.empty}>{emptyLabel}</span>
  return <pre style={ds.pre}>{str}</pre>
}
