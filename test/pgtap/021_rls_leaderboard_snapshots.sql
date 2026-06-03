-- pgTAP test: T007 — column-level privacy on `leaderboard_snapshots` MV
--                    (feature 004 US-L)
--
-- Source migrations:
--   supabase/migrations/0032_create_leaderboard_snapshots.sql
--     (MV + column-level GRANT + leaderboard_self companion view)
--
-- Spec references:
--   specs/004-leaderboard/contracts/mv-leaderboard-snapshots.md
--   specs/004-leaderboard/data-model.md §2.4 / §2.5
--   specs/004-leaderboard/research.md §R-3 (leaderboard_self via security_invoker)
--
-- FR references:
--   FR-L02   — Participants see public projection only; private columns
--              (exact_hits / outcome_hits / final_points) require the
--              self-row surface.
--   NFR-L6   — Wire-level privacy: private columns MUST NOT leave Postgres
--              for any row other than the caller's own.
--   FC-L6    — Admin sees the SAME RLS-applied surface as any participant;
--              admin parity (no role branch in the privacy mechanism).
--   R-3      — `leaderboard_self` view (security_invoker = true) is the
--              only surface returning private columns; the WHERE clause
--              pins to the caller's own participant_id.
--
-- IMPLEMENTATION DEVIATION (see migration 0032 header + research.md §R-3):
--   PG 17.6 rejects `ALTER MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY`
--   with SQLSTATE 42809. Migration 0032 therefore relies on the
--   column-level GRANT alone as the FR-L02 / NFR-L6 mechanism — no MV-level
--   RLS, no `leaderboard_snapshots_select_public` policy. This test
--   asserts the column-level GRANT shape directly: public columns are
--   selectable for any row; private columns raise
--   `42501 permission denied for column ...` on direct SELECT;
--   `leaderboard_self` is the only path that yields the caller's private
--   columns.
--
-- Invariants under test (12 asserts):
--   AS PARTICIPANT A (authenticated):
--     1. SELECT public projection (participant_id, stage, display_name,
--        total_points, rank, rank_is_shared) over the whole MV — succeeds.
--     2. SELECT exact_hits           — 42501 permission denied.
--     3. SELECT outcome_hits         — 42501 permission denied.
--     4. SELECT final_points         — 42501 permission denied.
--     5. SELECT *  FROM leaderboard_self — succeeds (R-3: private columns
--        reachable for own row via security_invoker).
--     6. leaderboard_self row count = 6 (one per stage, caller only).
--     7. leaderboard_self contains exactly one distinct participant_id
--        (the caller's own).
--     8. leaderboard_self.exact_hits for stage='all' equals A's seeded
--        match-exact count — proving the private column IS materialised
--        on the caller's own row via the view.
--
--   AS ADMIN (authenticated):
--     9. SELECT exact_hits on the MV — 42501 permission denied. FC-L6:
--        the column-level GRANT is role-blind; admin sees the same surface.
--    10. SELECT public columns on the MV — succeeds for all rows.
--    11. leaderboard_self row count for admin = 6 (admin's own 6 stages).
--    12. leaderboard_self contains exactly one distinct participant_id
--        when called by admin — the admin's own row only (FC-L6: admin
--        does NOT get a privileged view via leaderboard_self).
--
-- All throws_ok assertions are wrapped in SAVEPOINT … ROLLBACK TO so that
-- the 42501 error does not abort the outer transaction.
--
-- JWT simulation pattern: same `test_set_jwt` helper as 012_rls_score_events.sql.

BEGIN;

SELECT plan(12);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for deterministic assertions
-- ---------------------------------------------------------------------------
\set nortal_tid          '11111111-1111-1111-1111-111111111111'

-- Participant A — active, role=participant
\set a_user_id           '21111111-1111-1111-1111-111111111111'
\set a_oid               '22222222-2222-2222-2222-222222222222'
\set a_part_id           'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

-- Participant B — active, role=participant
\set b_user_id           '31111111-1111-1111-1111-111111111111'
\set b_oid               '33333333-3333-3333-3333-333333333333'
\set b_part_id           'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

-- Admin participant — active, role=admin
\set adm_user_id         '41111111-1111-1111-1111-111111111111'
\set adm_oid             '44444444-4444-4444-4444-444444444444'
\set adm_part_id         'dddddddd-dddd-dddd-dddd-dddddddddddd'

-- Teams + match seed (for the match_id FK on match-source events)
\set home_team_id        '51111111-1111-1111-1111-111111111111'
\set away_team_id        '52222222-2222-2222-2222-222222222222'
\set match_id            '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

-- ---------------------------------------------------------------------------
-- Helper: set the JWT claims + auth.uid() for the next call
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
-- Seed auth.users (FK target for participants.auth_user_id)
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id) VALUES
    (:'a_user_id'),
    (:'b_user_id'),
    (:'adm_user_id')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed tournament_config — Nortal tenant + admin_oids contains adm_oid so
