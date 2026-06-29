'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ApprovalResolutionStatus, ApprovalRow } from '@/types/approvals'

// Reuses the existing PATCH /api/approvals/:id endpoint — no DB writes from the
// client, no new validation. The API enforces the real permission/state rules
// (read_only forbidden; only a pending approval in the actor's department, by
// org_admin / department_lead, is resolvable). This UI just surfaces the actions.

type Feedback = { kind: 'ok'; status: string } | { kind: 'err'; message: string }

const ACTIONS: { status: ApprovalResolutionStatus; label: string; color: string; confirm?: string }[] = [
  { status: 'approved',  label: 'Approve',  color: '#16a34a' },
  { status: 'rejected',  label: 'Reject',   color: '#dc2626', confirm: 'Reject this approval?' },
  { status: 'withdrawn', label: 'Withdraw', color: '#6b7280', confirm: 'Withdraw this approval?' },
]

export default function ApprovalActions({
  approvalId,
  status,
  canResolve,
}: {
  approvalId: string
  status: string
  canResolve: boolean
}) {
  const router = useRouter()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<ApprovalResolutionStatus | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  // Resolved approvals are read-only.
  if (status !== 'pending') {
    return <div style={s.readonly}>This approval is <b>{status}</b> — no further actions.</div>
  }
  if (!canResolve) {
    return <div style={s.readonly}>Your role cannot resolve approvals.</div>
  }

  async function resolve(next: ApprovalResolutionStatus, confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    setBusy(next)
    setFeedback(null)
    try {
      const body: Record<string, unknown> = { status: next }
      if (note.trim()) body.decision_note = note.trim()
      const res = await fetch(`/api/approvals/${approvalId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!res.ok) {
        setFeedback({ kind: 'err', message: json?.error?.message ?? `Request failed (${res.status})` })
      } else {
        setFeedback({ kind: 'ok', status: (json.data as ApprovalRow).status })
        router.refresh()
      }
    } catch (err) {
      setFeedback({ kind: 'err', message: err instanceof Error ? err.message : 'Network error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={s.wrap}>
      <label style={s.noteLabel}>
        Decision Note <span style={s.hint}>(optional)</span>
        <input value={note} onChange={e => setNote(e.target.value)} placeholder="Rationale for this resolution" style={s.input} />
      </label>
      <div style={s.row}>
        {ACTIONS.map(a => (
          <button
            key={a.status}
            type="button"
            disabled={busy !== null}
            onClick={() => resolve(a.status, a.confirm)}
            style={{ ...s.btn, background: a.color, opacity: busy && busy !== a.status ? 0.5 : 1 }}
          >
            {busy === a.status ? '…' : a.label}
          </button>
        ))}
      </div>
      {feedback?.kind === 'err' && <div style={s.err}>{feedback.message}</div>}
      {feedback?.kind === 'ok' && <div style={s.ok}>Approval {feedback.status}.</div>}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap:      { fontFamily: 'monospace' },
  readonly:  { fontSize: 13, color: '#6b7280' },
  noteLabel: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#374151', maxWidth: 480, marginBottom: 10 },
  hint:      { color: '#9ca3af', fontWeight: 'normal' },
  input:     { padding: '5px 7px', fontFamily: 'monospace', fontSize: 12, border: '1px solid #ccc', borderRadius: 4 },
  row:       { display: 'flex', gap: 10, flexWrap: 'wrap' },
  btn:       { color: '#fff', border: 'none', borderRadius: 4, padding: '6px 16px', fontSize: 13, fontWeight: 700, fontFamily: 'monospace', cursor: 'pointer' },
  err:       { marginTop: 10, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#dc2626' },
  ok:        { marginTop: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#15803d' },
}
