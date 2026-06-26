'use client'

import Link from 'next/link'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, ApiClientError } from '@/lib/api-client'
import { StatusBadge, Alert } from '@/components/ui'
import type { ExecutionLogRow, ExecutionLogEventType, ExecutionLogContextType, ExecutionLogStatus } from '@/types/execution-logs'

const STATUSES: ExecutionLogStatus[]      = ['recorded', 'flagged', 'reviewed', 'corrected']
const EVENT_TYPES: ExecutionLogEventType[] = ['tool_call', 'state_change', 'error', 'note', 'approval_action']
const CONTEXT_TYPES: ExecutionLogContextType[] = ['request', 'task', 'workflow']

function short(id: string): string {
  return id.slice(0, 8) + '…'
}

export default function ExecutionLogsPage() {
  const router = useRouter()

  const [rows, setRows]         = useState<ExecutionLogRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  // filter state — selects apply immediately; text inputs apply on Enter/button
  const [filterStatus,      setFilterStatus]      = useState('')
  const [filterEventType,   setFilterEventType]   = useState('')
  const [filterContextType, setFilterContextType] = useState('')
  const [filterActor,       setFilterActor]       = useState('')
  const [pendingActor,      setPendingActor]      = useState('')
  const [filterContextId,   setFilterContextId]   = useState('')
  const [pendingContextId,  setPendingContextId]  = useState('')

  const load = useCallback(async (
    status: string, eventType: string, contextType: string,
    actor: string, contextId: string,
  ) => {
    setLoading(true)
    setLoadError(null)
    try {
      const params = new URLSearchParams()
      if (status)      params.set('status', status)
      if (eventType)   params.set('event_type', eventType)
      if (contextType) params.set('context_type', contextType)
      if (actor)       params.set('actor', actor)
      if (contextId)   params.set('context_id', contextId)
      const qs = params.toString()
      const data = await apiGet<ExecutionLogRow[]>(`/api/execution-logs${qs ? `?${qs}` : ''}`)
      setRows(data)
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setLoadError(err instanceof ApiClientError ? err.message : 'Failed to load execution logs')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    load(filterStatus, filterEventType, filterContextType, filterActor, filterContextId)
  }, [load, filterStatus, filterEventType, filterContextType, filterActor, filterContextId])

  function applyActor()     { setFilterActor(pendingActor.trim()) }
  function applyContextId() { setFilterContextId(pendingContextId.trim()) }

  function clearFilters() {
    setFilterStatus(''); setFilterEventType(''); setFilterContextType('')
    setFilterActor(''); setPendingActor('')
    setFilterContextId(''); setPendingContextId('')
  }

  const hasFilter = !!(filterStatus || filterEventType || filterContextType || filterActor || filterContextId)

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Execution Logs</h1>

      {/* Filters */}
      <div style={s.filterBar}>
        <label style={s.filterLabel}>
          Status
          <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={s.select}>
            <option value="">All</option>
            {STATUSES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label style={s.filterLabel}>
          Event Type
          <select value={filterEventType} onChange={e => setFilterEventType(e.target.value)} style={s.select}>
            <option value="">All</option>
            {EVENT_TYPES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label style={s.filterLabel}>
          Context Type
          <select value={filterContextType} onChange={e => setFilterContextType(e.target.value)} style={s.select}>
            <option value="">All</option>
            {CONTEXT_TYPES.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>

        <label style={s.filterLabel}>
          Actor
          <div style={s.inputRow}>
            <input
              value={pendingActor}
              onChange={e => setPendingActor(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyActor()}
              placeholder="user id or 'system'"
              style={{ ...s.input, width: '160px' }}
            />
            <button onClick={applyActor} style={s.btn}>Apply</button>
          </div>
        </label>

        <label style={s.filterLabel}>
          Context ID
          <div style={s.inputRow}>
            <input
              value={pendingContextId}
              onChange={e => setPendingContextId(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyContextId()}
              placeholder="task / request UUID"
              style={{ ...s.input, width: '180px' }}
            />
            <button onClick={applyContextId} style={s.btn}>Apply</button>
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
            ? 'No execution logs match these filters.'
            : 'No execution logs visible. (Scoped by RLS — department members see logs for their context entities; org_admin sees all.)'}
        </p>
      ) : (
        <div style={s.tableWrap}>
          <p style={s.rowCount}>{rows.length} row{rows.length !== 1 ? 's' : ''}</p>
          <table style={s.table}>
            <thead>
              <tr>
                {['id', 'event_type', 'summary', 'status', 'actor', 'context', 'occurred_at'].map(col => (
                  <th key={col} style={s.th}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr
                  key={r.id}
                  onClick={() => router.push(`/execution-logs/${r.id}`)}
                  style={s.row}
                >
                  <td style={s.td}>
                    <Link href={`/execution-logs/${r.id}`} onClick={e => e.stopPropagation()} style={s.idLink}>
                      <code>{short(r.id)}</code>
                    </Link>
                  </td>
                  <td style={s.td}><code>{r.event_type}</code></td>
                  <td style={{ ...s.td, maxWidth: '260px' }}>{r.summary}</td>
                  <td style={s.td}><StatusBadge status={r.status} /></td>
                  <td style={s.td}><code title={r.actor}>{r.actor === 'system' ? 'system' : short(r.actor)}</code></td>
                  <td style={s.td}>
                    <code>{r.context_type}</code>{' '}
                    <code title={r.context_id}>{short(r.context_id)}</code>
                  </td>
                  <td style={s.td} title={r.occurred_at}>
                    {new Date(r.occurred_at).toLocaleString()}
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
  main:        { fontFamily: 'monospace', padding: '2rem', maxWidth: '1400px' },
  h1:          { margin: '0 0 1.25rem', fontSize: '1.4rem' },
  filterBar:   { display: 'flex', gap: '1rem', marginBottom: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-end' },
  filterLabel: { display: 'flex', flexDirection: 'column', gap: '0.2rem', fontSize: '0.8rem' },
  inputRow:    { display: 'flex', gap: '0.3rem' },
  select:      { padding: '0.3rem 0.4rem', fontFamily: 'monospace', fontSize: '0.8rem', border: '1px solid #ccc' },
  input:       { padding: '0.3rem 0.4rem', fontFamily: 'monospace', fontSize: '0.8rem', border: '1px solid #ccc' },
  btn:         { padding: '0.3rem 0.6rem', fontFamily: 'monospace', fontSize: '0.8rem', cursor: 'pointer', border: '1px solid #ccc', alignSelf: 'flex-end' },
  muted:       { color: '#666', fontSize: '0.875rem' },
  rowCount:    { margin: '0 0 0.5rem', color: '#888', fontSize: '0.8rem' },
  tableWrap:   { overflowX: 'auto' },
  table:       { borderCollapse: 'collapse', width: '100%', fontSize: '0.8rem' },
  th:          { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '2px solid #ddd', whiteSpace: 'nowrap' },
  td:          { padding: '0.3rem 0.5rem', borderBottom: '1px solid #eee', verticalAlign: 'top', wordBreak: 'break-word' },
  row:         { cursor: 'pointer' },
  idLink:      { color: 'inherit', textDecoration: 'none' },
}
