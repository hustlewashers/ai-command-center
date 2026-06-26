import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok, createError } from '@/lib/errors'

type RouteParams = { params: Promise<{ id: string }> }

const SELECT_COLS = [
  'id', 'organization_id', 'event_type', 'actor',
  'occurred_at', 'summary', 'context_type', 'context_id',
  'metadata', 'status', 'created_at',
].join(', ')

// GET /api/execution-logs/:id
// Returns a single RLS-visible execution log row.
export async function GET(_request: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('execution_logs')
      .select(SELECT_COLS)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) throw createError('not_found', 'Execution log not found')
    return ok(data)
  } catch (err) {
    return errorResponse(err)
  }
}
