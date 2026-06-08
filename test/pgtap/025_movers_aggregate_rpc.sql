-- pgTAP test: get_movers_24h_aggregate() RPC (feature 005 dashboard, T005)
--
-- Source migration: supabase/migrations/0038_movers_24h_rpc.sql
-- Contract: specs/005-phase-4-dashboard/contracts/query-movers-global.md
--
-- Spec references:
--   FR-D11 — "Top 3 movers in pool" sub-section of MoversWidget
--   FR-D12 — Global 24-h rank delta computation, all participants
--   NFR-D07 — p95 ≤ 250 ms with 200 participants × ~10 events each
--
-- Assertion plan (12 total): function classification (STABLE, SECURITY
-- DEFINER, public schema) + privilege gates (anon denied, authenticated
-- allowed) + functional behaviour (empty pre-tournament, in-window vs.
-- out-of-window, GROUP BY semantics, SUM correctness, boundary exclusion,
-- final-* sources counted) + NFR-D07 perf budget.

BEGIN;

SELECT plan(12);

-- ---------------------------------------------------------------------------
-- Hermetic start — clear anything left over from prior committed work.
-- DELETEs are unqualified (cleared on rollback); supautils only blocks at
-- commit time so this is safe inside a BEGIN/ROLLBACK pgTAP test.
-- ---------------------------------------------------------------------------
DELETE FROM score_events WHERE id IS NOT NULL;
DELETE FROM matches      WHERE id IS NOT NULL;
DELETE FROM participants WHERE id IS NOT NULL;

\set nortal_tid '11111111-1111-1111-1111-111111111111'
\set t_home     '51111111-1111-1111-1111-111111111111'
\set t_away     '52222222-2222-2222-2222-222222222222'
\set m_id       '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', '{}'::uuid[])
ON CONFLICT (id) DO UPDATE SET nortal_tenant_id = EXCLUDED.nortal_tenant_id;

INSERT INTO teams (id, name, tla, provider_team_id) VALUES
    (:'t_home'::uuid, 'Home XI', 'HOM', 9001),
    (:'t_away'::uuid, 'Away XI', 'AWY', 9002)
ON CONFLICT (provider_team_id) DO NOTHING;

INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage,
                     kickoff_utc, status)
VALUES (:'m_id'::uuid, 99001, :'t_home'::uuid, :'t_away'::uuid,
        'group', now() - interval '2 hours', 'finished');

-- ===========================================================================
-- TEST 1 — function is classified STABLE
-- ===========================================================================
SELECT is(
    (SELECT provolatile::text
        FROM pg_proc
        WHERE proname = 'get_movers_24h_aggregate'),
    's',  -- 's' = STABLE
    'TEST 1: get_movers_24h_aggregate() is classified STABLE'
);

-- ===========================================================================
-- TEST 2 — function is SECURITY DEFINER
-- ===========================================================================
SELECT is(
    (SELECT prosecdef
        FROM pg_proc
        WHERE proname = 'get_movers_24h_aggregate'),
    true,
    'TEST 2: get_movers_24h_aggregate() is SECURITY DEFINER'
);

-- ===========================================================================
-- TEST 3 — function lives in the public schema
-- ===========================================================================
SELECT is(
    (SELECT pronamespace::regnamespace::text
        FROM pg_proc
        WHERE proname = 'get_movers_24h_aggregate'),
    'public',
    'TEST 3: get_movers_24h_aggregate() lives in public schema'
);

-- ===========================================================================
-- TEST 4 — anon role denied EXECUTE.
--
-- We assert via `has_function_privilege` rather than SET LOCAL ROLE +
-- throws_ok: a SET LOCAL ROLE inside a pgTAP transaction interacts badly
-- with the function lookup path of throws_ok and segfaults the backend
-- in local Supabase (suspected supautils + SECURITY DEFINER interplay).
-- The privilege-check approach is the canonical pgTAP idiom for this kind
-- of assertion and exercises the same ACL bit.
-- ===========================================================================
SELECT is(
    has_function_privilege('anon', 'public.get_movers_24h_aggregate()', 'EXECUTE'),
    false,
    'TEST 4: anon role does NOT have EXECUTE on get_movers_24h_aggregate()'
);

-- ===========================================================================
-- TEST 5 — authenticated role can EXECUTE (privilege bit set).
-- ===========================================================================
SELECT is(
    has_function_privilege('authenticated', 'public.get_movers_24h_aggregate()', 'EXECUTE'),
    true,
    'TEST 5: authenticated role HAS EXECUTE on get_movers_24h_aggregate()'
);

-- ===========================================================================
-- TEST 6 — empty score_events (pre-tournament) → zero rows
-- ===========================================================================
SELECT is(
    (SELECT count(*)::int FROM get_movers_24h_aggregate()),
    0,
    'TEST 6: empty score_events → zero rows (pre-tournament)'
);

