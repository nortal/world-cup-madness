-- pgTAP test: leaderboard_snapshots materialised view invariants
--             (feature 004 US-L, T006)
--
-- Source migration: supabase/migrations/0032_create_leaderboard_snapshots.sql
-- Contract:         specs/004-leaderboard/contracts/mv-leaderboard-snapshots.md
-- Spec:             FR-L01 (one row per active participant per stage),
--                   FR-L02 (privacy projection),
--                   FR-L03 (tie-breaker RANK chain),
--                   FR-L04 (rank_is_shared boolean),
--                   FR-L05 (stage rows exclude finals),
--                   FR-L07 (empty score_events → empty MV),
--                   FR-L22 (pre-tournament short-circuit prerequisite),
--                   FC-L4  (stage-specific final_points = 0),
--                   NFR-L3 (deterministic refresh, < 500 ms @ 50 participants).
--
-- The MV is refreshed manually here via REFRESH MATERIALIZED VIEW
-- [CONCURRENTLY] leaderboard_snapshots. The unique index on (participant_id,
-- stage) created by migration 0032 satisfies the CONCURRENTLY prerequisite.
--
-- SCHEMA NOTE: matches.stage uses long-form labels (`group`,`round-of-16`,
-- `quarter-final`,`semi-final`,`third-place`,`final`); the MV maps them to
-- short codes (`all`,`group`,`r16`,`quarter`,`semi`,`final`) per the migration
-- header. Fixture rows below use the long-form labels.
--
-- Inserts into score_events go through `postgres` (test session) which is the
-- table owner — RLS BYPASSed. This mirrors the SECURITY DEFINER write path
-- used by feature 003's scoring triggers (FR-P24: no `authenticated` write
-- policies on score_events).

BEGIN;

SELECT plan(20);

-- Hermetic start: clear participants (CASCADE drops predictions, score_events,
-- final_predictions); also clear leftover matches so MV row counts are exact.
DELETE FROM participants;
DELETE FROM matches;

\set nortal_tid '11111111-1111-1111-1111-111111111111'

INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', '{}'::uuid[])
ON CONFLICT (id) DO UPDATE SET nortal_tenant_id = EXCLUDED.nortal_tenant_id;

-- ---------------------------------------------------------------------------
-- FIXTURE: 4 active + 1 inactive participants
--   Three tied at 30 pts (Alice, Bob, Carol),
--   one distinct at 10 pts (Dave),
--   one inactive (Eve) — must be excluded from the MV.
-- ---------------------------------------------------------------------------
\set p_alice_user   '21111111-1111-1111-1111-111111111111'
\set p_alice_oid    '22222222-2222-2222-2222-222222222222'
\set p_bob_user     '31111111-1111-1111-1111-111111111111'
\set p_bob_oid      '33333333-3333-3333-3333-333333333333'
\set p_carol_user   '41111111-1111-1111-1111-111111111111'
\set p_carol_oid    '44444444-4444-4444-4444-444444444444'
\set p_dave_user    '51111111-1111-1111-1111-111111111111'
\set p_dave_oid     '55555555-5555-5555-5555-555555555555'
\set p_eve_user     '61111111-1111-1111-1111-111111111111'
\set p_eve_oid      '66666666-6666-6666-6666-666666666666'

INSERT INTO auth.users (id) VALUES
    (:'p_alice_user'), (:'p_bob_user'), (:'p_carol_user'),
    (:'p_dave_user'),  (:'p_eve_user')
ON CONFLICT (id) DO NOTHING;

INSERT INTO participants (auth_user_id, oid, email, display_name, role, status) VALUES
    (:'p_alice_user'::uuid, :'p_alice_oid'::uuid, 'alice@nortal.com', 'Alice', 'participant', 'active'),
    (:'p_bob_user'::uuid,   :'p_bob_oid'::uuid,   'bob@nortal.com',   'Bob',   'participant', 'active'),
    (:'p_carol_user'::uuid, :'p_carol_oid'::uuid, 'carol@nortal.com', 'Carol', 'participant', 'active'),
    (:'p_dave_user'::uuid,  :'p_dave_oid'::uuid,  'dave@nortal.com',  'Dave',  'participant', 'active'),
    (:'p_eve_user'::uuid,   :'p_eve_oid'::uuid,   'eve@nortal.com',   'Eve',   'participant', 'inactive');

