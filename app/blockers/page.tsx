'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost, apiPatch, ApiClientError } from '@/lib/api-client'
import { Alert, StatusBadge, LookupSelect } from '@/components/ui'
import type { BlockerRow } from '@/types/blockers'

const ENTITY_TYPES = ['task', 'work_packet'] as const
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
const ALL_STATUSES = ['open', 'investigating', 'pending_external', 'resolved', 'won_t_fix'] as const

const ENTITY_LOOKUP: Record<string, { url: string; labelKey: string; secondaryKey: string }> = {
  task:        { url: '/api/lookups/tasks',        labelKey: 'title', secondaryKey: 'status' },
  work_packet: { url: '/api/lookups/work-packets', labelKey: 'title', secondaryKey: 'status' },
}

function short(uuid: string | null | undefined): string {
  return uuid ? uuid.slice(0, 8) + '…' : '—'
}

export default function BlockersPage() {
  const router = useRouter()
  const [blockers, setBlockers] = useState<BlockerRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [description, setDescription] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [entityType, setEntityType] = useState<string>('task')
  const [entityId, setEntityId] = useState('')
  const [severity, setSeverity] = useState<string>('medium')

  const [patchStatus, setPatchStatus] = useState<Record<string, string>>({})
  const [patchSeverity, setPatchSeverity] = useState<Record<string, string>>({})
  const [patchNote, setPatchNote] = useState<Record<string, string>>({})
  const [patchMsg, setPatchMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [patching, setPatching] = useState<Record<string, boolean>>({})

  const loadBlockers = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await apiGet<BlockerRow[]>('/api/blockers')
      setBlockers(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load blockers')
    }
  }, [router])

  useEffect(() => { loadBlockers().finally(() => setLoading(false)) }, [loadBlockers])

  function handleEntityTypeChange(newType: string) {
    setEntityType(newType)
    setEntityId('')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setSubmitting(true)
    try {
      await apiPost('/api/blockers', {
        description: description.trim(),
        department_id: departmentId.trim(),
        blocked_entity_type: entityType,
        blocked_entity_id: entityId.trim(),
        severity,
      })
      setDescription(''); setDepartmentId(''); setEntityId(''); setSeverity('medium')
      await loadBlockers()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setSubmitError(err instanceof ApiClientError ? err.message : 'Create failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUpdate(id: string, newStatus: string, newSeverity: string, note: string) {
    setPatching(p => ({ ...p, [id]: true }))
    setPatchMsg(m => ({ ...m, [id]: { ok: false, text: '' } }))
    try {
      const body: Record<string, string | null> = { status: newStatus, severity: newSeverity }
      if (note.trim()) body.resolution_note = note.trim()
      await apiPatch(`/api/blockers/${id}`, body)
      setPatchStatus(s => { const n = { ...s }; delete n[id]; return n })
      setPatchSeverity(sv => { const n = { ...sv }; delete n[id]; return n })
      setPatchNote(nt => { const n = { ...nt }; delete n[id]; return n })
      setPatchMsg(m => ({ ...m, [id]: { ok: true, text: 'Updated' } }))
      await loadBlockers()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setPatchMsg(m => ({ ...m, [id]: { ok: false, text: err instanceof ApiClientError ? err.message : 'Update failed' } }))
    } finally {
      setPatching(p => ({ ...p, [id]: false }))
    }
  }

  const canSubmit = description.trim().length > 0 && departmentId.trim().length > 0 && entityId.trim().length > 0
  const entityMeta = ENTITY_LOOKUP[entityType]

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Blockers</h1>

      <form onSubmit={handleSubmit} style={s.form}>
        <p style={s.sectionLabel}>Required</p>
        <label style={s.label}>
          Description
          <textarea value={description} onChange={e => setDescription(e.target.value)} required
            rows={3} placeholder="Describe the impediment…" style={s.textarea} />
        </label>
        <label style={s.label}>
          Department
          <LookupSelect url="/api/lookups/departments" labelKey="name"
            value={departmentId} onChange={setDepartmentId} placeholder="Select department…" required />
        </label>
        <div style={s.row}>
          <label style={{ ...s.label, flex: '0 0 130px' }}>
            Entity Type
            <select value={entityType} onChange={e => handleEntityTypeChange(e.target.value)} style={s.select}>
              {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label style={{ ...s.label, flex: 1 }}>
            Blocked Entity
            <LookupSelect key={`entity-${entityType}`}
              url={entityMeta.url}
              labelKey={entityMeta.labelKey}
              secondaryKey={entityMeta.secondaryKey}
              value={entityId} onChange={setEntityId}
              placeholder={`Select ${entityType}…`} required />
          </label>
        </div>
        <label style={s.label}>
          Severity
          <select value={severity} onChange={e => setSeverity(e.target.value)} style={s.select}>
            {SEVERITIES.map(sv => <option key={sv} value={sv}>{sv}</option>)}
          </select>
        </label>
        <Alert type="error" message={submitError} />
        <button type="submit" disabled={submitting || !canSubmit} style={s.btn}>
          {submitting ? 'Creating…' : 'Create blocker'}
        </button>
      </form>

      <hr style={s.hr} />

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : loadError ? (
        <Alert type="error" message={loadError} />
      ) : blockers.length === 0 ? (
        <p style={s.muted}>No blockers visible. (Dept-scoped; agents see only blockers on their assigned tasks/work_packets.)</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['id', 'description', 'severity', 'status', 'entity_type', 'entity_id', 'dept_id', 'reported_by', 'created_at', 'update'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {blockers.map(b => {
                const msg = patchMsg[b.id]
                return (
                  <tr key={b.id}>
                    <td style={s.td}><code title={b.id}>{short(b.id)}</code></td>
                    <td style={{ ...s.td, maxWidth: '180px' }}>{b.description}</td>
                    <td style={s.td}>{b.severity}</td>
                    <td style={s.td}><StatusBadge status={b.status} /></td>
                    <td style={s.td}>{b.blocked_entity_type}</td>
                    <td style={s.td}><code title={b.blocked_entity_id}>{short(b.blocked_entity_id)}</code></td>
                    <td style={s.td}><code title={b.department_id}>{short(b.department_id)}</code></td>
                    <td style={s.td}><code title={b.reported_by_user_id}>{short(b.reported_by_user_id)}</code></td>
                    <td style={s.td}>{new Date(b.created_at).toLocaleString()}</td>
                    <td style={s.tdCtrl}>
                      <div style={s.ctrlRow}>
                        <select value={patchStatus[b.id] ?? b.status}
                          onChange={e => setPatchStatus(ps => ({ ...ps, [b.id]: e.target.value }))}
                          style={s.selectSm}>
                          {ALL_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                        </select>
                        <select value={patchSeverity[b.id] ?? b.severity}
                          onChange={e => setPatchSeverity(sv => ({ ...sv, [b.id]: e.target.value }))}
                          style={s.selectSm}>
                          {SEVERITIES.map(sv => <option key={sv} value={sv}>{sv}</option>)}
                        </select>
                        <button
                          onClick={() => handleUpdate(b.id, patchStatus[b.id] ?? b.status, patchSeverity[b.id] ?? b.severity, patchNote[b.id] ?? '')}
                          disabled={!!patching[b.id]} style={s.btnSm}>
                          {patching[b.id] ? '…' : 'Update'}
                        </button>
                      </div>
                      <input value={patchNote[b.id] ?? ''}
                        onChange={e => setPatchNote(nt => ({ ...nt, [b.id]: e.target.value }))}
                        placeholder="resolution_note (required for resolved/won_t_fix)"
                        style={s.noteInput} />
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
  main:         { fontFamily: 'monospace', padding: '2rem', maxWidth: '1400px' },
  h1:           { margin: '0 0 1.5rem' },
  form:         { display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: '520px' },
  sectionLabel: { margin: 0, fontSize: '0.75rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' },
  label:        { display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.875rem' },
  input:        { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  select:       { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  textarea:     { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.8rem', border: '1px solid #ccc', resize: 'vertical' },
  row:          { display: 'flex', gap: '0.75rem' },
  btn:          { padding: '0.4rem 1rem', fontFamily: 'monospace', cursor: 'pointer', alignSelf: 'flex-start', marginTop: '0.25rem' },
  hr:           { margin: '1.5rem 0', borderColor: '#ddd' },
  muted:        { color: '#666', fontSize: '0.875rem' },
  tableWrap:    { overflowX: 'auto' },
  table:        { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  th:           { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' },
  td:           { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word' },
  tdCtrl:       { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', whiteSpace: 'nowrap', minWidth: '280px' },
  ctrlRow:      { display: 'flex', gap: '0.3rem', alignItems: 'center' },
  selectSm:     { padding: '0.2rem 0.3rem', fontFamily: 'monospace', fontSize: '0.75rem', border: '1px solid #ccc' },
  btnSm:        { padding: '0.2rem 0.5rem', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' },
  noteInput:    { marginTop: '0.25rem', padding: '0.2rem 0.3rem', fontFamily: 'monospace', fontSize: '0.72rem', border: '1px solid #ccc', width: '100%', boxSizing: 'border-box' },
}
