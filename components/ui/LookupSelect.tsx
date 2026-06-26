'use client'

import { useState, useEffect } from 'react'

interface LookupOption {
  id: string
  [key: string]: string
}

interface LookupSelectProps {
  url: string | null
  labelKey: string
  secondaryKey?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  required?: boolean
  style?: React.CSSProperties
}

export function LookupSelect({
  url,
  labelKey,
  secondaryKey,
  value,
  onChange,
  placeholder,
  required,
  style,
}: LookupSelectProps) {
  const [options, setOptions] = useState<LookupOption[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!url) return
    setLoading(true)
    setOptions([])
    fetch(url)
      .then(r => r.json())
      .then(j => setOptions(j.data ?? []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [url])

  const base: React.CSSProperties = {
    padding: '0.35rem 0.5rem',
    fontFamily: 'monospace',
    fontSize: '0.875rem',
    border: '1px solid #ccc',
    ...style,
  }

  if (!url) {
    return (
      <input value={value} onChange={e => onChange(e.target.value)}
        required={required} placeholder={placeholder ?? 'UUID'} style={base} />
    )
  }

  if (loading) {
    return <select disabled style={base}><option>Loading…</option></select>
  }

  if (options.length === 0) {
    return (
      <input value={value} onChange={e => onChange(e.target.value)}
        required={required} placeholder={placeholder ?? 'UUID (no options)'} style={base} />
    )
  }

  return (
    <select value={value} onChange={e => onChange(e.target.value)} required={required} style={base}>
      <option value="">{placeholder ?? 'Select…'}</option>
      {options.map(o => {
        const label = (o[labelKey] ?? o.id).slice(0, 48)
        const secondary = secondaryKey ? ` [${o[secondaryKey]}]` : ''
        return (
          <option key={o.id} value={o.id}>
            {label}{secondary} ({o.id.slice(0, 8)})
          </option>
        )
      })}
    </select>
  )
}
