-- pgTAP test: T012 — RLS on `integration_runs`
--
-- Source migration: supabase/migrations/0016_match_rls.sql
-- Spec reference:   specs/002-match-catalog-read/data-model.md
--                   §"RLS policies"
-- FR reference:     FR-M22
--
-- Goal: verify that `integration_runs` is admin-read-only from end-user roles:
--   1. RLS is ENABLED on the table.
--   2. Exactly one policy exists, named `integration_runs_select_admin`.
--   3. Total policy count on the table is exactly 1
--      (defence-in-depth against future migrations adding stray policies).
--   4. The policy applies to SELECT only.
--   5. The policy targets the `authenticated` role.
--   6. No INSERT/UPDATE/DELETE policies exist on the table
--      (writes happen only via service_role from the sync-matches Edge Function).
--
-- Note: the policy's USING predicate (`is_admin_user()`) is covered by
-- separate tests for the predicate itself — not asserted here.

BEGIN;

SELECT plan(6);

-- 1. RLS is enabled on integration_runs.
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.integration_runs'::regclass
    ),
    TRUE,
    'RLS is enabled on public.integration_runs'
);

-- 2. The exact set of policies on integration_runs matches what the migration declared.
SELECT policies_are(
    'public',
    'integration_runs',
    ARRAY['integration_runs_select_admin'],
    'public.integration_runs has exactly the one expected RLS policy'
);

-- 3. Total policy count on integration_runs is exactly 1
--    (catches stray INSERT/UPDATE/DELETE policies even if a future migration
--    reuses the expected name).
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'integration_runs'
    ),
    1,
    'public.integration_runs has exactly 1 policy total'
);

-- 4. The single policy applies to SELECT only.
SELECT policy_cmd_is(
    'public', 'integration_runs', 'integration_runs_select_admin', 'SELECT',
    'integration_runs_select_admin applies to SELECT'
);

-- 5. The policy targets the `authenticated` role.
--    pg_policies.roles is name[] (Postgres role names).
SELECT ok(
    (
        SELECT 'authenticated' = ANY(roles)
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'integration_runs'
          AND policyname = 'integration_runs_select_admin'
    ),
    'integration_runs_select_admin targets the authenticated role'
);

-- 6. No INSERT/UPDATE/DELETE/ALL policies of any name exist on integration_runs.
--    pg_policies.cmd uses verbose values: 'SELECT','INSERT','UPDATE','DELETE','ALL'.
--    Writes are routed exclusively through service_role (sync-matches Edge Function).
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'integration_runs'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    0,
    'public.integration_runs has NO INSERT/UPDATE/DELETE/ALL policies (service_role writes only)'
);

SELECT * FROM finish();

ROLLBACK;