-- ---------------------------------------------------------------------------
-- FIXTURE: 5 finished matches across the five stages
--   match_g  — group
--   match_r  — round-of-16
--   match_q  — quarter-final
--   match_s  — semi-final
--   match_f  — final
-- All matches inserted as 'scheduled' first to bypass the scoring trigger
-- (we'll insert score_events directly so the test isolates MV behaviour from
-- trigger behaviour, which is covered by tests 015/016).
-- ---------------------------------------------------------------------------
\set match_g '71111111-1111-1111-1111-111111111111'
\set match_r '72222222-2222-2222-2222-222222222222'
\set match_q '73333333-3333-3333-3333-333333333333'
\set match_s '74444444-4444-4444-4444-444444444444'
\set match_f '75555555-5555-5555-5555-555555555555'

INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status) VALUES
    (:'match_g'::uuid, 90001, (SELECT id FROM teams WHERE tla='ENG'), (SELECT id FROM teams WHERE tla='FRA'), 'group',         now() - interval '5 days', 'scheduled'),
    (:'match_r'::uuid, 90002, (SELECT id FROM teams WHERE tla='ENG'), (SELECT id FROM teams WHERE tla='GER'), 'round-of-16',   now() - interval '4 days', 'scheduled'),
    (:'match_q'::uuid, 90003, (SELECT id FROM teams WHERE tla='ESP'), (SELECT id FROM teams WHERE tla='ITA'), 'quarter-final', now() - interval '3 days', 'scheduled'),
    (:'match_s'::uuid, 90004, (SELECT id FROM teams WHERE tla='BRA'), (SELECT id FROM teams WHERE tla='ARG'), 'semi-final',    now() - interval '2 days', 'scheduled'),
    (:'match_f'::uuid, 90005, (SELECT id FROM teams WHERE tla='ENG'), (SELECT id FROM teams WHERE tla='BRA'), 'final',         now() - interval '1 day',  'scheduled');

-- ---------------------------------------------------------------------------
-- SCORE_EVENTS: hand-crafted to drive the invariant assertions.
--
-- Alice  — group=10 (exact) + r16=5  (outcome) + final-champion=15 → all=30
-- Bob    — group=5  (outcome)+ r16=10 (exact)   + final-champion=15 → all=30
-- Carol  — group=10 (exact) + r16=10 (exact)    + final-not-picked-champion=10 → all=30
-- Dave   — group=10 (exact)                                              → all=10
-- (Eve inactive → no rows visible in MV regardless)
--
-- Tie-breaker chain on the 'all' stage:
--   Alice/Bob/Carol all have total=30. Alice has 1 exact, Bob has 1 exact,
--   Carol has 2 exacts. ⇒ pre-final tie-break: Carol leads on exact_hits.
--   Wait — that breaks the 3-way tie. We need a true 3-way tie at total +
--   exact + outcome + final to test FR-L04 + rank_is_shared properly.
--
-- Redesigned to give Alice/Bob/Carol identical (total=30, exact=2,
-- outcome=0, final=10):
--   Alice — group=10 exact + r16=10 exact +   final-not-picked-champion=10 → 30/2/0/10
--   Bob   — group=10 exact + r16=10 exact +   final-not-picked-champion=10 → 30/2/0/10
--   Carol — group=10 exact + r16=10 exact +   final-not-picked-champion=10 → 30/2/0/10
--   Dave  — group=10 exact                                                  → 10/1/0/0
-- ---------------------------------------------------------------------------
INSERT INTO score_events (participant_id, match_id, source, points) VALUES
    -- Alice match scoring
    ((SELECT id FROM participants WHERE oid=:'p_alice_oid'::uuid), :'match_g'::uuid, 'match-exact', 10),
    ((SELECT id FROM participants WHERE oid=:'p_alice_oid'::uuid), :'match_r'::uuid, 'match-exact', 10),
    -- Alice final scoring (10 pts, not-picked-champion is the lowest-points final source still > 0)
    ((SELECT id FROM participants WHERE oid=:'p_alice_oid'::uuid), NULL, 'final-not-picked-champion', 10),

    -- Bob match scoring
    ((SELECT id FROM participants WHERE oid=:'p_bob_oid'::uuid), :'match_g'::uuid, 'match-exact', 10),
    ((SELECT id FROM participants WHERE oid=:'p_bob_oid'::uuid), :'match_r'::uuid, 'match-exact', 10),
    ((SELECT id FROM participants WHERE oid=:'p_bob_oid'::uuid), NULL, 'final-not-picked-champion', 10),

    -- Carol match scoring
    ((SELECT id FROM participants WHERE oid=:'p_carol_oid'::uuid), :'match_g'::uuid, 'match-exact', 10),
    ((SELECT id FROM participants WHERE oid=:'p_carol_oid'::uuid), :'match_r'::uuid, 'match-exact', 10),
    ((SELECT id FROM participants WHERE oid=:'p_carol_oid'::uuid), NULL, 'final-not-picked-champion', 10),

    -- Dave: just the group-stage exact
    ((SELECT id FROM participants WHERE oid=:'p_dave_oid'::uuid), :'match_g'::uuid, 'match-exact', 10);

