import { createClient } from '@/lib/supabase/server'
import { resolveUserContext } from '@/lib/auth/context'
import { errorResponse, ok } from '@/lib/errors'

export async function GET() {
  try {
    const supabase = await createClient()
    await resolveUserContext(supabase)

    const { data, error } = await supabase
      .from('work_packets')
      .select('id, title, status')
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) throw new Error(error.message)
    return ok(data ?? [])
  } catch (err) {
    return errorResponse(err)
  }
}