-- is_admin_user() returns true for the admin participant.
-- ---------------------------------------------------------------------------
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', ARRAY[:'adm_oid'::uuid])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

-- ---------------------------------------------------------------------------
-- Seed participants (A + B as participants, third as admin)
-- ---------------------------------------------------------------------------
INSERT INTO participants (id, auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'a_part_id'::uuid,   :'a_user_id'::uuid,   :'a_oid'::uuid,   'a@nortal.com',   'Participant A', 'participant', 'active'),
    (:'b_part_id'::uuid,   :'b_user_id'::uuid,   :'b_oid'::uuid,   'b@nortal.com',   'Participant B', 'participant', 'active'),
    (:'adm_part_id'::uuid, :'adm_user_id'::uuid, :'adm_oid'::uuid, 'adm@nortal.com', 'Admin User',    'admin',       'active')
ON CONFLICT (oid) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed teams + one scheduled group-stage match (match_id FK target for
-- match-source score_events).
--
-- IMPORTANT: status='scheduled' (NOT 'finished') because the
-- matches_trigger_scoring trigger from migration 0030 auto-fires
-- calculate_match_points() on INSERT/UPDATE when status='finished'+scores,
-- which would seed `no-prediction` rows for ALL 3 active participants and
-- collide with the manual score_events INSERTs below (partial unique index
-- on (participant_id, match_id) WHERE match_id IS NOT NULL). We bypass
-- the trigger by leaving the match scheduled, then INSERT score_events
-- directly as the test owner (simulating the SECURITY DEFINER trigger).
-- ---------------------------------------------------------------------------
INSERT INTO teams (id, name, tla, provider_team_id)
VALUES
    (:'home_team_id'::uuid, 'Home XI', 'HOM', 9001),
    (:'away_team_id'::uuid, 'Away XI', 'AWY', 9002)
ON CONFLICT (provider_team_id) DO NOTHING;

INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage,
                     group_label, kickoff_utc, venue, status,
                     score_home, score_away)
VALUES
    (:'match_id'::uuid, 99001, :'home_team_id'::uuid, :'away_team_id'::uuid,
     'group', 'A', '2026-06-15 18:00:00+00', 'Test Stadium', 'scheduled',
     NULL, NULL)
