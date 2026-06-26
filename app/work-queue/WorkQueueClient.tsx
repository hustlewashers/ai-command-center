'use client'

import Link from 'next/link'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { apiGet, apiPatch, ApiClientError } from '@/lib/api-client'
import { StatusBadge } from '@/components/ui'
import type { TaskRow } from '@/types/tasks'
import type { ApprovalRow } from '@/types/approvals'
import type { WorkPacketRow } from '@/types/work-packets'
import type { BlockerRow } from '@/types/blockers'
import type { OutputRow } from '@/types/outputs'
import type { RequestRow } from '@/types/requests'

// ---------- quick-action maps ----------

const TASK_NEXT: Record<string, { label: string; status: string } | undefined> = {
  backlog:     { label: '→ Ready',   status: 'ready' },
  ready:       { label: '→ Start',   status: 'in_progress' },
  in_progress: { label: '→ Review',  status: 'in_review' },
  blocked:     { label: '→ Resume',  status: 'in_progress' },
  in_review:   { label: '→ Done',    status: 'done' },
}

const WP_NEXT: Record<string, { label: string; status: string } | undefined> = {
  draft:        { label: '→ Ready',   status: 'ready' },
  ready:        { label: '→ Execute', status: 'in_execution' },
  in_execution: { label: '→ Accept',  status: 'accepted' },
  // pending_approval: intentionally omitted — gate must resolve first
}

const OUTPUT_NEXT: Record<string, { label: string; status: string } | undefined> = {
  draft:     { label: '→ Review',  status: 'in_review' },
  in_review: { label: '→ Approve', status: 'approved' },
  approved:  { label: '→ Deliver', status: 'delivered' },
}

const REQUEST_NEXT: Record<string, { label: string; status: string } | undefined> = {
  received:    { label: '→ Triaged',     status: 'triaged' },
  triaged:     { label: '→ In Progress', status: 'in_progress' },
  in_progress: { label: '→ Complete',    status: 'completed' },
}

// ---------- inner components ----------

interface SectionProps {
  title: string
  count: number
  href: string
  loading: boolean
  error: string | null
  note?: string
  children: React.ReactNode
}

function Section({ title, count, href, loading, error, note, children }: SectionProps) {
  return (
    <div style={s.card}>
      <div style={s.cardHdr}>
        <b style={s.cardTitle}>{title}</b>
        <span style={s.cardCount}>{count}</span>
        {note && <span style={s.cardNote}>{note}</span>}
        <Link href={href} style={s.cardLink}>View all →</Link>
      </div>
      <div style={s.cardBody}>
        {loading
          ? <p style={s.muted}>Loading…</p>
          : error
          ? <p style={s.errTxt}>{error}</p>
          : children}
      </div>
    </div>
  )
}

function TH({ children }: { children: React.ReactNode }) {
  return <th style={s.th}>{children}</th>
}

function TD({ children, w }: { children: React.ReactNode; w?: string }) {
  return (
    <td style={{ ...s.td, ...(w ? { maxWidth: w, wordBreak: 'break-word' as const } : {}) }}>
      {children}
    </td>
  )
}

function Empty({ label }: { label: string }) {
  return <p style={s.muted}>{label}</p>
}

interface ActBtnProps {
  onClick: () => void
  disabled?: boolean
  variant?: 'default' | 'green' | 'red' | 'yellow'
  children: React.ReactNode
}

function ActBtn({ onClick, disabled, variant = 'default', children }: ActBtnProps) {
  const extra: React.CSSProperties =
    variant === 'green'  ? { background: '#d4edda', borderColor: '#aed6bc' } :
    variant === 'red'    ? { background: '#f8d7da', borderColor: '#f0b0b7' } :
    variant === 'yellow' ? { background: '#fff3cd', borderColor: '#f0c674' } : {}
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...s.actBtn, ...extra }}>
      {children}
    </button>
  )
}

