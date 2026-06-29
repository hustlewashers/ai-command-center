'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type {
  WorkflowRecoveryAction,
  WorkflowRecoveryEligibility,
  WorkflowRecoveryResult,
} from '@/types/workflow-recovery'

type Feedback =
  | { kind: 'success'; result: WorkflowRecoveryResult }
  | { kind: 'error'; message: string }

const BUTTONS: { action: WorkflowRecoveryAction; label: string; flag: keyof WorkflowRecoveryEligibility; color: string; confirm?: string }[] = [
  { action: 'retry',   label: 'Retry',   flag: 'can_retry',   color: '#2563eb' },
  { action: 'resume',  label: 'Resume',  flag: 'can_resume',  color: '#16a34a' },
  { action: 'restart', label: 'Restart', flag: 'can_restart', color: '#7c3aed', confirm: 'Restart re-runs the workflow from step 0 and may create duplicate records. Continue?' },
  { action: 'cancel',  label: 'Cancel',  flag: 'can_cancel',  color: '#dc2626', confirm: 'Cancel this workflow run?' },
]

export default function WorkflowRecoveryActions({
  runId,
  eligibility,
  canRecover,
}: {
  runId: string
  eligibility: WorkflowRecoveryEligibility
  canRecover: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<WorkflowRecoveryAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const available = BUTTONS.filter(b => eligibility[b.flag])

  if (!canRecover) {
    return (
      <div style={s.wrap}>
        <span style={s.note}>Your role cannot perform recovery actions.</span>
      </div>
    )
  }

  if (available.length === 0 && !feedback) {
    return (
      <div style={s.wrap}>
        <span style={s.note}>No recovery actions available for this run state.</span>
      </div>
    )
  }

  async function perform(action: WorkflowRecoveryAction, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setBusy(action)
    setFeedback(null)
    try {
      const res = await fetch(`/api/workflow-runs/${runId}/recovery`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ action }),
      })
      const json = await res.json()
      if (!res.ok) {
        setFeedback({ kind: 'error', message: json?.error?.message ?? `Request failed (${res.status})` })
      } else {
        setFeedback({ kind: 'success', result: json.data as WorkflowRecoveryResult })
        // Reflect new run state (e.g. cancelled, or parent → resuming).
        router.refresh()
      }
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.row}>
        <span style={s.title}>Recovery</span>
        {available.map(b => (
          <button
            key={b.action}
            type="button"
            disabled={busy !== null}
            onClick={() => perform(b.action, b.confirm)}
            style={{ ...s.btn, background: b.color, opacity: busy && busy !== b.action ? 0.5 : 1 }}
          >
            {busy === b.action ? '…' : b.label}
          </button>
        ))}
      </div>

      {feedback?.kind === 'error' && (
        <div style={s.errBox}>{feedback.message}</div>
      )}

      {feedback?.kind === 'success' && (
        <div style={s.okBox}>
          <span>{feedback.result.message}</span>
          {feedback.result.new_job_id && (
            <Link href="/background-jobs" style={s.okLink}>
              View job {feedback.result.new_job_id.slice(0, 8)}…
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap:   { margin: '4px 0 20px', fontFamily: 'monospace' },
  row:    { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  title:  { fontSize: 13, fontWeight: 700, color: '#374151' },
  btn:    { color: '#fff', border: 'none', borderRadius: 4, padding: '5px 14px', fontSize: 12, fontWeight: 700, fontFamily: 'monospace', cursor: 'pointer' },
  note:   { fontSize: 12, color: '#9ca3af' },
  errBox: { marginTop: 10, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#dc2626' },
  okBox:  { marginTop: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#15803d', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  okLink: { color: '#2563eb', textDecoration: 'none', fontWeight: 700 },
}
