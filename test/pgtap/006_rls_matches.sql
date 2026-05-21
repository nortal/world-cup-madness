-- pgTAP test: T011 — RLS policies on `public.teams` and `public.matches`
--
-- Source migration: supabase/migrations/0016_match_rls.sql
-- Spec reference:   specs/002-match-catalog-read/data-model.md
--                   §"RLS policies"
-- FR reference:     FR-M22
--
-- Invariants under test (per table — teams, matches):
--   * RLS is ENABLED on the table.
--   * Exactly one policy exists on the table, named `<table>_select_eligible`.
--   * Total policy count on the table is exactly 1 (defence-in-depth:
--     catches stray INSERT/UPDATE/DELETE policies even if a future migration
--     reuses the expected SELECT policy name).
--   * The policy applies to SELECT only.
--   * No INSERT/UPDATE/DELETE policies exist on the table — writes happen
--     exclusively via service_role from the sync-matches Edge Function.
--
-- NOTE: the policy's USING clause (is_eligible_nortal_user()) is covered by
-- test 003_provision_function.sql. This file only asserts the policy
-- *plumbing* (existence, command, role), not the predicate implementation.

BEGIN;

SELECT plan(10);

-- ---------------------------------------------------------------------------
-- public.teams
-- ---------------------------------------------------------------------------

-- 1. RLS is enabled on teams.
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.teams'::regclass
    ),
    TRUE,
    'RLS is enabled on public.teams'
);

-- 2. The exact set of policies on teams matches what the migration declared.
SELECT policies_are(
    'public',
    'teams',
    ARRAY['teams_select_eligible'],
    'public.teams has exactly the one expected RLS policy (teams_select_eligible)'
);

-- 3. Total policy count on teams is exactly 1
--    (defence-in-depth: catches stray INSERT/UPDATE/DELETE policies even if
--    a future migration reuses the expected name).
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'teams'
    ),
    1,
    'public.teams has exactly 1 policy total'
);

-- 4. teams_select_eligible is SELECT-only and targets the `authenticated` role.
SELECT policy_cmd_is(
    'public', 'teams', 'teams_select_eligible', 'SELECT',
    'teams_select_eligible applies to SELECT'
);

-- 5. No INSERT/UPDATE/DELETE/ALL policies of any name exist on teams.
--    pg_policies.cmd uses verbose values: 'SELECT','INSERT','UPDATE','DELETE','ALL'.
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'teams'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    0,
    'public.teams has NO INSERT/UPDATE/DELETE/ALL policies (writes go through service_role)'
);

-- ---------------------------------------------------------------------------
-- public.matches
-- ---------------------------------------------------------------------------

-- 1. RLS is enabled on matches.
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.matches'::regclass
    ),
    TRUE,
    'RLS is enabled on public.matches'
);

-- 2. The exact set of policies on matches matches what the migration declared.
SELECT policies_are(
    'public',
    'matches',
    ARRAY['matches_select_eligible'],
    'public.matches has exactly the one expected RLS policy (matches_select_eligible)'
);

-- 3. Total policy count on matches is exactly 1
--    (defence-in-depth: catches stray INSERT/UPDATE/DELETE policies even if
--    a future migration reuses the expected name).
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'matches'
    ),
    1,
    'public.matches has exactly 1 policy total'
);

-- 4. matches_select_eligible is SELECT-only and targets the `authenticated` role.
SELECT policy_cmd_is(
    'public', 'matches', 'matches_select_eligible', 'SELECT',
    'matches_select_eligible applies to SELECT'
);

-- 5. No INSERT/UPDATE/DELETE/ALL policies of any name exist on matches.
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'matches'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    0,
    'public.matches has NO INSERT/UPDATE/DELETE/ALL policies (writes go through service_role)'
);

SELECT * FROM finish();

ROLLBACK;