REFRESH MATERIALIZED VIEW leaderboard_snapshots;

-- ===========================================================================
-- TEST 1 — MV row count = active participants × 6 stages = 4 × 6 = 24
-- ===========================================================================
SELECT is(
    (SELECT count(*)::int FROM leaderboard_snapshots),
    24,
    'TEST 1: MV row count = active participants (4) × 6 stages = 24 (FR-L01)'
);

-- TEST 2 — inactive participant Eve has zero rows
SELECT is(
    (SELECT count(*)::int FROM leaderboard_snapshots
        WHERE participant_id = (SELECT id FROM participants WHERE oid=:'p_eve_oid'::uuid)),
    0,
    'TEST 2: inactive participant excluded from MV (FR-L01)'
);

-- TEST 3 — each active participant has exactly one row per stage code
SELECT is(
    (SELECT array_agg(DISTINCT stage ORDER BY stage)::text[] FROM leaderboard_snapshots
        WHERE participant_id = (SELECT id FROM participants WHERE oid=:'p_alice_oid'::uuid)),
    ARRAY['all','final','group','quarter','r16','semi']::text[],
    'TEST 3: each active participant has one row per stage code'
);

-- ===========================================================================
-- TEST 4 — RANK() on the 'all' stage: three tied at rank 1, Dave at rank 4
-- ===========================================================================
SELECT is(
    (SELECT array_agg(rank ORDER BY display_name)
        FROM leaderboard_snapshots
        WHERE stage = 'all'
          AND participant_id IN (
              SELECT id FROM participants
              WHERE oid IN (:'p_alice_oid'::uuid, :'p_bob_oid'::uuid,
                            :'p_carol_oid'::uuid, :'p_dave_oid'::uuid)
          )),
    ARRAY[1, 1, 1, 4]::bigint[],
    'TEST 4: tied trio ranks 1,1,1 and Dave ranks 4 (FR-L03 RANK chain)'
);

-- TEST 5 — rank_is_shared = TRUE for all three tied participants
SELECT is(
    (SELECT bool_and(rank_is_shared)::boolean FROM leaderboard_snapshots
        WHERE stage = 'all'
          AND participant_id IN (
              SELECT id FROM participants
              WHERE oid IN (:'p_alice_oid'::uuid, :'p_bob_oid'::uuid, :'p_carol_oid'::uuid)
          )),
    true,
    'TEST 5: rank_is_shared = TRUE for all three tied participants (FR-L04)'
);

-- TEST 6 — rank_is_shared = FALSE for Dave (only one at his (total, exact, outcome, final) tuple)
SELECT is(
    (SELECT rank_is_shared FROM leaderboard_snapshots
        WHERE stage = 'all'
          AND participant_id = (SELECT id FROM participants WHERE oid=:'p_dave_oid'::uuid)),
    false,
    'TEST 6: rank_is_shared = FALSE for the lone distinct rank (FR-L04)'
);

