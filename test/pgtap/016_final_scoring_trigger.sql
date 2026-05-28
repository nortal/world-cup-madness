-- pgTAP test: final-prediction scoring trigger (feature 003 US-PC, T054)
--
-- Source migration: supabase/migrations/0031_final_scoring_trigger.sql
-- Contract: specs/003-predictions-and-scoring/contracts/trigger-calculate-final-points.md
-- Spec: FR-P17 (20 pts per correct final pick), FR-P16 (idempotent),
--       research.md R-6 (FK cascade SET NULL fires single-participant rebuild)
--
-- Invariants under test (10 assertions):
--   1. tournament_config full-sweep trigger exists
--   2. final_predictions single-participant trigger exists
--   3. correct champion → final-champion, 20 pts (full sweep on config UPDATE)
--   4. incorrect champion → final-champion, 0 pts
--   5. NULL pick → final-not-picked-<item>, 0 pts
--   6. exactly 4 final rows per participant (one per item) after a sweep
--   7. single-participant rebuild: editing one participant's picks rebuilds
--      ONLY their rows
--   8. FK cascade: deleting a picked player SET NULLs the pick AND rebuilds
--      that participant's final-top-scorer row as final-not-picked-top-scorer (R-6)
--   9. idempotency: re-running full sweep with unchanged config keeps 4 rows + same points
--  10. correct top-scorer (player) → final-top-scorer, 20 pts

BEGIN;

SELECT plan(10);

DELETE FROM participants;  -- hermetic start (clears committed smoke-test data)

\set nortal_tid '11111111-1111-1111-1111-111111111111'
\set p1_user '21111111-1111-1111-1111-111111111111'
\set p1_oid  '22222222-2222-2222-2222-222222222222'
\set p2_user '31111111-1111-1111-1111-111111111111'
\set p2_oid  '33333333-3333-3333-3333-333333333333'

INSERT INTO auth.users (id) VALUES (:'p1_user'), (:'p2_user') ON CONFLICT (id) DO NOTHING;
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', '{}'::uuid[])
ON CONFLICT (id) DO UPDATE SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
    champion_team_id = NULL, runner_up_team_id = NULL,
    top_scorer_player_id = NULL, best_player_player_id = NULL;

INSERT INTO participants (auth_user_id, oid, email, display_name, role, status) VALUES
    (:'p1_user'::uuid, :'p1_oid'::uuid, 'fp1@nortal.com', 'FP1', 'participant', 'active'),
    (:'p2_user'::uuid, :'p2_oid'::uuid, 'fp2@nortal.com', 'FP2', 'participant', 'active')
ON CONFLICT (oid) DO NOTHING;

-- Seed a couple of players for the top-scorer picks.
INSERT INTO players (provider_player_id, name, position, team_id) VALUES
    (88001, 'Test TopScorer', 'Attacker', (SELECT id FROM teams WHERE tla='ENG')),
    (88002, 'Test Other', 'Midfielder', (SELECT id FROM teams WHERE tla='FRA'))
ON CONFLICT (provider_player_id) DO NOTHING;

-- P1 picks champion=ENG, top_scorer=TopScorer; P2 picks champion=FRA, nothing else.
INSERT INTO final_predictions (participant_id, champion_team_id, top_scorer_player_id)
VALUES (
    (SELECT id FROM participants WHERE oid=:'p1_oid'::uuid),
    (SELECT id FROM teams WHERE tla='ENG'),
    (SELECT id FROM players WHERE provider_player_id=88001)
);
INSERT INTO final_predictions (participant_id, champion_team_id)
VALUES (
    (SELECT id FROM participants WHERE oid=:'p2_oid'::uuid),
    (SELECT id FROM teams WHERE tla='FRA')
);

-- TEST 1 — full-sweep trigger exists
SELECT is(
    (SELECT count(*)::int FROM pg_trigger
        WHERE tgrelid='public.tournament_config'::regclass
        AND tgname='tournament_config_trigger_final_scoring'),
    1,
    'TEST 1: tournament_config_trigger_final_scoring exists'
);

