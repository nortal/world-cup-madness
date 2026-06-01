-- pgTAP test: prediction + scoring RPCs (feature 003)
--
-- Source migration: supabase/migrations/0028_prediction_rpcs.sql
-- Spec references:
--   specs/003-predictions-and-scoring/contracts/rpc-submit-prediction.md
--   specs/003-predictions-and-scoring/spec.md FR-P01..FR-P06
--
-- This file is named 017_prediction_rpcs.sql because it grows in three phases:
--   T019 (this file)  — submit_prediction coverage (lock semantics + audit)
--   T038 (future)     — submit_final_prediction coverage
--   T055 (future)     — set_tournament_winner + recalculate_all_scores coverage
-- Section dividers below mark the extension points for the later phases so the
-- file's structure stays predictable.
--
-- ---------------------------------------------------------------------------
-- LOCK SEMANTIC (read me first — this is the source of the boundary triplet)
-- ---------------------------------------------------------------------------
-- BR-LOCK-002 + BR-LOCK-003 specify a STRICT-GREATER-THAN lock boundary. The
-- guard in submit_prediction is:
--
--     IF v_kickoff_utc IS NULL OR (v_kickoff_utc - now()) <= interval '60 minutes' THEN
--         RAISE EXCEPTION 'PREDICTION_LOCKED' USING ERRCODE = 'check_violation';
--     END IF;
--
-- Therefore the three boundary cases are:
--   kickoff_utc = now() + 61 minutes  -> remaining = 61 min -> EDITABLE  (61 > 60)
--   kickoff_utc = now() + 60 minutes  -> remaining = 60 min -> LOCKED    (60 <= 60)  ← THIS surprises readers
--   kickoff_utc = now() + 59 minutes  -> remaining = 59 min -> LOCKED    (59 <= 60)
--
-- Exactly-at-T-60-minutes is LOCKED, not editable. Do not "fix" this if a
-- future contributor expects T-60 = editable — re-read BR-LOCK-003 before
-- changing the comparison.
--
-- JWT simulation pattern: the test_set_jwt helper below is copied verbatim
-- from 008_match_rpcs.sql / 010_rls_predictions.sql (each pgTAP file is
-- self-contained per project convention).

BEGIN;

SELECT plan(31);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for deterministic assertions
-- ---------------------------------------------------------------------------
\set nortal_tid    '11111111-1111-1111-1111-111111111111'
-- Participant A — active, will submit predictions
\set a_user_id     '21111111-1111-1111-1111-111111111111'
\set a_oid         '22222222-2222-2222-2222-222222222222'
-- Admin OID — listed in tournament_config.admin_oids so is_admin_user() works
-- for any future test that needs it (this file doesn't, but the seed mirrors
-- 010_rls_predictions.sql so later phases can extend without reseeding).
\set admin_oid     '44444444-4444-4444-4444-444444444444'
-- Orphan auth user — has an auth.users row but NO participants row. Used by
-- the PARTICIPANT_NOT_FOUND test (TEST 10).
\set orphan_user_id '51111111-1111-1111-1111-111111111111'
\set orphan_oid     '55555555-5555-5555-5555-555555555555'

-- Deterministic match UUIDs (one per boundary case in the triplet).
\set m61_id        '7a000000-0000-0000-0000-000000000061'
\set m60_id        '7a000000-0000-0000-0000-000000000060'
\set m59_id        '7a000000-0000-0000-0000-000000000059'

-- ---------------------------------------------------------------------------
-- Helper: set the JWT claims for the next function call
-- ---------------------------------------------------------------------------
-- Copied verbatim from 008_match_rpcs.sql / 010_rls_predictions.sql. Uses
-- app_metadata.tid + app_metadata.oid placement per migration 0010's
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
-- Seed: auth.users (service-role / superuser context — RLS does not apply here)
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id) VALUES
    (:'a_user_id'),
    (:'orphan_user_id')
ON CONFLICT (id) DO NOTHING;