-- TEST 7 — Dave's rank equals 4 (skipped 2 and 3 per RANK() semantics)
SELECT is(
    (SELECT rank::int FROM leaderboard_snapshots
        WHERE stage = 'all'
          AND participant_id = (SELECT id FROM participants WHERE oid=:'p_dave_oid'::uuid)),
    4,
    'TEST 7: RANK() leaves a gap after a 3-way tie — Dave at rank 4 (FR-L03)'
);

-- ===========================================================================
-- TEST 8 — final_points = 0 for every non-'all' row (FC-L4 / FR-L05)
-- ===========================================================================
SELECT is(
    (SELECT count(*)::int FROM leaderboard_snapshots
        WHERE stage <> 'all' AND final_points <> 0),
    0,
    'TEST 8: final_points = 0 for every non-all stage row (FC-L4 / FR-L05)'
);

-- TEST 9 — final_points on 'all' for Alice = 10 (her final-not-picked row)
SELECT is(
    (SELECT final_points::int FROM leaderboard_snapshots
        WHERE stage = 'all'
          AND participant_id = (SELECT id FROM participants WHERE oid=:'p_alice_oid'::uuid)),
    10,
    'TEST 9: all-stage final_points = 10 for Alice (sum of final-* sources)'
);

-- ===========================================================================
-- TEST 10 — stage-specific total_points exclude `final-*` source rows
--   Alice group  = 10 (match-exact only; her final-not-picked-champion=10 must NOT appear)
--   Alice all    = 30 (group=10 + r16=10 + final=10)
-- ===========================================================================
SELECT is(
    (SELECT total_points::int FROM leaderboard_snapshots
        WHERE stage = 'group'
          AND participant_id = (SELECT id FROM participants WHERE oid=:'p_alice_oid'::uuid)),
    10,
    'TEST 10: stage=group total excludes final-* sources (FC-L4 / FR-L05)'
);

-- TEST 11 — Alice 'all' total = 30 (includes the final-not-picked-champion)
SELECT is(
    (SELECT total_points::int FROM leaderboard_snapshots
        WHERE stage = 'all'
          AND participant_id = (SELECT id FROM participants WHERE oid=:'p_alice_oid'::uuid)),
    30,
    'TEST 11: stage=all total includes all source types (FR-L01)'
);

-- TEST 12 — Dave 'all' total = 10 (only one group-stage exact)
SELECT is(
    (SELECT total_points::int FROM leaderboard_snapshots
        WHERE stage = 'all'
          AND participant_id = (SELECT id FROM participants WHERE oid=:'p_dave_oid'::uuid)),
    10,
    'TEST 12: Dave all-stage total = 10 (single match-exact, no final source)'
);

-- TEST 13 — stage=r16 has 4 rows (one per active participant), three with
-- total=10 (the three tied participants) + Dave with total=0 (no r16 score).
SELECT is(
    (SELECT array_agg(total_points ORDER BY total_points DESC, display_name)::int[]
        FROM leaderboard_snapshots WHERE stage = 'r16'),
    ARRAY[10, 10, 10, 0]::int[],
    'TEST 13: r16 stage rows have correct totals (three with r16 exact, Dave at 0)'
);

-- TEST 14 — exact_hits on 'all' stage matches manual count (Alice/Bob/Carol = 2 each, Dave = 1)
SELECT is(
    (SELECT exact_hits::int FROM leaderboard_snapshots
        WHERE stage = 'all'
          AND participant_id = (SELECT id FROM participants WHERE oid=:'p_carol_oid'::uuid)),
    2,
    'TEST 14: exact_hits aggregation correct on all-stage (Carol = 2)'
);

-- ===========================================================================
-- TEST 15 — empty score_events → empty MV (FR-L07 / FR-L22 prerequisite)
-- Wrapped in a savepoint so the wipe doesn't leak into later tests.
-- ===========================================================================
SAVEPOINT before_empty;
DELETE FROM score_events;
-- Non-CONCURRENT refresh: CONCURRENTLY refuses to run "on a materialized view
-- that has not been populated" — but ours IS populated here, so it would work.
-- We use the plain form because the fixture clears the data; either is fine.
REFRESH MATERIALIZED VIEW leaderboard_snapshots;

SELECT is(
    (SELECT count(*)::int FROM leaderboard_snapshots
        WHERE total_points <> 0 OR exact_hits <> 0
           OR outcome_hits <> 0 OR final_points <> 0),
    0,
    'TEST 15: empty score_events → all MV rows have zero scores (FR-L07 / FR-L22)'
);

