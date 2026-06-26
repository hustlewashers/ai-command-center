const COLORS: Record<string, { bg: string; color: string }> = {
  open:             { bg: '#fff3cd', color: '#856404' },
  draft:            { bg: '#e9ecef', color: '#495057' },
  resolved:         { bg: '#d4edda', color: '#155724' },
  approved:         { bg: '#d4edda', color: '#155724' },
  delivered:        { bg: '#d4edda', color: '#155724' },
  done:             { bg: '#d4edda', color: '#155724' },
  completed:        { bg: '#d4edda', color: '#155724' },
  accepted:         { bg: '#d4edda', color: '#155724' },
  in_progress:      { bg: '#cce5ff', color: '#004085' },
  in_review:        { bg: '#cce5ff', color: '#004085' },
  in_execution:     { bg: '#cce5ff', color: '#004085' },
  triaged:          { bg: '#cce5ff', color: '#004085' },
  investigating:    { bg: '#cce5ff', color: '#004085' },
  confirmed:        { bg: '#cce5ff', color: '#004085' },
  pending:          { bg: '#fff3cd', color: '#856404' },
  pending_approval: { bg: '#fff3cd', color: '#856404' },
  pending_external: { bg: '#fff3cd', color: '#856404' },
  ready:            { bg: '#d1ecf1', color: '#0c5460' },
  proposed:         { bg: '#d1ecf1', color: '#0c5460' },
  received:         { bg: '#e9ecef', color: '#495057' },
  backlog:          { bg: '#e9ecef', color: '#6c757d' },
  rejected:         { bg: '#f8d7da', color: '#721c24' },
  cancelled:        { bg: '#f8d7da', color: '#721c24' },
  won_t_fix:        { bg: '#f8d7da', color: '#721c24' },
  blocked:          { bg: '#f8d7da', color: '#721c24' },
  expired:          { bg: '#f8d7da', color: '#721c24' },
  superseded:       { bg: '#e9ecef', color: '#6c757d' },
  withdrawn:        { bg: '#e9ecef', color: '#6c757d' },
}

const DEFAULT = { bg: '#e9ecef', color: '#495057' }

interface StatusBadgeProps {
  status: string
  style?: React.CSSProperties
}

export function StatusBadge({ status, style }: StatusBadgeProps) {
  const c = COLORS[status] ?? DEFAULT
  return (
    <span style={{
      display: 'inline-block',
      padding: '0.1rem 0.35rem',
      background: c.bg,
      color: c.color,
      border: `1px solid ${c.color}33`,
      borderRadius: '3px',
      fontFamily: 'monospace',
      fontSize: '0.75rem',
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {status}
    </span>
  )
}
