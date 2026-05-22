-- pgTAP test: Row-Level Security policies on `public.participants`
--
-- Source migration: supabase/migrations/0008_rls_policies.sql
-- Spec reference:   specs/001-authentication-and-participant/data-model.md
--                   §"Row-Level Security Policies -> participants"
--
-- Invariants under test:
--   * RLS is ENABLED on public.participants.
--   * Exactly three policies exist on public.participants.
--   * The three policies are named:
--       - participants_select_own
--       - participants_select_active_for_leaderboard
--       - participants_admin_select_all
--   * Every policy on public.participants applies to SELECT only.
--     (Writes are intentionally routed through SECURITY DEFINER functions;
--      there must be NO INSERT/UPDATE/DELETE policies for the
--      `authenticated` role on this table.)
--   * Each policy targets the `authenticated` role.

BEGIN;

SELECT plan(11);

-- 1. RLS is enabled on participants.
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.participants'::regclass
    ),
    TRUE,
    'RLS is enabled on public.participants'
);

-- 2. The exact set of policies on participants matches what the migration declared.
SELECT policies_are(
    'public',
    'participants',
    ARRAY[
        'participants_select_own',
        'participants_select_active_for_leaderboard',
        'participants_admin_select_all'
    ],
    'public.participants has exactly the three expected RLS policies'
);

-- 3. Total policy count on participants is exactly 3
--    (defence-in-depth: catches stray INSERT/UPDATE/DELETE policies even if
--    a future migration reuses one of the expected names).
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'participants'
    ),
    3,
    'public.participants has exactly 3 policies total'
);

-- 4. Each named policy is SELECT-only.
SELECT policy_cmd_is(
    'public', 'participants', 'participants_select_own', 'SELECT',
    'participants_select_own applies to SELECT'
);

SELECT policy_cmd_is(
    'public', 'participants', 'participants_select_active_for_leaderboard', 'SELECT',
    'participants_select_active_for_leaderboard applies to SELECT'
);

SELECT policy_cmd_is(
    'public', 'participants', 'participants_admin_select_all', 'SELECT',
    'participants_admin_select_all applies to SELECT'
);

-- 5. No INSERT/UPDATE/DELETE policies of any name exist on participants.
--    pg_policies.cmd uses verbose values: 'SELECT','INSERT','UPDATE','DELETE','ALL'.
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'participants'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    0,
    'public.participants has NO INSERT/UPDATE/DELETE/ALL policies (writes go through SECURITY DEFINER)'
);

-- 6. Each named policy targets the `authenticated` role.
--    pg_policies.roles is name[] (Postgres role names).
SELECT ok(
    (
        SELECT 'authenticated' = ANY(roles)
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'participants'
          AND policyname = 'participants_select_own'
    ),
    'participants_select_own targets the authenticated role'
);

SELECT ok(
    (
        SELECT 'authenticated' = ANY(roles)
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'participants'
          AND policyname = 'participants_select_active_for_leaderboard'
    ),
    'participants_select_active_for_leaderboard targets the authenticated role'
);

SELECT ok(
    (
        SELECT 'authenticated' = ANY(roles)
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'participants'
          AND policyname = 'participants_admin_select_all'
    ),
    'participants_admin_select_all targets the authenticated role'
);

-- 7. Sanity: confirm pg_policies returns SELECT for every policy we found
--    (catches a future migration adding a permissive ALL policy named oddly).
SELECT is(
    (
        SELECT array_agg(DISTINCT cmd ORDER BY cmd)
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'participants'
    ),
    ARRAY['SELECT']::text[],
    'every policy on public.participants is SELECT'
);

SELECT * FROM finish();

ROLLBACK;
