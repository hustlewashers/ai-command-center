'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiPost, ApiClientError } from '@/lib/api-client'
import type { WorkPacketAiSummaryReadiness } from '@/lib/workflows/readiness/work-packet-summary'

type TriggerResult = {
  triggered: boolean
  deduped: boolean
  workflow_id: string | null
  background_job_id: string | null
  workflow_run_id: string | null
  reason: string
  readiness: WorkPacketAiSummaryReadiness
}
type Feedback = { kind: 'ok'; result: TriggerResult } | { kind: 'err'; message: string }

function buttonLabel(readiness: WorkPacketAiSummaryReadiness): string {
  if (readiness.can_trigger) return 'Summarize with AI'
  if (readiness.status === 'active') return 'AI summary already running'
  if (readiness.status === 'failed') return 'Recover AI summary'
  if (readiness.status === 'completed') return 'AI summary already exists'
  return 'AI summary not ready'
}

// Sprint 7.9 — "Summarize with AI" action for a work packet. Mirrors
// RequestAiSummaryActions; readiness is computed server-side and shared with the
// API so the button cannot start known-doomed runs.
export default function WorkPacketAiSummaryActions({
  workPacketId,
  readiness,
}: {
  workPacketId: string
  readiness: WorkPacketAiSummaryReadiness
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  async function summarize() {
    setBusy(true)
    setFeedback(null)
    try {
      const result = await apiPost<TriggerResult>(`/api/work-packets/${workPacketId}/summarize`, {})
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
      <button type="button" onClick={summarize} disabled={busy || !readiness.can_trigger}
        style={{ ...s.btn, opacity: busy || !readiness.can_trigger ? 0.5 : 1 }}>
        {busy ? 'Starting...' : buttonLabel(readiness)}
      </button>
      <span style={s.inline}>{readiness.reason}</span>
      {readiness.recovery_run_id && (
        <Link href={`/workflow-runs/${readiness.recovery_run_id}`} style={s.actionLink}>recovery</Link>
      )}

      {feedback?.kind === 'err' && <div style={s.err}>{feedback.message}</div>}
      {feedback?.kind === 'ok' && (
        <div style={feedback.result.deduped || !feedback.result.triggered ? s.info : s.ok}>
          <span>
            {feedback.result.triggered ? 'AI summary enqueued.'
              : feedback.result.deduped ? 'AI summary already running; reused it.'
              : `Not started: ${feedback.result.reason}`}
          </span>
          {feedback.result.workflow_run_id && (
            <Link href={`/workflow-runs/${feedback.result.workflow_run_id}`} style={s.link}>view run</Link>
          )}
          {!feedback.result.workflow_run_id && feedback.result.background_job_id && (
            <Link href="/background-jobs" style={s.link}>view job</Link>
          )}
          {feedback.result.readiness.draft_output_id && (
            <Link href={`/outputs/${feedback.result.readiness.draft_output_id}`} style={s.link}>draft</Link>
          )}
          {feedback.result.readiness.approval_id && (
            <Link href={`/approvals/${feedback.result.readiness.approval_id}`} style={s.link}>approval</Link>
          )}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  btn:    { background: '#7c3aed', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 13, fontWeight: 700, fontFamily: 'monospace', cursor: 'pointer' },
  inline: { marginLeft: 10, fontSize: 12, color: '#6b7280' },
  actionLink: { marginLeft: 10, fontSize: 12, color: '#2563eb', textDecoration: 'none', fontWeight: 700 },
  err:    { marginTop: 10, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#dc2626' },
  ok:     { marginTop: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#15803d', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  info:   { marginTop: 10, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#1d4ed8', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  link:   { color: '#2563eb', textDecoration: 'none', fontWeight: 700 },
}
