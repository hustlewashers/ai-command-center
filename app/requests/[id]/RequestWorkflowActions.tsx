'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { apiGet, apiPost, ApiClientError } from '@/lib/api-client'

type Lookup = { id: string; name: string }
type TriggerResult = {
  triggered: boolean; deduped: boolean
  workflow_id: string | null; background_job_id: string | null; workflow_run_id: string | null
  reason: string
}
type Feedback = { kind: 'ok'; result: TriggerResult } | { kind: 'err'; message: string }

export default function RequestWorkflowActions({
  requestId,
  roleAllowed,
  hasActiveWorkflow,
  missingInputs,
  defaultProjectId,
  defaultDepartmentId,
}: {
  requestId: string
  roleAllowed: boolean
  hasActiveWorkflow: boolean
  missingInputs: string[]
  defaultProjectId: string
  defaultDepartmentId: string
}) {
  const router = useRouter()
  const [projects, setProjects] = useState<Lookup[]>([])
  const [depts, setDepts] = useState<Lookup[]>([])
  const [projectId, setProjectId] = useState(defaultProjectId)
  const [deptId, setDeptId] = useState(defaultDepartmentId)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const needProject = missingInputs.includes('project_id')
  const needDept    = missingInputs.includes('department_id')

  // Only fetch lookups when the operator must supply missing inputs.
  useEffect(() => {
    if (needProject) apiGet<Lookup[]>('/api/lookups/projects').then(setProjects).catch(() => {})
    if (needDept)    apiGet<Lookup[]>('/api/lookups/departments').then(setDepts).catch(() => {})
  }, [needProject, needDept])

  if (!roleAllowed) {
    return <div style={s.note}>Your role cannot start workflows.</div>
  }
  if (hasActiveWorkflow) {
    return <div style={s.note}>A workflow is already active for this request.</div>
  }

  const blocked = (needProject && !projectId) || (needDept && !deptId)

  async function start() {
    setBusy(true)
    setFeedback(null)
    try {
      const body: Record<string, string> = { workflow_id: 'request_to_task' }
      if (needProject && projectId) body.project_id = projectId
      if (needDept && deptId)       body.department_id = deptId
      const result = await apiPost<TriggerResult>(`/api/requests/${requestId}/trigger-workflow`, body)
      setFeedback({ kind: 'ok', result })
      router.refresh()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setFeedback({ kind: 'err', message: err instanceof ApiClientError ? err.message : 'Trigger failed' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      {(needProject || needDept) && (
        <div style={s.warn}>
          <strong>Missing workflow inputs.</strong> This request has no{' '}
          {[needDept ? 'department' : null, needProject ? 'project' : null].filter(Boolean).join(' or ')}.
          Choose values below to start the workflow — they are saved back onto the request.
          <div style={s.selectRow}>
            {needDept && (
              <label style={s.field}>
                <span style={s.fieldLabel}>Department</span>
                <select value={deptId} onChange={e => setDeptId(e.target.value)} style={s.select}>
                  <option value="">— select —</option>
                  {depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
            )}
            {needProject && (
              <label style={s.field}>
                <span style={s.fieldLabel}>Project</span>
                <select value={projectId} onChange={e => setProjectId(e.target.value)} style={s.select}>
                  <option value="">— select —</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
            )}
          </div>
        </div>
      )}

      <button type="button" onClick={start} disabled={busy || blocked} style={{ ...s.btn, opacity: busy || blocked ? 0.5 : 1 }}>
        {busy ? 'Starting…' : 'Start request_to_task workflow'}
      </button>

      {feedback?.kind === 'err' && <div style={s.err}>{feedback.message}</div>}
      {feedback?.kind === 'ok' && (() => {
        const r = feedback.result
        // skipped = neither triggered nor deduped (e.g. still missing inputs)
        const tone = r.triggered ? s.ok : r.deduped ? s.info : s.warnMsg
        return (
          <div style={tone}>
            <span>
              {r.triggered ? 'Workflow enqueued.'
                : r.deduped ? 'A workflow is already active — reused it.'
                : `Not started: ${r.reason}`}
            </span>
            {r.workflow_run_id && (
              <Link href={`/workflow-runs/${r.workflow_run_id}`} style={s.link}>view run</Link>
            )}
            {!r.workflow_run_id && r.background_job_id && (
              <Link href="/background-jobs" style={s.link}>view job</Link>
            )}
          </div>
        )
      })()}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  note:       { fontSize: 13, color: '#6b7280' },
  warn:       { background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '10px 12px', marginBottom: 10, fontSize: 12, color: '#92400e' },
  selectRow:  { display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' },
  field:      { display: 'flex', flexDirection: 'column', gap: 2 },
  fieldLabel: { fontSize: 11, color: '#6b7280' },
  select:     { padding: '4px 6px', fontFamily: 'monospace', fontSize: 12, border: '1px solid #ccc', borderRadius: 4 },
  btn:        { background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 14px', fontSize: 13, fontWeight: 700, fontFamily: 'monospace', cursor: 'pointer' },
  err:        { marginTop: 10, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#dc2626' },
  ok:         { marginTop: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#15803d', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  info:       { marginTop: 10, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#1d4ed8', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  warnMsg:    { marginTop: 10, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 4, padding: '8px 12px', fontSize: 12, color: '#92400e', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' },
  link:       { color: '#2563eb', textDecoration: 'none', fontWeight: 700 },
}