-- tournament_config row 1 (required for is_admin_user() lookups even though
-- this file doesn't currently exercise admin paths — keeps the seed consistent
-- with 010_rls_predictions.sql so later phases can extend without rework).
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', ARRAY[:'admin_oid'::uuid])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

-- Active participant A. The orphan auth user gets NO participants row on
-- purpose so submit_prediction raises PARTICIPANT_NOT_FOUND for them.
INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'a_user_id'::uuid, :'a_oid'::uuid, 'a@nortal.com', 'User A', 'participant', 'active')
ON CONFLICT (oid) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: three matches, one per boundary case in the lock triplet.
-- Teams come from the migration 0017 seed via TLA lookup — ENG vs FRA, GER vs
-- ITA, BRA vs ARG would all work; we pick three distinct pairs to keep the
-- match rows obviously distinct in any failure output.
-- ---------------------------------------------------------------------------
INSERT INTO matches (
    id, provider_id, home_team_id, away_team_id, stage, group_label,
    kickoff_utc, venue, status
)
VALUES
    -- M61: kickoff in 61 minutes — remaining 61 > 60 → EDITABLE
    (:'m61_id'::uuid, 90061,
     (SELECT id FROM teams WHERE tla = 'ENG'),
     (SELECT id FROM teams WHERE tla = 'FRA'),
     'group', 'A', now() + interval '61 minutes', 'Test Stadium 61', 'scheduled'),
    -- M60: kickoff in EXACTLY 60 minutes — remaining 60 <= 60 → LOCKED (strict)
    (:'m60_id'::uuid, 90060,
     (SELECT id FROM teams WHERE tla = 'GER'),
     (SELECT id FROM teams WHERE tla = 'ITA'),
     'group', 'B', now() + interval '60 minutes', 'Test Stadium 60', 'scheduled'),
    -- M59: kickoff in 59 minutes — remaining 59 <= 60 → LOCKED
    (:'m59_id'::uuid, 90059,
     (SELECT id FROM teams WHERE tla = 'BRA'),
     (SELECT id FROM teams WHERE tla = 'ARG'),
     'group', 'C', now() + interval '59 minutes', 'Test Stadium 59', 'scheduled');

-- Suppress audit rows from the seed inserts above so the audit-content tests
-- (TEST 11 / 12) assert ONLY on RPC-emitted rows.
DELETE FROM audit_log;

-- ===========================================================================
-- submit_prediction() — tests 1-12
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Plumbing tests (catalog assertions — no RPC call needed)
-- ---------------------------------------------------------------------------

-- TEST 1 — Function exists with the documented signature
SELECT has_function(
    'public',
    'submit_prediction',
    ARRAY['uuid','integer','integer'],
    'TEST 1: submit_prediction(uuid, integer, integer) is defined'
);

-- TEST 2 — Function is SECURITY DEFINER (required so the RPC's audit + upsert
-- run with the function-owner's privileges, not the caller's authenticated role)
SELECT is(
    (
        SELECT prosecdef
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname = 'submit_prediction'
          AND pg_get_function_identity_arguments(p.oid)
              = 'p_match_id uuid, p_home integer, p_away integer'
    ),
    TRUE,
    'TEST 2: submit_prediction is SECURITY DEFINER (pg_proc.prosecdef = true)'
);

-- TEST 3 — EXECUTE granted to authenticated (the REVOKE/GRANT pair at the
-- bottom of migration 0028)
SELECT ok(
    has_function_privilege(
        'authenticated',
        'public.submit_prediction(uuid, integer, integer)',
        'EXECUTE'
    ),
    'TEST 3: authenticated role has EXECUTE on submit_prediction'
);

-- ---------------------------------------------------------------------------
-- Behavioural tests — switch to authenticated role and spoof JWT.
-- We GRANT the required table privileges to authenticated up front so the
-- RPC's writes succeed (mirrors 010_rls_predictions.sql pattern).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON predictions TO authenticated;
GRANT SELECT ON participants TO authenticated;
GRANT SELECT ON matches      TO authenticated;
GRANT SELECT, INSERT ON audit_log TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO authenticated;

