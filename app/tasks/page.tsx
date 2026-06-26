'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost, apiPatch, ApiClientError } from '@/lib/api-client'
import { Alert, StatusBadge, LookupSelect } from '@/components/ui'
import type { TaskRow } from '@/types/tasks'

const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const
const INITIAL_STATUSES = ['backlog', 'ready'] as const
const ALL_STATUSES = ['backlog', 'ready', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'] as const

function short(uuid: string | null | undefined): string {
  return uuid ? uuid.slice(0, 8) + '…' : '—'
}

export default function TasksPage() {
  const router = useRouter()
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [title, setTitle] = useState('')
  const [projectId, setProjectId] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [requestId, setRequestId] = useState('')
  const [assignedTo, setAssignedTo] = useState('')
  const [priority, setPriority] = useState<string>('normal')
  const [status, setStatus] = useState<string>('backlog')

  const [patchStatus, setPatchStatus] = useState<Record<string, string>>({})
  const [patchPriority, setPatchPriority] = useState<Record<string, string>>({})
  const [patchMsg, setPatchMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [patching, setPatching] = useState<Record<string, boolean>>({})

  const loadTasks = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await apiGet<TaskRow[]>('/api/tasks')
      setTasks(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load tasks')
    }
  }, [router])

  useEffect(() => { loadTasks().finally(() => setLoading(false)) }, [loadTasks])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setSubmitting(true)
    try {
      const body: Record<string, string | null | undefined> = {
        title: title.trim(), project_id: projectId.trim(),
        department_id: departmentId.trim(), priority, status,
      }
      if (requestId.trim()) body.request_id = requestId.trim()
      if (assignedTo.trim()) body.assigned_to_user_id = assignedTo.trim()
      await apiPost('/api/tasks', body)
      setTitle(''); setProjectId(''); setDepartmentId(''); setRequestId(''); setAssignedTo('')
      setPriority('normal'); setStatus('backlog')
      await loadTasks()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setSubmitError(err instanceof ApiClientError ? err.message : 'Create failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUpdate(id: string, newStatus: string, newPriority: string) {
    setPatching(p => ({ ...p, [id]: true }))
    setPatchMsg(m => ({ ...m, [id]: { ok: false, text: '' } }))
    try {
      await apiPatch(`/api/tasks/${id}`, { status: newStatus, priority: newPriority })
      setPatchStatus(s => { const n = { ...s }; delete n[id]; return n })
      setPatchPriority(p => { const n = { ...p }; delete n[id]; return n })
      setPatchMsg(m => ({ ...m, [id]: { ok: true, text: 'Updated' } }))
      await loadTasks()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setPatchMsg(m => ({ ...m, [id]: { ok: false, text: err instanceof ApiClientError ? err.message : 'Update failed' } }))
    } finally {
      setPatching(p => ({ ...p, [id]: false }))
    }
  }

  const canSubmit = title.trim().length > 0 && projectId.trim().length > 0 && departmentId.trim().length > 0

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Tasks</h1>

      <form onSubmit={handleSubmit} style={s.form}>
        <p style={s.sectionLabel}>Required</p>
        <label style={s.label}>
          Title
          <input value={title} onChange={e => setTitle(e.target.value)} required
            placeholder="Task title…" style={s.input} />
        </label>
        <label style={s.label}>
          Project
          <LookupSelect url="/api/lookups/projects" labelKey="name"
            value={projectId} onChange={setProjectId} placeholder="Select project…" required />
        </label>
        <label style={s.label}>
          Department
          <LookupSelect url="/api/lookups/departments" labelKey="name"
            value={departmentId} onChange={setDepartmentId} placeholder="Select department…" required />
        </label>
        <p style={{ ...s.sectionLabel, marginTop: '0.75rem' }}>Optional</p>
        <label style={s.label}>
          Request ID
          <input value={requestId} onChange={e => setRequestId(e.target.value)}
            placeholder="UUID (leave blank to skip)" style={s.input} />
        </label>
        <label style={s.label}>
          Assigned To (user ID)
          <input value={assignedTo} onChange={e => setAssignedTo(e.target.value)}
            placeholder="UUID (leave blank to skip)" style={s.input} />
        </label>
        <div style={s.row}>
          <label style={{ ...s.label, flex: 1 }}>
            Priority
            <select value={priority} onChange={e => setPriority(e.target.value)} style={s.select}>
              {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label style={{ ...s.label, flex: 1 }}>
            Initial Status
            <select value={status} onChange={e => setStatus(e.target.value)} style={s.select}>
              {INITIAL_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
            </select>
          </label>
        </div>
        <Alert type="error" message={submitError} />
        <button type="submit" disabled={submitting || !canSubmit} style={s.btn}>
          {submitting ? 'Creating…' : 'Create task'}
        </button>
      </form>

      <hr style={s.hr} />

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : loadError ? (
        <Alert type="error" message={loadError} />
      ) : tasks.length === 0 ? (
        <p style={s.muted}>No tasks visible. (Tasks are department-scoped — you must be in a department or org_admin.)</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['id', 'title', 'project_id', 'dept_id', 'request_id', 'assigned_to', 'priority', 'status', 'created_at', 'update'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map(t => {
                const msg = patchMsg[t.id]
                return (
                  <tr key={t.id}>
                    <td style={s.td}><code title={t.id}>{short(t.id)}</code></td>
                    <td style={{ ...s.td, maxWidth: '160px' }}>{t.title}</td>
                    <td style={s.td}><code title={t.project_id}>{short(t.project_id)}</code></td>
                    <td style={s.td}><code title={t.department_id}>{short(t.department_id)}</code></td>
                    <td style={s.td}><code title={t.request_id ?? ''}>{short(t.request_id)}</code></td>
                    <td style={s.td}><code title={t.assigned_to_user_id ?? ''}>{short(t.assigned_to_user_id)}</code></td>
                    <td style={s.td}>{t.priority}</td>
                    <td style={s.td}><StatusBadge status={t.status} /></td>
                    <td style={s.td}>{new Date(t.created_at).toLocaleString()}</td>
                    <td style={s.tdCtrl}>
                      <div style={s.ctrlRow}>
                        <select value={patchStatus[t.id] ?? t.status}
                          onChange={e => setPatchStatus(ps => ({ ...ps, [t.id]: e.target.value }))}
                          style={s.selectSm}>
                          {ALL_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                        </select>
                        <select value={patchPriority[t.id] ?? t.priority}
                          onChange={e => setPatchPriority(pp => ({ ...pp, [t.id]: e.target.value }))}
                          style={s.selectSm}>
                          {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                        <button
                          onClick={() => handleUpdate(t.id, patchStatus[t.id] ?? t.status, patchPriority[t.id] ?? t.priority)}
                          disabled={!!patching[t.id]} style={s.btnSm}>
                          {patching[t.id] ? '…' : 'Update'}
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
  main:         { fontFamily: 'monospace', padding: '2rem', maxWidth: '1300px' },
  h1:           { margin: '0 0 1.5rem' },
  form:         { display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: '520px' },
  sectionLabel: { margin: 0, fontSize: '0.75rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' },
  label:        { display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.875rem' },
  input:        { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  select:       { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  row:          { display: 'flex', gap: '0.75rem' },
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
}
