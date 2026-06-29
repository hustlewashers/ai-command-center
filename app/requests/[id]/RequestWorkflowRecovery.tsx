'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type {
  WorkflowRecoveryAction,
  WorkflowRecoveryEligibility,
  WorkflowRecoveryResult,
} from '@/types/workflow-recovery'

// Reuses the EXISTING recovery API (POST /api/workflow-runs/:id/recovery) and the
// eligibility flags computed by the recovery engine — no rules duplicated here.

type Feedback =
  | { kind: 'success'; result: WorkflowRecoveryResult }
  | { kind: 'error'; message: string }

const BUTTONS: {
  action: WorkflowRecoveryAction
  label: string
  flag: keyof WorkflowRecoveryEligibility
  color: string
  confirm?: string
}[] = [
  { action: 'retry',   label: 'Retry',   flag: 'can_retry',   color: '#2563eb' },
  { action: 'resume',  label: 'Resume',  flag: 'can_resume',  color: '#16a34a' },
  { action: 'restart', label: 'Restart', flag: 'can_restart', color: '#7c3aed',
    confirm: 'Restart re-runs the workflow from step 0 with a fresh attempt counter. This may create duplicate records. Continue?' },
  { action: 'cancel',  label: 'Cancel',  flag: 'can_cancel',  color: '#dc2626',
    confirm: 'Cancel this workflow run? It will stop in its current state.' },
]

export default function RequestWorkflowRecovery({
  runId,
  eligibility,
  canRecover,
  recommendedAction,
}: {
  runId: string | null
  eligibility: WorkflowRecoveryEligibility | null
  canRecover: boolean
  recommendedAction: WorkflowRecoveryAction | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<WorkflowRecoveryAction | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [confirming, setConfirming] = useState<{ action: WorkflowRecoveryAction; message: string } | null>(null)

  if (!runId || !eligibility) {
    return <div style={s.note}>No workflow run to recover yet.</div>
  }
  if (!canRecover) {
    return <div style={s.note}>Your role cannot perform recovery actions.</div>
  }

  const available = BUTTONS.filter(b => eligibility[b.flag])
  if (available.length === 0) {
    return <div style={s.note}>No recovery actions available for this run state.</div>
  }

  async function perform(action: WorkflowRecoveryAction) {
    setConfirming(null)
    setBusy(action)
    setFeedback(null)
    try {
      const res = await fetch(`/api/workflow-runs/${runId}/recovery`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const json = await res.json()
      if (!res.ok) {
        setFeedback({ kind: 'error', message: json?.error?.message ?? `Request failed (${res.status})` })
      } else {
        setFeedback({ kind: 'success', result: json.data as WorkflowRecoveryResult })
        router.refresh()
      }
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setBusy(null)
    }
  }

  function onClick(b: (typeof BUTTONS)[number]) {
    if (b.confirm) setConfirming({ action: b.action, message: b.confirm })
    else perform(b.action)
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
            onClick={() => onClick(b)}
            style={{
              ...s.btn, background: b.color,
              opacity: busy && busy !== b.action ? 0.5 : 1,
              outline: recommendedAction === b.action ? '2px solid #111' : 'none',
            }}
            title={recommendedAction === b.action ? 'Recommended' : undefined}
          >
            {busy === b.action ? '…' : b.label}
          </button>
        ))}
        {recommendedAction && (
          <span style={s.recommend}>recommended: {recommendedAction}</span>
        )}
      </div>

      {feedback?.kind === 'error' && <div style={s.errBox}>{feedback.message}</div>}
      {feedback?.kind === 'success' && (
        <div style={s.okBox}>
          <span>{feedback.result.message}</span>
          {feedback.result.new_run_id && (
            <Link href={`/workflow-runs/${feedback.result.new_run_id}`} style={s.okLink}>view new run</Link>
          )}
          {!feedback.result.new_run_id && feedback.result.new_job_id && (
            <Link href="/background-jobs" style={s.okLink}>view job {feedback.result.new_job_id.slice(0, 8)}…</Link>
          )}
        </div>
      )}

      {/* Confirmation modal for Restart / Cancel */}
      {confirming && (
        <div style={s.overlay} role="dialog" aria-modal="true">
          <div style={s.modal}>
            <div style={s.modalTitle}>Confirm {confirming.action}</div>
            <div style={s.modalBody}>{confirming.message}</div>
            <div style={s.modalRow}>
              <button type="button" style={s.modalCancel} onClick={() => setConfirming(null)}>Cancel</button>
              <button type="button" style={s.modalConfirm} onClick={() => perform(confirming.action)}>
                Confirm {confirming.action}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap:        { margin: '4px 0', fontFamily: 'monospace' },
  row:         { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  title:       { fontSize: 13, fontWeight: 700, color: '#374151' },
  btn:         { color: '#fff', border: 'none', borderRadius: 4, padding: '5px 14px', fontSize: 12, fontWeight: 700, fontFamily: 'monospace', cursor: 'pointer' },
  recommend:   { fontSize: 11, color: '#6b7280' },
  note:        { fontSize: 12, color: '#9ca3af' },
  errBox:      { marginTop: 10, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#dc2626' },
  okBox:       { marginTop: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#15803d', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  okLink:      { color: '#2563eb', textDecoration: 'none', fontWeight: 700 },
  overlay:     { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal:       { background: '#fff', borderRadius: 8, padding: 20, maxWidth: 420, width: '90%', boxShadow: '0 10px 40px rgba(0,0,0,0.3)', fontFamily: 'monospace' },
  modalTitle:  { fontSize: 15, fontWeight: 700, marginBottom: 8, textTransform: 'capitalize' },
  modalBody:   { fontSize: 13, color: '#374151', marginBottom: 16, lineHeight: 1.5 },
  modalRow:    { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  modalCancel: { background: '#e5e7eb', color: '#374151', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 12, fontWeight: 700, fontFamily: 'monospace', cursor: 'pointer' },
  modalConfirm:{ background: '#dc2626', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 12, fontWeight: 700, fontFamily: 'monospace', cursor: 'pointer', textTransform: 'capitalize' },
}
