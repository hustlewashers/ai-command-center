import type { SupabaseClient } from '@supabase/supabase-js'
import type { UserContext, UserRole } from '@/types/api'
import { createError } from '@/lib/errors'

// Resolves the caller's platform context from public.users via the authenticated session.
//
// Resolution path (per G1 §7):
//   auth.uid() → public.users (status='active', deleted_at IS NULL)
//               → userId, organizationId, departmentId, role
//
// Null-context denial: if the authenticated user has no active public.users row
// (non-provisioned, suspended, archived, or deleted), the RLS policy
// `users_select_same_org` returns no rows → treated as unauthenticated.
//
// This is the ONLY sanctioned source of caller context. Organization, department,
// and role must never be accepted from request bodies, query params, or JWT claims.
export async function resolveUserContext(supabase: SupabaseClient): Promise<UserContext> {
  // Layer 1: Validate the JWT through Supabase Auth
  const {
    data: { user: authUser },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !authUser) {
    throw createError('unauthenticated', 'No valid session')
  }

  // Layer 2: Resolve platform context via the RLS-protected public.users query.
  // The RLS policy `users_select_same_org` (migration 005) filters by:
  //   organization_id = private.current_organization_id()
  // For non-active users private.current_organization_id() returns null → predicate
  // fails → empty result set → correct unauthenticated response.
  const { data: platformUser, error: userError } = await supabase
    .from('users')
    .select('id, organization_id, department_id, role')
    .eq('auth_user_id', authUser.id)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle()

  if (userError) {
    throw createError('internal', 'Context resolution failed', userError.message)
  }

  if (!platformUser) {
    throw createError('unauthenticated', 'No active platform membership')
  }

  return {
    userId: platformUser.id as string,
    organizationId: platformUser.organization_id as string,
    departmentId: (platformUser.department_id as string) ?? null,
    role: platformUser.role as UserRole,
  }
}
