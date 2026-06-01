-- pgTAP test: RLS policies on `public.players`
--
-- Source migrations:
--   supabase/migrations/0021_create_players.sql   (table + CHECK constraints)
--   supabase/migrations/0029_prediction_rls.sql   (ALTER ... ENABLE ROW LEVEL SECURITY
--                                                  + players_select_eligible policy)
-- Spec references:
--   specs/003-predictions-and-scoring/data-model.md
--     §1.3 "players — football players (squad sync target)"
--     §4.3 "RLS policies → players"
--
-- Invariants under test (mirrors the eligible-tenant SELECT pattern from
-- 006_rls_matches.sql, plus live-data assertions that exercise the policy
-- predicate under the `authenticated` role):
--
--   POLICY PLUMBING (mirrors 006_rls_matches.sql)
--     * RLS is ENABLED on public.players.
--     * Exactly one policy exists on public.players, named
--       `players_select_eligible`.
--     * Total policy count on public.players is exactly 1
--       (defence-in-depth: catches stray INSERT/UPDATE/DELETE policies even if
--       a future migration reuses the expected SELECT policy name).
--     * `players_select_eligible` applies to SELECT only.
--     * `players_select_eligible` targets the `authenticated` role.
--     * The USING predicate is exactly `is_eligible_nortal_user()`.
--     * No INSERT/UPDATE/DELETE/ALL policies of any name exist on public.players
--       — writes happen exclusively via service_role from the squad-sync
--       Edge Function (data-model §4.3, FR-P24 spirit).
--
--   LIVE-DATA POLICY ENFORCEMENT (eligible vs ineligible, under `authenticated`)
--     * An eligible-tenant participant (JWT tid == tournament_config.nortal_tenant_id)
--       can SELECT all seeded players.
--     * An ineligible-tenant participant (JWT tid != nortal_tenant_id) sees 0 rows.
--     * INSERT / UPDATE / DELETE by an eligible-tenant `authenticated` user fail
--       (no write policy exists → RLS denies). Each negative path uses a
--       SAVEPOINT so a failure does not abort the transaction.
--
--   CONSTRAINT (service_role; not RLS — included here because it pairs naturally
--   with players writes and there is no dedicated constraints test file yet)
--     * `players_position_valid` CHECK rejects an arbitrary string outside the
--       four football-data.org v4 values (Goalkeeper/Defender/Midfielder/Attacker).

BEGIN;

SELECT plan(13);

-- ===========================================================================
-- 0. Fixed UUIDs (mirrors 003_provision_function.sql for legibility)
-- ===========================================================================
\set nortal_tid       '11111111-1111-1111-1111-111111111111'
\set foreign_tid      '99999999-9999-9999-9999-999999999999'

-- Eligible participant E (Nortal tenant)
\set eligible_sub     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1'
\set eligible_oid     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'

-- Ineligible participant I (foreign tenant). The row in `participants` is
-- irrelevant for the predicate (which reads the JWT, not the DB) — we still
-- seed it so the test mirrors the production shape: a previously-eligible
-- user whose JWT now carries a non-Nortal tid.
\set ineligible_sub   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1'
\set ineligible_oid   'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2'

-- ===========================================================================
-- 1-7. POLICY PLUMBING ASSERTIONS
-- ===========================================================================

-- 1. RLS is enabled on players.
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.players'::regclass
    ),
    TRUE,
    'RLS is enabled on public.players'
);

-- 2. The exact set of policies on players matches what migration 0029 declared.
SELECT policies_are(
    'public',
    'players',
    ARRAY['players_select_eligible'],
    'public.players has exactly the one expected RLS policy (players_select_eligible)'
);

-- 3. Total policy count on players is exactly 1
--    (defence-in-depth: catches stray INSERT/UPDATE/DELETE policies even if
--    a future migration reuses the expected name).
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'players'
    ),
    1,
    'public.players has exactly 1 policy total'
);

-- 4. players_select_eligible is SELECT-only.
SELECT policy_cmd_is(
    'public', 'players', 'players_select_eligible', 'SELECT',
    'players_select_eligible applies to SELECT'
);

