-- pgTAP test: T025 — scoring trigger MV-refresh extension
--                     (feature 004 US-LC)
--
-- Source migration: supabase/migrations/0034_extend_scoring_triggers_refresh.sql
--   (extends calculate_match_points, calculate_final_points,
--    recalculate_all_scores with FC-L2-decoupled refresh_leaderboard() tail.)
--
-- Companion pre-existing migrations whose contract this test reaffirms:
--   0030_match_scoring_trigger.sql   — matches_trigger_scoring trigger
--   0031_final_scoring_trigger.sql   — tournament_config & final_predictions triggers
--   0033_refresh_leaderboard_rpc.sql — refresh_leaderboard() RPC + audit shapes
--
-- Spec references (feature 004 US-LC scope):
--   FR-L06 — Realtime layer refreshes within 5s of scoring commit (this test
--            asserts the SERVER-SIDE half: the MV is refreshed inside the
--            scoring transaction so the audit row that drives Realtime is
--            already present at commit time).
--   FR-L12 — Every successful refresh writes a 'leaderboard.refresh' audit row.
--   FR-L16 — Subscribers only see the MV — verified by checking the MV catches
--            up after the trigger fires (no other surface exposes ranks).
--   FR-L17 — Admin direct refresh path (FC-L2 recovery branch, asserts 4-5).
--   FR-L18 — Reconnect / recovery behaviour. Server-side counterpart: the MV
--            can be brought back into sync by an explicit refresh after a
--            transient failure window (asserts 4-5).
--   FR-L19 — admin-only refresh_leaderboard() RPC (already covered by 022_*;
--            referenced here for the recovery path).
--   FR-L20 — Each scoring run's refresh attempt produces exactly one
--            audit row: success OR failed.
--   FC-L2  — Refresh failure decouples from scoring commit (asserts 3a-3d).
--   NFR-L2 — End-to-end 5s budget; the server-side prerequisite is that the
--            audit row exists at scoring-transaction commit time.
--
-- ACTUAL SHAPE NOTES (verified against migrations 0033 + 0034):
--   - audit_log columns are `action` / `occurred_at` / `entity_type` /
--     `entity_id` / `new_value`. The CHECK constraint name is
--     `audit_log_action_check`.
--   - refresh_leaderboard() detects caller_kind via the GUC
--     `app.scoring_run_id`. Migration 0034's two per-record functions mint a
--     synthetic UUID per invocation; recalculate_all_scores() passes the real
--     scoring_runs.id. Both result in caller_kind='trigger'.
--   - calculate_match_points() suppresses its tail refresh when invoked from
--     inside recalculate_all_scores() (sentinel GUC
--     app.suppress_leaderboard_refresh='true'), so a recalc-all run produces
--     exactly ONE refresh audit row at end-of-RPC — not N (one per match).
--
-- Asserts (13 total) — ordered so destructive index drops come last:
--    1. After matches UPDATE → status='finished'+score, the trigger fires AND
--       writes exactly one 'leaderboard.refresh' audit row (FR-L12 / FR-L20).
--    2. Audit payload caller_kind='trigger' (FR-L20).
--    3. Audit payload scoring_run_id is a non-null UUID (FR-L20 traceability).
--    4. MV reflects the new scoring: the participant who picked the exact
--       score has total_points=10 in the 'all' stage row (FR-L06 / FR-L16 —
--       the only ranking surface caught up inside the scoring transaction).
--    5. calculate_final_points() trigger (UPDATE tournament_config) emits
--       exactly one 'leaderboard.refresh' audit row (FR-L20).
--    6. recalculate_all_scores() RPC emits exactly ONE 'leaderboard.refresh'
--       audit row — not N (one per match). Validates the suppression GUC
--       path in migration 0034 (single end-of-RPC refresh).
--    7. recalculate_all_scores() refresh row's scoring_run_id equals the real
--       scoring_runs.id of the in-flight admin-recalc-all run (FR-L20).
--    8. FC-L2: drop the MV unique index → matches UPDATE → score_events
--       reflects the new state (scoring trigger committed despite refresh
--       failure).
--    9. FC-L2: same call → 'leaderboard.refresh_failed' audit row written.
--   10. FC-L2: outer transaction remains writable AFTER the failure — a smoke
--       INSERT into audit_log succeeds (would itself fail if the scoring
--       trigger had re-raised and aborted the tx).
--   11. FR-L17/L18 recovery: re-create the unique index → admin invokes
--       refresh_leaderboard() directly → MV catches up. We check by counting
--       the leaderboard_snapshots rows post-refresh (must equal active *
--       6 stages).
--   12. FR-L17/L18 recovery: the admin refresh emits a 'leaderboard.refresh'
--       row with caller_kind='admin'.
--   13. trigger path's MV row total_points matches the manually-summed
--       score_events total for the exact-picker after recovery (closes the
--       loop: refresh actually brought the MV back in sync).
--
-- ORDER NOTES:
--   - As in 022_*, we use SAVEPOINT/RELEASE (NOT ROLLBACK TO) so pgTAP's
--     planned-vs-ran counter stays in sync.
--   - The FC-L2 index-drop runs after ALL non-recovery asserts because DROP
--     INDEX leaderboard_snapshots_pk permanently breaks REFRESH ...
--     CONCURRENTLY for the rest of the transaction until step 11 re-creates
--     it. Steps 1-7 must complete before the drop.
--   - Between caller-kind segments we RESET app.scoring_run_id /
--     app.suppress_leaderboard_refresh to avoid the misroute bug noted in
--     022_*. RELEASE SAVEPOINT does not undo SET LOCAL.

