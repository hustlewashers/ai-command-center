'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const supabase = createClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    if (signInError) {
      setError(signInError.message)
      setLoading(false)
      return
    }

    // Refresh server components so the home page picks up the new session
    router.refresh()
    router.push('/')
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.heading}>AI Command Center</h1>
      <h2 style={styles.subheading}>Sign in</h2>
      <form onSubmit={handleSubmit} style={styles.form}>
        <label style={styles.label}>
          Email
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
            style={styles.input}
          />
        </label>
        <label style={styles.label}>
          Password
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={styles.input}
          />
        </label>
        {error && <p style={styles.error}>{error}</p>}
        <button type="submit" disabled={loading} style={styles.button}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  main: { fontFamily: 'monospace', padding: '2rem', maxWidth: '360px' },
  heading: { margin: '0 0 0.25rem' },
  subheading: { margin: '0 0 1.5rem', fontWeight: 'normal', fontSize: '1rem', color: '#555' },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  label: { display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.9rem' },
  input: { padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.9rem', border: '1px solid #ccc' },
  error: { color: '#c00', margin: 0, fontSize: '0.875rem' },
  button: { padding: '0.5rem 1rem', fontFamily: 'monospace', cursor: 'pointer' },
}