-- 5. players_select_eligible targets the `authenticated` role.
SELECT ok(
    (
        SELECT 'authenticated' = ANY(roles)
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'players'
          AND policyname = 'players_select_eligible'
    ),
    'players_select_eligible targets the authenticated role'
);

-- 6. USING predicate is exactly is_eligible_nortal_user().
--    (Migration 0029 line 81 — bare predicate, no AND/OR.)
SELECT is(
    (
        SELECT qual
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'players'
          AND policyname = 'players_select_eligible'
    ),
    'is_eligible_nortal_user()',
    'players_select_eligible USING clause is exactly is_eligible_nortal_user()'
);

-- 7. No INSERT/UPDATE/DELETE/ALL policies of any name exist on players.
--    pg_policies.cmd uses verbose values: 'SELECT','INSERT','UPDATE','DELETE','ALL'.
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'players'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    0,
    'public.players has NO INSERT/UPDATE/DELETE/ALL policies (writes go through service_role)'
);

-- ===========================================================================
-- LIVE-DATA SETUP
-- ===========================================================================
-- Seed tournament_config so is_eligible_nortal_user() has a tid to compare against.
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid'::uuid, '{}'::uuid[])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

-- Seed auth.users for FK on participants.auth_user_id.
INSERT INTO auth.users (id) VALUES
    (:'eligible_sub'::uuid),
    (:'ineligible_sub'::uuid)
ON CONFLICT (id) DO NOTHING;

-- Seed an active eligible participant E (irrelevant to the players predicate
-- but mirrors production: the JWT path is what really decides eligibility).
INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'eligible_sub'::uuid,   :'eligible_oid'::uuid,
        'eligible-players-test@nortal.com',   'E Eligible',   'participant', 'active'),
    (:'ineligible_sub'::uuid, :'ineligible_oid'::uuid,
        'ineligible-players-test@example.com', 'I Ineligible', 'participant', 'active')
ON CONFLICT (auth_user_id) DO NOTHING;

-- Pick a seeded team via TLA (Brazil is in migration 0017_seed_teams.sql).
-- Insert 3 players against that team. This runs as the test session's superuser
-- (postgres) so it bypasses RLS — same pattern as the squad-sync Edge Function
-- writing via service_role.
WITH t AS (SELECT id FROM teams WHERE tla = 'BRA')
INSERT INTO players (provider_player_id, name, position, team_id)
SELECT * FROM (VALUES
    (9000001, 'Player Alpha',  'Goalkeeper'::text, (SELECT id FROM t)),
    (9000002, 'Player Beta',   'Defender'::text,   (SELECT id FROM t)),
    (9000003, 'Player Gamma',  'Midfielder'::text, (SELECT id FROM t))
) AS v(provider_player_id, name, position, team_id);

-- ===========================================================================
-- 8. ELIGIBLE participant E sees all 3 players
-- ===========================================================================
-- Switch to the `authenticated` role + set a JWT with the Nortal tid.
-- SET LOCAL is scoped to this transaction (rolled back at the end).
SET LOCAL role TO authenticated;
SELECT set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub',          :'eligible_sub',
        'email',        'eligible-players-test@nortal.com',
        'app_metadata', jsonb_build_object('tid', :'nortal_tid', 'oid', :'eligible_oid')
    )::text,
    true
);
SELECT set_config('request.jwt.claim.sub', :'eligible_sub', true);

SELECT is(
    (SELECT COUNT(*)::int FROM players WHERE provider_player_id IN (9000001, 9000002, 9000003)),
    3,
    'eligible-tenant authenticated user SELECTs all 3 seeded players (RLS allows)'
);

-- ===========================================================================
-- 9. INELIGIBLE participant I sees 0 rows
-- ===========================================================================
SELECT set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub',          :'ineligible_sub',
        'email',        'ineligible-players-test@example.com',
        'app_metadata', jsonb_build_object('tid', :'foreign_tid', 'oid', :'ineligible_oid')
    )::text,
    true
);
SELECT set_config('request.jwt.claim.sub', :'ineligible_sub', true);