BEGIN;

SELECT plan(13);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs
-- ---------------------------------------------------------------------------
\set nortal_tid          '11111111-1111-1111-1111-111111111111'

-- Admin participant (so direct refresh_leaderboard() works for the recovery test)
\set adm_user_id         '41111111-1111-1111-1111-111111111111'
\set adm_oid             '44444444-4444-4444-4444-444444444444'
\set adm_part_id         'dddddddd-dddd-dddd-dddd-dddddddddddd'

-- "Exact" prediction participant
\set e_user_id           '21111111-1111-1111-1111-111111111111'
\set e_oid               '22222222-2222-2222-2222-222222222222'
\set e_part_id           'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

-- Two more for tie/rank shape
\set b_user_id           '31111111-1111-1111-1111-111111111111'
\set b_oid               '33333333-3333-3333-3333-333333333333'

\set c_user_id           '51111111-1111-1111-1111-111111111111'
\set c_oid               '55555555-5555-5555-5555-555555555555'

-- Teams + match seeds
\set match_a             '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set match_b             '5bbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

-- ---------------------------------------------------------------------------
-- Helper: set JWT claims (admin path)
-- ---------------------------------------------------------------------------
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
-- Hermetic start — clear participants (CASCADE clears predictions /
-- score_events / final_predictions), clear matches.
-- ---------------------------------------------------------------------------
DELETE FROM participants;
DELETE FROM matches WHERE provider_id BETWEEN 99000 AND 99999;

-- ---------------------------------------------------------------------------
-- Seed auth.users + tournament_config + participants
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id) VALUES
    (:'adm_user_id'), (:'e_user_id'), (:'b_user_id'), (:'c_user_id')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', ARRAY[:'adm_oid'::uuid])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids,
        champion_team_id = NULL,
        runner_up_team_id = NULL,
        top_scorer_player_id = NULL,
        best_player_player_id = NULL;

INSERT INTO participants (id, auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'adm_part_id'::uuid, :'adm_user_id'::uuid, :'adm_oid'::uuid, 'adm@nortal.com',  'Admin User',  'admin',       'active'),
    (:'e_part_id'::uuid,   :'e_user_id'::uuid,   :'e_oid'::uuid,   'exact@nortal.com','Exact',       'participant', 'active'),
    (gen_random_uuid(),    :'b_user_id'::uuid,   :'b_oid'::uuid,   'b@nortal.com',    'Bob',         'participant', 'active'),
    (gen_random_uuid(),    :'c_user_id'::uuid,   :'c_oid'::uuid,   'c@nortal.com',    'Carol',       'participant', 'active')
ON CONFLICT (oid) DO NOTHING;

-- Seed match A — scheduled. We UPDATE it to 'finished' in TEST 1 to fire trigger.
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage,
                     group_label, kickoff_utc, venue, status)
