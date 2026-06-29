// Shared detail-page style constants (Sprint 5.15).
// These are the exact inline styles the individual detail pages had been
// re-declaring, lifted into one place so refactored pages render identically.

import type { CSSProperties } from 'react'

export const ds: Record<string, CSSProperties> = {
  page:    { padding: '24px', fontFamily: 'monospace', maxWidth: 1000 },
  header:  { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
  h1:      { fontSize: 20, fontWeight: 700, margin: 0 },
  back:    { fontSize: 13, color: '#6b7280', textDecoration: 'none' },
  section: { marginBottom: 22 },
  h2:      { fontSize: 14, fontWeight: 700, color: '#374151', margin: '0 0 10px' },
  grid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px 16px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: 16 },
  label:   { fontSize: 11, color: '#6b7280', marginBottom: 2 },
  val:     { fontSize: 13 },
  link:    { color: '#2563eb', textDecoration: 'none' },
  list:    { display: 'flex', flexDirection: 'column', gap: 4 },
  rowItem: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', borderBottom: '1px solid #f3f4f6', fontSize: 12, flexWrap: 'wrap' },
  dim:     { color: '#6b7280' },
  tag:     { background: '#f3f4f6', padding: '1px 5px', borderRadius: 3, fontSize: 11 },
  empty:   { color: '#9ca3af', fontSize: 12, padding: '4px 0' },
  pre:     { margin: 0, fontSize: 11, background: '#f3f4f6', padding: '8px 10px', borderRadius: 4, maxHeight: 240, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
  pill:    { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '4px 10px', fontSize: 12, color: '#2563eb', textDecoration: 'none' },
  viewAll: { color: '#2563eb', textDecoration: 'none', fontSize: 12, fontWeight: 400, marginLeft: 8 },
}
