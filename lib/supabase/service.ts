import { createClient } from '@supabase/supabase-js'

// Service-role Supabase client — bypasses RLS entirely.
// NEVER import this from client components or NEXT_PUBLIC_ paths.
// Only route handlers and lib/jobs/* should import this module.
export function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set')
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set — this module is server-only and must not be called from browser code')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    },
  })
}
