-- pgTAP test: should_refresh_leaderboard() gating predicate (feature 004 US-L, T009)
--
-- Source migration: supabase/migrations/0033_refresh_leaderboard_rpc.sql
-- Contract: specs/004-leaderboard/contracts/cron-leaderboard-refresh-tick.md
-- Data model: specs/004-leaderboard/data-model.md §4 (predicate body)
--
-- Spec references:
--   FR-L21 — cron tick is a no-op when there is nothing meaningful to refresh
--   FR-L22 — pre-tournament short-circuit (empty score_events)
--   NFR-L4 — efficient cron (the predicate keeps the heavy REFRESH out of
--            quiet ticks and pre-tournament ticks)
--
-- SCHEMA NOTE: the contract doc names columns `event_type` / `created_at`,
-- but the actual `audit_log` (migration 0004) uses `action` / `occurred_at`.
-- The predicate in 0033 was written against the real column names — this
-- test inserts against those.
--
-- The predicate's gate ladder (from 0033, lines 87–110):
--   1. score_events empty                         → FALSE  (FR-L22)
--   2. any non-cancelled match in now() ± 90 min  → TRUE
--   3. no prior 'leaderboard.refresh' audit row   → TRUE   (first-time)
--   4. last 'leaderboard.refresh' < now() - 60min → TRUE   (quiet catch-up)
--   5. otherwise                                  → FALSE  (cron no-op)
--
-- Boundary semantics from 0033:
--   - BETWEEN is INCLUSIVE: a kickoff at exactly now() + 90 min is in-window.
--   - The quiet-period clock uses strict `<`: a refresh at exactly now()-60min
--     does NOT trigger; only strictly older than 60 min does.
--
-- Assertion plan (12 total): function classification (STABLE) + the five gate
-- branches + boundary precision pin-downs.

BEGIN;

SELECT plan(12);

-- ---------------------------------------------------------------------------
-- Hermetic start — clear anything left over from prior committed work.
-- The DELETEs cascade through predictions/score_events/final_predictions/
-- audit_log refs on participants. Matches has no FK from audit_log so we
-- clear it explicitly. All within BEGIN/ROLLBACK, so this reverts.
-- ---------------------------------------------------------------------------
DELETE FROM score_events WHERE id IS NOT NULL;
DELETE FROM audit_log    WHERE id IS NOT NULL;
DELETE FROM matches      WHERE id IS NOT NULL;
DELETE FROM participants WHERE id IS NOT NULL;

\set nortal_tid '11111111-1111-1111-1111-111111111111'
\set p_user     '21111111-1111-1111-1111-111111111111'
\set p_oid      '22222222-2222-2222-2222-222222222222'
\set p_id       'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set t_home     '51111111-1111-1111-1111-111111111111'
\set t_away     '52222222-2222-2222-2222-222222222222'
\set m_id       '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

INSERT INTO auth.users (id) VALUES (:'p_user') ON CONFLICT (id) DO NOTHING;

INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', '{}'::uuid[])
ON CONFLICT (id) DO UPDATE SET nortal_tenant_id = EXCLUDED.nortal_tenant_id;

INSERT INTO participants (id, auth_user_id, oid, email, display_name, role, status)
VALUES (:'p_id'::uuid, :'p_user'::uuid, :'p_oid'::uuid,
        'gate@nortal.com', 'GateUser', 'participant', 'active');

INSERT INTO teams (id, name, tla, provider_team_id) VALUES
    (:'t_home'::uuid, 'Home XI', 'HOM', 9001),
    (:'t_away'::uuid, 'Away XI', 'AWY', 9002)
ON CONFLICT (provider_team_id) DO NOTHING;

-- One match starts well outside the ±90 min window so it doesn't perturb the
-- "empty score_events" assertion. We retune kickoff_utc per-test below.
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage,
                     kickoff_utc, status)
VALUES (:'m_id'::uuid, 99001, :'t_home'::uuid, :'t_away'::uuid,
        'group', now() + interval '30 days', 'scheduled');

-- ===========================================================================
-- TEST 1 — function is classified STABLE (per data-model §4 + 0033 line 80)
-- ===========================================================================
SELECT is(
    (SELECT provolatile::text
        FROM pg_proc
        WHERE proname = 'should_refresh_leaderboard'),
    's',  -- 's' = STABLE, 'i' = IMMUTABLE, 'v' = VOLATILE
    'TEST 1: should_refresh_leaderboard() is classified STABLE'
);

