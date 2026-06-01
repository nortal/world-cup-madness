-- pgTAP test: T012 — RLS policies on `public.score_events`
--
-- Source migrations:
--   supabase/migrations/0025_create_score_events.sql  (table + ENUM)
--   supabase/migrations/0029_prediction_rls.sql       (RLS policies)
--
-- Spec references:
--   specs/003-predictions-and-scoring/data-model.md §1.4 (table spec)
--   specs/003-predictions-and-scoring/data-model.md §4.4 (RLS policies)
--
-- FR reference: FR-P24 / FC-3 — only SECURITY DEFINER trigger functions
-- (calculate_match_points / calculate_final_points in migrations 0030/0031)
-- may write to score_events. The PostgREST/`authenticated` role MUST NOT
-- have any INSERT / UPDATE / DELETE policy — read-only at the SQL layer.
--
-- Invariants under test:
--   PLUMBING (structural):
--     * RLS is ENABLED on public.score_events.
--     * Exactly the 2 expected SELECT policies exist:
--         - score_events_select_own   (participant: own rows)
--         - score_events_select_admin (admin: all rows)
--     * Total policy count is exactly 2 — defence-in-depth assertion that
--       no INSERT / UPDATE / DELETE / ALL policy exists by any name.
--     * Both SELECT policies target the `authenticated` role.
--
--   BEHAVIOURAL (FR-P24 negative paths):
--     * Participant A sees only their own rows (2 of 3 seeded).
--     * Participant A's filter-by-other-participant returns 0 rows.
--     * Participant A cannot INSERT     (no INSERT policy → RLS denies).
--     * Participant A cannot UPDATE     (no UPDATE policy → RLS denies).
--     * Participant A cannot DELETE     (no DELETE policy → RLS denies).
--     * Admin sees all rows (3 of 3 seeded).
--     * Admin cannot INSERT either — admin's SELECT policy does NOT grant
--       writes; only SECURITY DEFINER trigger funcs write. This is the
--       FR-P24 enforcement: the SQL layer is silent on writes for
--       EVERY authenticated identity.
--
-- The four negative-path assertions are wrapped in SAVEPOINT … ROLLBACK TO
-- so each failure does not abort the outer test transaction (Postgres
-- aborts the current transaction on the first error otherwise).
--
-- JWT simulation pattern: same `test_set_jwt` helper as
-- 003_provision_function.sql / 008_match_rpcs.sql (each pgTAP file is
-- self-contained per project convention).

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
-- Seed teams + one match (match_id FK target for match-source score_events)
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
     'group', 'A', '2026-06-15 18:00:00+00', 'Test Stadium', 'finished',
     2, 1)
ON CONFLICT (provider_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed score_events directly (running as test superuser bypasses RLS — this
-- simulates what the SECURITY DEFINER trigger functions in migrations
-- 0030/0031 do at runtime).
-- ---------------------------------------------------------------------------
INSERT INTO score_events (participant_id, match_id, source, points)
VALUES
    -- A: exact-score match row (10 pts)
    (:'a_part_id'::uuid, :'match_id'::uuid, 'match-exact',     10),
    -- B: outcome-only match row (5 pts)
    (:'b_part_id'::uuid, :'match_id'::uuid, 'match-outcome',    5),
    -- A: final-champion row (20 pts) — match_id MUST be NULL per CHECK
    (:'a_part_id'::uuid, NULL,              'final-champion',  20);

-- ===========================================================================
-- STRUCTURAL ASSERTIONS (1-5)
-- ===========================================================================

-- 1. RLS is enabled on score_events.
SELECT is(
    (
        SELECT relrowsecurity
        FROM pg_class
        WHERE oid = 'public.score_events'::regclass
    ),
    TRUE,
    'RLS is enabled on public.score_events'
);

-- 2. Exactly the two expected SELECT policies exist (defence-in-depth —
--    would fail if any future migration adds an INSERT/UPDATE/DELETE policy
--    or renames either of these).
SELECT policies_are(
    'public',
    'score_events',
    ARRAY[
        'score_events_select_own',
        'score_events_select_admin'
    ],
    'public.score_events has exactly the two expected RLS policies'
);

-- 3. FR-P24 enforcement: ZERO INSERT/UPDATE/DELETE/ALL policies exist on
--    score_events. pg_policies.cmd uses verbose values
--    ('SELECT','INSERT','UPDATE','DELETE','ALL'). A future migration adding
--    ANY write policy under ANY name would make this assertion fail.
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'score_events'
          AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
    ),
    0,
    'FR-P24: public.score_events has ZERO INSERT/UPDATE/DELETE/ALL policies (writes only via SECURITY DEFINER triggers in 0030/0031)'
);

-- 4. Both SELECT policies target the `authenticated` role.
--    pg_policies.roles is name[]; assert membership for each policy.
SELECT ok(
    (
        SELECT bool_and('authenticated' = ANY(roles))
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'score_events'
          AND policyname IN ('score_events_select_own', 'score_events_select_admin')
    ),
    'both SELECT policies on score_events target the authenticated role'
);

