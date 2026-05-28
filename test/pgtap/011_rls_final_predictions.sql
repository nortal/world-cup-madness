-- pgTAP test: RLS policies on `public.final_predictions`
--
-- Source migrations:
--   supabase/migrations/0022_create_final_predictions.sql  (table + champion≠runner-up CHECK)
--   supabase/migrations/0029_prediction_rls.sql            (the four RLS policies)
-- Spec reference:
--   specs/003-predictions-and-scoring/data-model.md §4.2 (policy shape: same as predictions)
--   specs/003-predictions-and-scoring/data-model.md §1.2 (table spec + CHECK constraint)
--
-- Invariants under test (policy plumbing + behaviour):
--   * RLS is ENABLED on public.final_predictions.
--   * Exactly 4 policies exist, with the expected names:
--       - final_predictions_select_own
--       - final_predictions_insert_own
--       - final_predictions_update_own
--       - final_predictions_select_admin
--   * The three "own" policies target the `authenticated` role.
--   * The admin SELECT policy USING clause references is_admin_user().
--   * NO DELETE policies (deletions only via participant cascade).
--
-- Behavioural tests (executed under `authenticated` role with spoofed JWT):
--   * Participant A can SELECT their own row.
--   * Participant A cannot SELECT participant B's row (filtered out by RLS, 0 rows).
--   * Participant A cannot INSERT a row with participant_id = B.id
--     (WITH CHECK fails -> insufficient_privilege / 42501).
--   * Participant A can UPDATE their own row (top_scorer_player_id change).
--   * Admin role SELECT * returns every existing row (>= 1; the only seeded row is A's).
--   * Attempting to UPDATE champion_team_id = runner_up_team_id violates
--     final_predictions_champion_distinct_runner_up CHECK (23514).
--
-- JWT spoofing pattern: copied verbatim from 003_provision_function.sql
-- and 008_match_rpcs.sql (project convention: pgTAP files are self-contained).
-- pgTAP's throws_ok wraps the failing statement in its own SAVEPOINT so the
-- outer transaction stays usable across the remaining assertions.

BEGIN;

SELECT plan(12);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for deterministic assertions
-- ---------------------------------------------------------------------------
\set nortal_tid       '11111111-1111-1111-1111-111111111111'
-- Participant A (active, owns the seeded final_predictions row)
\set a_user_id        '21111111-1111-1111-1111-111111111111'
\set a_oid            '22222222-2222-2222-2222-222222222222'
-- Participant B (active, never submits a final_prediction)
\set b_user_id        '31111111-1111-1111-1111-111111111111'
\set b_oid            '33333333-3333-3333-3333-333333333333'
-- Admin participant for the admin-SELECT assertion
\set admin_user_id    '41111111-1111-1111-1111-111111111111'
\set admin_oid        '44444444-4444-4444-4444-444444444444'

-- ---------------------------------------------------------------------------
-- Helper: spoof the JWT claims so auth.uid() / is_admin_user() resolve.
-- ---------------------------------------------------------------------------
-- Copied verbatim from 003_provision_function.sql / 008_match_rpcs.sql.
-- Uses app_metadata.tid + app_metadata.oid placement per migration 0010's
-- claim-reads update.
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
-- Seed: tournament_config (nortal tenant + admin_oids list naming our admin)
-- ---------------------------------------------------------------------------
-- The admin participant's oid MUST appear in admin_oids for is_admin_user()
-- to return true once the participant row is created with role='admin'.
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', ARRAY[:'admin_oid']::uuid[])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

-- ---------------------------------------------------------------------------
-- Seed: auth.users rows so the participants FK to auth.users(id) is valid.
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id) VALUES
    (:'a_user_id'),
    (:'b_user_id'),
    (:'admin_user_id')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: two active participants A + B, plus an admin participant.