-- ---------------------------------------------------------------------------
-- Seed a small functional fixture for TESTs 7-9 + 11-12.
--   p_a: 3 in-window events, points 10 + 5 + 0 = 15
--   p_b: 1 in-window event,  points 10           = 10
--   p_c: 1 OUT-OF-WINDOW event (48 h ago)        → excluded
--   p_d: 1 BOUNDARY event at exactly NOW() - 24 h - 1 s → excluded (gate is >=)
--   p_e: 1 final-* (no match_id) in-window       = 7
-- ---------------------------------------------------------------------------
\set p_a 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set p_b 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set p_c 'cccccccc-cccc-cccc-cccc-cccccccccccc'
\set p_d 'dddddddd-dddd-dddd-dddd-dddddddddddd'
\set p_e 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

\set u_a '1a1a1a1a-1a1a-1a1a-1a1a-1a1a1a1a1a1a'
\set u_b '1b1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b'
\set u_c '1c1c1c1c-1c1c-1c1c-1c1c-1c1c1c1c1c1c'
\set u_d '1d1d1d1d-1d1d-1d1d-1d1d-1d1d1d1d1d1d'
\set u_e '1e1e1e1e-1e1e-1e1e-1e1e-1e1e1e1e1e1e'

INSERT INTO auth.users (id) VALUES
    (:'u_a'::uuid), (:'u_b'::uuid), (:'u_c'::uuid), (:'u_d'::uuid), (:'u_e'::uuid)
ON CONFLICT (id) DO NOTHING;

INSERT INTO participants (id, auth_user_id, oid, email, display_name, role, status) VALUES
    (:'p_a'::uuid, :'u_a'::uuid, gen_random_uuid(), 'mover-a@nortal.com', 'MoverA', 'participant', 'active'),
    (:'p_b'::uuid, :'u_b'::uuid, gen_random_uuid(), 'mover-b@nortal.com', 'MoverB', 'participant', 'active'),
    (:'p_c'::uuid, :'u_c'::uuid, gen_random_uuid(), 'mover-c@nortal.com', 'MoverC', 'participant', 'active'),
    (:'p_d'::uuid, :'u_d'::uuid, gen_random_uuid(), 'mover-d@nortal.com', 'MoverD', 'participant', 'active'),
    (:'p_e'::uuid, :'u_e'::uuid, gen_random_uuid(), 'mover-e@nortal.com', 'MoverE', 'participant', 'active');

-- p_a: 3 in-window match events (10 + 5 + 0). Use distinct synthetic matches
-- to avoid the score_events_one_per_participant_match unique index.
\set m_a2 '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'
\set m_a3 '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'

INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage,
                     kickoff_utc, status) VALUES
    (:'m_a2'::uuid, 99002, :'t_home'::uuid, :'t_away'::uuid, 'group',
        now() - interval '3 hours', 'finished'),
    (:'m_a3'::uuid, 99003, :'t_home'::uuid, :'t_away'::uuid, 'group',
        now() - interval '4 hours', 'finished');

INSERT INTO score_events (participant_id, match_id, source, points, awarded_at) VALUES
    (:'p_a'::uuid, :'m_id'::uuid, 'match-exact',    10, now() - interval '1 hour'),
    (:'p_a'::uuid, :'m_a2'::uuid, 'match-outcome',   5, now() - interval '2 hours'),
    (:'p_a'::uuid, :'m_a3'::uuid, 'match-wrong',     0, now() - interval '3 hours'),
    (:'p_b'::uuid, :'m_id'::uuid, 'match-exact',    10, now() - interval '6 hours'),
    -- p_c: 48 h ago → outside the 24-h window
    (:'p_c'::uuid, :'m_id'::uuid, 'match-exact',    10, now() - interval '48 hours'),
    -- p_d: boundary — exactly 24h + 1s ago → excluded (gate is `>= now() - 24h`)
    (:'p_d'::uuid, :'m_id'::uuid, 'match-exact',    10, now() - interval '24 hours' - interval '1 second'),
    -- p_e: final-* source (no match_id) in window
    (:'p_e'::uuid, NULL,          'final-champion', 7, now() - interval '2 hours');

-- ===========================================================================
-- TEST 7 — in-window vs. out-of-window: only in-window events count.
--          Expected mover set: {p_a, p_b, p_e} = 3 rows.
--          (p_c is 48 h old; p_d is just past the 24-h boundary.)
-- ===========================================================================
SELECT is(
    (SELECT count(*)::int FROM get_movers_24h_aggregate()),
    3,
    'TEST 7: only in-window events counted (p_a, p_b, p_e); p_c and p_d excluded'
);

