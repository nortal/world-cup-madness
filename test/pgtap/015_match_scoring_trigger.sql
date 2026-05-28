-- pgTAP test: match scoring trigger (feature 003 US-PC, T053)
--
-- Source migration: supabase/migrations/0030_match_scoring_trigger.sql
-- Contract: specs/003-predictions-and-scoring/contracts/trigger-calculate-match-points.md
-- Spec: FR-P12 (10/5/0), FR-P13 (trigger on finished/cancelled), FR-P14
--       (no-prediction rows), FR-P15 (cancelled = 0 to all), FR-P16 (idempotent)
--
-- SCHEMA NOTE: scores live on `matches` (no match_results table). The trigger
-- fires on UPDATE matches → status='finished'+scores OR status='cancelled'.
--
-- Invariants under test (12 assertions):
--   1. trigger exists on matches
--   2. exact score → match-exact, 10 pts
--   3. correct outcome → match-outcome, 5 pts
--   4. wrong outcome → match-wrong, 0 pts
--   5. no prediction → no-prediction, 0 pts
--   6. every active participant gets exactly one row per finished match
--   7. cancelled match → match-cancelled, 0 pts, for everyone
--   8. trigger does NOT fire on status='live' (no rows written)
--   9. idempotency: re-finishing with same score keeps one row per participant + same points
--  10. re-score after admin correction flips source + points (5 → 10) in place
--  11. inactive participants are excluded from scoring
--  12. capacity: 50 participants scored in < 5 seconds (NFR-P2 proxy; full
--      200 is exercised by T056's recalc-all grid)

BEGIN;

SELECT plan(12);

-- Hermetic start: clear any participants left over from prior committed work
-- (e.g. manual psql smoke tests). All within this BEGIN/ROLLBACK, so it
-- reverts. CASCADE clears predictions / score_events / final_predictions.
DELETE FROM participants;

\set nortal_tid '11111111-1111-1111-1111-111111111111'

-- Seed two named participants + one inactive, plus a match.
\set p_exact_user   '21111111-1111-1111-1111-111111111111'
\set p_exact_oid    '22222222-2222-2222-2222-222222222222'
\set p_outcome_user '31111111-1111-1111-1111-111111111111'
\set p_outcome_oid  '33333333-3333-3333-3333-333333333333'
\set p_wrong_user   '41111111-1111-1111-1111-111111111111'
\set p_wrong_oid    '44444444-4444-4444-4444-444444444444'
\set p_none_user    '51111111-1111-1111-1111-111111111111'
\set p_none_oid     '55555555-5555-5555-5555-555555555555'
\set p_inactive_user '61111111-1111-1111-1111-111111111111'
\set p_inactive_oid  '66666666-6666-6666-6666-666666666666'
\set match_a '71111111-1111-1111-1111-111111111111'

INSERT INTO auth.users (id) VALUES
    (:'p_exact_user'), (:'p_outcome_user'), (:'p_wrong_user'),
    (:'p_none_user'), (:'p_inactive_user')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', '{}'::uuid[])
ON CONFLICT (id) DO UPDATE SET nortal_tenant_id = EXCLUDED.nortal_tenant_id;

INSERT INTO participants (auth_user_id, oid, email, display_name, role, status) VALUES
    (:'p_exact_user'::uuid,    :'p_exact_oid'::uuid,    'exact@nortal.com',    'Exact',    'participant', 'active'),
    (:'p_outcome_user'::uuid,  :'p_outcome_oid'::uuid,  'outcome@nortal.com',  'Outcome',  'participant', 'active'),
    (:'p_wrong_user'::uuid,    :'p_wrong_oid'::uuid,    'wrong@nortal.com',    'Wrong',    'participant', 'active'),
    (:'p_none_user'::uuid,     :'p_none_oid'::uuid,     'none@nortal.com',     'None',     'participant', 'active'),
    (:'p_inactive_user'::uuid, :'p_inactive_oid'::uuid, 'inactive@nortal.com', 'Inactive', 'participant', 'inactive')
ON CONFLICT (oid) DO NOTHING;

-- Match A — start as scheduled.
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status)
VALUES (
    :'match_a'::uuid, 97001,
    (SELECT id FROM teams WHERE tla='ENG'),
    (SELECT id FROM teams WHERE tla='FRA'),
    'group', now() + interval '3 hours', 'scheduled'
) ON CONFLICT (id) DO NOTHING;

