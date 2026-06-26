'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost, apiPatch, ApiClientError } from '@/lib/api-client'
import { Alert, StatusBadge, LookupSelect } from '@/components/ui'
import type { WorkPacketRow } from '@/types/work-packets'

const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const
const INITIAL_STATUSES = ['draft', 'ready'] as const
const ALL_STATUSES = ['draft', 'ready', 'pending_approval', 'in_execution', 'accepted', 'superseded', 'cancelled'] as const
const PARENT_TYPES = ['project', 'task'] as const

function short(uuid: string | null | undefined): string {
  return uuid ? uuid.slice(0, 8) + '…' : '—'
}

function parseJson(raw: string, field: string): { value: unknown; error: string | null } {
  try { return { value: JSON.parse(raw), error: null } }
  catch { return { value: null, error: `"${field}" is not valid JSON` } }
}

const PARENT_LOOKUP: Record<string, string> = {
  project: '/api/lookups/projects',
  task:    '/api/lookups/tasks',
}
const PARENT_LABEL: Record<string, string> = { project: 'name', task: 'title' }
const PARENT_SECONDARY: Record<string, string | undefined> = { project: undefined, task: 'status' }

export default function WorkPacketsPage() {
  const router = useRouter()
  const [packets, setPackets] = useState<WorkPacketRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [title, setTitle] = useState('')
  const [objective, setObjective] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [parentType, setParentType] = useState<string>('project')
  const [parentId, setParentId] = useState('')
  const [priority, setPriority] = useState<string>('normal')
  const [status, setStatus] = useState<string>('draft')
  const [approvalRequired, setApprovalRequired] = useState(false)
  const [scopeRaw, setScopeRaw] = useState('{}')
  const [criteriaRaw, setCriteriaRaw] = useState('[]')
  const [constraintsRaw, setConstraintsRaw] = useState('{}')

  const [patchStatus, setPatchStatus] = useState<Record<string, string>>({})
  const [patchApproval, setPatchApproval] = useState<Record<string, boolean>>({})
  const [patchMsg, setPatchMsg] = useState<Record<string, { ok: boolean; text: string }>>({})
  const [patching, setPatching] = useState<Record<string, boolean>>({})

  const loadPackets = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await apiGet<WorkPacketRow[]>('/api/work-packets')
      setPackets(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load work packets')
    }
  }, [router])

  useEffect(() => { loadPackets().finally(() => setLoading(false)) }, [loadPackets])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    const scope = parseJson(scopeRaw.trim() || '{}', 'scope')
    const criteria = parseJson(criteriaRaw.trim() || '[]', 'acceptance_criteria')
    const constraints = parseJson(constraintsRaw.trim() || '{}', 'constraints')
    if (scope.error) { setSubmitError(scope.error); return }
    if (criteria.error) { setSubmitError(criteria.error); return }
    if (constraints.error) { setSubmitError(constraints.error); return }
    setSubmitting(true)
    try {
      await apiPost('/api/work-packets', {
        title: title.trim(), objective: objective.trim(),
        department_id: departmentId.trim(), parent_type: parentType, parent_id: parentId.trim(),
        priority, status, approval_required_before_start: approvalRequired,
        scope: scope.value, acceptance_criteria: criteria.value, constraints: constraints.value,
      })
      setTitle(''); setObjective(''); setDepartmentId(''); setParentType('project'); setParentId('')
      setPriority('normal'); setStatus('draft'); setApprovalRequired(false)
      setScopeRaw('{}'); setCriteriaRaw('[]'); setConstraintsRaw('{}')
      await loadPackets()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setSubmitError(err instanceof ApiClientError ? err.message : 'Create failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUpdate(id: string, newStatus: string, newApproval: boolean) {
    setPatching(p => ({ ...p, [id]: true }))
    setPatchMsg(m => ({ ...m, [id]: { ok: false, text: '' } }))
    try {
      await apiPatch(`/api/work-packets/${id}`, { status: newStatus, approval_required_before_start: newApproval })
      setPatchStatus(s => { const n = { ...s }; delete n[id]; return n })
      setPatchApproval(a => { const n = { ...a }; delete n[id]; return n })
      setPatchMsg(m => ({ ...m, [id]: { ok: true, text: 'Updated' } }))
      await loadPackets()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setPatchMsg(m => ({ ...m, [id]: { ok: false, text: err instanceof ApiClientError ? err.message : 'Update failed' } }))
    } finally {
      setPatching(p => ({ ...p, [id]: false }))
    }
  }

  const canSubmit = title.trim().length > 0 && objective.trim().length > 0 && departmentId.trim().length > 0 && parentId.trim().length > 0

  function handleParentTypeChange(newType: string) {
    setParentType(newType)
    setParentId('')
  }

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Work Packets</h1>

      <form onSubmit={handleSubmit} style={s.form}>
        <p style={s.sectionLabel}>Required</p>
        <label style={s.label}>
          Title
          <input value={title} onChange={e => setTitle(e.target.value)} required
            placeholder="Work packet title…" style={s.input} />
        </label>
        <label style={s.label}>
          Objective
          <textarea value={objective} onChange={e => setObjective(e.target.value)} required
            rows={2} placeholder="Intended outcome…" style={s.textarea} />
        </label>
        <label style={s.label}>
          Department
          <LookupSelect url="/api/lookups/departments" labelKey="name"
            value={departmentId} onChange={setDepartmentId} placeholder="Select department…" required />
        </label>
        <div style={s.row}>
          <label style={{ ...s.label, flex: '0 0 120px' }}>
            Parent Type
            <select value={parentType} onChange={e => handleParentTypeChange(e.target.value)} style={s.select}>
              {PARENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label style={{ ...s.label, flex: 1 }}>
            Parent
            <LookupSelect key={`parent-${parentType}`}
              url={PARENT_LOOKUP[parentType]}
              labelKey={PARENT_LABEL[parentType]}
              secondaryKey={PARENT_SECONDARY[parentType]}
              value={parentId} onChange={setParentId}
              placeholder={`Select ${parentType}…`} required />
          </label>
        </div>
        <p style={{ ...s.sectionLabel, marginTop: '0.75rem' }}>Optional</p>
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
        <label style={s.checkboxLabel}>
          <input type="checkbox" checked={approvalRequired}
            onChange={e => setApprovalRequired(e.target.checked)} style={{ marginRight: '0.4rem' }} />
          approval_required_before_start
        </label>
        <label style={s.label}>
          scope <span style={s.hint}>(JSON object)</span>
          <textarea value={scopeRaw} onChange={e => setScopeRaw(e.target.value)}
            rows={2} style={s.textarea} spellCheck={false} />
        </label>
        <label style={s.label}>
          acceptance_criteria <span style={s.hint}>(JSON array)</span>
          <textarea value={criteriaRaw} onChange={e => setCriteriaRaw(e.target.value)}
            rows={2} style={s.textarea} spellCheck={false} />
        </label>
        <label style={s.label}>
          constraints <span style={s.hint}>(JSON object)</span>
          <textarea value={constraintsRaw} onChange={e => setConstraintsRaw(e.target.value)}
            rows={2} style={s.textarea} spellCheck={false} />
        </label>
        <Alert type="error" message={submitError} />
        <button type="submit" disabled={submitting || !canSubmit} style={s.btn}>
          {submitting ? 'Creating…' : 'Create work packet'}
        </button>
      </form>

      <hr style={s.hr} />

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : loadError ? (
        <Alert type="error" message={loadError} />
      ) : packets.length === 0 ? (
        <p style={s.muted}>No work packets visible. (Work packets are department-scoped — agents see nothing.)</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['id', 'title', 'dept', 'parent', 'priority', 'status', 'approval_req', 'created_at', 'update'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {packets.map(p => {
                const msg = patchMsg[p.id]
                const effectiveApproval = p.id in patchApproval ? patchApproval[p.id] : p.approval_required_before_start
                return (
                  <tr key={p.id}>
                    <td style={s.td}><code title={p.id}>{short(p.id)}</code></td>
                    <td style={{ ...s.td, maxWidth: '140px' }}>{p.title}</td>
                    <td style={s.td}><code title={p.department_id}>{short(p.department_id)}</code></td>
                    <td style={s.td}><span style={s.muted2}>{p.parent_type}/</span><code title={p.parent_id}>{short(p.parent_id)}</code></td>
                    <td style={s.td}>{p.priority}</td>
                    <td style={s.td}><StatusBadge status={p.status} /></td>
                    <td style={s.td}>{p.approval_required_before_start ? 'yes' : 'no'}</td>
                    <td style={s.td}>{new Date(p.created_at).toLocaleString()}</td>
                    <td style={s.tdCtrl}>
                      <div style={s.ctrlRow}>
                        <select value={patchStatus[p.id] ?? p.status}
                          onChange={e => setPatchStatus(ps => ({ ...ps, [p.id]: e.target.value }))}
                          style={s.selectSm}>
                          {ALL_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
                        </select>
                        <button onClick={() => handleUpdate(p.id, patchStatus[p.id] ?? p.status, effectiveApproval)}
                          disabled={!!patching[p.id]} style={s.btnSm}>
                          {patching[p.id] ? '…' : 'Update'}
                        </button>
                      </div>
                      <label style={s.checkboxSm}>
                        <input type="checkbox" checked={effectiveApproval}
                          onChange={e => setPatchApproval(a => ({ ...a, [p.id]: e.target.checked }))}
                          style={{ marginRight: '0.25rem' }} />
                        approval_req
                      </label>
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
  form:         { display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: '560px' },
  sectionLabel: { margin: 0, fontSize: '0.75rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' },
  label:        { display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.875rem' },
  checkboxLabel:{ display: 'flex', alignItems: 'center', fontSize: '0.875rem', cursor: 'pointer' },
  hint:         { color: '#888', fontSize: '0.75rem', marginLeft: '0.25rem' },
  input:        { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  select:       { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  textarea:     { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.8rem', border: '1px solid #ccc', resize: 'vertical' },
  row:          { display: 'flex', gap: '0.75rem' },
  btn:          { padding: '0.4rem 1rem', fontFamily: 'monospace', cursor: 'pointer', alignSelf: 'flex-start', marginTop: '0.25rem' },
  hr:           { margin: '1.5rem 0', borderColor: '#ddd' },
  muted:        { color: '#666', fontSize: '0.875rem' },
  muted2:       { color: '#999', fontSize: '0.75rem' },
  tableWrap:    { overflowX: 'auto' },
  table:        { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  th:           { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' },
  td:           { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word' },
  tdCtrl:       { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', whiteSpace: 'nowrap' },
  ctrlRow:      { display: 'flex', gap: '0.3rem', alignItems: 'center' },
  selectSm:     { padding: '0.2rem 0.3rem', fontFamily: 'monospace', fontSize: '0.75rem', border: '1px solid #ccc' },
  btnSm:        { padding: '0.2rem 0.5rem', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' },
  checkboxSm:   { display: 'flex', alignItems: 'center', fontSize: '0.72rem', marginTop: '0.25rem', cursor: 'pointer' },
}