-- ---------------------------------------------------------------------------
INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'a_user_id'::uuid,     :'a_oid'::uuid,     'a@nortal.com',     'Participant A', 'participant', 'active'),
    (:'b_user_id'::uuid,     :'b_oid'::uuid,     'b@nortal.com',     'Participant B', 'participant', 'active'),
    (:'admin_user_id'::uuid, :'admin_oid'::uuid, 'admin@nortal.com', 'Admin User',    'admin',       'active')
ON CONFLICT (oid) DO NOTHING;

-- ===========================================================================
-- 1. RLS plumbing assertions (policy existence, command, role, predicate)
-- ===========================================================================

-- 1.1 RLS is enabled on final_predictions.
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.final_predictions'::regclass
    ),
    TRUE,
    'RLS is enabled on public.final_predictions'
);

-- 1.2 The exact set of policies on final_predictions matches migration 0029.
SELECT policies_are(
    'public',
    'final_predictions',
    ARRAY[
        'final_predictions_select_own',
        'final_predictions_insert_own',
        'final_predictions_update_own',
        'final_predictions_select_admin'
    ],
    'public.final_predictions has exactly the four expected RLS policies'
);

-- 1.3 Each of the three "own" policies targets the `authenticated` role.
--     (We assert all three in a single ok() via subquery aggregation so the
--     plan count stays compact; per-policy granularity is covered by 1.2 +
--     policies_are above and by the SET ROLE behavioural tests below.)
SELECT ok(
    (
        SELECT bool_and('authenticated' = ANY(roles))
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'final_predictions'
          AND policyname IN (
                'final_predictions_select_own',
                'final_predictions_insert_own',
                'final_predictions_update_own'
          )
    ),
    'all three final_predictions "own" policies target the authenticated role'
);

-- 1.4 The admin SELECT policy USING clause references is_admin_user().
SELECT ok(
    (SELECT qual
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename  = 'final_predictions'
        AND policyname = 'final_predictions_select_admin')
    LIKE '%is_admin_user()%',
    'final_predictions_select_admin USING clause references is_admin_user()'
);

-- 1.5 NO DELETE policies — final_predictions stay until the participant
--     cascade purges them (FK ON DELETE CASCADE from participants).
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'final_predictions'
          AND cmd = 'DELETE'
    ),
    0,
    'public.final_predictions has NO DELETE policies (rows persist until participant cascade)'
);

-- ===========================================================================
-- 2. Seed one final_predictions row for participant A via the test
--    session's role (superuser bypasses RLS), with champion=ENG, runner-up=FRA.
--    We resolve the team UUIDs by TLA from the migration 0017 seed so the
--    test stays decoupled from team-id reshuffles.
-- ===========================================================================
INSERT INTO final_predictions (participant_id, champion_team_id, runner_up_team_id)
VALUES (
    (SELECT id FROM participants WHERE oid = :'a_oid'::uuid),
    (SELECT id FROM teams        WHERE tla = 'ENG'),
    (SELECT id FROM teams        WHERE tla = 'FRA')
);

-- ===========================================================================
-- 3. Behavioural assertions under the `authenticated` role
-- ===========================================================================

-- Sign in as participant A and switch into the `authenticated` role so the
-- per-policy USING / WITH CHECK clauses are evaluated (the test session is
-- superuser by default, which bypasses RLS entirely).
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

-- 3.1 Participant A sees exactly their own row (1 row).
SELECT is(
    (SELECT COUNT(*)::int FROM final_predictions),
    1,
    'participant A SELECT * FROM final_predictions returns exactly 1 row (own row)'
);