SELECT is(
    (SELECT COUNT(*)::int FROM players),
    0,
    'ineligible-tenant authenticated user SELECTs 0 players (RLS denies)'
);

-- ===========================================================================
-- 10. ELIGIBLE participant E cannot INSERT (no INSERT policy)
-- ===========================================================================
-- Re-seat as eligible so the negative test isolates the "no write policy"
-- behaviour from the eligibility predicate.
SELECT set_config(
    'request.jwt.claims',
    jsonb_build_object(
        'sub',          :'eligible_sub',
        'email',        'eligible-players-test@nortal.com',
        'app_metadata', jsonb_build_object('tid', :'nortal_tid', 'oid', :'eligible_oid')
    )::text,
    true
);
SELECT set_config('request.jwt.claim.sub', :'eligible_sub', true);

SAVEPOINT before_insert;
SELECT throws_ok(
    $$
        INSERT INTO players (provider_player_id, name, position, team_id)
        SELECT 9000999, 'Forbidden Insert', 'Attacker', id FROM teams WHERE tla = 'BRA'
    $$,
    '42501',  -- insufficient_privilege / RLS denial
    NULL,
    'eligible authenticated user CANNOT INSERT into players (no INSERT policy)'
);
RELEASE SAVEPOINT before_insert;

-- ===========================================================================
-- 11. ELIGIBLE participant E cannot UPDATE (no UPDATE policy)
-- ===========================================================================
SAVEPOINT before_update;
-- An UPDATE matching zero rows because RLS hides them still returns success
-- with 0 rows affected, so we both attempt the UPDATE AND assert no row mutated.
-- The safer check: assert the row count under the eligible user remains 3 AND
-- that running the UPDATE under the eligible user produces zero affected rows.
WITH attempt AS (
    UPDATE players SET name = 'TAMPERED' WHERE provider_player_id = 9000001
    RETURNING id
)
SELECT is(
    (SELECT COUNT(*)::int FROM attempt),
    0,
    'eligible authenticated user UPDATE on players affects 0 rows (no UPDATE policy → row invisible to UPDATE)'
);
RELEASE SAVEPOINT before_update;

-- ===========================================================================
-- 12. ELIGIBLE participant E cannot DELETE (no DELETE policy)
-- ===========================================================================
SAVEPOINT before_delete;
WITH attempt AS (
    DELETE FROM players WHERE provider_player_id IN (9000001, 9000002, 9000003)
    RETURNING id
)
SELECT is(
    (SELECT COUNT(*)::int FROM attempt),
    0,
    'eligible authenticated user DELETE on players affects 0 rows (no DELETE policy → row invisible to DELETE)'
);
RELEASE SAVEPOINT before_delete;

-- ===========================================================================
-- 13. CONSTRAINT: players_position_valid rejects 'Striker'
-- ===========================================================================
-- This is a CHECK-constraint test (service_role isn't subject to RLS), included
-- here as the only players write-path test until a dedicated constraints file
-- is added. Reset to the test session superuser so RLS is bypassed and the
-- assertion isolates the CHECK constraint.
RESET role;
-- Clear the JWT so any future predicate calls in this transaction don't
-- accidentally read stale claims.
SELECT set_config('request.jwt.claims',     NULL, true);
SELECT set_config('request.jwt.claim.sub',  NULL, true);

SAVEPOINT before_bad_position;
SELECT throws_ok(
    $$
        INSERT INTO players (provider_player_id, name, position, team_id)
        SELECT 9001000, 'Bad Position', 'Striker', id FROM teams WHERE tla = 'BRA'
    $$,
    '23514',  -- check_violation
    NULL,
    'players_position_valid CHECK rejects position=''Striker'' (only Goalkeeper/Defender/Midfielder/Attacker allowed)'
);
RELEASE SAVEPOINT before_bad_position;

SELECT * FROM finish();

ROLLBACK;
