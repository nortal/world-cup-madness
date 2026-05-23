-- pgTAP test: Row-Level Security policies on `public.predictions`
--
-- Source migrations: supabase/migrations/0020_create_predictions.sql
--                    supabase/migrations/0029_prediction_rls.sql
-- Spec reference:    specs/003-predictions-and-scoring/data-model.md §4.1
--
-- Invariants under test (two layers — plumbing + behaviour):
--
-- Plumbing (catalog assertions):
--   1. RLS is ENABLED on public.predictions.
--   2. Exactly four policies exist on predictions, with the names declared by
--      0029_prediction_rls.sql:
--        - predictions_select_own
--        - predictions_insert_own
--        - predictions_update_own
--        - predictions_select_admin
--   3. The three "own" policies target the `authenticated` role.
--   4. predictions_select_admin targets `authenticated` AND its USING expression
--      calls is_admin_user() (verified via pg_policies.qual).
--   5. NO FOR DELETE policies exist on predictions — deletes happen only via
--      ON DELETE CASCADE from participants or matches (data-model.md §1.1).
--
-- Behaviour (run as the `authenticated` role with spoofed JWT claims):
--   6. Participant A SELECTs predictions and sees their own row (1 row).
--   7. Participant A SELECT WHERE participant_id = B.id returns 0 rows
--      (cross-participant invisibility — RLS strips B's rows from the result).
--   8. Participant A INSERT WITH check (participant_id = B.id) FAILS with
--      new_row_violates_row_level_security (SQLSTATE 42501).
--   9. Participant A UPDATE of their own row succeeds (predicted_home_score).
--  10. Admin SELECT returns BOTH participants' rows (2 rows).
--  11. Anon role sees 0 rows (no policy grants anon SELECT).
--
-- JWT simulation pattern: copied from 008_match_rpcs.sql / 003_provision_function.sql.
-- Role-spoofing pattern: SET LOCAL ROLE authenticated|anon (transaction-scoped).
--   Each behavioural test uses a SAVEPOINT so the expected-failure INSERT in
--   test 8 does NOT abort the surrounding transaction.

BEGIN;

SELECT plan(11);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for deterministic assertions
-- ---------------------------------------------------------------------------
\set nortal_tid    '11111111-1111-1111-1111-111111111111'
-- Participant A (regular)
\set a_user_id     '21111111-1111-1111-1111-111111111111'
\set a_oid         '22222222-2222-2222-2222-222222222222'
-- Participant B (regular — cross-participant isolation peer)
\set b_user_id     '31111111-1111-1111-1111-111111111111'
\set b_oid         '33333333-3333-3333-3333-333333333333'
-- Admin participant (for admin SELECT test)
\set admin_user_id '41111111-1111-1111-1111-111111111111'
\set admin_oid     '44444444-4444-4444-4444-444444444444'

-- ---------------------------------------------------------------------------
-- Helper: set the JWT claims for the next statement (auth.uid + auth.jwt)
-- ---------------------------------------------------------------------------
-- Verbatim from 008_match_rpcs.sql. Uses app_metadata.tid + app_metadata.oid
-- placement per migration 0010's claim-reads update.
CREATE OR REPLACE FUNCTION test_set_jwt(
    p_sub   UUID,
    p_tid   UUID,
    p_oid   UUID,
    p_email TEXT,
    p_name  TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_claims JSONB;
BEGIN
    v_claims := jsonb_build_object(
        'sub',            p_sub::text,
        'email',          p_email,
        'app_metadata',   jsonb_build_object(
                              'tid', p_tid::text,
                              'oid', p_oid::text
                          ),
        'user_metadata',  jsonb_build_object('name', p_name)
    );
    PERFORM set_config('request.jwt.claims',     v_claims::text, true);
    PERFORM set_config('request.jwt.claim.sub',  p_sub::text,    true);
END $$;

-- ---------------------------------------------------------------------------
-- Seed: auth.users + tournament_config + 3 participants
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id) VALUES
    (:'a_user_id'),
    (:'b_user_id'),
    (:'admin_user_id')
ON CONFLICT (id) DO NOTHING;

-- tournament_config row 1 with the admin's OID listed in admin_oids so that
-- is_admin_user() returns true for the admin participant (admin role assigned
-- below via direct INSERT; is_admin_user() only checks participants.role).
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', ARRAY[:'admin_oid'::uuid])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

-- Both regular participants are active; admin participant has role='admin'.
-- We INSERT directly (bypassing the provision RPC) so seeding is deterministic.
INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'a_user_id'::uuid,     :'a_oid'::uuid,     'a@nortal.com',     'User A',     'participant', 'active'),
    (:'b_user_id'::uuid,     :'b_oid'::uuid,     'b@nortal.com',     'User B',     'participant', 'active'),
    (:'admin_user_id'::uuid, :'admin_oid'::uuid, 'admin@nortal.com', 'Admin User', 'admin',       'active')