-- ===========================================================================
-- TEST 2 — FR-L22: empty score_events → FALSE (pre-tournament short-circuit)
-- ===========================================================================
-- Match is 30 days out (out of window), score_events empty → gate 1 fires.
SELECT is(
    should_refresh_leaderboard(),
    false,
    'TEST 2: empty score_events → FALSE (FR-L22 pre-tournament)'
);

-- Seed exactly one score_event so subsequent tests pass gate 1.
-- 'no-prediction' source requires match_id (per score_events CHECK).
INSERT INTO score_events (participant_id, match_id, source, points)
VALUES (:'p_id'::uuid, :'m_id'::uuid, 'no-prediction', 0);

-- ===========================================================================
-- TEST 3 — match within now() ± 90 min → TRUE (gate 2)
-- ===========================================================================
-- Move the match into the window (30 min ahead). Audit log empty —
-- but gate 2 fires before gate 3/4 so the answer is TRUE regardless.
SAVEPOINT in_window;

UPDATE matches
    SET kickoff_utc = now() + interval '30 minutes'
    WHERE id = :'m_id'::uuid;

SELECT is(
    should_refresh_leaderboard(),
    true,
    'TEST 3: non-cancelled match within ±90 min → TRUE (match-window gate)'
);

-- Even with a very recent refresh row, gate 2 wins over gate 4.
INSERT INTO audit_log (action, entity_type, entity_id, occurred_at, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots', NULL,
        now() - interval '5 minutes',
        jsonb_build_object('caller_kind','admin'));

SELECT is(
    should_refresh_leaderboard(),
    true,
    'TEST 4: match in window + recent refresh → TRUE (match-window overrides quiet-period)'
);

ROLLBACK TO SAVEPOINT in_window;

-- ===========================================================================
-- TEST 5 — cancelled match in window does NOT satisfy gate 2
-- ===========================================================================
SAVEPOINT cancelled_window;

UPDATE matches
    SET kickoff_utc = now() + interval '30 minutes',
        status = 'cancelled'
    WHERE id = :'m_id'::uuid;

-- audit_log still empty → gate 3 (first-time) gives TRUE. But we want to prove
-- the cancelled match did NOT trigger gate 2. Insert a recent refresh row so
-- gate 4 returns FALSE; if gate 2 had matched the answer would be TRUE.
INSERT INTO audit_log (action, entity_type, entity_id, occurred_at, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots', NULL,
        now() - interval '5 minutes',
        jsonb_build_object('caller_kind','admin'));

SELECT is(
    should_refresh_leaderboard(),
    false,
    'TEST 5: cancelled match in window + recent refresh → FALSE (gate 2 ignores cancelled)'
);

ROLLBACK TO SAVEPOINT cancelled_window;

-- ===========================================================================
-- TEST 6 — no prior leaderboard.refresh audit row → TRUE (gate 3, first-time)
-- ===========================================================================
SAVEPOINT first_time;

-- Push match well out of window; audit_log has no leaderboard.refresh rows.
UPDATE matches
    SET kickoff_utc = now() + interval '30 days',
        status = 'scheduled'
    WHERE id = :'m_id'::uuid;

SELECT is(
    should_refresh_leaderboard(),
    true,
    'TEST 6: no prior leaderboard.refresh audit row → TRUE (first-time)'
);

ROLLBACK TO SAVEPOINT first_time;

-- ===========================================================================
-- TEST 7 — last refresh > 60 min ago AND no match in window → TRUE (gate 4)
-- ===========================================================================
SAVEPOINT quiet_catchup;

UPDATE matches
    SET kickoff_utc = now() + interval '30 days',
        status = 'scheduled'
    WHERE id = :'m_id'::uuid;

INSERT INTO audit_log (action, entity_type, entity_id, occurred_at, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots', NULL,
        now() - interval '90 minutes',
        jsonb_build_object('caller_kind','cron'));

SELECT is(
    should_refresh_leaderboard(),
    true,
    'TEST 7: last refresh 90 min ago + no match in window → TRUE (quiet-period catch-up)'
);

