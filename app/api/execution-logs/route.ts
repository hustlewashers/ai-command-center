import { type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

const SELECT_COLS = [
  'id', 'organization_id', 'event_type', 'actor',
  'occurred_at', 'summary', 'context_type', 'context_id',
  'metadata', 'status', 'created_at',
].join(', ')

// GET /api/execution-logs
// Returns RLS-visible execution log rows, newest first.
// Optional query params: status, event_type, actor, context_type, context_id
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { searchParams } = request.nextUrl
    const status      = searchParams.get('status')
    const eventType   = searchParams.get('event_type')
    const actor       = searchParams.get('actor')
    const contextType = searchParams.get('context_type')
    const contextId   = searchParams.get('context_id')

    let query = supabase
      .from('execution_logs')
      .select(SELECT_COLS)
      .order('occurred_at', { ascending: false })
      .limit(100)

    if (status)      query = query.eq('status', status)
    if (eventType)   query = query.eq('event_type', eventType)
    if (actor)       query = query.ilike('actor', `%${actor}%`)
    if (contextType) query = query.eq('context_type', contextType)
    if (contextId)   query = query.eq('context_id', contextId)

    const { data, error } = await query
    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}