-- ===========================================================================
-- TEST 8 — GROUP BY semantics: one row per participant, even if they have
--          multiple in-window events (p_a has 3, must appear once).
-- ===========================================================================
SELECT is(
    (SELECT count(DISTINCT participant_id)::int FROM get_movers_24h_aggregate()),
    3,
    'TEST 8: one row per UNIQUE participant (GROUP BY participant_id)'
);

-- ===========================================================================
-- TEST 9 — SUM correctness: p_a's three events 10 + 5 + 0 → delta_24h = 15
-- ===========================================================================
SELECT is(
    (SELECT delta_24h FROM get_movers_24h_aggregate() WHERE participant_id = :'p_a'::uuid),
    15::smallint,
    'TEST 9: SUM correctness — p_a 10+5+0 → delta_24h = 15'
);

-- ===========================================================================
-- TEST 10 — boundary exclusion: p_d at exactly NOW() - 24h - 1s is NOT in
--           the returned set. Gate is `awarded_at >= NOW() - INTERVAL '24h'`.
-- ===========================================================================
SELECT is(
    (SELECT count(*)::int FROM get_movers_24h_aggregate() WHERE participant_id = :'p_d'::uuid),
    0,
    'TEST 10: event at exactly NOW() - 24h - 1s excluded (gate is `>=`)'
);

-- ===========================================================================
-- TEST 11 — final-* source events count too — function has no source filter,
--           it is a pure SUM(points) across all sources. p_e has a
--           final-champion row in window worth 7 pts.
-- ===========================================================================
SELECT is(
    (SELECT delta_24h FROM get_movers_24h_aggregate() WHERE participant_id = :'p_e'::uuid),
    7::smallint,
    'TEST 11: final-* (no match_id) source events are included in the SUM'
);

-- ===========================================================================
-- TEST 12 — NFR-D07 perf budget: seed 200 participants × 10 events each
--           inside the 24 h window, time the RPC, assert < 250 ms.
--           CI budget — generous, kept identical to the spec NFR.
-- ===========================================================================

-- Clear the small functional fixture so it doesn't perturb the perf timing.
DELETE FROM score_events WHERE participant_id IS NOT NULL;
DELETE FROM participants WHERE id IN (:'p_a'::uuid, :'p_b'::uuid, :'p_c'::uuid, :'p_d'::uuid, :'p_e'::uuid);

-- Seed 200 participants. Use a CTE + RETURNING to feed the score_events seed.
WITH new_users AS (
    INSERT INTO auth.users (id)
    SELECT gen_random_uuid()
    FROM generate_series(1, 200)
    RETURNING id
), numbered AS (
    SELECT id, row_number() OVER () AS n FROM new_users
)
INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
SELECT id, gen_random_uuid(),
       'perf-mover-'||n||'@nortal.com',
       'PerfMover'||n,
       'participant', 'active'
FROM numbered;

-- Seed 10 distinct synthetic matches — needed so the 200 × 10 score_events
-- seed doesn't trip score_events_one_per_participant_match (UNIQUE on
-- (participant_id, match_id) where match_id IS NOT NULL).
INSERT INTO matches (provider_id, home_team_id, away_team_id, stage,
                     kickoff_utc, status)
SELECT 90000 + g,
       :'t_home'::uuid,
       :'t_away'::uuid,
       'group',
       now() - (g * interval '1 day'),
       'finished'
FROM generate_series(1, 10) AS g;

-- 200 × 10 = 2000 score_events, all inside the 24 h window.
-- Pair each participant with each of the 10 perf matches; spread awarded_at
-- across the window so the index is exercised realistically.
INSERT INTO score_events (participant_id, match_id, source, points, awarded_at)
SELECT p.id,
       m.id,
       'no-prediction'::score_event_source,
       0,
       now() - ((m.provider_id - 90000) * interval '1 minute')
FROM participants p
CROSS JOIN matches m
WHERE p.email LIKE 'perf-mover-%@nortal.com'
  AND m.provider_id BETWEEN 90001 AND 90010;

CREATE TEMP TABLE t_movers_perf (elapsed_ms NUMERIC);

DO $$
DECLARE
    v_start TIMESTAMPTZ;
    v_count INT;
BEGIN
    v_start := clock_timestamp();
    SELECT count(*) INTO v_count FROM get_movers_24h_aggregate();
    INSERT INTO t_movers_perf (elapsed_ms)
        VALUES (EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000);
END $$;

SELECT ok(
    (SELECT elapsed_ms FROM t_movers_perf) < 250,
    format('TEST 12: 200-participant × 10-event aggregate completed in %s ms (NFR-D07 < 250 ms)',
        round((SELECT elapsed_ms FROM t_movers_perf), 1))
);

SELECT * FROM finish();

ROLLBACK;