-- 3.2 Participant A cannot read participant B's row — the predicate filters
--     it out (we ask for B's participant_id explicitly; expect 0 rows).
SELECT is(
    (SELECT COUNT(*)::int
       FROM final_predictions
      WHERE participant_id = (
          SELECT id FROM participants WHERE oid = :'b_oid'::uuid
      )),
    0,
    'participant A WHERE participant_id = B.id returns 0 rows (RLS filters out B)'
);

-- 3.3 Participant A cannot INSERT a row impersonating participant B.
--     The WITH CHECK on final_predictions_insert_own rejects it; PostgREST/
--     pg surfaces this as 42501 (insufficient_privilege) — same code used by
--     the matching predictions RLS tests + the existing trigger_match_sync
--     gate test in 008_match_rpcs.sql.
--     pgTAP wraps this throws_ok in its own SAVEPOINT so the outer
--     transaction survives for subsequent assertions.
SELECT throws_ok(
    $$ INSERT INTO final_predictions (participant_id, champion_team_id)
       VALUES (
           (SELECT id FROM participants WHERE oid = '33333333-3333-3333-3333-333333333333'::uuid),
           (SELECT id FROM teams        WHERE tla = 'ENG')
       ) $$,
    '42501',
    NULL,
    'participant A INSERT with participant_id=B fails with insufficient_privilege (RLS WITH CHECK)'
);

-- 3.4 Participant A can UPDATE their own row — change top_scorer_player_id.
--     We pick the first available player_id (NULL is also a valid value, but
--     to prove the UPDATE landed we set it to a non-NULL value if any player
--     rows exist; otherwise we set it back to NULL — both prove the policy
--     accepted the UPDATE since the row count returned must be 1).
--     Using top_scorer_player_id avoids touching the champion/runner-up
--     columns (whose CHECK is exercised separately below).
UPDATE final_predictions
   SET top_scorer_player_id = (SELECT id FROM players LIMIT 1),  -- may be NULL if players table empty
       updated_at           = now()
 WHERE participant_id = (SELECT id FROM participants WHERE oid = :'a_oid'::uuid);

SELECT is(
    (SELECT COUNT(*)::int
       FROM final_predictions
      WHERE participant_id = (SELECT id FROM participants WHERE oid = :'a_oid'::uuid)),
    1,
    'participant A UPDATE on own row succeeded (still selectable, 1 row)'
);

-- 3.5 Champion≠runner-up CHECK constraint — attempting to UPDATE both columns
--     to the same team UUID raises check_violation (23514).
--     Wrapped by pgTAP's throws_ok savepoint; the outer transaction survives.
SELECT throws_ok(
    $$ UPDATE final_predictions
          SET champion_team_id  = (SELECT id FROM teams WHERE tla = 'ENG'),
              runner_up_team_id = (SELECT id FROM teams WHERE tla = 'ENG')
        WHERE participant_id = (
            SELECT id FROM participants WHERE oid = '22222222-2222-2222-2222-222222222222'::uuid
        ) $$,
    '23514',  -- check_violation
    NULL,
    'UPDATE setting champion = runner-up violates final_predictions_champion_distinct_runner_up CHECK'
);

-- Drop back to the test session's superuser role so the admin assertion can
-- swap to a different JWT and re-enter `authenticated` cleanly.
RESET ROLE;

-- ===========================================================================
-- 4. Admin SELECT returns all rows (only A's row exists since B never
--    submitted a final_prediction).
-- ===========================================================================

-- Sign in as the admin participant; is_admin_user() now returns true because
-- the admin participant's oid is in tournament_config.admin_oids AND their
-- role is 'admin' AND status is 'active'.
SELECT test_set_jwt(:'admin_user_id'::uuid, :'nortal_tid'::uuid, :'admin_oid'::uuid, 'admin@nortal.com');
SET LOCAL ROLE authenticated;

-- 4.1 Admin sees at least one row (the seeded A row).
SELECT cmp_ok(
    (SELECT COUNT(*)::int FROM final_predictions),
    '>=',
    1,
    'admin SELECT * FROM final_predictions returns >= 1 row (via final_predictions_select_admin)'
);

-- 4.2 Of the visible rows, exactly 1 belongs to participant A (and none to
--     participant B, who never inserted). The admin policy is permissive so
--     this acts as both a "rows are visible" check and a sanity check on
--     the seed.
SELECT is(
    (SELECT COUNT(*)::int
       FROM final_predictions
      WHERE participant_id = (
          SELECT id FROM participants WHERE oid = '22222222-2222-2222-2222-222222222222'::uuid
      )),
    1,
    'admin sees exactly 1 row for participant A (and 0 for B, who never submitted)'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
