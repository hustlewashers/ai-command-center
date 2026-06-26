'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPost, apiPatch, ApiClientError } from '@/lib/api-client'
import { Alert, StatusBadge, LookupSelect } from '@/components/ui'
import type { ApprovalRow, ApprovalSubjectType } from '@/types/approvals'

const SUBJECT_TYPES: ApprovalSubjectType[] = ['task', 'work_packet', 'decision', 'output']
const CATEGORIES = ['a', 'b'] as const
const RESOLUTION_STATUSES = ['approved', 'rejected', 'withdrawn'] as const

const SUBJECT_LOOKUP: Record<string, { url: string; labelKey: string; secondaryKey: string } | null> = {
  task:        { url: '/api/lookups/tasks',        labelKey: 'title',   secondaryKey: 'status' },
  work_packet: { url: '/api/lookups/work-packets', labelKey: 'title',   secondaryKey: 'status' },
  decision:    { url: '/api/lookups/decisions',    labelKey: 'summary', secondaryKey: 'status' },
  output:      null,
}

function short(uuid: string | null | undefined): string {
  return uuid ? uuid.slice(0, 8) + '…' : '—'
}

export default function ApprovalsPage() {
  const router = useRouter()
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)

  const [subjectType, setSubjectType] = useState<ApprovalSubjectType>('task')
  const [subjectId, setSubjectId] = useState('')
  const [category, setCategory] = useState<'a' | 'b'>('a')
  const [triggerReason, setTriggerReason] = useState('')
  const [departmentId, setDepartmentId] = useState('')
  const [approverRole, setApproverRole] = useState('')
  const [approverUserId, setApproverUserId] = useState('')
  const [expiresAt, setExpiresAt] = useState('')

  const [resolveId, setResolveId] = useState('')
  const [resolveStatus, setResolveStatus] = useState<'approved' | 'rejected' | 'withdrawn'>('approved')
  const [resolveNote, setResolveNote] = useState('')
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)

  const loadApprovals = useCallback(async () => {
    setLoadError(null)
    try {
      const data = await apiGet<ApprovalRow[]>('/api/approvals')
      setApprovals(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load approvals')
    }
  }, [router])

  useEffect(() => { loadApprovals().finally(() => setLoading(false)) }, [loadApprovals])

  function handleSubjectTypeChange(newType: ApprovalSubjectType) {
    setSubjectType(newType)
    setSubjectId('')
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError(null)
    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = {
        subject_type:   subjectType,
        subject_id:     subjectId.trim(),
        category,
        trigger_reason: triggerReason.trim(),
        department_id:  departmentId.trim(),
        approver_role:  approverRole.trim(),
      }
      if (approverUserId.trim()) payload.approver_user_id = approverUserId.trim()
      if (expiresAt) payload.expires_at = new Date(expiresAt).toISOString()
      await apiPost('/api/approvals', payload)
      setSubjectId(''); setTriggerReason(''); setDepartmentId(''); setApproverRole('')
      setApproverUserId(''); setExpiresAt('')
      await loadApprovals()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setSubmitError(err instanceof ApiClientError ? err.message : 'Create failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault()
    setResolveError(null)
    setResolving(true)
    try {
      const payload: Record<string, unknown> = { status: resolveStatus }
      if (resolveNote.trim()) payload.decision_note = resolveNote.trim()
      await apiPatch(`/api/approvals/${resolveId.trim()}`, payload)
      setResolveId(''); setResolveNote('')
      await loadApprovals()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setResolveError(err instanceof ApiClientError ? err.message : 'Resolve failed')
    } finally {
      setResolving(false)
    }
  }

  const subjectMeta = SUBJECT_LOOKUP[subjectType]
  const canCreate = subjectId.trim().length > 0 && triggerReason.trim().length > 0 &&
    departmentId.trim().length > 0 && approverRole.trim().length > 0

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Approvals</h1>

      <h2 style={s.h2}>Create approval</h2>
      <form onSubmit={handleCreate} style={s.form}>
        <p style={s.sectionLabel}>Required</p>
        <label style={s.label}>
          Subject Type
          <select value={subjectType} onChange={e => handleSubjectTypeChange(e.target.value as ApprovalSubjectType)} style={s.select}>
            {SUBJECT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label style={s.label}>
          Subject <span style={s.hint}>(the {subjectType} being approved)</span>
          <LookupSelect key={`subj-${subjectType}`}
            url={subjectMeta?.url ?? null}
            labelKey={subjectMeta?.labelKey ?? 'id'}
            secondaryKey={subjectMeta?.secondaryKey}
            value={subjectId} onChange={setSubjectId}
            placeholder={`Select ${subjectType}…`} required />
        </label>
        <label style={s.label}>
          Category <span style={s.hint}>(a = lightweight, b = formal)</span>
          <select value={category} onChange={e => setCategory(e.target.value as 'a' | 'b')} style={s.select}>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label style={s.label}>
          Trigger Reason
          <input value={triggerReason} onChange={e => setTriggerReason(e.target.value)} required
            placeholder="e.g. High-risk execution pathway detected" style={s.input} />
        </label>
        <label style={s.label}>
          Department
          <LookupSelect url="/api/lookups/departments" labelKey="name"
            value={departmentId} onChange={setDepartmentId} placeholder="Select department…" required />
        </label>
        <label style={s.label}>
          Approver Role <span style={s.hint}>(freeform)</span>
          <input value={approverRole} onChange={e => setApproverRole(e.target.value)} required
            placeholder="department_lead" style={s.input} />
        </label>
        <p style={{ ...s.sectionLabel, marginTop: '0.75rem' }}>Optional</p>
        <label style={s.label}>
          Approver User ID
          <input value={approverUserId} onChange={e => setApproverUserId(e.target.value)}
            placeholder="UUID (leave blank to unset)" style={s.input} />
        </label>
        <label style={s.label}>
          Expires At
          <input type="datetime-local" value={expiresAt} onChange={e => setExpiresAt(e.target.value)} style={s.input} />
        </label>
        <Alert type="error" message={submitError} />
        <button type="submit" disabled={submitting || !canCreate} style={s.btn}>
          {submitting ? 'Creating…' : 'Create approval'}
        </button>
      </form>

      <hr style={s.hr} />

      <h2 style={s.h2}>Resolve approval</h2>
      <form onSubmit={handleResolve} style={s.form}>
        <label style={s.label}>
          Approval ID
          <input value={resolveId} onChange={e => setResolveId(e.target.value)} required
            placeholder="UUID of the pending approval" style={s.input} />
        </label>
        <label style={s.label}>
          Resolution
          <select value={resolveStatus} onChange={e => setResolveStatus(e.target.value as typeof resolveStatus)} style={s.select}>
            {RESOLUTION_STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
        </label>
        <label style={s.label}>
          Decision Note <span style={s.hint}>(optional)</span>
          <input value={resolveNote} onChange={e => setResolveNote(e.target.value)}
            placeholder="Rationale for this resolution" style={s.input} />
        </label>
        <Alert type="error" message={resolveError} />
        <button type="submit" disabled={resolving || resolveId.trim().length === 0} style={s.btn}>
          {resolving ? 'Resolving…' : 'Resolve'}
        </button>
      </form>

      <hr style={s.hr} />

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : loadError ? (
        <Alert type="error" message={loadError} />
      ) : approvals.length === 0 ? (
        <p style={s.muted}>No approvals visible. (Visibility is scoped to your department or assigned tasks.)</p>
      ) : (
        <div style={s.tableWrap}>
          <table style={s.table}>
            <thead>
              <tr>
                {['id', 'dept', 'subject_type', 'subject_id', 'cat', 'trigger_reason', 'approver_role', 'status', 'decided_at', 'created_at'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {approvals.map(a => (
                <tr key={a.id}>
                  <td style={s.td}><code title={a.id}>{short(a.id)}</code></td>
                  <td style={s.td}><code title={a.department_id}>{short(a.department_id)}</code></td>
                  <td style={s.td}><code>{a.subject_type}</code></td>
                  <td style={s.td}><code title={a.subject_id}>{short(a.subject_id)}</code></td>
                  <td style={s.td}><code>{a.category}</code></td>
                  <td style={{ ...s.td, maxWidth: '160px' }}>{a.trigger_reason}</td>
                  <td style={s.td}>{a.approver_role}</td>
                  <td style={s.td}><StatusBadge status={a.status} /></td>
                  <td style={s.td}>{a.decided_at ? new Date(a.decided_at).toLocaleString() : '—'}</td>
                  <td style={s.td}>{new Date(a.created_at).toLocaleString()}</td>
                </tr>
              ))}
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
  h2:           { margin: '0 0 0.75rem', fontSize: '1rem' },
  form:         { display: 'flex', flexDirection: 'column', gap: '0.6rem', maxWidth: '520px' },
  sectionLabel: { margin: 0, fontSize: '0.75rem', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' },
  label:        { display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.875rem' },
  hint:         { color: '#888', fontSize: '0.75rem', marginLeft: '0.25rem' },
  input:        { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  select:       { padding: '0.35rem 0.5rem', fontFamily: 'monospace', fontSize: '0.875rem', border: '1px solid #ccc' },
  btn:          { padding: '0.4rem 1rem', fontFamily: 'monospace', cursor: 'pointer', alignSelf: 'flex-start', marginTop: '0.25rem' },
  hr:           { margin: '1.5rem 0', borderColor: '#ddd' },
  muted:        { color: '#666', fontSize: '0.875rem' },
  tableWrap:    { overflowX: 'auto' },
  table:        { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  th:           { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' },
  td:           { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word' },
}
