'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiGet, apiPost, apiPatch, ApiClientError } from '@/lib/api-client'
import { Alert, StatusBadge, LookupSelect } from '@/components/ui'
import type { DecisionRow } from '@/types/decisions'

const INSERT_STATUSES = ['proposed', 'pending_approval'] as const
const ALL_STATUSES = ['proposed', 'confirmed', 'pending_approval', 'approved', 'rejected', 'superseded'] as const

function short(uuid: string | null | undefined): string {
  return uuid ? uuid.slice(0, 8) + '…' : '—'
}

export default function DecisionsPage() {
  const router = useRouter()
  const [decisions, setDecisions] = useState<DecisionRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [taskId, setTaskId] = useState('')
  const [summary, setSummary] = useState('')
  const [rationale, setRationale] = useState('')
  const [status, setStatus] = useState<string>('proposed')

  const [patchStatus, setPatchStatus] = useState<Record<string, string>>({})
  const [patchMsg, setPatchMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [patching, setPatching] = useState<Record<string, boolean>>({})

  const loadDecisions = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await apiGet<DecisionRow[]>('/api/decisions')
      setDecisions(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load decisions')
    }
  }, [router])

  useEffect(() => { loadDecisions().finally(() => setLoading(false)) }, [loadDecisions])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setSubmitting(true)
    try {
      await apiPost('/api/decisions', { task_id: taskId.trim(), summary: summary.trim(), rationale: rationale.trim(), status })
      setTaskId(''); setSummary(''); setRationale(''); setStatus('proposed')
      await loadDecisions()
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
      await apiPatch(`/api/decisions/${id}`, { status: newStatus })
      setPatchStatus(s => { const n = { ...s }; delete n[id]; return n })
      setPatchMsg(m => ({ ...m, [id]: { ok: true, text: 'Updated' } }))
      await loadDecisions()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setPatchMsg(m => ({ ...m, [id]: { ok: false, text: err instanceof ApiClientError ? err.message : 'Update failed' } }))
    } finally {
      setPatching(p => ({ ...p, [id]: false }))
    }
  }

  const canSubmit = taskId.trim().length > 0 && summary.trim().length > 0 && rationale.trim().length > 0

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Decisions</h1>

      <form onSubmit={handleSubmit} style={s.form}>
        <p style={s.sectionLabel}>Required</p>
        <label style={s.label}>
          Task
          <LookupSelect url="/api/lookups/tasks" labelKey="title" secondaryKey="status"
            value={taskId} onChange={setTaskId} placeholder="Select parent task…" required />
        </label>
        <label style={s.label}>
          Summary <span style={s.hint}>(the decision itself)</span>
          <textarea value={summary} onChange={e => setSummary(e.target.value)} required
            rows={2} placeholder="Use OAuth2 with PKCE…" style={s.textarea} />
        </label>
        <label style={s.label}>
          Rationale <span style={s.hint}>(the why)</span>
          <textarea value={rationale} onChange={e => setRationale(e.target.value)} required
            rows={2} placeholder="Matches org policy and reduces token risk…" style={s.textarea} />
        </label>
        <p style={{ ...s.sectionLabel, marginTop: '0.75rem' }}>Optional</p>
        <label style={s.label}>
          Initial Status
          <select value={status} onChange={e => setStatus(e.target.value)} style={s.select}>
            {INSERT_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
        </label>
        <Alert type="error" message={submitError} />
        <button type="submit" disabled={submitting || !canSubmit} style={s.btn}>
          {submitting ? 'Creating…' : 'Create decision'}
        </button>
      </form>

      <hr style={s.hr} />

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : loadError ? (
        <Alert type="error" message={loadError} />
      ) : decisions.length === 0 ? (
        <p style={s.muted}>No decisions visible. (Visibility is scoped through the parent task department.)</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['id', 'task_id', 'summary', 'rationale', 'status', 'decided_by', 'decided_at', 'created_at', 'update'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {decisions.map(d => {
                const msg = patchMsg[d.id]
                return (
                  <tr key={d.id}>
                    <td style={s.td}><Link href={`/decisions/${d.id}`} style={s.rowLink} title={d.id}><code>{short(d.id)}</code></Link></td>
                    <td style={s.td}><Link href={`/tasks/${d.task_id}`} style={s.rowLink} title={d.task_id}><code>{short(d.task_id)}</code></Link></td>
                    <td style={{ ...s.td, maxWidth: '160px' }}><Link href={`/decisions/${d.id}`} style={s.rowLink}>{d.summary}</Link></td>
                    <td style={{ ...s.td, maxWidth: '160px' }}>{d.rationale}</td>
                    <td style={s.td}><StatusBadge status={d.status} /></td>
                    <td style={s.td}><code title={d.decided_by_user_id ?? ''}>{short(d.decided_by_user_id)}</code></td>
                    <td style={s.td}>{new Date(d.decided_at).toLocaleString()}</td>
                    <td style={s.td}>{new Date(d.created_at).toLocaleString()}</td>
                    <td style={s.tdCtrl}>
                      <div style={s.ctrlRow}>
                        <select value={patchStatus[d.id] ?? d.status}
                          onChange={e => setPatchStatus(p => ({ ...p, [d.id]: e.target.value }))}
                          style={s.selectSm}>
                          {ALL_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                        </select>
                        <button onClick={() => handleUpdate(d.id, patchStatus[d.id] ?? d.status)}
                          disabled={!!patching[d.id]} style={s.btnSm}>
                          {patching[d.id] ? '…' : 'Update'}
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
  main:         { fontFamily: 'monospace', padding: '2rem', maxWidth: '1200px' },
  h1:           { margin: '0 0 1.5rem' },
  form:         { display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: '520px' },
  sectionLabel: { margin: 0, fontSize: '0.75rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' },
  label:        { display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.875rem' },
  hint:         { color: '#888', fontSize: '0.75rem', marginLeft: '0.25rem' },
  select:       { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  textarea:     { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc', resize: 'vertical' },
  btn:          { padding: '0.4rem 1rem', fontFamily: 'monospace', cursor: 'pointer', alignSelf: 'flex-start', marginTop: '0.25rem' },
  hr:           { margin: '1.5rem 0', borderColor: '#ddd' },
  muted:        { color: '#666', fontSize: '0.875rem' },
  tableWrap:    { overflowX: 'auto' },
  table:        { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  th:           { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' },
  td:           { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word' },
  tdCtrl:       { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', whiteSpace: 'nowrap' },
  ctrlRow:      { display: 'flex', gap: '0.3rem', alignItems: 'center' },
  selectSm:     { padding: '0.2rem 0.3rem', fontFamily: 'monospace', fontSize: '0.75rem', border: '1px solid #ccc' },
  btnSm:        { padding: '0.2rem 0.5rem', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' },
  rowLink:      { color: '#2563eb', textDecoration: 'none' },
}
