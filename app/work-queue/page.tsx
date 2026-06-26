import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import WorkQueueClient from './WorkQueueClient'

export default async function WorkQueuePage() {
  const supabase = await createClient()

  let ctx = null
  try {
    ctx = await resolveUserContext(supabase)
  } catch { /* unauthenticated */ }

  if (!ctx) redirect('/login')

  return (
    <WorkQueueClient
      userId={ctx.userId}
      role={ctx.role}
      departmentId={ctx.departmentId}
    />
  )
}