VALUES
    (:'match_a'::uuid, 99001,
     (SELECT id FROM teams WHERE tla='ENG'),
     (SELECT id FROM teams WHERE tla='FRA'),
     'group', 'A', now() + interval '3 hours', 'Test Stadium A', 'scheduled');

-- Predictions: Exact picks 2-1 (will be exact), Bob picks 3-0 (correct outcome), Carol picks 0-2 (wrong outcome)
INSERT INTO predictions (participant_id, match_id, predicted_home_score, predicted_away_score) VALUES
    (:'e_part_id'::uuid, :'match_a'::uuid, 2, 1),
    ((SELECT id FROM participants WHERE oid=:'b_oid'::uuid), :'match_a'::uuid, 3, 0),
    ((SELECT id FROM participants WHERE oid=:'c_oid'::uuid), :'match_a'::uuid, 0, 2);

-- Clear any leftover leaderboard audit rows so per-test counts are unambiguous.
DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';

-- Ensure the MV has a clean state we can REFRESH CONCURRENTLY against.
REFRESH MATERIALIZED VIEW leaderboard_snapshots;

-- ===========================================================================
-- TESTS 1-4: Match-scoring trigger refreshes MV with caller_kind='trigger'
-- ===========================================================================
SAVEPOINT sp_match_trigger;

-- Fire the scoring trigger. Match goes 2-1 (Exact's prediction is exact, 10pts).
UPDATE matches SET status='finished', score_home=2, score_away=1
    WHERE id = :'match_a'::uuid;

-- Assert 1 (FR-L12 / FR-L20): exactly one 'leaderboard.refresh' audit row.
SELECT is(
    (SELECT count(*)::int FROM audit_log WHERE action = 'leaderboard.refresh'),
    1,
    'TEST 1 (FR-L12/FR-L20): matches UPDATE → exactly one leaderboard.refresh audit row'
);

-- Assert 2 (FR-L20): caller_kind='trigger' on the audit payload.
SELECT is(
    (SELECT new_value ->> 'caller_kind'
     FROM audit_log
     WHERE action = 'leaderboard.refresh'
     ORDER BY occurred_at DESC, id DESC LIMIT 1),
    'trigger',
    'TEST 2 (FR-L20): matches UPDATE audit payload records caller_kind=trigger'
);

-- Assert 3 (FR-L20): scoring_run_id is a non-null UUID (synthetic per-call uuid).
SELECT isnt(
    (SELECT new_value ->> 'scoring_run_id'
     FROM audit_log
     WHERE action = 'leaderboard.refresh'
     ORDER BY occurred_at DESC, id DESC LIMIT 1),
    NULL,
    'TEST 3 (FR-L20): matches UPDATE audit payload carries a non-null scoring_run_id'
);

-- Assert 4 (FR-L06/FR-L16): MV reflects new scoring inside the scoring tx.
-- Exact participant total_points should be 10 in 'all' stage.
SELECT is(
    (SELECT total_points::int FROM leaderboard_snapshots
        WHERE participant_id = :'e_part_id'::uuid AND stage = 'all'),
    10,
    'TEST 4 (FR-L06/FR-L16): MV reflects new score (Exact = 10 pts) after scoring trigger refresh'
);

RELEASE SAVEPOINT sp_match_trigger;

-- ===========================================================================
-- TEST 5: calculate_final_points() trigger via tournament_config UPDATE
-- ===========================================================================
SAVEPOINT sp_final_trigger;

DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';

-- Insert a final_predictions row for Exact so final-* score_events get written.
INSERT INTO final_predictions (participant_id, champion_team_id)
VALUES (:'e_part_id'::uuid, (SELECT id FROM teams WHERE tla='ENG'))
ON CONFLICT (participant_id) DO UPDATE
    SET champion_team_id = EXCLUDED.champion_team_id;

-- Fire the full-sweep trigger by setting the tournament champion.
UPDATE tournament_config
    SET champion_team_id = (SELECT id FROM teams WHERE tla='ENG')
    WHERE id = 1;

-- Assert 5: exactly one 'leaderboard.refresh' audit row from the final trigger.
SELECT is(
    (SELECT count(*)::int FROM audit_log WHERE action = 'leaderboard.refresh'),
    1,
    'TEST 5 (FR-L12/FR-L20): tournament_config UPDATE fires final scoring trigger → exactly one leaderboard.refresh audit row'
);

RELEASE SAVEPOINT sp_final_trigger;

-- ===========================================================================
-- TESTS 6-7: recalculate_all_scores() emits ONE refresh row at end-of-RPC
-- ===========================================================================
SAVEPOINT sp_recalc_all;

-- Add a second finished match so we know the loop covers > 1 iteration; if
-- migration 0034 misbehaved and emitted one refresh PER match, the count
-- would be 2 (or more), failing assert 6.
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage,
                     group_label, kickoff_utc, venue, status,
                     score_home, score_away)