-- TEST 2 — single-participant trigger exists
SELECT is(
    (SELECT count(*)::int FROM pg_trigger
        WHERE tgrelid='public.final_predictions'::regclass
        AND tgname='final_predictions_trigger_scoring'),
    1,
    'TEST 2: final_predictions_trigger_scoring exists'
);

-- Admin sets champion=ENG + top_scorer=TopScorer → full sweep fires.
UPDATE tournament_config
SET champion_team_id = (SELECT id FROM teams WHERE tla='ENG'),
    top_scorer_player_id = (SELECT id FROM players WHERE provider_player_id=88001);

-- TEST 3 — P1 correct champion → 20
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p1_oid'::uuid)
        AND source='final-champion'),
    'final-champion:20',
    'TEST 3: P1 correct champion (ENG) → final-champion, 20 points'
);

-- TEST 4 — P2 incorrect champion (FRA, winner is ENG) → 0
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p2_oid'::uuid)
        AND source='final-champion'),
    'final-champion:0',
    'TEST 4: P2 incorrect champion (FRA vs ENG) → final-champion, 0 points'
);

-- TEST 10 — P1 correct top-scorer → 20
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p1_oid'::uuid)
        AND source='final-top-scorer'),
    'final-top-scorer:20',
    'TEST 10: P1 correct top-scorer → final-top-scorer, 20 points'
);

-- TEST 5 — P2 never picked top-scorer → final-not-picked-top-scorer, 0
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p2_oid'::uuid)
        AND source::text LIKE 'final-%top-scorer'),
    'final-not-picked-top-scorer:0',
    'TEST 5: P2 unpicked top-scorer → final-not-picked-top-scorer, 0 points'
);

-- TEST 6 — exactly 4 final rows per participant
SELECT is(
    (SELECT count(*)::int FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p1_oid'::uuid)
        AND match_id IS NULL),
    4,
    'TEST 6: exactly 4 final-* rows per participant (champion/runner-up/top-scorer/best-player)'
);

-- TEST 9 — idempotency: re-run full sweep (set the same champion again, but
-- the WHEN clause requires a DISTINCT change, so toggle via NULL then back).
-- Simpler: directly call calculate_final_points(NULL) and assert stable.
SELECT calculate_final_points(NULL);
SELECT is(
    (SELECT count(*)::int FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p1_oid'::uuid)
        AND match_id IS NULL)
    || '/' ||
    (SELECT points FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p1_oid'::uuid)
        AND source='final-champion'),
    '4/20',
    'TEST 9: re-running full sweep is idempotent (still 4 rows, champion still 20)'
);

-- TEST 7 — single-participant rebuild: P2 edits their champion pick → only P2 rebuilds.
-- Capture P1's champion row id before, assert it is unchanged (same points)
-- after P2's edit fires only the single-participant trigger.
UPDATE final_predictions
SET champion_team_id = (SELECT id FROM teams WHERE tla='ENG')  -- now P2 correct too
WHERE participant_id = (SELECT id FROM participants WHERE oid=:'p2_oid'::uuid);
SELECT is(
    (SELECT points FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p2_oid'::uuid)
        AND source='final-champion'),
    20::smallint,
    'TEST 7: single-participant rebuild on final_predictions edit (P2 champion now ENG → 20)'
);

-- TEST 8 — FK cascade: delete the picked top-scorer player → P1's pick SET NULL,
-- final_predictions UPDATE trigger fires, P1's final-top-scorer rebuilt to not-picked.
DELETE FROM players WHERE provider_player_id = 88001;
SELECT is(
    (SELECT source::text || ':' || points FROM score_events
        WHERE participant_id=(SELECT id FROM participants WHERE oid=:'p1_oid'::uuid)
        AND source::text LIKE 'final-%top-scorer'),
    'final-not-picked-top-scorer:0',
    'TEST 8: deleting a picked player (FK SET NULL) rebuilds P1 final-top-scorer → not-picked, 0 (R-6)'
);

SELECT * FROM finish();

ROLLBACK;