-- 5. Predicate-shape sanity: the own-policy references the
--    participants.auth_user_id lookup and the admin-policy uses
--    is_admin_user(). pg_policies.qual is the rendered USING expression.
SELECT ok(
    (
        SELECT qual LIKE '%auth_user_id%' AND qual LIKE '%participants%'
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'score_events'
          AND policyname = 'score_events_select_own'
    ),
    'score_events_select_own USING clause references participants.auth_user_id'
);

SELECT ok(
    (
        SELECT qual LIKE '%is_admin_user%'
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'score_events'
          AND policyname = 'score_events_select_admin'
    ),
    'score_events_select_admin USING clause references is_admin_user()'
);

-- ===========================================================================
-- BEHAVIOURAL ASSERTIONS — Participant A (authenticated)
-- ===========================================================================

-- Switch into the authenticated role with A's JWT so RLS evaluates.
SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

-- 6. Participant A sees only their own 2 rows (match-exact + final-champion).
SELECT is(
    (SELECT COUNT(*)::int FROM score_events),
    2,
    'participant A sees exactly 2 rows (their own match + final events)'
);

-- 7. Participant A's explicit filter for B's participant_id returns nothing.
SELECT is(
    (SELECT COUNT(*)::int FROM score_events WHERE participant_id = :'b_part_id'::uuid),
    0,
    'participant A cannot SELECT B''s rows even with explicit filter (RLS-isolated)'
);

-- ---------------------------------------------------------------------------
-- FR-P24 NEGATIVE PATH 1/4: INSERT denied — no INSERT policy on table.
-- Postgres raises SQLSTATE 42501 (insufficient_privilege) when RLS rejects
-- a write that has no permissive policy. Some Postgres versions surface it
-- as "new row violates row-level security policy" instead; throws_ok with
-- NULL message matches either text, and we assert by SQLSTATE.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_insert_denied;
SELECT throws_ok(
    format(
        'INSERT INTO score_events (participant_id, match_id, source, points) VALUES (%L, %L, %L, %L)',
        :'a_part_id', :'match_id', 'match-wrong', 0
    ),
    '42501',
    NULL,
    'FR-P24: participant A INSERT into score_events raises insufficient_privilege (no INSERT policy)'
);
ROLLBACK TO SAVEPOINT sp_insert_denied;

-- ---------------------------------------------------------------------------
-- FR-P24 NEGATIVE PATH 2/4: UPDATE invisible — no UPDATE policy on table.
-- Postgres RLS semantic: a write with no matching policy returns 0 rows
-- affected (the row is invisible to the write), NOT an error. Same shape as
-- the players table test (013_rls_players.sql) handles this — we assert the
-- affected-row count is 0 rather than expecting a throw.
-- ---------------------------------------------------------------------------
WITH attempted AS (
    UPDATE score_events SET points = 100 WHERE participant_id = :'a_part_id'
    RETURNING 1
)
SELECT is(
    (SELECT count(*) FROM attempted)::int,
    0,
    'FR-P24: participant A UPDATE on score_events affects 0 rows (no UPDATE policy → row invisible to write)'
);

-- ---------------------------------------------------------------------------
-- FR-P24 NEGATIVE PATH 3/4: DELETE invisible — no DELETE policy on table.
-- Same RLS semantic as UPDATE above.
-- ---------------------------------------------------------------------------
WITH attempted AS (
    DELETE FROM score_events WHERE participant_id = :'a_part_id'
    RETURNING 1
)
SELECT is(
    (SELECT count(*) FROM attempted)::int,
    0,
    'FR-P24: participant A DELETE on score_events affects 0 rows (no DELETE policy → row invisible to write)'
);

-- Reset role for the admin block.
RESET ROLE;

-- ===========================================================================
-- BEHAVIOURAL ASSERTIONS — Admin (authenticated)
-- ===========================================================================

-- Switch into the authenticated role with the admin's JWT.
SELECT test_set_jwt(:'adm_user_id'::uuid, :'nortal_tid'::uuid, :'adm_oid'::uuid, 'adm@nortal.com');
SET LOCAL ROLE authenticated;

-- 11. Admin sees all 3 rows (score_events_select_admin policy).
SELECT is(
    (SELECT COUNT(*)::int FROM score_events),
    3,
    'admin sees all 3 score_events rows (A''s 2 + B''s 1) via score_events_select_admin'
);

-- ---------------------------------------------------------------------------
-- FR-P24 NEGATIVE PATH 4/4: even admin cannot INSERT — the admin policy is
-- SELECT-only. The SQL layer is intentionally silent on writes for EVERY
-- authenticated identity. Admin scoring corrections flow through
-- calculate_match_points / calculate_final_points (SECURITY DEFINER
-- functions in migrations 0030/0031), NEVER via direct INSERTs.
-- ---------------------------------------------------------------------------
SAVEPOINT sp_admin_insert_denied;
SELECT throws_ok(
    format(
        'INSERT INTO score_events (participant_id, match_id, source, points) VALUES (%L, %L, %L, %L)',
        :'adm_part_id', :'match_id', 'match-wrong', 0
    ),
    '42501',
    NULL,
    'FR-P24: even ADMIN INSERT on score_events raises insufficient_privilege — only SECURITY DEFINER triggers can write'
);
ROLLBACK TO SAVEPOINT sp_admin_insert_denied;

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