VALUES
    (:'match_b'::uuid, 99002,
     (SELECT id FROM teams WHERE tla='GER'),
     (SELECT id FROM teams WHERE tla='ESP'),
     'group', 'B', now() - interval '2 hours', 'Test Stadium B',
     'finished', 1, 1);
-- ^ This INSERT itself fires the per-match trigger, which emits one
-- leaderboard.refresh row. We clear audit_log AFTER the insert.

DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';

-- Run recalc-all as admin.
SELECT test_set_jwt(:'adm_user_id'::uuid, :'nortal_tid'::uuid, :'adm_oid'::uuid, 'adm@nortal.com');
SET LOCAL ROLE authenticated;

-- Capture the recalc-all run id from the returned jsonb so we can verify the
-- audit payload's scoring_run_id matches.
CREATE TEMP TABLE t_recalc_run (run_id UUID, outcome TEXT) ON COMMIT DROP;

INSERT INTO t_recalc_run (run_id, outcome)
SELECT
    (refresh_result ->> 'scoring_run_id')::UUID,
    refresh_result ->> 'outcome'
FROM (SELECT recalculate_all_scores() AS refresh_result) sub;

RESET ROLE;

-- Assert 6: exactly ONE 'leaderboard.refresh' audit row from the recalc-all
-- RPC, even though it called calculate_match_points() for both match A and
-- match B. Validates the suppression-GUC mechanism in migration 0034.
SELECT is(
    (SELECT count(*)::int FROM audit_log WHERE action = 'leaderboard.refresh'),
    1,
    'TEST 6 (FR-L20 + 0034): recalculate_all_scores emits exactly ONE leaderboard.refresh row (not N per match)'
);

-- Assert 7: the audit row's scoring_run_id is the real admin-recalc-all
-- scoring_runs.id (not a synthetic per-match UUID).
SELECT is(
    (SELECT new_value ->> 'scoring_run_id'
     FROM audit_log
     WHERE action = 'leaderboard.refresh'
     ORDER BY occurred_at DESC, id DESC LIMIT 1),
    (SELECT run_id::text FROM t_recalc_run),
    'TEST 7 (FR-L20): recalc-all refresh row carries the real scoring_runs.id (admin-recalc-all)'
);

RELEASE SAVEPOINT sp_recalc_all;

-- ===========================================================================
-- TESTS 8-10: FC-L2 — drop unique index, force refresh failure, prove the
--                     scoring tx still commits + outer tx stays writable.
-- ===========================================================================
SAVEPOINT sp_fc_l2;

DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';

-- Drop the unique index REFRESH ... CONCURRENTLY requires. The refresh inside
-- the scoring tail will then raise — refresh_leaderboard()'s inner EXCEPTION
-- writes a 'leaderboard.refresh_failed' row and returns non-error jsonb. The
-- outer BEGIN/EXCEPTION in calculate_match_points() additionally swallows any
-- exception leaking out — both layers together protect the scoring commit.
DROP INDEX leaderboard_snapshots_pk;

-- Fire a re-score: change match A from 2-1 → 3-0. Exact's exact 2-1 prediction
-- becomes correct-outcome (still home win) instead of exact, so points fall
-- from 10 to 5. This proves the scoring write committed despite refresh failure.
UPDATE matches SET score_home=3, score_away=0 WHERE id = :'match_a'::uuid;