ON CONFLICT (provider_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed score_events directly (test superuser bypasses RLS — simulates the
-- SECURITY DEFINER trigger functions in 0030/0031). A gets a match-exact
-- + final-champion row; B gets a match-outcome row. This makes the MV
-- non-trivial AND gives A a non-zero exact_hits + final_points for
-- assertion #8.
-- ---------------------------------------------------------------------------
INSERT INTO score_events (participant_id, match_id, source, points)
VALUES
    -- A: exact-score match row (10 pts)  → exact_hits=1 in 'all' + 'group'
    (:'a_part_id'::uuid, :'match_id'::uuid, 'match-exact',     10),
    -- B: outcome-only match row (5 pts)  → outcome_hits=1 in 'all' + 'group'
    (:'b_part_id'::uuid, :'match_id'::uuid, 'match-outcome',    5),
    -- A: final-champion row (20 pts)     → final_points=20 in 'all' for A
    (:'a_part_id'::uuid, NULL,              'final-champion',  20);

-- Build the MV state before role switching (REFRESH runs as the test owner;
-- subsequent reads will apply column-level GRANTs).
REFRESH MATERIALIZED VIEW leaderboard_snapshots;

-- ===========================================================================
-- BEHAVIOURAL ASSERTIONS — Participant A (authenticated)
-- ===========================================================================

-- Switch into the authenticated role with A's JWT so auth.uid() resolves
-- to A and the column-level GRANT applies (the column GRANT is scoped to
-- the `authenticated` role; the test owner bypasses it).
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

-- 1. Public projection SELECT succeeds across the whole MV.
--    Columns explicitly listed in the column-level GRANT (migration 0032):
--      participant_id, stage, display_name, total_points, rank, rank_is_shared
SELECT lives_ok(
    $$SELECT participant_id, stage, display_name, total_points, rank, rank_is_shared
      FROM leaderboard_snapshots$$,
    'participant A can SELECT the public projection across all MV rows (FR-L02)'
);

-- 2. SELECT exact_hits — column-level GRANT does NOT include this column.
--    Postgres raises SQLSTATE 42501 "permission denied for column exact_hits".
SAVEPOINT sp_exact_hits_denied;
SELECT throws_ok(
    $$SELECT exact_hits FROM leaderboard_snapshots$$,
    '42501',
    NULL,
    'NFR-L6: participant SELECT exact_hits denied by column-level GRANT (42501)'
);
ROLLBACK TO SAVEPOINT sp_exact_hits_denied;

-- 3. SELECT outcome_hits — same column-level GRANT denial.
SAVEPOINT sp_outcome_hits_denied;
SELECT throws_ok(
    $$SELECT outcome_hits FROM leaderboard_snapshots$$,
    '42501',
    NULL,
    'NFR-L6: participant SELECT outcome_hits denied by column-level GRANT (42501)'
);
ROLLBACK TO SAVEPOINT sp_outcome_hits_denied;

-- 4. SELECT final_points — same column-level GRANT denial.
SAVEPOINT sp_final_points_denied;
SELECT throws_ok(
    $$SELECT final_points FROM leaderboard_snapshots$$,
    '42501',
    NULL,
    'NFR-L6: participant SELECT final_points denied by column-level GRANT (42501)'
);
ROLLBACK TO SAVEPOINT sp_final_points_denied;

-- 5. leaderboard_self with SELECT * succeeds. R-3 contract: the view's
--    `security_invoker = true` evaluates under the caller, and the WHERE
--    pins to the caller's own participant_id; the view-level GRANT covers
--    ALL columns because the row filter does the privacy work. If this
--    asserts FAILS with 42501, the security_invoker + column-GRANT
--    interaction is broken and the GRANT scheme needs adjustment.
--
-- Wrapped in a SAVEPOINT so a 42501 from this assertion (the contract-bug
-- failure path) does not abort the outer transaction and tank the
-- subsequent assertions in the file. lives_ok itself does not throw on
-- failure but the underlying EXECUTE does, which aborts the txn — hence
-- the savepoint guard.
SAVEPOINT sp_self_select_star;
SELECT lives_ok(
    $$SELECT * FROM leaderboard_self$$,
    'R-3: SELECT * via leaderboard_self succeeds — security_invoker + WHERE pin lets the caller read their own private columns'
);
ROLLBACK TO SAVEPOINT sp_self_select_star;

-- 6. leaderboard_self returns exactly 6 rows for the caller — one per
--    stage ('all', 'group', 'r16', 'quarter', 'semi', 'final').
SAVEPOINT sp_self_rowcount;
SELECT is(
    (SELECT count(*)::int FROM leaderboard_self),
    6,
    'leaderboard_self returns 6 stage rows for the caller (one per stage)'
);
ROLLBACK TO SAVEPOINT sp_self_rowcount;

-- 7. leaderboard_self contains exactly one distinct participant_id — the
--    caller's own. Proves the WHERE pin works: no other participants leak
--    through the view.
SAVEPOINT sp_self_distinct_participant;
SELECT is(
    (SELECT count(DISTINCT participant_id)::int FROM leaderboard_self),
    1,
    'leaderboard_self contains exactly the caller participant (no other rows leak)'
);
ROLLBACK TO SAVEPOINT sp_self_distinct_participant;

-- 8. Through leaderboard_self, the caller's private columns ARE
--    materialised correctly. A's 'all' stage row should expose
--    exact_hits=1 (the one match-exact score_event seeded above).
SAVEPOINT sp_self_exact_hits;
SELECT is(
    (SELECT exact_hits FROM leaderboard_self WHERE stage = 'all'),
    1,
    'leaderboard_self surfaces the caller''s own private columns (A.exact_hits = 1 via match-exact seed)'
);
ROLLBACK TO SAVEPOINT sp_self_exact_hits;

RESET ROLE;

-- ===========================================================================
-- BEHAVIOURAL ASSERTIONS — Admin (authenticated)
-- ===========================================================================

-- Re-set the JWT to the admin's identity; admin still authenticates as the
-- `authenticated` role per Supabase RLS conventions.
SELECT test_set_jwt(:'adm_user_id'::uuid, :'nortal_tid'::uuid, :'adm_oid'::uuid, 'adm@nortal.com');
SET LOCAL ROLE authenticated;

-- 9. FC-L6: admin is ALSO denied on private columns. The column-level
--    GRANT applies to the `authenticated` role — it does not branch on
--    role. Admin parity with participants on the privacy surface.
SAVEPOINT sp_admin_exact_hits_denied;
SELECT throws_ok(
    $$SELECT exact_hits FROM leaderboard_snapshots$$,
    '42501',
    NULL,
    'FC-L6: admin SELECT exact_hits ALSO denied (column GRANT is role-blind — admin sees the same surface)'
);
ROLLBACK TO SAVEPOINT sp_admin_exact_hits_denied;

-- 10. Admin can SELECT the public projection across all MV rows (same
--     surface as participants).
SELECT lives_ok(
    $$SELECT participant_id, stage, display_name, total_points, rank, rank_is_shared
      FROM leaderboard_snapshots$$,
    'FC-L6: admin can SELECT public projection across all MV rows (same surface as participants)'
);

-- 11. FC-L6: leaderboard_self for admin still returns ONLY the admin's
--     own 6 stage rows. The view does NOT grant admin a privileged
--     full-table view of everyone's private columns.
SAVEPOINT sp_admin_self_rowcount;
SELECT is(
    (SELECT count(*)::int FROM leaderboard_self),
    6,
    'FC-L6: leaderboard_self returns 6 rows for admin (admin''s own stages only)'
);
ROLLBACK TO SAVEPOINT sp_admin_self_rowcount;

-- 12. FC-L6: leaderboard_self for admin contains exactly one distinct
--     participant_id — the admin's own. The security_invoker WHERE pin
--     applies to admin just like any other participant.
SAVEPOINT sp_admin_self_distinct_participant;
SELECT is(
    (SELECT count(DISTINCT participant_id)::int FROM leaderboard_self),
    1,
    'FC-L6: leaderboard_self contains only the admin''s own participant (no privileged cross-row access)'
);
ROLLBACK TO SAVEPOINT sp_admin_self_distinct_participant;

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
