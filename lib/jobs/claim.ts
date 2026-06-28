import { getServiceClient } from '@/lib/supabase/service'
import type { BackgroundJob } from '@/types/jobs'

const BATCH_SIZE = 5

export async function claimBatch(): Promise<BackgroundJob[]> {
  const svc = getServiceClient()
  const now = new Date().toISOString()

  // Fetch next claimable candidates ordered by priority (lower = higher priority) then age
  const { data: candidates, error: fetchErr } = await svc
    .from('background_jobs')
    .select('id')
    .in('status', ['queued', 'retrying'])
    .or(`scheduled_for.is.null,scheduled_for.lte.${now}`)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE)

  if (fetchErr) throw new Error(`claim fetch failed: ${fetchErr.message}`)
  if (!candidates || candidates.length === 0) return []

  const ids = (candidates as { id: string }[]).map(c => c.id)

  // Optimistic claim — only rows still in a claimable status are updated.
  // Rows already claimed by another worker are silently skipped.
  const { data: claimed, error: claimErr } = await svc
    .from('background_jobs')
    .update({ status: 'processing', started_at: now })
    .in('id', ids)
    .in('status', ['queued', 'retrying'])
    .select('*')

  if (claimErr) throw new Error(`claim update failed: ${claimErr.message}`)
  return (claimed ?? []) as BackgroundJob[]
}