-- Predictions: exact 2-1, outcome 3-0 (home win), wrong 0-2 (away win); none = no row; inactive 2-1
INSERT INTO predictions (participant_id, match_id, predicted_home_score, predicted_away_score) VALUES
    ((SELECT id FROM participants WHERE oid=:'p_exact_oid'::uuid),    :'match_a'::uuid, 2, 1),
    ((SELECT id FROM participants WHERE oid=:'p_outcome_oid'::uuid),  :'match_a'::uuid, 3, 0),
    ((SELECT id FROM participants WHERE oid=:'p_wrong_oid'::uuid),    :'match_a'::uuid, 0, 2),
    ((SELECT id FROM participants WHERE oid=:'p_inactive_oid'::uuid), :'match_a'::uuid, 2, 1);

-- ---------------------------------------------------------------------------
-- TEST 1 — trigger exists on matches
-- ---------------------------------------------------------------------------
SELECT is(
    (SELECT count(*)::int FROM pg_trigger
        WHERE tgrelid = 'public.matches'::regclass
        AND tgname = 'matches_trigger_scoring'),
    1,
    'TEST 1: matches_trigger_scoring exists on matches'
);

-- Finish match A 2-1 → trigger fires.
UPDATE matches SET status='finished', score_home=2, score_away=1 WHERE id = :'match_a'::uuid;

-- TEST 2 — exact → match-exact 10
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE match_id=:'match_a'::uuid
        AND participant_id=(SELECT id FROM participants WHERE oid=:'p_exact_oid'::uuid)),
    'match-exact:10',
    'TEST 2: exact prediction (2-1 vs 2-1) → match-exact, 10 points'
);

-- TEST 3 — correct outcome → match-outcome 5
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE match_id=:'match_a'::uuid
        AND participant_id=(SELECT id FROM participants WHERE oid=:'p_outcome_oid'::uuid)),
    'match-outcome:5',
    'TEST 3: correct outcome (3-0 vs 2-1, both home win) → match-outcome, 5 points'
);

-- TEST 4 — wrong outcome → match-wrong 0
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE match_id=:'match_a'::uuid
        AND participant_id=(SELECT id FROM participants WHERE oid=:'p_wrong_oid'::uuid)),
    'match-wrong:0',
    'TEST 4: wrong outcome (0-2 away win vs 2-1 home win) → match-wrong, 0 points'
);

-- TEST 5 — no prediction → no-prediction 0
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE match_id=:'match_a'::uuid
        AND participant_id=(SELECT id FROM participants WHERE oid=:'p_none_oid'::uuid)),
    'no-prediction:0',
    'TEST 5: no prediction submitted → no-prediction, 0 points'
);

-- TEST 6 — exactly one row per ACTIVE participant (4 active, not the inactive one)
SELECT is(
    (SELECT count(*)::int FROM score_events WHERE match_id=:'match_a'::uuid),
    4,
    'TEST 6: one score_events row per active participant (4 active; inactive excluded)'
);

-- TEST 11 (checked here while match A is finished) — inactive participant has no row
SELECT is(
    (SELECT count(*)::int FROM score_events
        WHERE match_id=:'match_a'::uuid
        AND participant_id=(SELECT id FROM participants WHERE oid=:'p_inactive_oid'::uuid)),
    0,
    'TEST 11: inactive participant is excluded from scoring (0 rows despite having a prediction)'
);

-- TEST 9 — idempotency: re-finish with same score → still 4 rows, exact still 10
UPDATE matches SET status='finished', score_home=2, score_away=1 WHERE id = :'match_a'::uuid;
SELECT is(
    (SELECT count(*)::int FROM score_events WHERE match_id=:'match_a'::uuid)
        || '/' ||
    (SELECT points FROM score_events
        WHERE match_id=:'match_a'::uuid
        AND participant_id=(SELECT id FROM participants WHERE oid=:'p_exact_oid'::uuid)),
    '4/10',
    'TEST 9: re-finishing with the same score is idempotent (4 rows, exact still 10)'
);