-- ---------------------------------------------------------------------------
-- TEST 4 — T-61 min EDITABLE (happy path, action='created')
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test4;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT is(
    (SELECT submit_prediction(:'m61_id'::uuid, 2, 1) ->> 'outcome'),
    'success',
    'TEST 4a: T-61 min — submit_prediction returns outcome=success'
);

SELECT is(
    (SELECT submit_prediction(:'m61_id'::uuid, 2, 1) ->> 'action'),
    'updated',  -- the prior call already inserted; this second call is an UPDATE
    'TEST 4b: T-61 min — second call with same args returns action=updated (idempotent UPSERT)'
);

-- Re-run to capture predicted_home_score on the response envelope. We use a
-- fresh value (3, 1) so the assertion is unambiguous — submit_prediction echoes
-- the args it was called with.
SELECT is(
    ((SELECT submit_prediction(:'m61_id'::uuid, 3, 1)) ->> 'predicted_home_score')::int,
    3,
    'TEST 4c: T-61 min — response envelope echoes predicted_home_score=3'
);

RESET ROLE;
RELEASE SAVEPOINT sp_test4;

-- ---------------------------------------------------------------------------
-- TEST 5 — Re-submit same match (full happy path: created then updated)
-- We use a SEPARATE savepoint with a fresh participant/match combo so the
-- assertions about action='created' / action='updated' are unambiguous.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test5;
-- Reset predictions so the first call in this savepoint is genuinely an INSERT.
DELETE FROM predictions WHERE match_id = :'m61_id'::uuid;

SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

-- First call: insert (action='created').
SELECT is(
    (SELECT submit_prediction(:'m61_id'::uuid, 2, 1) ->> 'action'),
    'created',
    'TEST 5a: first submit_prediction for a (participant, match) pair returns action=created'
);

-- Second call: UPSERT updates the existing row (action='updated').
SELECT is(
    (SELECT submit_prediction(:'m61_id'::uuid, 2, 2) ->> 'action'),
    'updated',
    'TEST 5b: second submit_prediction for same (participant, match) returns action=updated'
);

RESET ROLE;
RELEASE SAVEPOINT sp_test5;

-- ---------------------------------------------------------------------------
-- TEST 6 — T-60 min LOCKED (boundary, strict-greater-than rule)
-- Exactly at kickoff_utc - 60 min the prediction IS locked. See the
-- LOCK SEMANTIC block at the top of this file.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test6;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
    format('SELECT submit_prediction(%L::uuid, 1, 0)', :'m60_id'),
    '23514',  -- check_violation
    NULL,
    'TEST 6: T-60 min (boundary) — submit_prediction raises check_violation / PREDICTION_LOCKED'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test6;

-- ---------------------------------------------------------------------------
-- TEST 7 — T-59 min LOCKED (inside the lock window)
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test7;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
    format('SELECT submit_prediction(%L::uuid, 1, 0)', :'m59_id'),
    '23514',  -- check_violation
    NULL,
    'TEST 7: T-59 min — submit_prediction raises check_violation / PREDICTION_LOCKED'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test7;

-- ---------------------------------------------------------------------------
-- TEST 8 — Out-of-range predicted_home_score (CHECK constraint at the table)
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test8;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
    format('SELECT submit_prediction(%L::uuid, 21, 0)', :'m61_id'),
    '23514',  -- check_violation (predictions_home_range, BETWEEN 0 AND 20)
    NULL,
    'TEST 8: predicted_home_score=21 raises check_violation (predictions_home_range)'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test8;

-- ---------------------------------------------------------------------------
-- TEST 9 — MATCH_NOT_FOUND for an unknown match UUID
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test9;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
    $$SELECT submit_prediction('00000000-0000-0000-0000-deadbeefdead'::uuid, 2, 1)$$,
    'P0002',  -- RAISE EXCEPTION ... USING ERRCODE='no_data_found' maps to PL/pgSQL P0002, not SQL-standard 02000
    NULL,
    'TEST 9: unknown match UUID raises no_data_found / MATCH_NOT_FOUND'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test9;

