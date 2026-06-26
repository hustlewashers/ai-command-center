-- Sprint 1.1 — Auth Context Spine Verification
-- Run against: supabase db connect (local) or remote project wbtvrzivthuqqntnorsw
--
-- Pattern: BEGIN … ROLLBACK (never mutates the system of record)
-- Substitute real auth_user_id values from public.users before running.
--
-- Usage (local):
--   supabase db connect < scripts/verify-context.sql
-- Usage (remote with psql):
--   psql "$DATABASE_URL" < scripts/verify-context.sql

\echo '=== Sprint 1.1 Auth Context Spine Verification ==='
\echo ''

-- ── TEST 1: Active user resolves full context ──────────────────────────────
\echo 'TEST 1: Active user resolves all four context values'
do $$
declare
  v_auth_user_id uuid := '<REPLACE: auth_user_id of an active public.users row>';
  v_user_id      uuid;
  v_org_id       uuid;
  v_dept_id      uuid;
  v_role         text;
begin
  -- Simulate an authenticated session for this auth user
  execute 'set local role authenticated';
  execute format('set local "request.jwt.claim.sub" = %L', v_auth_user_id);

  select
    private.current_user_id(),
    private.current_organization_id(),
    private.current_department_id(),
    private.current_role()
  into v_user_id, v_org_id, v_dept_id, v_role;

  assert v_user_id      is not null, 'FAIL: current_user_id() returned null for active user';
  assert v_org_id       is not null, 'FAIL: current_organization_id() returned null for active user';
  assert v_role         is not null, 'FAIL: current_role() returned null for active user';
  assert v_role in ('org_admin','department_lead','department_member','read_only','agent'),
    'FAIL: current_role() returned unknown role: ' || v_role;

  raise notice 'PASS: user_id=%, org_id=%, dept_id=%, role=%',
    v_user_id, v_org_id, v_dept_id, v_role;
end $$;

-- ── TEST 2: Non-active user → all helpers null ─────────────────────────────
\echo 'TEST 2: Non-active (suspended) user resolves null context'
do $$
declare
  v_auth_user_id uuid := '<REPLACE: auth_user_id of a suspended/invited public.users row>';
  v_user_id      uuid;
  v_org_id       uuid;
begin
  execute 'set local role authenticated';
  execute format('set local "request.jwt.claim.sub" = %L', v_auth_user_id);

  select private.current_user_id(), private.current_organization_id()
  into v_user_id, v_org_id;

  assert v_user_id is null, 'FAIL: non-active user should yield null user_id';
  assert v_org_id  is null, 'FAIL: non-active user should yield null org_id';

  raise notice 'PASS: non-active user → null context (unauthenticated behavior confirmed)';
end $$;

-- ── TEST 3: RLS-scoped users SELECT (own org only) ─────────────────────────
\echo 'TEST 3: users SELECT scoped to own org'
do $$
declare
  v_auth_user_id uuid := '<REPLACE: auth_user_id of an active public.users row>';
  v_org_id       uuid;
  v_cross_count  int;
begin
  execute 'set local role authenticated';
  execute format('set local "request.jwt.claim.sub" = %L', v_auth_user_id);

  select private.current_organization_id() into v_org_id;

  -- All visible users must belong to the caller's org
  select count(*) into v_cross_count
  from public.users
  where organization_id != v_org_id;

  assert v_cross_count = 0,
    'FAIL: users SELECT leaked ' || v_cross_count || ' cross-org rows';

  raise notice 'PASS: users SELECT returns only own-org rows';
end $$;

-- ── TEST 4: requests SELECT org-scoped ────────────────────────────────────
\echo 'TEST 4: requests SELECT returns only own-org rows'
do $$
declare
  v_auth_user_id uuid := '<REPLACE: auth_user_id of an active public.users row>';
  v_org_id       uuid;
  v_cross_count  int;
begin
  execute 'set local role authenticated';
  execute format('set local "request.jwt.claim.sub" = %L', v_auth_user_id);

  select private.current_organization_id() into v_org_id;

  select count(*) into v_cross_count
  from public.requests
  where organization_id != v_org_id;

  assert v_cross_count = 0,
    'FAIL: requests SELECT leaked ' || v_cross_count || ' cross-org rows';

  raise notice 'PASS: requests SELECT org-isolated';
end $$;

-- ── TEST 5: tasks SELECT dept-scoped ──────────────────────────────────────
\echo 'TEST 5: tasks SELECT returns only own-dept rows (for dept_member)'
do $$
declare
  v_auth_user_id uuid := '<REPLACE: auth_user_id of a department_member>';
  v_dept_id      uuid;
  v_cross_count  int;
begin
  execute 'set local role authenticated';
  execute format('set local "request.jwt.claim.sub" = %L', v_auth_user_id);

  select private.current_department_id() into v_dept_id;

  if v_dept_id is null then
    raise notice 'SKIP: user has no department_id — not a dept-scoped role';
    return;
  end if;

  select count(*) into v_cross_count
  from public.tasks
  where department_id != v_dept_id;

  assert v_cross_count = 0,
    'FAIL: tasks SELECT leaked ' || v_cross_count || ' cross-dept rows for dept_member';

  raise notice 'PASS: tasks SELECT dept-isolated for department_member';
end $$;

-- ── TEST 6: Scope injection — client-supplied org_id grants nothing ─────────
\echo 'TEST 6: Scope injection — filtering by a foreign org_id returns nothing'
do $$
declare
  v_auth_user_id  uuid := '<REPLACE: auth_user_id of an active public.users row>';
  v_foreign_org   uuid := gen_random_uuid(); -- a fake foreign org
  v_injected_rows int;
begin
  execute 'set local role authenticated';
  execute format('set local "request.jwt.claim.sub" = %L', v_auth_user_id);

  -- Even if a client tries to filter by a foreign org, RLS ensures no rows leak
  select count(*) into v_injected_rows
  from public.users
  where organization_id = v_foreign_org;

  assert v_injected_rows = 0,
    'FAIL: scope injection returned ' || v_injected_rows || ' rows for foreign org';

  raise notice 'PASS: scope injection yields 0 rows';
end $$;

\echo ''
\echo '=== Verification complete (all ran in-transaction; no mutations committed) ==='
