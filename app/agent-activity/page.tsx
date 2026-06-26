'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, ApiClientError } from '@/lib/api-client'
import { StatusBadge, Alert } from '@/components/ui'
import type { AgentActivityRow, AgentActivityStatus } from '@/types/agent-activity'

const STATUSES: AgentActivityStatus[] = ['completed', 'failed', 'skipped', 'flagged']

function short(id: string | null | undefined): string {
  return id ? id.slice(0, 8) + '…' : '—'
}


export default function AgentActivityPage() {
  const router = useRouter()

  const [rows, setRows] = useState<AgentActivityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // filter state
  const [filterStatus, setFilterStatus]       = useState('')
  const [filterType, setFilterType]           = useState('')
  const [filterTaskId, setFilterTaskId]       = useState('')
  const [pendingTaskId, setPendingTaskId]     = useState('')

  const load = useCallback(async (status: string, type: string, taskId: string) => {
    setLoading(true)
    setLoadError(null)
    try {
      const params = new URLSearchParams()
      if (status) params.set('status', status)
      if (type)   params.set('activity_type', type)
      if (taskId) params.set('task_id', taskId)
      const qs = params.toString()
      const data = await apiGet<AgentActivityRow[]>(`/api/agent-activity${qs ? `?${qs}` : ''}`)
      setRows(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load activity')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    load(filterStatus, filterType, filterTaskId)
  }, [load, filterStatus, filterType, filterTaskId])

  function applyTaskId() {
    setFilterTaskId(pendingTaskId.trim())
  }

  function clearFilters() {
    setFilterStatus('')
    setFilterType('')
    setFilterTaskId('')
    setPendingTaskId('')
  }

  const hasFilter = !!(filterStatus || filterType || filterTaskId)

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Agent Activity</h1>

      {/* Filters */}
      <div style={s.filterBar}>
        <label style={s.filterLabel}>
          Status
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={s.select}>
            <option value="">All</option>
            {STATUSES.map(st => <option key={st} value={st}>{st}</option>)}
          </select>
        </label>

        <label style={s.filterLabel}>
          Activity Type
          <input
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            placeholder="e.g. task_execution"
            style={s.input}
          />
        </label>

        <label style={s.filterLabel}>
          Task ID
          <div style={{ display: 'flex', gap: '0.3rem' }}>
            <input
              value={pendingTaskId}
              onChange={e => setPendingTaskId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyTaskId()}
              placeholder="UUID or prefix"
              style={{ ...s.input, width: '180px' }}
            />
            <button onClick={applyTaskId} style={s.btn}>Apply</button>
          </div>
        </label>

        {hasFilter && (
          <button onClick={clearFilters} style={{ ...s.btn, marginTop: '1.1rem' }}>
            Clear filters
          </button>
        )}
      </div>

      <Alert type="error" message={loadError} />

      {loading ? (
        <p style={s.muted}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={s.muted}>
          {hasFilter
            ? 'No activity matches these filters.'
            : 'No agent activity visible. (Scoped by RLS — agents see their own activity, dept roles see scoped activity, org_admin sees all.)'}
        </p>
      ) : (
        <div style={s.tableWrap}>
          <p style={s.rowCount}>{rows.length} row{rows.length !== 1 ? 's' : ''}</p>
          <table style={s.table}>
            <thead>
              <tr>
                {['type', 'summary', 'status', 'agent', 'task', 'work_packet', 'created'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td style={s.td}><code>{r.activity_type}</code></td>
                  <td style={{ ...s.td, maxWidth: '240px' }}>{r.summary}</td>
                  <td style={s.td}><StatusBadge status={r.status} /></td>
                  <td style={s.td}><code title={r.agent_user_id ?? ''}>{short(r.agent_user_id)}</code></td>
                  <td style={s.td}><code title={r.task_id ?? ''}>{short(r.task_id)}</code></td>
                  <td style={s.td}><code title={r.work_packet_id ?? ''}>{short(r.work_packet_id)}</code></td>
                  <td style={s.td} title={r.created_at}>
                    {new Date(r.created_at).toLocaleString()}
                  </td>
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
  main:       { fontFamily: 'monospace', padding: '2rem', maxWidth: '1400px' },
  h1:         { margin: '0 0 1.25rem', fontSize: '1.4rem' },
  filterBar:  { display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-end' },
  filterLabel:{ display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem' },
  select:     { padding: '0.3rem 0.4rem', fontFamily: 'monospace', fontSize: '0.8rem', border: '1px solid #ccc' },
  input:      { padding: '0.3rem 0.4rem', fontFamily: 'monospace', fontSize: '0.8rem', border: '1px solid #ccc' },
  btn:        { padding: '0.3rem 0.6rem', fontFamily: 'monospace', fontSize: '0.8rem', cursor: 'pointer', border: '1px solid #ccc', alignSelf: 'flex-end' },
  muted:      { color: '#666', fontSize: '0.875rem' },
  rowCount:   { margin: '0 0 0.5rem', color: '#888', fontSize: '0.8rem' },
  tableWrap:  { overflowX: 'auto' },
  table:      { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  th:         { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' },
  td:         { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word' },
}