-- ---------------------------------------------------------------------------
-- TEST 10 — PARTICIPANT_NOT_FOUND when the JWT's auth.uid() has no active
-- participants row. We sign in as the orphan auth user (has auth.users row
-- but no participants row).
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test10;
SELECT test_set_jwt(:'orphan_user_id'::uuid, :'nortal_tid'::uuid, :'orphan_oid'::uuid, 'orphan@nortal.com');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
    format('SELECT submit_prediction(%L::uuid, 2, 1)', :'m61_id'),
    'P0002',  -- maps to PL/pgSQL no_data_found
    NULL,
    'TEST 10: JWT with no participants row raises no_data_found / PARTICIPANT_NOT_FOUND'
);

RESET ROLE;
ROLLBACK TO SAVEPOINT sp_test10;

-- ---------------------------------------------------------------------------
-- TEST 11 — Audit row written for the created action (payload content)
-- We perform a fresh INSERT in its own savepoint, then assert on the
-- most-recent prediction.created audit row for participant A.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test11;
-- Clear any prior audit rows + predictions so the assertion is unambiguous.
DELETE FROM audit_log;
DELETE FROM predictions WHERE match_id = :'m61_id'::uuid;

SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT submit_prediction(:'m61_id'::uuid, 2, 1);

RESET ROLE;

-- Stash participant A's id so the audit query can target their rows
-- regardless of role context.
SELECT set_config(
    'test.a_participant_id',
    (SELECT id::text FROM participants WHERE oid = :'a_oid'::uuid),
    true
);

SELECT is(
    (
        SELECT (new_value ->> 'match_id')::uuid
        FROM audit_log
        WHERE participant_id = current_setting('test.a_participant_id')::uuid
          AND action = 'prediction.created'
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1
    ),
    :'m61_id'::uuid,
    'TEST 11a: prediction.created audit row new_value.match_id matches M61'
);

SELECT is(
    (
        SELECT new_value ->> 'predicted_home_score'
        FROM audit_log
        WHERE participant_id = current_setting('test.a_participant_id')::uuid
          AND action = 'prediction.created'
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1
    ),
    '2',
    'TEST 11b: prediction.created audit row new_value.predicted_home_score = "2"'
);

RELEASE SAVEPOINT sp_test11;

-- ---------------------------------------------------------------------------
-- TEST 12 — Audit row written for the updated action (count >= 1)
-- Continues from TEST 11: the row from #11 already exists, so any subsequent
-- call to submit_prediction for the same (participant, match) is an UPDATE
-- and emits a prediction.updated audit row.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_test12;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT submit_prediction(:'m61_id'::uuid, 4, 2);

RESET ROLE;

SELECT cmp_ok(
    (
        SELECT COUNT(*)::int
        FROM audit_log
        WHERE participant_id = current_setting('test.a_participant_id')::uuid
          AND action = 'prediction.updated'
    ),
    '>=',
    1,
    'TEST 12: at least one prediction.updated audit row exists for participant A'
);

RELEASE SAVEPOINT sp_test12;

-- ===========================================================================
-- submit_final_prediction() — T038 (US-PB)
-- ===========================================================================
-- Coverage:
--   T13 — function exists
--   T14 — function is SECURITY DEFINER
--   T15 — authenticated has EXECUTE
--   T16 — partial submit (only champion + runner_up) returns success + action=created
--   T17 — full submit (all 4 picks) returns action=updated on second call
--   T18 — CHECK violation: champion == runner_up rejected
--   T19 — Lock: when min(kickoff_utc) is in the past → FINAL_PREDICTIONS_LOCKED

-- Test 13 — function exists
SELECT has_function(
    'public', 'submit_final_prediction', ARRAY['uuid','uuid','uuid','uuid'],
    'TEST 13: submit_final_prediction(uuid, uuid, uuid, uuid) is defined'
);

-- Test 14 — SECURITY DEFINER
SELECT is(
    (SELECT prosecdef FROM pg_proc WHERE proname = 'submit_final_prediction'),
    TRUE,
    'TEST 14: submit_final_prediction is SECURITY DEFINER'
);

