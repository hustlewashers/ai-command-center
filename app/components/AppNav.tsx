import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'

const NAV_LINKS = [
  { href: '/work-queue', label: 'Work Queue' },
  { href: '/execution-logs', label: 'Exec Logs' },
  { href: '/agent-activity', label: 'Activity' },
  { href: '/requests', label: 'Requests' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/work-packets', label: 'Work Packets' },
  { href: '/decisions', label: 'Decisions' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/outputs', label: 'Outputs' },
  { href: '/blockers', label: 'Blockers' },
  { href: '/background-jobs', label: 'Jobs' },
  { href: '/workflow-runs', label: 'Workflow Runs' },
  { href: '/ai-operations', label: 'AI Ops' },
]

export default async function AppNav() {
  const supabase = await createClient()
  let role: string | null = null
  try {
    const ctx = await resolveUserContext(supabase)
    role = ctx.role
  } catch {
    return null
  }

  return (
    <nav style={s.nav}>
      <div style={s.inner}>
        <Link href="/" style={s.brand}>AI-CC</Link>
        <div style={s.links}>
          {NAV_LINKS.map(l => (
            <Link key={l.href} href={l.href} style={s.link}>{l.label}</Link>
          ))}
        </div>
        <span style={s.role}>{role}</span>
        <form action="/api/auth/logout" method="POST" style={{ margin: 0 }}>
          <button type="submit" style={s.logout}>Sign out</button>
        </form>
      </div>
    </nav>
  )
}

const s: Record<string, React.CSSProperties> = {
  nav:    { background: '#111', color: '#eee', padding: '0 1rem', fontFamily: 'monospace', fontSize: '0.8rem', position: 'sticky', top: 0, zIndex: 100 },
  inner:  { display: 'flex', alignItems: 'center', gap: '0.6rem', maxWidth: '1600px', margin: '0 auto', height: '40px' },
  brand:  { color: '#fff', textDecoration: 'none', fontWeight: 'bold', marginRight: '0.25rem', whiteSpace: 'nowrap' },
  links:  { display: 'flex', gap: '0.4rem', flex: 1, flexWrap: 'wrap' },
  link:   { color: '#aaa', textDecoration: 'none', whiteSpace: 'nowrap', padding: '0.15rem 0.25rem' },
  role:   { color: '#555', fontSize: '0.72rem', whiteSpace: 'nowrap' },
  logout: { background: 'none', border: '1px solid #444', color: '#aaa', fontFamily: 'monospace', fontSize: '0.72rem', padding: '0.15rem 0.4rem', cursor: 'pointer', whiteSpace: 'nowrap' },
}
