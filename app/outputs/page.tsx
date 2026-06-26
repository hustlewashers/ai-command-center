'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost, apiPatch, ApiClientError } from '@/lib/api-client'
import { Alert, StatusBadge, LookupSelect } from '@/components/ui'
import type { OutputRow } from '@/types/outputs'

const OUTPUT_TYPES = ['report', 'artifact', 'message', 'data', 'other'] as const
const ALL_STATUSES = ['draft', 'in_review', 'approved', 'delivered', 'superseded', 'rejected'] as const

function short(uuid: string | null | undefined): string {
  return uuid ? uuid.slice(0, 8) + '…' : '—'
}

export default function OutputsPage() {
  const router = useRouter()
  const [outputs, setOutputs] = useState<OutputRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [title, setTitle] = useState('')
  const [outputType, setOutputType] = useState<string>('report')
  const [content, setContent] = useState('')
  const [storagePath, setStoragePath] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [taskId, setTaskId] = useState('')
  const [projectId, setProjectId] = useState('')

  const [patchStatus, setPatchStatus] = useState<Record<string, string>>({})
  const [patchMsg, setPatchMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [patching, setPatching] = useState<Record<string, boolean>>({})

  const loadOutputs = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await apiGet<OutputRow[]>('/api/outputs')
      setOutputs(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load outputs')
    }
  }, [router])

  useEffect(() => { loadOutputs().finally(() => setLoading(false)) }, [loadOutputs])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setSubmitting(true)
    try {
      const body: Record<string, string | null | undefined> = {
        title: title.trim(), output_type: outputType,
        department_id: departmentId.trim(), task_id: taskId.trim(),
        project_id: projectId.trim(), status: 'draft',
      }
      if (content.trim()) body.content = content.trim()
      if (storagePath.trim()) body.storage_path = storagePath.trim()
      await apiPost('/api/outputs', body)
      setTitle(''); setContent(''); setStoragePath('')
      setDepartmentId(''); setTaskId(''); setProjectId('')
      await loadOutputs()
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
      await apiPatch(`/api/outputs/${id}`, { status: newStatus })
      setPatchStatus(s => { const n = { ...s }; delete n[id]; return n })
      setPatchMsg(m => ({ ...m, [id]: { ok: true, text: 'Updated' } }))
      await loadOutputs()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setPatchMsg(m => ({ ...m, [id]: { ok: false, text: err instanceof ApiClientError ? err.message : 'Update failed' } }))
    } finally {
      setPatching(p => ({ ...p, [id]: false }))
    }
  }

  const canSubmit = (
    title.trim().length > 0 &&
    departmentId.trim().length > 0 &&
    taskId.trim().length > 0 &&
    projectId.trim().length > 0 &&
    (content.trim().length > 0 || storagePath.trim().length > 0)
  )

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Outputs</h1>

      <form onSubmit={handleSubmit} style={s.form}>
        <p style={s.sectionLabel}>Required</p>
        <label style={s.label}>
          Title
          <input value={title} onChange={e => setTitle(e.target.value)} required
            placeholder="Output title…" style={s.input} />
        </label>
        <label style={s.label}>
          Output Type
          <select value={outputType} onChange={e => setOutputType(e.target.value)} style={s.select}>
            {OUTPUT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label style={s.label}>
          Department
          <LookupSelect url="/api/lookups/departments" labelKey="name"
            value={departmentId} onChange={setDepartmentId} placeholder="Select department…" required />
        </label>
        <label style={s.label}>
          Task
          <LookupSelect url="/api/lookups/tasks" labelKey="title" secondaryKey="status"
            value={taskId} onChange={setTaskId} placeholder="Select parent task…" required />
        </label>
        <label style={s.label}>
          Project <span style={s.hint}>(must match task&apos;s project)</span>
          <LookupSelect url="/api/lookups/projects" labelKey="name"
            value={projectId} onChange={setProjectId} placeholder="Select project…" required />
        </label>
        <p style={{ ...s.sectionLabel, marginTop: '0.75rem' }}>Content (at least one required)</p>
        <label style={s.label}>
          Content <span style={s.hint}>(inline text body)</span>
          <textarea value={content} onChange={e => setContent(e.target.value)}
            rows={3} placeholder="Output body text…" style={s.textarea} />
        </label>
        <label style={s.label}>
          Storage Path <span style={s.hint}>(pointer to stored file)</span>
          <input value={storagePath} onChange={e => setStoragePath(e.target.value)}
            placeholder="storage/path/to/file" style={s.input} />
        </label>
        <Alert type="error" message={submitError} />
        <button type="submit" disabled={submitting || !canSubmit} style={s.btn}>
          {submitting ? 'Creating…' : 'Create output'}
        </button>
      </form>

      <hr style={s.hr} />

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : loadError ? (
        <Alert type="error" message={loadError} />
      ) : outputs.length === 0 ? (
        <p style={s.muted}>No outputs visible. (Outputs are department-scoped — agents see only assigned-task outputs.)</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['id', 'title', 'type', 'status', 'dept_id', 'task_id', 'project_id', 'produced_at', 'delivered_at', 'update'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {outputs.map(o => {
                const msg = patchMsg[o.id]
                return (
                  <tr key={o.id}>
                    <td style={s.td}><code title={o.id}>{short(o.id)}</code></td>
                    <td style={{ ...s.td, maxWidth: '160px' }}>{o.title}</td>
                    <td style={s.td}>{o.output_type}</td>
                    <td style={s.td}><StatusBadge status={o.status} /></td>
                    <td style={s.td}><code title={o.department_id}>{short(o.department_id)}</code></td>
                    <td style={s.td}><code title={o.task_id}>{short(o.task_id)}</code></td>
                    <td style={s.td}><code title={o.project_id}>{short(o.project_id)}</code></td>
                    <td style={s.td}>{new Date(o.produced_at).toLocaleString()}</td>
                    <td style={s.td}>{o.delivered_at ? new Date(o.delivered_at).toLocaleString() : '—'}</td>
                    <td style={s.tdCtrl}>
                      <div style={s.ctrlRow}>
                        <select value={patchStatus[o.id] ?? o.status}
                          onChange={e => setPatchStatus(ps => ({ ...ps, [o.id]: e.target.value }))}
                          style={s.selectSm}>
                          {ALL_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                        </select>
                        <button onClick={() => handleUpdate(o.id, patchStatus[o.id] ?? o.status)}
                          disabled={!!patching[o.id]} style={s.btnSm}>
                          {patching[o.id] ? '…' : 'Update'}
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
  hint:         { color: '#888', fontSize: '0.75rem', marginLeft: '0.25rem' },
  input:        { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  select:       { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  textarea:     { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.8rem', border: '1px solid #ccc', resize: 'vertical' },
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