-- Test 15 — EXECUTE grant to authenticated
SELECT ok(
    has_function_privilege('authenticated',
        'public.submit_final_prediction(uuid, uuid, uuid, uuid)', 'EXECUTE'),
    'TEST 15: authenticated has EXECUTE on submit_final_prediction'
);

-- Resolve two distinct team UUIDs for the picks (champion, runner_up).
\set fp_champion_id ''
\set fp_runner_up_id ''
SELECT set_config('test.fp_champion_id', (SELECT id::text FROM teams WHERE tla='ENG'), true);
SELECT set_config('test.fp_runner_up_id', (SELECT id::text FROM teams WHERE tla='FRA'), true);

-- Spoof participant A's JWT for the submit calls (re-use the same A from earlier tests).
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

-- Test 16 — partial submit (only champion + runner_up; players left NULL) → success, action=created
-- Note: there are zero non-cancelled matches at this point (test fixture seeded
-- only the M61/M60/M59 trio above which are all 'scheduled'). The "min kickoff
-- in the past" lock check passes because the earliest scheduled kickoff is in
-- the future (+59m).
SELECT is(
    (SELECT submit_final_prediction(
        current_setting('test.fp_champion_id')::uuid,
        current_setting('test.fp_runner_up_id')::uuid,
        NULL, NULL) ->> 'action'),
    'created',
    'TEST 16: partial submit_final_prediction (champion + runner_up only) returns action=created'
);

-- Test 17 — re-submit same row with one extra pick → action=updated
SELECT is(
    (SELECT submit_final_prediction(
        current_setting('test.fp_champion_id')::uuid,
        current_setting('test.fp_runner_up_id')::uuid,
        NULL, NULL) ->> 'action'),
    'updated',
    'TEST 17: second submit_final_prediction for same participant returns action=updated'
);

-- Test 18 — CHECK violation: champion == runner_up
RESET ROLE;
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
    format('SELECT submit_final_prediction(%L::uuid, %L::uuid, NULL, NULL)',
        current_setting('test.fp_champion_id'),
        current_setting('test.fp_champion_id')),  -- same UUID for both
    '23514',  -- check_violation from final_predictions_champion_distinct_runner_up
    NULL,
    'TEST 18: submit_final_prediction with champion == runner_up raises check_violation'
);

-- Test 19 — Lock: insert a match in the PAST, then attempt submit → FINAL_PREDICTIONS_LOCKED
RESET ROLE;
SAVEPOINT sp_lock_test;
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status)
VALUES (
    gen_random_uuid(), 95099,
    (SELECT id FROM teams WHERE tla='ENG'),
    (SELECT id FROM teams WHERE tla='GER'),
    'group',
    now() - interval '1 hour',
    'scheduled'
);
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
    format('SELECT submit_final_prediction(%L::uuid, NULL, NULL, NULL)',
        current_setting('test.fp_champion_id')),
    '23514',
    NULL,
    'TEST 19: submit_final_prediction after first kickoff raises FINAL_PREDICTIONS_LOCKED (BR-LOCK-005)'
);
RESET ROLE;
ROLLBACK TO SAVEPOINT sp_lock_test;

-- ===========================================================================
-- set_tournament_winner() + recalculate_all_scores() — T055 (US-PC)
-- ===========================================================================
-- Coverage (TEST 20-26):
--   20 — set_tournament_winner: non-admin caller → FORBIDDEN (42501)
--   21 — set_tournament_winner: admin + invalid item → INVALID_WINNER_ITEM (22023)
--   22 — set_tournament_winner: admin + valid champion → outcome=success
--   23 — set_tournament_winner: scoring_triggered=true on a real change
--   24 — recalculate_all_scores: non-admin → FORBIDDEN
--   25 — recalculate_all_scores: admin → outcome=success + scoring_runs row written
--   26 — recalculate_all_scores: mutex — pre-existing in-flight row → outcome=skipped

RESET ROLE;