ON CONFLICT (oid) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: one team pair + one future match (>2h from now to stay well clear of
-- any lock window the future submit_prediction RPC may enforce — this test
-- doesn't exercise lock logic, just RLS plumbing, but we keep the fixture
-- realistic)
-- ---------------------------------------------------------------------------
INSERT INTO teams (name, tla, provider_team_id) VALUES
    ('Test Team Home', 'THM', 80001),
    ('Test Team Away', 'TAY', 80002)
ON CONFLICT (provider_team_id) DO NOTHING;

CREATE TEMP TABLE t_match AS
WITH ins AS (
    INSERT INTO matches (
        provider_id, home_team_id, away_team_id, stage, group_label,
        kickoff_utc, venue, status
    )
    SELECT
        80100,
        (SELECT id FROM teams WHERE tla = 'THM'),
        (SELECT id FROM teams WHERE tla = 'TAY'),
        'group', 'A',
        now() + interval '3 hours',
        'Test Stadium',
        'scheduled'
    RETURNING id
)
SELECT id FROM ins;

-- ---------------------------------------------------------------------------
-- Seed: insert ONE prediction for participant A while still running as the
-- test session's superuser (postgres) — RLS does not apply, so this is the
-- equivalent of a service-role write used to set up the fixture.
-- ---------------------------------------------------------------------------
INSERT INTO predictions (participant_id, match_id, predicted_home_score, predicted_away_score)
VALUES (
    (SELECT id FROM participants WHERE oid = :'a_oid'::uuid),
    (SELECT id FROM t_match),
    2, 1
);

-- Also seed a prediction for participant B so the admin-SELECT test can
-- assert both participants' rows are visible.
INSERT INTO predictions (participant_id, match_id, predicted_home_score, predicted_away_score)
VALUES (
    (SELECT id FROM participants WHERE oid = :'b_oid'::uuid),
    (SELECT id FROM t_match),
    0, 0
);

-- ===========================================================================
-- TEST 1 — RLS is enabled on public.predictions
-- ===========================================================================
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.predictions'::regclass
    ),
    TRUE,
    'TEST 1: RLS is enabled on public.predictions'
);

-- ===========================================================================
-- TEST 2 — Exactly four policies exist, with the expected names
-- ===========================================================================
SELECT policies_are(
    'public',
    'predictions',
    ARRAY[
        'predictions_select_own',
        'predictions_insert_own',
        'predictions_update_own',
        'predictions_select_admin'
    ],
    'TEST 2: public.predictions has exactly the four expected RLS policies'
);

-- ===========================================================================
-- TEST 3 — All three "own" policies target the `authenticated` role
--          (single assertion: every "own" policy has authenticated in roles[])
-- ===========================================================================
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'predictions'
          AND policyname IN (
              'predictions_select_own',
              'predictions_insert_own',
              'predictions_update_own'
          )
          AND 'authenticated' = ANY(roles)
    ),
    3,
    'TEST 3: all three predictions_*_own policies target the authenticated role'
);

-- ===========================================================================
-- TEST 4 — predictions_select_admin targets `authenticated` AND its USING
--          expression contains the is_admin_user() call.
--          pg_policies.qual is the deparsed USING text; we grep for the call.
-- ===========================================================================
SELECT ok(
    (
        SELECT 'authenticated' = ANY(roles)
               AND qual LIKE '%is_admin_user()%'
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'predictions'
          AND policyname = 'predictions_select_admin'
    ),
    'TEST 4: predictions_select_admin targets authenticated AND uses is_admin_user()'
);

-- ===========================================================================
-- TEST 5 — NO FOR DELETE policies exist on predictions
--          (deletes happen only via ON DELETE CASCADE from participants/matches)
-- ===========================================================================
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'predictions'
          AND cmd IN ('DELETE', 'ALL')
    ),
    0,
    'TEST 5: public.predictions has NO FOR DELETE / FOR ALL policies (cascades only)'
);

-- ===========================================================================
-- Behavioural tests — switch to `authenticated` role and spoof JWT.
--
-- We GRANT the required table privileges to the `authenticated` role at the
-- top so PostgREST-style RLS reads/writes succeed. (Supabase grants these via
-- its `supabase_auth_admin` migration; in pgTAP we set them explicitly so the
-- test does not depend on grants outside the migrations under test.)
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE ON predictions TO authenticated;
GRANT SELECT ON participants TO authenticated;