function InlineMsg({ msg }: { msg: { ok: boolean; text: string } | undefined }) {
  if (!msg?.text) return null
  return (
    <span style={{ color: msg.ok ? '#060' : '#c00', fontSize: '0.72rem', marginLeft: '0.25rem' }}>
      {msg.text}
    </span>
  )
}

// ---------- main component ----------

interface Props {
  userId: string
  role: string
  departmentId: string | null
}

export default function WorkQueueClient({ userId, role, departmentId }: Props) {
  const router = useRouter()

  // section data
  const [tasks, setTasks]       = useState<TaskRow[]>([])
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [wps, setWps]           = useState<WorkPacketRow[]>([])
  const [blockers, setBlockers] = useState<BlockerRow[]>([])
  const [outputs, setOutputs]   = useState<OutputRow[]>([])
  const [requests, setRequests] = useState<RequestRow[]>([])

  // section loading / error (object keeps state compact)
  const [loading, setLoading] = useState({
    tasks: true, approvals: true, wps: true, blockers: true, outputs: true, requests: true,
  })
  const [errors, setErrors] = useState<Record<string, string | null>>({
    tasks: null, approvals: null, wps: null, blockers: null, outputs: null, requests: null,
  })

  // per-row action state (shared across all entity types; UUIDs don't collide)
  const [actioning, setActioning] = useState<Record<string, boolean>>({})
  const [actionMsg, setActionMsg] = useState<Record<string, { ok: boolean; text: string }>>({})

  // approval-specific: optional decision_note per row
  const [approvalNote, setApprovalNote] = useState<Record<string, string>>({})

  // blocker-specific: show resolve note input per row
  const [resolveFor, setResolveFor]   = useState<Record<string, boolean>>({})
  const [resolveNote, setResolveNote] = useState<Record<string, string>>({})

  // ---------- error helper ----------

  const handleApiError = useCallback((err: unknown, section: string) => {
    if (err instanceof ApiClientError && err.isUnauthenticated) {
      router.push('/login')
    } else {
      setErrors(e => ({
        ...e,
        [section]: err instanceof ApiClientError ? err.message : `Failed to load ${section}`,
      }))
    }
  }, [router])

  // ---------- load functions ----------

  const loadTasks = useCallback(async () => {
    setLoading(l => ({ ...l, tasks: true }))
    setErrors(e => ({ ...e, tasks: null }))
    try {
      const data = await apiGet<TaskRow[]>('/api/tasks')
      setTasks(data.filter(t =>
        t.assigned_to_user_id === userId &&
        !['done', 'cancelled'].includes(t.status)
      ))
    } catch (err) {
      handleApiError(err, 'tasks')
    } finally {
      setLoading(l => ({ ...l, tasks: false }))
    }
  }, [userId, handleApiError])

  const loadApprovals = useCallback(async () => {
    setLoading(l => ({ ...l, approvals: true }))
    setErrors(e => ({ ...e, approvals: null }))
    try {
      const data = await apiGet<ApprovalRow[]>('/api/approvals')
      setApprovals(data.filter(a => a.status === 'pending'))
    } catch (err) {
      handleApiError(err, 'approvals')
    } finally {
      setLoading(l => ({ ...l, approvals: false }))
    }
  }, [handleApiError])

  const loadWps = useCallback(async () => {
    setLoading(l => ({ ...l, wps: true }))
    setErrors(e => ({ ...e, wps: null }))
    try {
      const data = await apiGet<WorkPacketRow[]>('/api/work-packets')
      setWps(data.filter(w => ['draft', 'ready', 'pending_approval', 'in_execution'].includes(w.status)))
    } catch (err) {
      handleApiError(err, 'wps')
    } finally {
      setLoading(l => ({ ...l, wps: false }))
    }
  }, [handleApiError])

  const loadBlockers = useCallback(async () => {
    setLoading(l => ({ ...l, blockers: true }))
    setErrors(e => ({ ...e, blockers: null }))
    try {
      const data = await apiGet<BlockerRow[]>('/api/blockers')
      setBlockers(data.filter(b => ['open', 'resolved', 'won_t_fix'].includes(b.status)))
    } catch (err) {
      handleApiError(err, 'blockers')
    } finally {
      setLoading(l => ({ ...l, blockers: false }))
    }
  }, [handleApiError])

  const loadOutputs = useCallback(async () => {
    setLoading(l => ({ ...l, outputs: true }))
    setErrors(e => ({ ...e, outputs: null }))
    try {
      const data = await apiGet<OutputRow[]>('/api/outputs')
      setOutputs(data.filter(o => ['draft', 'in_review', 'approved'].includes(o.status)))
    } catch (err) {
      handleApiError(err, 'outputs')
    } finally {
      setLoading(l => ({ ...l, outputs: false }))
    }
  }, [handleApiError])

  const loadRequests = useCallback(async () => {
    setLoading(l => ({ ...l, requests: true }))
    setErrors(e => ({ ...e, requests: null }))
    try {
      const data = await apiGet<RequestRow[]>('/api/requests')
      setRequests(data.filter(r => !['completed', 'rejected', 'cancelled'].includes(r.status)))
    } catch (err) {
      handleApiError(err, 'requests')
    } finally {
      setLoading(l => ({ ...l, requests: false }))
    }
  }, [handleApiError])

  useEffect(() => {
    loadTasks()
    loadApprovals()
    loadWps()
    loadBlockers()
    loadOutputs()
    loadRequests()
  }, [loadTasks, loadApprovals, loadWps, loadBlockers, loadOutputs, loadRequests])

  // ---------- action helper ----------

  async function doAction(
    endpoint: string,
    id: string,
    patch: Record<string, unknown>,
    reload: () => Promise<void>,
    successMsg: string,
    onSuccess?: () => void,
  ) {
    setActioning(a => ({ ...a, [id]: true }))
    setActionMsg(m => ({ ...m, [id]: { ok: false, text: '' } }))
    try {
      await apiPatch(`/api/${endpoint}/${id}`, patch)
      setActionMsg(m => ({ ...m, [id]: { ok: true, text: successMsg } }))
      await reload()
      onSuccess?.()
    } catch (err) {
      if (err instanceof ApiClientError && err.isUnauthenticated) { router.push('/login'); return }
      setActionMsg(m => ({
        ...m,
        [id]: { ok: false, text: err instanceof ApiClientError ? err.message : 'Action failed' },
      }))
    } finally {
      setActioning(a => ({ ...a, [id]: false }))
    }
  }

  // ---------- render ----------

  return (
    <main style={s.main}>
      <h1 style={s.h1}>Work Queue</h1>

      <div style={s.ctxBar}>
        <span><b>role:</b> {role}</span>
        <span><b>user:</b> <code>{userId.slice(0, 8)}…</code></span>
        {departmentId && <span><b>dept:</b> <code>{departmentId.slice(0, 8)}…</code></span>}
      </div>

      <div style={s.grid}>

        {/* My Tasks */}
        <Section
          title="My Tasks" count={tasks.length} href="/tasks"
          loading={loading.tasks} error={errors.tasks} note="assigned to you"
        >
          {tasks.length === 0
            ? <Empty label="No open tasks assigned to you." />
            : (
              <table style={s.table}>
                <thead><tr><TH>title</TH><TH>priority</TH><TH>status</TH><TH>action</TH></tr></thead>
                <tbody>
                  {tasks.map(t => {
                    const next = TASK_NEXT[t.status]
                    return (
                      <tr key={t.id}>
                        <TD w="160px">{t.title.slice(0, 45)}</TD>
                        <TD>{t.priority}</TD>
                        <TD><StatusBadge status={t.status} /></TD>
                        <TD>
                          {next && (
                            <ActBtn
                              onClick={() => doAction('tasks', t.id, { status: next.status }, loadTasks, next.label)}
                              disabled={!!actioning[t.id]}
                            >
                              {actioning[t.id] ? '…' : next.label}
                            </ActBtn>
                          )}
                          <InlineMsg msg={actionMsg[t.id]} />
                        </TD>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          }
        </Section>

        {/* Pending Approvals */}
        <Section
          title="Pending Approvals" count={approvals.length} href="/approvals"
          loading={loading.approvals} error={errors.approvals}
        >
          {approvals.length === 0
            ? <Empty label="No pending approvals visible to you." />
            : (
              <table style={s.table}>
                <thead><tr><TH>subject</TH><TH>cat</TH><TH>trigger</TH><TH>actions</TH></tr></thead>
                <tbody>
                  {approvals.map(a => {
                    const note = approvalNote[a.id] ?? ''
                    const busy = !!actioning[a.id]
                    return (
                      <tr key={a.id}>
                        <TD><code>{a.subject_type}</code></TD>
                        <TD><code>{a.category}</code></TD>
                        <TD w="130px">{(a.trigger_reason ?? '').slice(0, 40)}</TD>
                        <TD>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
                              <ActBtn variant="green" disabled={busy}
                                onClick={() => doAction('approvals', a.id, { status: 'approved', decision_note: note.trim() || null }, loadApprovals, 'Approved')}>
                                {busy ? '…' : 'Approve'}
                              </ActBtn>
                              <ActBtn variant="red" disabled={busy}
                                onClick={() => doAction('approvals', a.id, { status: 'rejected', decision_note: note.trim() || null }, loadApprovals, 'Rejected')}>
                                {busy ? '…' : 'Reject'}
                              </ActBtn>
                              <ActBtn disabled={busy}
                                onClick={() => doAction('approvals', a.id, { status: 'withdrawn' }, loadApprovals, 'Withdrawn')}>
                                {busy ? '…' : 'Withdraw'}
                              </ActBtn>
                            </div>
                            <input
                              value={note}
                              onChange={e => setApprovalNote(n => ({ ...n, [a.id]: e.target.value }))}
                              placeholder="decision_note (optional)"
                              style={s.noteInput}
                            />
                            <InlineMsg msg={actionMsg[a.id]} />
                          </div>
                        </TD>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          }
        </Section>

        {/* Active Work Packets */}
        <Section
          title="Active Work Packets" count={wps.length} href="/work-packets"
          loading={loading.wps} error={errors.wps}
        >
          {wps.length === 0
            ? <Empty label="No active work packets visible to you." />
            : (
              <table style={s.table}>
                <thead><tr><TH>title</TH><TH>priority</TH><TH>status</TH><TH>action</TH></tr></thead>
                <tbody>
                  {wps.map(w => {
                    const next = WP_NEXT[w.status]
                    const busy = !!actioning[w.id]
                    return (
                      <tr key={w.id}>
                        <TD w="150px">{w.title.slice(0, 42)}</TD>
                        <TD>{w.priority}</TD>
                        <TD><StatusBadge status={w.status} /></TD>
                        <TD>
                          {w.status === 'pending_approval'
                            ? <span style={s.gateNote}>awaiting approval</span>
                            : next
                            ? (
                              <ActBtn disabled={busy}
                                onClick={() => doAction('work-packets', w.id, { status: next.status }, loadWps, next.label)}>
                                {busy ? '…' : next.label}
                              </ActBtn>
                            )
                            : null
                          }
                          <InlineMsg msg={actionMsg[w.id]} />
                        </TD>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          }
        </Section>

        {/* Blockers */}
        <Section
          title="Blockers" count={blockers.length} href="/blockers"
          loading={loading.blockers} error={errors.blockers}
        >
          {blockers.length === 0
            ? <Empty label="No open or recently resolved blockers." />
            : (
              <table style={s.table}>
                <thead><tr><TH>description</TH><TH>sev</TH><TH>entity</TH><TH>status</TH><TH>action</TH></tr></thead>
                <tbody>
                  {blockers.map(b => {
                    const busy = !!actioning[b.id]
                    const isResolving = !!resolveFor[b.id]
                    const note = resolveNote[b.id] ?? ''
                    return (
                      <tr key={b.id}>
                        <TD w="130px">{(b.description ?? '').slice(0, 38)}</TD>
                        <TD>{b.severity}</TD>
                        <TD>{b.blocked_entity_type}</TD>
                        <TD><StatusBadge status={b.status} /></TD>
                        <TD>
                          {b.status === 'open' && !isResolving && (
                            <ActBtn variant="yellow" disabled={busy}
                              onClick={() => setResolveFor(r => ({ ...r, [b.id]: true }))}>
                              Resolve
                            </ActBtn>
                          )}
                          {b.status === 'open' && isResolving && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                              <input
                                value={note}
                                onChange={e => setResolveNote(n => ({ ...n, [b.id]: e.target.value }))}
                                placeholder="Resolution note (required)"
                                style={s.noteInput}
                                autoFocus
                              />
                              <div style={{ display: 'flex', gap: '0.25rem' }}>
                                <ActBtn variant="yellow" disabled={busy}
                                  onClick={() => {
                                    const n = note.trim()
                                    if (!n) {
                                      setActionMsg(m => ({ ...m, [b.id]: { ok: false, text: 'Note required' } }))
                                      return
                                    }
                                    doAction(
                                      'blockers', b.id,
                                      { status: 'resolved', resolution_note: n },
                                      loadBlockers,
                                      'Resolved',
                                      () => {
                                        setResolveFor(r => { const x = { ...r }; delete x[b.id]; return x })
                                        setResolveNote(nn => { const x = { ...nn }; delete x[b.id]; return x })
                                      },
                                    )
                                  }}>
                                  {busy ? '…' : 'Confirm'}
                                </ActBtn>
                                <ActBtn disabled={busy}
                                  onClick={() => {
                                    setResolveFor(r => { const x = { ...r }; delete x[b.id]; return x })
                                    setResolveNote(nn => { const x = { ...nn }; delete x[b.id]; return x })
                                  }}>
                                  Cancel
                                </ActBtn>
                              </div>
                            </div>
                          )}
                          {(b.status === 'resolved' || b.status === 'won_t_fix') && (
                            <ActBtn disabled={busy}
                              onClick={() => doAction('blockers', b.id, { status: 'open', severity: b.severity }, loadBlockers, 'Reopened')}>
                              {busy ? '…' : 'Reopen'}
                            </ActBtn>
                          )}
                          <InlineMsg msg={actionMsg[b.id]} />
                        </TD>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          }
        </Section>

        {/* Outputs Needing Attention — full width */}
        <div style={s.fullSpan}>
          <Section
            title="Outputs Needing Attention" count={outputs.length} href="/outputs"
            loading={loading.outputs} error={errors.outputs}
          >
            {outputs.length === 0
              ? <Empty label="No outputs in draft, in_review, or approved." />
              : (
                <table style={s.table}>
                  <thead><tr><TH>title</TH><TH>type</TH><TH>status</TH><TH>produced</TH><TH>action</TH></tr></thead>
                  <tbody>
                    {outputs.map(o => {
                      const next = OUTPUT_NEXT[o.status]
                      const busy = !!actioning[o.id]
                      return (
                        <tr key={o.id}>
                          <TD w="220px">{o.title.slice(0, 60)}</TD>
                          <TD>{o.output_type}</TD>
                          <TD><StatusBadge status={o.status} /></TD>
                          <TD>{new Date(o.produced_at).toLocaleDateString()}</TD>
                          <TD>
                            {next && (
                              <ActBtn disabled={busy}
                                onClick={() => doAction('outputs', o.id, { status: next.status }, loadOutputs, next.label)}>
                                {busy ? '…' : next.label}
                              </ActBtn>
                            )}
                            <InlineMsg msg={actionMsg[o.id]} />
                          </TD>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )
            }
          </Section>
        </div>

        {/* Requests — full width */}
        <div style={s.fullSpan}>
          <Section
            title="Requests" count={requests.length} href="/requests"
            loading={loading.requests} error={errors.requests}
          >
            {requests.length === 0
              ? <Empty label="No open requests visible to you." />
              : (
                <table style={s.table}>
                  <thead><tr><TH>intent</TH><TH>status</TH><TH>submitted</TH><TH>action</TH></tr></thead>
                  <tbody>
                    {requests.map(r => {
                      const next = REQUEST_NEXT[r.status]
                      const busy = !!actioning[r.id]
                      return (
                        <tr key={r.id}>
                          <TD w="280px">{r.intent.slice(0, 80)}</TD>
                          <TD><StatusBadge status={r.status} /></TD>
                          <TD>{new Date(r.submitted_at).toLocaleDateString()}</TD>
                          <TD>
                            {next && (
                              <ActBtn disabled={busy}
                                onClick={() => doAction('requests', r.id, { status: next.status }, loadRequests, next.label)}>
                                {busy ? '…' : next.label}
                              </ActBtn>
                            )}
                            <InlineMsg msg={actionMsg[r.id]} />
                          </TD>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )
            }
          </Section>
        </div>

      </div>
    </main>
  )
}

// ---------- styles ----------

const s: Record<string, React.CSSProperties> = {
  main:      { fontFamily: 'monospace', padding: '2rem', maxWidth: '1400px' },
  h1:        { margin: '0 0 0.75rem', fontSize: '1.4rem' },
  ctxBar:    { display: 'flex', gap: '1.5rem', marginBottom: '1.5rem', fontSize: '0.8rem', color: '#555', flexWrap: 'wrap' },
  grid:      { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' },
  fullSpan:  { gridColumn: '1 / -1' },
  card:      { border: '1px solid #ddd', borderRadius: '4px', overflow: 'hidden' },
  cardHdr:   { display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.45rem 0.75rem', background: '#f5f5f5', borderBottom: '1px solid #ddd' },
  cardTitle: { fontWeight: 'bold', fontSize: '0.83rem', flex: 1 },
  cardCount: { background: '#333', color: '#fff', padding: '0.1rem 0.4rem', borderRadius: '3px', fontSize: '0.75rem', fontWeight: 'bold' },
  cardNote:  { color: '#888', fontSize: '0.72rem', fontStyle: 'italic' },
  cardLink:  { color: '#666', fontSize: '0.75rem', textDecoration: 'none', whiteSpace: 'nowrap' },
  cardBody:  { padding: '0.25rem 0' },
  table:     { borderCollapse: 'collapse', width: '100%', fontSize: '0.78rem' },
  th:        { textAlign: 'left', padding: '0.2rem 0.75rem', color: '#888', fontSize: '0.72rem', fontWeight: 'normal', borderBottom: '1px solid #eee' },
  td:        { padding: '0.25rem 0.75rem', borderBottom: '1px solid #f0f0f0', verticalAlign: 'top' },
  muted:     { margin: 0, padding: '0.5rem 0.75rem', color: '#aaa', fontSize: '0.8rem' },
  errTxt:    { margin: 0, padding: '0.5rem 0.75rem', color: '#c00', fontSize: '0.8rem' },
  actBtn:    { padding: '0.15rem 0.4rem', fontFamily: 'monospace', fontSize: '0.72rem', cursor: 'pointer', border: '1px solid #ccc', borderRadius: '2px', marginRight: '0.2rem' },
  noteInput: { padding: '0.15rem 0.3rem', fontFamily: 'monospace', fontSize: '0.72rem', border: '1px solid #ccc', width: '100%', boxSizing: 'border-box' },
  gateNote:  { color: '#888', fontSize: '0.72rem', fontStyle: 'italic' },
}
