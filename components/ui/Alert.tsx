interface AlertProps {
  type: 'error' | 'success' | 'info'
  message: string | null
}

export function Alert({ type, message }: AlertProps) {
  if (!message) return null
  const c = type === 'error'
    ? { bg: '#fff0f0', color: '#c00', border: '#fcc' }
    : type === 'success'
    ? { bg: '#f0fff0', color: '#060', border: '#afa' }
    : { bg: '#f0f4ff', color: '#004', border: '#aaf' }
  return (
    <p style={{
      margin: 0,
      padding: '0.5rem 0.75rem',
      background: c.bg,
      color: c.color,
      border: `1px solid ${c.border}`,
      fontFamily: 'monospace',
      fontSize: '0.875rem',
    }}>
      {message}
    </p>
  )
}