-- ---------------------------------------------------------------------------
-- TEST 6 — Participant A sees their own row (1 row returned by SELECT *)
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test6;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT is(
    (SELECT COUNT(*)::int FROM predictions),
    1,
    'TEST 6: participant A SELECTs predictions and sees exactly 1 row (own row)'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test6;

-- ---------------------------------------------------------------------------
-- TEST 7 — Cross-participant invisibility:
--          A queries WHERE participant_id = B.id and gets 0 rows back.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test7;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');

-- Resolve B's participant id BEFORE switching role (the authenticated role's
-- participants SELECT policy may filter B out otherwise). Stash in a setting.
SELECT set_config(
    'test.b_participant_id',
    (SELECT id::text FROM participants WHERE oid = :'b_oid'::uuid),
    true
);

SET LOCAL ROLE authenticated;

SELECT is(
    (
        SELECT COUNT(*)::int
        FROM predictions
        WHERE participant_id = current_setting('test.b_participant_id')::uuid
    ),
    0,
    'TEST 7: participant A cannot SELECT participant B''s prediction rows (RLS strips them)'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test7;

-- ---------------------------------------------------------------------------
-- TEST 8 — Cross-participant INSERT must FAIL:
--          A tries to INSERT a prediction with participant_id = B.id.
--          The WITH CHECK clause of predictions_insert_own evaluates
--          B.id IN (rows-where-auth_user_id = auth.uid()) -> false -> raises
--          new_row_violates_row_level_security (SQLSTATE 42501).
--          SAVEPOINT lets the test continue after the expected error.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test8;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SELECT set_config(
    'test.b_participant_id',
    (SELECT id::text FROM participants WHERE oid = :'b_oid'::uuid),
    true
);
SELECT set_config(
    'test.match_id',
    (SELECT id::text FROM t_match),
    true
);

SET LOCAL ROLE authenticated;

SELECT throws_ok(
    $$INSERT INTO predictions (participant_id, match_id, predicted_home_score, predicted_away_score)
      VALUES (
          current_setting('test.b_participant_id')::uuid,
          current_setting('test.match_id')::uuid,
          5, 5
      )$$,
    '42501',  -- insufficient_privilege / new_row_violates_row_level_security
    NULL,
    'TEST 8: participant A INSERT with participant_id = B.id raises 42501 (RLS WITH CHECK violation)'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test8;

-- ---------------------------------------------------------------------------
-- TEST 9 — Participant A UPDATE of their own row succeeds.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test9;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');

SET LOCAL ROLE authenticated;

UPDATE predictions SET predicted_home_score = 4 WHERE predicted_home_score = 2;

SELECT is(
    (SELECT predicted_home_score::int FROM predictions WHERE predicted_home_score = 4),
    4,
    'TEST 9: participant A can UPDATE their own prediction row'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test9;

-- ---------------------------------------------------------------------------
-- TEST 10 — Admin SELECTs and sees BOTH participants' rows (2 rows).
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test10;
SELECT test_set_jwt(:'admin_user_id'::uuid, :'nortal_tid'::uuid, :'admin_oid'::uuid, 'admin@nortal.com');

SET LOCAL ROLE authenticated;

SELECT is(
    (SELECT COUNT(*)::int FROM predictions),
    2,
    'TEST 10: admin SELECTs predictions and sees BOTH participants'' rows (via is_admin_user())'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test10;

-- ---------------------------------------------------------------------------
-- TEST 11 — Anon role sees 0 rows (no policy grants anon any SELECT).
--           Anon has no JWT claims; we still GRANT SELECT to anon so the
--           query reaches the RLS layer rather than failing with
--           permission_denied at the table grant layer (which would mask
--           the RLS check).
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test11;
GRANT SELECT ON predictions TO anon;

-- Clear any leftover JWT from a prior test (defensive — SAVEPOINT rollback
-- above should have reverted it, but set_config(true) is transaction-scoped).
SELECT set_config('request.jwt.claims',    '', true);
SELECT set_config('request.jwt.claim.sub', '', true);

SET LOCAL ROLE anon;

SELECT is(
    (SELECT COUNT(*)::int FROM predictions),
    0,
    'TEST 11: anon role sees 0 rows on predictions (no policy grants anon SELECT)'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test11;

SELECT * FROM finish();

ROLLBACK;
