'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiGet, apiPost, apiPatch, ApiClientError } from '@/lib/api-client'
import { Alert, StatusBadge } from '@/components/ui'
import type { RequestRow, RequestRowWithWorkflow } from '@/types/requests'

const ALL_STATUSES = ['received', 'triaged', 'in_progress', 'completed', 'rejected', 'cancelled'] as const

// Colors for the latest-workflow-state cell.
const WF_COLOR: Record<string, string> = {
  pending: '#6b7280', running: '#2563eb', resuming: '#d97706',
  completed: '#16a34a', failed: '#dc2626', cancelled: '#9ca3af',
}

type Lookup = { id: string; name: string }
type CreatedRequest = RequestRow & {
  workflow?: { triggered: boolean; deduped: boolean; reason: string } | null
}

// Small lightweight AI summary signal for the request list (Sprint 6.4).
function aiSignal(ai: { run_id: string; status: string } | null): React.ReactNode {
  if (!ai) return <span style={{ color: '#bbb', fontSize: '0.72rem' }}>none</span>
  let label = ai.status
  let color = '#6b7280'
  if (['pending', 'running', 'resuming'].includes(ai.status)) { label = 'running'; color = '#2563eb' }
  else if (ai.status === 'completed') { label = 'draft'; color = '#16a34a' }
  else if (ai.status === 'failed') { label = 'failed'; color = '#dc2626' }
  else if (ai.status === 'cancelled') { label = 'cancelled'; color = '#9ca3af' }
  return (
    <Link href={`/workflow-runs/${ai.run_id}`} style={{ textDecoration: 'none' }}>
      <span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: '0.66rem', fontWeight: 'bold', color: '#fff', background: color, whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </Link>
  )
}

export default function RequestsPage() {
  const router = useRouter()
  const [requests, setRequests] = useState<RequestRowWithWorkflow[]>([])
  const [intent, setIntent] = useState('')
  const [depts, setDepts] = useState<Lookup[]>([])
  const [projects, setProjects] = useState<Lookup[]>([])
  const [deptId, setDeptId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitNote, setSubmitNote] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [patchStatus, setPatchStatus] = useState<Record<string, string>>({})
  const [patchMsg, setPatchMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [patching, setPatching] = useState<Record<string, boolean>>({})

  const loadRequests = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await apiGet<RequestRowWithWorkflow[]>('/api/requests')
      setRequests(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load requests')
    }
  }, [router])

  useEffect(() => { loadRequests().finally(() => setLoading(false)) }, [loadRequests])

  useEffect(() => {
    apiGet<Lookup[]>('/api/lookups/departments').then(setDepts).catch(() => {})
    apiGet<Lookup[]>('/api/lookups/projects').then(setProjects).catch(() => {})
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setSubmitNote(null)
    setSubmitting(true)
    try {
      const created = await apiPost<CreatedRequest>('/api/requests', {
        intent: intent.trim(),
        routed_department_id: deptId || null,
        project_id: projectId || null,
      })
      setIntent('')
      // Surface whether the request automatically started a workflow.
      const wf = created.workflow
      if (wf?.triggered)      setSubmitNote('Request created — workflow enqueued.')
      else if (wf?.deduped)   setSubmitNote('Request created — existing workflow reused.')
      else if (wf)            setSubmitNote(`Request created — no workflow: ${wf.reason}`)
      else                    setSubmitNote('Request created.')
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
        <label style={s.label}>
          Department <span style={s.hint}>(required to auto-start a workflow)</span>
          <select value={deptId} onChange={e => setDeptId(e.target.value)} style={s.select}>
            <option value="">— none —</option>
            {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label style={s.label}>
          Project <span style={s.hint}>(required to auto-start a workflow)</span>
          <select value={projectId} onChange={e => setProjectId(e.target.value)} style={s.select}>
            <option value="">— none —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <Alert type="error" message={submitError} />
        {submitNote && <div style={s.note}>{submitNote}</div>}
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
                {['id', 'intent', 'source', 'status', 'workflow', 'ai', 'routed_dept', 'project', 'submitted_at', 'update'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {requests.map(r => {
                const msg = patchMsg[r.id]
                return (
                  <tr key={r.id}>
                    <td style={s.td}>
                      <Link href={`/requests/${r.id}`} style={s.idLink} title={r.id}>
                        <code>{r.id.slice(0, 8)}…</code>
                      </Link>
                    </td>
                    <td style={{ ...s.td, maxWidth: '240px' }}>{r.intent}</td>
                    <td style={s.td}>{r.source}</td>
                    <td style={s.td}><StatusBadge status={r.status} /></td>
                    <td style={s.td}>
                      {r.workflow ? (
                        <span style={s.wfCell}>
                          <Link href={`/workflow-runs/${r.workflow.run_id}`} style={s.wfLink}>
                            <span style={{ ...s.wfBadge, background: WF_COLOR[r.workflow.status] ?? '#6b7280' }}>
                              {r.workflow.status}
                            </span>
                          </Link>
                          {(r.workflow.status === 'failed' || r.workflow.status === 'cancelled') && (
                            <Link href={`/requests/${r.id}#recovery`} style={s.recoverBtn}>Recover</Link>
                          )}
                        </span>
                      ) : (
                        <span style={s.wfNone}>none</span>
                      )}
                    </td>
                    <td style={s.td}>{aiSignal(r.ai_summary)}</td>
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
  hint:     { color: '#999', fontSize: '0.72rem', fontWeight: 'normal' },
  textarea: { padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc', resize: 'vertical' },
  select:   { padding: '0.4rem', fontFamily: 'monospace', fontSize: '0.85rem', border: '1px solid #ccc' },
  note:     { color: '#15803d', fontSize: '0.8rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '4px', padding: '0.4rem 0.6rem' },
  idLink:   { color: '#2563eb', textDecoration: 'none' },
  wfCell:   { display: 'inline-flex', alignItems: 'center', gap: '0.35rem' },
  wfLink:   { textDecoration: 'none' },
  wfBadge:  { display: 'inline-block', padding: '1px 7px', borderRadius: 3, fontSize: '0.68rem', fontWeight: 'bold', color: '#fff', whiteSpace: 'nowrap' },
  wfNone:   { color: '#bbb', fontSize: '0.72rem' },
  recoverBtn:{ display: 'inline-block', padding: '1px 6px', borderRadius: 3, fontSize: '0.66rem', fontWeight: 'bold', color: '#fff', background: '#d97706', textDecoration: 'none', whiteSpace: 'nowrap' },
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
