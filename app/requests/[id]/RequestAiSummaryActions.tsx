'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiPost, ApiClientError } from '@/lib/api-client'

type TriggerResult = {
  triggered: boolean; deduped: boolean
  workflow_id: string | null; background_job_id: string | null; workflow_run_id: string | null
  reason: string
}
type Feedback = { kind: 'ok'; result: TriggerResult } | { kind: 'err'; message: string }

// Sprint 6.4 — "Summarize with AI" action. Reuses POST /api/requests/:id/summarize,
// which enqueues the existing request_ai_summary workflow (worker executes it).
export default function RequestAiSummaryActions({
  requestId,
  allowed,
  hasActiveAiSummary,
}: {
  requestId: string
  allowed: boolean
  hasActiveAiSummary: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  if (!allowed) {
    return <div style={s.note}>Your role cannot start an AI summary.</div>
  }

  async function summarize() {
    setBusy(true)
    setFeedback(null)
    try {
      const result = await apiPost<TriggerResult>(`/api/requests/${requestId}/summarize`, {})
      setFeedback({ kind: 'ok', result })
      router.refresh()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setFeedback({ kind: 'err', message: err instanceof ApiClientError ? err.message : 'Failed to start AI summary' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button type="button" onClick={summarize} disabled={busy || hasActiveAiSummary}
        style={{ ...s.btn, opacity: busy || hasActiveAiSummary ? 0.5 : 1 }}>
        {busy ? 'Starting…' : 'Summarize with AI'}
      </button>
      {hasActiveAiSummary && <span style={s.inline}>AI summary already running.</span>}

      {feedback?.kind === 'err' && <div style={s.err}>{feedback.message}</div>}
      {feedback?.kind === 'ok' && (
        <div style={feedback.result.deduped ? s.info : s.ok}>
          <span>
            {feedback.result.triggered ? 'AI summary enqueued.'
              : feedback.result.deduped ? 'AI summary already running — reused it.'
              : `Not started: ${feedback.result.reason}`}
          </span>
          {feedback.result.workflow_run_id && (
            <Link href={`/workflow-runs/${feedback.result.workflow_run_id}`} style={s.link}>view run</Link>
          )}
          {!feedback.result.workflow_run_id && feedback.result.background_job_id && (
            <Link href="/background-jobs" style={s.link}>view job</Link>
          )}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  note:   { fontSize: 13, color: '#6b7280' },
  btn:    { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 13, fontWeight: 700, fontFamily: 'monospace', cursor: 'pointer' },
  inline: { marginLeft: 10, fontSize: 12, color: '#6b7280' },
  err:    { marginTop: 10, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#dc2626' },
  ok:     { marginTop: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#15803d', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  info:   { marginTop: 10, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#1d4ed8', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  link:   { color: '#2563eb', textDecoration: 'none', fontWeight: 700 },
}
