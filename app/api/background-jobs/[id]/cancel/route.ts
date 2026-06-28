import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'

// POST /api/background-jobs/:id/cancel
// Cancels a queued or retrying job. Requires org_admin role.
// RLS (background_jobs_update_org_admin) also enforces org_admin — this
// layer-4 check provides a typed error before the DB fires 42501.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const context = await resolveUserContext(supabase)

    if (context.role !== 'org_admin') {
      throw createError('forbidden', 'Only org_admin can cancel background jobs')
    }

    const { data, error } = await supabase
      .from('background_jobs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', id)
      .in('status', ['queued', 'retrying'])
      .select('id, status')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        throw createError('not_found', 'Job not found or is not in a cancellable state')
      }
      if (error.code === '42501') {
        throw createError('forbidden', 'Insufficient permission to cancel this job')
      }
      throw new Error(error.message)
    }

    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}