-- TEST 16 — but the MV still contains one row per active participant per stage
-- (the LEFT JOIN keeps zero-score participants visible at rank 1, tied)
SELECT is(
    (SELECT count(*)::int FROM leaderboard_snapshots),
    24,
    'TEST 16: empty score_events → MV still has 4 active × 6 stages = 24 rows'
);

ROLLBACK TO SAVEPOINT before_empty;
-- After the rollback we have to re-refresh because the rollback doesn't
-- restore the MV physical state — but actually MV contents are not transactional
-- in the usual sense; the refresh writes go through the txn though. Belt-and-
-- braces: refresh once more so subsequent assertions see the original fixture.
REFRESH MATERIALIZED VIEW leaderboard_snapshots;

-- ===========================================================================
-- TEST 17 — idempotency: two consecutive refreshes produce identical state
-- ===========================================================================
CREATE TEMP TABLE snapshot_a AS
    SELECT * FROM leaderboard_snapshots ORDER BY participant_id, stage;

REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;

CREATE TEMP TABLE snapshot_b AS
    SELECT * FROM leaderboard_snapshots ORDER BY participant_id, stage;

SELECT is(
    (SELECT count(*)::int
        FROM (SELECT * FROM snapshot_a EXCEPT SELECT * FROM snapshot_b) d),
    0,
    'TEST 17: two consecutive refreshes produce identical state (NFR-L3 deterministic)'
);

-- TEST 18 — symmetric direction of the EXCEPT (catch rows added by refresh #2)
SELECT is(
    (SELECT count(*)::int
        FROM (SELECT * FROM snapshot_b EXCEPT SELECT * FROM snapshot_a) d),
    0,
    'TEST 18: refresh #2 introduces no new rows beyond refresh #1 (NFR-L3 deterministic)'
);

-- ===========================================================================
-- TEST 19 — duration budget: REFRESH MATERIALIZED VIEW CONCURRENTLY on a
-- 50-active-participant fixture completes in < 500 ms.
--
-- We extend the fixture by an additional 46 active participants (4 + 46 = 50)
-- each carrying a single match-exact 10 row against the existing match_g, then
-- time one CONCURRENT refresh. The 500-ms budget is the NFR-L3 target; we pad
-- to 1500 ms in the assertion to absorb CI variance per project convention
-- (mirror's the 015 test capacity assertion budget).
-- ===========================================================================
DO $$
DECLARE
    v_uid UUID;
    v_pid UUID;
    i     INTEGER;
BEGIN
    FOR i IN 1..46 LOOP
        v_uid := gen_random_uuid();
        INSERT INTO auth.users (id) VALUES (v_uid);
        INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
            VALUES (v_uid, gen_random_uuid(), 'perf'||i||'@nortal.com', 'Perf'||i, 'participant', 'active')
            RETURNING id INTO v_pid;
        INSERT INTO score_events (participant_id, match_id, source, points)
            VALUES (v_pid, (SELECT id FROM matches WHERE provider_id = 90001), 'match-exact', 10);
    END LOOP;
END $$;

REFRESH MATERIALIZED VIEW leaderboard_snapshots;

CREATE TEMP TABLE t_perf (elapsed_ms NUMERIC);

DO $$
DECLARE
    v_start TIMESTAMPTZ;
BEGIN
    v_start := clock_timestamp();
    REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;
    INSERT INTO t_perf (elapsed_ms)
        VALUES (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000);
END $$;

SELECT ok(
    (SELECT elapsed_ms FROM t_perf) < 1500,
    format('TEST 19: 50-participant CONCURRENT refresh completed in %s ms (target NFR-L3 < 500 ms; CI budget 1500 ms)',
        round((SELECT elapsed_ms FROM t_perf)))
);

-- TEST 20 — sanity: post-perf-fixture MV row count = 50 active × 6 stages = 300
SELECT is(
    (SELECT count(*)::int FROM leaderboard_snapshots),
    300,
    'TEST 20: post-perf-fixture row count = 50 active × 6 stages = 300'
);

SELECT * FROM finish();

ROLLBACK;
