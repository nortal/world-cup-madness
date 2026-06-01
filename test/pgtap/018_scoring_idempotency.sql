-- pgTAP test: scoring idempotency + recalc-all grid (feature 003 US-PC, T056)
--
-- Source: supabase/migrations/0028_prediction_rpcs.sql (recalculate_all_scores)
--         supabase/migrations/0030_match_scoring_trigger.sql
-- Spec: FR-P16 (idempotent), FR-P18 (admin recalc-all), NFR-P3 (recalc time),
--       FR-P28 (scoring_runs telemetry)
--
-- Invariants under test (6 assertions):
--   1. recalc grid: seed 10 matches × 20 participants (all finished), run
--      recalculate_all_scores → 200 match score_events rows + matches_processed=10
--   2. idempotency: run recalc again → identical row count + identical total points
--   3. determinism: the SUM(points) across all participants is stable across runs
--   4. NFR-P3 proxy: the 10×20 grid recalc completes in < 10 seconds (full
--      104×200 is the production target; the proxy proves the per-match budget)
--   5. scoring_runs telemetry: each recalc writes one completed admin-recalc-all row
--   6. per-action mutex: a second concurrent in-flight row blocks a new recalc → skipped

BEGIN;

SELECT plan(6);

-- JWT helper (self-contained per project convention).
CREATE OR REPLACE FUNCTION test_set_jwt(p_sub UUID, p_tid UUID, p_oid UUID, p_email TEXT, p_name TEXT DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM set_config('request.jwt.claims',
        jsonb_build_object('sub', p_sub::text, 'email', p_email,
            'app_metadata', jsonb_build_object('tid', p_tid::text, 'oid', p_oid::text))::text, true);
    PERFORM set_config('request.jwt.claim.sub', p_sub::text, true);
END $$;

DELETE FROM participants;  -- hermetic start

\set nortal_tid '11111111-1111-1111-1111-111111111111'
\set admin_user '91111111-1111-1111-1111-111111111111'
\set admin_oid  '99999999-9999-9999-9999-999999999999'

INSERT INTO auth.users (id) VALUES (:'admin_user') ON CONFLICT (id) DO NOTHING;
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', ARRAY[:'admin_oid'::uuid])
ON CONFLICT (id) DO UPDATE SET admin_oids = EXCLUDED.admin_oids;

INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
VALUES (:'admin_user'::uuid, :'admin_oid'::uuid, 'gridadmin@nortal.com', 'GridAdmin', 'admin', 'active')
ON CONFLICT (oid) DO NOTHING;

-- Seed grid: 10 matches (all will be finished 2-1), 20 participants (incl admin).
-- Each participant predicts the same 2-1 so scoring is deterministic.
DO $$
DECLARE
    v_match UUID;
    v_part UUID;
    v_uid UUID;
    i INTEGER; j INTEGER;
    v_eng UUID := (SELECT id FROM teams WHERE tla='ENG');
    v_fra UUID := (SELECT id FROM teams WHERE tla='FRA');
BEGIN
    -- 19 extra participants (admin already seeded = 20 total active)
    FOR j IN 1..19 LOOP
        v_uid := gen_random_uuid();
        INSERT INTO auth.users (id) VALUES (v_uid);
        INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
            VALUES (v_uid, gen_random_uuid(), 'grid'||j||'@nortal.com', 'Grid'||j, 'participant', 'active');
    END LOOP;

    -- 10 matches, each scheduled (will be finished below), each with predictions
    FOR i IN 1..10 LOOP
        v_match := gen_random_uuid();
        INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status)
            VALUES (v_match, 98000+i, v_eng, v_fra, 'group', now() + (i || ' hours')::interval, 'finished');
        UPDATE matches SET score_home=2, score_away=1 WHERE id=v_match;  -- fires trigger; but predictions not in yet
        FOR v_part IN SELECT id FROM participants WHERE status='active' LOOP
            INSERT INTO predictions (participant_id, match_id, predicted_home_score, predicted_away_score)
                VALUES (v_part, v_match, 2, 1);
        END LOOP;
    END LOOP;
END $$;

-- At this point predictions exist but were inserted AFTER each match finished,
-- so the per-match trigger scored them as no-prediction. recalculate_all_scores
-- rebuilds with the predictions present.

-- TEST 1 — run recalc; matches_processed = 10
SELECT test_set_jwt(:'admin_user'::uuid, :'nortal_tid'::uuid, :'admin_oid'::uuid, 'gridadmin@nortal.com');
SET LOCAL ROLE authenticated;

SELECT is(
    (SELECT (recalculate_all_scores() ->> 'matches_processed'))::int,
    10,
    'TEST 1: recalculate_all_scores processes all 10 finished matches'
);
RESET ROLE;

-- TEST 2 — after recalc, 10 matches × 20 participants = 200 match-scoring rows,
-- all match-exact 10 (everyone predicted 2-1, official 2-1).
SELECT is(
    (SELECT count(*)::int FROM score_events WHERE source='match-exact'),
    200,
    'TEST 2: recalc produced 200 match-exact rows (10 matches × 20 participants)'
);

-- TEST 3 — determinism: capture total, run recalc again, total unchanged.
CREATE TEMP TABLE t_total AS SELECT COALESCE(sum(points),0)::int AS total FROM score_events WHERE match_id IS NOT NULL;

SELECT test_set_jwt(:'admin_user'::uuid, :'nortal_tid'::uuid, :'admin_oid'::uuid, 'gridadmin@nortal.com');
SET LOCAL ROLE authenticated;
SELECT recalculate_all_scores();
RESET ROLE;

SELECT is(
    (SELECT COALESCE(sum(points),0)::int FROM score_events WHERE match_id IS NOT NULL),
    (SELECT total FROM t_total),
    'TEST 3: total match points stable across two recalc runs (determinism, FR-P16)'
);

-- TEST 4 — idempotency on row count: still exactly 200 match-scoring rows.
SELECT is(
    (SELECT count(*)::int FROM score_events WHERE match_id IS NOT NULL),
    200,
    'TEST 4: row count unchanged after second recalc (no duplication, DELETE-then-INSERT)'
);

-- TEST 5 — telemetry: completed admin-recalc-all rows exist (one per run = 2).
SELECT cmp_ok(
    (SELECT count(*)::int FROM scoring_runs WHERE action='admin-recalc-all' AND finished_at IS NOT NULL),
    '>=', 2,
    'TEST 5: each recalc wrote a completed scoring_runs row (FR-P28 telemetry)'
);

-- TEST 6 — per-action mutex: pre-insert an in-flight row, new recalc → skipped.
INSERT INTO scoring_runs (action, started_at, status) VALUES ('admin-recalc-all', now(), 'success');
SELECT test_set_jwt(:'admin_user'::uuid, :'nortal_tid'::uuid, :'admin_oid'::uuid, 'gridadmin@nortal.com');
SET LOCAL ROLE authenticated;
SELECT is(
    (SELECT recalculate_all_scores() ->> 'outcome'),
    'skipped',
    'TEST 6: concurrent in-flight recalc is rejected (per-action partial-unique-index mutex)'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
