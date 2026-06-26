'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost, apiPatch, ApiClientError } from '@/lib/api-client'
import { Alert, StatusBadge } from '@/components/ui'
import type { RequestRow } from '@/types/requests'

const ALL_STATUSES = ['received', 'triaged', 'in_progress', 'completed', 'rejected', 'cancelled'] as const

export default function RequestsPage() {
  const router = useRouter()
  const [requests, setRequests] = useState<RequestRow[]>([])
  const [intent, setIntent] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [patchStatus, setPatchStatus] = useState<Record<string, string>>({})
  const [patchMsg, setPatchMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [patching, setPatching] = useState<Record<string, boolean>>({})

  const loadRequests = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await apiGet<RequestRow[]>('/api/requests')
      setRequests(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load requests')
    }
  }, [router])

  useEffect(() => { loadRequests().finally(() => setLoading(false)) }, [loadRequests])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setSubmitting(true)
    try {
      await apiPost('/api/requests', { intent: intent.trim() })
      setIntent('')
      await loadRequests()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setSubmitError(err instanceof ApiClientError ? err.message : 'Create failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUpdate(id: string, newStatus: string) {
    setPatching(p => ({ ...p, [id]: true }))
    setPatchMsg(m => ({ ...m, [id]: { ok: false, text: '' } }))
    try {
      await apiPatch(`/api/requests/${id}`, { status: newStatus })
      setPatchStatus(s => { const n = { ...s }; delete n[id]; return n })
      setPatchMsg(m => ({ ...m, [id]: { ok: true, text: 'Updated' } }))
      await loadRequests()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setPatchMsg(m => ({ ...m, [id]: { ok: false, text: err instanceof ApiClientError ? err.message : 'Update failed' } }))
    } finally {
      setPatching(p => ({ ...p, [id]: false }))
    }
  }

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Requests</h1>

      <form onSubmit={handleSubmit} style={s.form}>
        <label style={s.label}>
          Intent
          <textarea value={intent} onChange={e => setIntent(e.target.value)}
            rows={3} required placeholder="Describe the request…" style={s.textarea} />
        </label>
        <Alert type="error" message={submitError} />
        <button type="submit" disabled={submitting || intent.trim().length === 0} style={s.btn}>
          {submitting ? 'Creating…' : 'Create request'}
        </button>
      </form>

      <hr style={s.hr} />

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : loadError ? (
        <Alert type="error" message={loadError} />
      ) : requests.length === 0 ? (
        <p style={s.muted}>No requests yet.</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['id', 'intent', 'source', 'status', 'routed_dept', 'project', 'submitted_at', 'update'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {requests.map(r => {
                const msg = patchMsg[r.id]
                return (
                  <tr key={r.id}>
                    <td style={s.td}><code title={r.id}>{r.id.slice(0, 8)}…</code></td>
                    <td style={{ ...s.td, maxWidth: '240px' }}>{r.intent}</td>
                    <td style={s.td}>{r.source}</td>
                    <td style={s.td}><StatusBadge status={r.status} /></td>
                    <td style={s.td}><code>{r.routed_department_id ? r.routed_department_id.slice(0, 8) + '…' : '—'}</code></td>
                    <td style={s.td}><code>{r.project_id ? r.project_id.slice(0, 8) + '…' : '—'}</code></td>
                    <td style={s.td}>{new Date(r.submitted_at).toLocaleString()}</td>
                    <td style={s.tdCtrl}>
                      <div style={s.ctrlRow}>
                        <select value={patchStatus[r.id] ?? r.status}
                          onChange={e => setPatchStatus(ps => ({ ...ps, [r.id]: e.target.value }))}
                          style={s.selectSm}>
                          {ALL_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                        </select>
                        <button onClick={() => handleUpdate(r.id, patchStatus[r.id] ?? r.status)}
                          disabled={!!patching[r.id]} style={s.btnSm}>
                          {patching[r.id] ? '…' : 'Update'}
                        </button>
                      </div>
                      {msg?.text && (
                        <div style={{ color: msg.ok ? '#060' : '#c00', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                          {msg.text}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}

const s: Record<string, React.CSSProperties> = {
  main:     { fontFamily: 'monospace', padding: '2rem', maxWidth: '1100px' },
  h1:       { margin: '0 0 1.5rem' },
  form:     { display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '480px' },
  label:    { display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.875rem' },
  textarea: { padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc', resize: 'vertical' },
  btn:      { padding: '0.4rem 1rem', fontFamily: 'monospace', cursor: 'pointer', alignSelf: 'flex-start' },
  hr:       { margin: '1.5rem 0', borderColor: '#ddd' },
  muted:    { color: '#666', fontSize: '0.875rem' },
  tableWrap:{ overflowX: 'auto' },
  table:    { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  th:       { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' },
  td:       { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word' },
  tdCtrl:   { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', whiteSpace: 'nowrap' },
  ctrlRow:  { display: 'flex', gap: '0.3rem', alignItems: 'center' },
  selectSm: { padding: '0.2rem 0.3rem', fontFamily: 'monospace', fontSize: '0.75rem', border: '1px solid #ccc' },
  btnSm:    { padding: '0.2rem 0.5rem', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' },
}