-- Seed an admin participant (oid already in tournament_config.admin_oids).
\set admin_user_id '81111111-1111-1111-1111-111111111111'
INSERT INTO auth.users (id) VALUES (:'admin_user_id') ON CONFLICT (id) DO NOTHING;
INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
VALUES (:'admin_user_id'::uuid, :'admin_oid'::uuid, 'admin@nortal.com', 'Admin', 'admin', 'active')
ON CONFLICT (oid) DO NOTHING;

-- TEST 20 — non-admin (User A) → FORBIDDEN
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;
SELECT throws_ok(
    format('SELECT set_tournament_winner(%L, %L::uuid)', 'champion', gen_random_uuid()),
    '42501',
    NULL,
    'TEST 20: set_tournament_winner by non-admin raises insufficient_privilege (FORBIDDEN)'
);
RESET ROLE;

-- TEST 21 — admin + invalid item → INVALID_WINNER_ITEM
SELECT test_set_jwt(:'admin_user_id'::uuid, :'nortal_tid'::uuid, :'admin_oid'::uuid, 'admin@nortal.com');
SET LOCAL ROLE authenticated;
SELECT throws_ok(
    format('SELECT set_tournament_winner(%L, %L::uuid)', 'mvp', gen_random_uuid()),
    '22023',  -- invalid_parameter_value
    NULL,
    'TEST 21: set_tournament_winner with invalid item raises invalid_parameter_value (INVALID_WINNER_ITEM)'
);

-- TEST 22 — admin + valid champion → outcome=success
SELECT is(
    (SELECT set_tournament_winner('champion', (SELECT id FROM teams WHERE tla='ENG')) ->> 'outcome'),
    'success',
    'TEST 22: set_tournament_winner(champion, ENG) by admin returns outcome=success'
);

-- TEST 23 — scoring_triggered true on a real change (runner-up was unset → now set)
SELECT is(
    (SELECT set_tournament_winner('runner-up', (SELECT id FROM teams WHERE tla='FRA')) ->> 'scoring_triggered'),
    'true',
    'TEST 23: set_tournament_winner reports scoring_triggered=true when the column actually changes'
);
RESET ROLE;

-- TEST 24 — recalculate_all_scores by non-admin → FORBIDDEN
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;
SELECT throws_ok(
    'SELECT recalculate_all_scores()',
    '42501',
    NULL,
    'TEST 24: recalculate_all_scores by non-admin raises insufficient_privilege (FORBIDDEN)'
);
RESET ROLE;

-- TEST 25 — recalculate_all_scores by admin → success + scoring_runs row
SELECT test_set_jwt(:'admin_user_id'::uuid, :'nortal_tid'::uuid, :'admin_oid'::uuid, 'admin@nortal.com');
SET LOCAL ROLE authenticated;
SELECT is(
    (SELECT recalculate_all_scores() ->> 'outcome'),
    'success',
    'TEST 25: recalculate_all_scores by admin returns outcome=success'
);
RESET ROLE;
SELECT cmp_ok(
    (SELECT count(*)::int FROM scoring_runs WHERE action='admin-recalc-all' AND status='success' AND finished_at IS NOT NULL),
    '>=', 1,
    'TEST 25b: recalculate_all_scores wrote a completed scoring_runs row'
);

-- TEST 26 — mutex: pre-insert an in-flight row, then admin recalc → skipped.
-- NOTE: no SAVEPOINT/ROLLBACK here. The outer BEGIN/ROLLBACK cleans up the
-- in-flight row at file end. (A ROLLBACK TO SAVEPOINT would revert pgTAP's
-- transactional test counter and desync the planned-vs-ran tally even though
-- the `ok N` line was already printed.)
INSERT INTO scoring_runs (action, started_at, status) VALUES ('admin-recalc-all', now(), 'success');
SELECT test_set_jwt(:'admin_user_id'::uuid, :'nortal_tid'::uuid, :'admin_oid'::uuid, 'admin@nortal.com');
SET LOCAL ROLE authenticated;
SELECT is(
    (SELECT recalculate_all_scores() ->> 'outcome'),
    'skipped',
    'TEST 26: recalculate_all_scores returns outcome=skipped when another run is in-flight (mutex via partial unique index)'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