-- Assert 8: score_events reflects the new state — the scoring transaction
-- successfully committed even though the refresh failed (FC-L2 core promise).
SELECT is(
    (SELECT source::text || ':' || points::text
        FROM score_events
        WHERE match_id = :'match_a'::uuid
        AND participant_id = :'e_part_id'::uuid),
    'match-outcome:5',
    'TEST 8 (FC-L2): scoring trigger committed despite refresh failure — Exact = match-outcome 5'
);

-- Assert 9: 'leaderboard.refresh_failed' audit row was written.
SELECT is(
    (SELECT count(*)::int FROM audit_log WHERE action = 'leaderboard.refresh_failed'),
    1,
    'TEST 9 (FC-L2 / FR-L20): refresh failure produced a leaderboard.refresh_failed audit row'
);

-- Assert 10: the outer transaction stays writable. If FC-L2 were broken, the
-- scoring trigger would have re-raised and aborted us; this INSERT would then
-- itself fail with "current transaction is aborted".
INSERT INTO audit_log(action, entity_type, entity_id, new_value)
    VALUES (
        'leaderboard.refresh',
        'leaderboard_snapshots',
        NULL,
        '{"smoke": true, "purpose": "FC-L2 smoke insert post-failure"}'::jsonb
    );

SELECT pass(
    'TEST 10 (FC-L2): outer transaction remains writable after scoring trigger refresh failure'
);

RELEASE SAVEPOINT sp_fc_l2;

-- ===========================================================================
-- TESTS 11-13: Recovery — re-create unique index, admin invokes
--                          refresh_leaderboard() directly, MV catches up.
-- ===========================================================================
SAVEPOINT sp_recovery;

-- Re-create the unique index so REFRESH ... CONCURRENTLY works again.
CREATE UNIQUE INDEX leaderboard_snapshots_pk
    ON leaderboard_snapshots (participant_id, stage);

-- CRITICAL: RESET app.scoring_run_id. SET LOCAL in earlier savepoints (where
-- the scoring trigger ran via UPDATE) survives RELEASE SAVEPOINT — same
-- gotcha noted in 022_*. Without this reset, the admin refresh below would
-- be misrouted to caller_kind='trigger' (the prior synthetic UUID is still
-- in the GUC).
RESET app.scoring_run_id;

DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';

-- Admin invokes refresh directly (FR-L17/L19 recovery path).
SELECT test_set_jwt(:'adm_user_id'::uuid, :'nortal_tid'::uuid, :'adm_oid'::uuid, 'adm@nortal.com');
SET LOCAL ROLE authenticated;

-- SELECT (not PERFORM — PERFORM is plpgsql-only; this is a top-level psql script).
SELECT refresh_leaderboard();

RESET ROLE;

-- Assert 11: MV row count = active participants (4) * 6 stages = 24 rows.
SELECT is(
    (SELECT count(*)::int FROM leaderboard_snapshots),
    24,
    'TEST 11 (FR-L17/L18 recovery): MV rows = 4 active participants * 6 stages = 24 after admin refresh'
);

-- Assert 12: the recovery refresh emitted a 'leaderboard.refresh' row with
-- caller_kind='admin'.
SELECT is(
    (SELECT new_value ->> 'caller_kind'
     FROM audit_log
     WHERE action = 'leaderboard.refresh'
     ORDER BY occurred_at DESC, id DESC LIMIT 1),
    'admin',
    'TEST 12 (FR-L17/L20): admin direct refresh recovery emits leaderboard.refresh row with caller_kind=admin'
);

-- Assert 13: post-recovery, the MV's total_points for Exact in 'all' stage
-- equals the sum of their score_events (closes the loop — the refresh
-- actually brought the MV back in sync with score_events after the failure
-- window).
SELECT is(
    (SELECT total_points::int FROM leaderboard_snapshots
        WHERE participant_id = :'e_part_id'::uuid AND stage = 'all'),
    (SELECT COALESCE(SUM(points), 0)::int FROM score_events
        WHERE participant_id = :'e_part_id'::uuid),
    'TEST 13 (FR-L16): post-recovery MV total_points matches score_events sum (closes the refresh loop)'
);

RELEASE SAVEPOINT sp_recovery;

SELECT * FROM finish();

ROLLBACK;