-- TEST 10 — admin correction 2-1 → 3-0: the "exact" participant (2-1) becomes
-- correct-outcome (still home win), the "outcome" participant (3-0) becomes exact.
UPDATE matches SET score_home=3, score_away=0 WHERE id = :'match_a'::uuid;
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE match_id=:'match_a'::uuid
        AND participant_id=(SELECT id FROM participants WHERE oid=:'p_outcome_oid'::uuid)),
    'match-exact:10',
    'TEST 10: admin score correction (2-1 → 3-0) flips the 3-0 picker from outcome(5) to exact(10) in place'
);

-- TEST 7 — cancelled match: new match B, cancel it, everyone gets match-cancelled 0
\set match_b '72222222-2222-2222-2222-222222222222'
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status)
VALUES (
    :'match_b'::uuid, 97002,
    (SELECT id FROM teams WHERE tla='ENG'),
    (SELECT id FROM teams WHERE tla='GER'),
    'group', now() + interval '5 hours', 'scheduled'
);
UPDATE matches SET status='cancelled' WHERE id = :'match_b'::uuid;
SELECT is(
    (SELECT count(*)::int FROM score_events
        WHERE match_id=:'match_b'::uuid AND source='match-cancelled' AND points=0),
    4,
    'TEST 7: cancelled match awards match-cancelled 0 to all 4 active participants'
);

-- TEST 8 — trigger does NOT fire on status='live'
\set match_c '73333333-3333-3333-3333-333333333333'
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status)
VALUES (
    :'match_c'::uuid, 97003,
    (SELECT id FROM teams WHERE tla='ESP'),
    (SELECT id FROM teams WHERE tla='ITA'),
    'group', now() + interval '7 hours', 'scheduled'
);
UPDATE matches SET status='live', score_home=1, score_away=0 WHERE id = :'match_c'::uuid;
SELECT is(
    (SELECT count(*)::int FROM score_events WHERE match_id=:'match_c'::uuid),
    0,
    'TEST 8: trigger does NOT fire on status=live (in-progress score update writes no score_events)'
);

-- TEST 12 — capacity: 50 extra participants + 1 new match, finish, assert < 5s.
-- (Full 200-participant scale is exercised end-to-end by T056's recalc grid;
-- here we prove the single-match trigger budget is comfortably met.)
CREATE TEMP TABLE t_capacity (elapsed_ms NUMERIC);

DO $$
DECLARE
    v_match UUID := gen_random_uuid();
    v_uid UUID;
    i INTEGER;
    v_start TIMESTAMPTZ;
BEGIN
    INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status)
    VALUES (v_match, 97050,
        (SELECT id FROM teams WHERE tla='BRA'),
        (SELECT id FROM teams WHERE tla='ARG'),
        'group', now() + interval '9 hours', 'scheduled');

    FOR i IN 1..50 LOOP
        v_uid := gen_random_uuid();
        INSERT INTO auth.users (id) VALUES (v_uid);
        INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
            VALUES (v_uid, gen_random_uuid(), 'cap'||i||'@nortal.com', 'Cap'||i, 'participant', 'active');
        INSERT INTO predictions (participant_id, match_id, predicted_home_score, predicted_away_score)
            VALUES ((SELECT id FROM participants WHERE auth_user_id=v_uid), v_match, i % 5, (i+1) % 4);
    END LOOP;

    v_start := clock_timestamp();
    UPDATE matches SET status='finished', score_home=2, score_away=1 WHERE id = v_match;
    INSERT INTO t_capacity (elapsed_ms)
        VALUES (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000);
END $$;

-- TEST 12 — capacity assertion (SELECT ok so it emits a TAP line)
SELECT ok(
    (SELECT elapsed_ms FROM t_capacity) < 5000,
    format('TEST 12: 50-participant match scoring trigger completed in %sms (< 5000ms, NFR-P2)',
        round((SELECT elapsed_ms FROM t_capacity)))
);

SELECT * FROM finish();

ROLLBACK;