ROLLBACK TO SAVEPOINT quiet_catchup;

-- ===========================================================================
-- TEST 8 — last refresh ≤ 60 min ago AND no match in window → FALSE (gate 5)
-- ===========================================================================
SAVEPOINT quiet_skip;

UPDATE matches
    SET kickoff_utc = now() + interval '30 days',
        status = 'scheduled'
    WHERE id = :'m_id'::uuid;

INSERT INTO audit_log (action, entity_type, entity_id, occurred_at, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots', NULL,
        now() - interval '10 minutes',
        jsonb_build_object('caller_kind','cron'));

SELECT is(
    should_refresh_leaderboard(),
    false,
    'TEST 8: last refresh 10 min ago + no match in window → FALSE (cron tick is no-op)'
);

ROLLBACK TO SAVEPOINT quiet_skip;

-- ===========================================================================
-- TEST 9 — boundary pin: kickoff at exactly now() + 90 min → TRUE
--          (BETWEEN is inclusive)
-- ===========================================================================
SAVEPOINT window_upper;

UPDATE matches
    SET kickoff_utc = now() + interval '90 minutes',
        status = 'scheduled'
    WHERE id = :'m_id'::uuid;

INSERT INTO audit_log (action, entity_type, entity_id, occurred_at, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots', NULL,
        now() - interval '5 minutes',
        jsonb_build_object('caller_kind','cron'));

SELECT is(
    should_refresh_leaderboard(),
    true,
    'TEST 9: kickoff at exactly now()+90min → TRUE (BETWEEN is inclusive)'
);

ROLLBACK TO SAVEPOINT window_upper;

-- ===========================================================================
-- TEST 10 — boundary pin: kickoff at exactly now() - 90 min → TRUE
--           (lower BETWEEN bound also inclusive)
-- ===========================================================================
SAVEPOINT window_lower;

UPDATE matches
    SET kickoff_utc = now() - interval '90 minutes',
        status = 'scheduled'
    WHERE id = :'m_id'::uuid;

INSERT INTO audit_log (action, entity_type, entity_id, occurred_at, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots', NULL,
        now() - interval '5 minutes',
        jsonb_build_object('caller_kind','cron'));

SELECT is(
    should_refresh_leaderboard(),
    true,
    'TEST 10: kickoff at exactly now()-90min → TRUE (BETWEEN lower bound inclusive)'
);

ROLLBACK TO SAVEPOINT window_lower;

-- ===========================================================================
-- TEST 11 — boundary pin: kickoff just outside window (now() + 91 min) → FALSE
--           when a recent refresh exists
-- ===========================================================================
SAVEPOINT just_outside;

UPDATE matches
    SET kickoff_utc = now() + interval '91 minutes',
        status = 'scheduled'
    WHERE id = :'m_id'::uuid;

INSERT INTO audit_log (action, entity_type, entity_id, occurred_at, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots', NULL,
        now() - interval '5 minutes',
        jsonb_build_object('caller_kind','cron'));

SELECT is(
    should_refresh_leaderboard(),
    false,
    'TEST 11: kickoff at now()+91min (just outside ±90min) + recent refresh → FALSE'
);

ROLLBACK TO SAVEPOINT just_outside;

-- ===========================================================================
-- TEST 12 — quiet-period boundary pin: last refresh > 60 min ago triggers
--           catch-up. Use 61 min — strictly older than 60 — to assert gate 4
--           fires (the predicate uses `v_last_refresh < now() - 60 min`,
--           strict less-than).
-- ===========================================================================
SAVEPOINT quiet_boundary;

UPDATE matches
    SET kickoff_utc = now() + interval '30 days',
        status = 'scheduled'
    WHERE id = :'m_id'::uuid;

INSERT INTO audit_log (action, entity_type, entity_id, occurred_at, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots', NULL,
        now() - interval '61 minutes',
        jsonb_build_object('caller_kind','cron'));

SELECT is(
    should_refresh_leaderboard(),
    true,
    'TEST 12: last refresh 61 min ago (strictly > 60) + no match in window → TRUE (quiet-period catch-up; strict `<` boundary)'
);

ROLLBACK TO SAVEPOINT quiet_boundary;

SELECT finish();

ROLLBACK;
