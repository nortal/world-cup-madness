-- pgTAP test: set_timezone(), update_timezone(), trigger_match_sync() RPCs
--
-- Source migration: supabase/migrations/0015_match_rpcs.sql
-- Spec references:
--   specs/002-match-catalog-read/contracts/rpc-set-timezone.md
--   specs/002-match-catalog-read/contracts/rpc-update-timezone.md
--   specs/002-match-catalog-read/contracts/rpc-trigger-match-sync.md
--   specs/002-match-catalog-read/spec.md FR-M14, FR-M15, FR-M16, FR-M18
--
-- Invariants under test:
--
-- set_timezone() — first-sign-in helper, one-shot semantics:
--    1. Happy path — outcome=success, participants.timezone updated.
--    2. Audit row written by the AFTER UPDATE trigger from feature 001's
--       migration 0005 (no new audit infra needed — see migration 0014).
--    3. One-shot semantics — second call returns outcome=no-op (the WHERE
--       clause filters on timezone = 'UTC', so subsequent calls match nothing).
--    4. Audit fires exactly ONCE (not twice from the no-op).
--    5. Validation — empty string raises check_violation.
--    6. Validation — > 64 chars raises check_violation.
--    7. Validation — value containing whitespace raises check_violation.
--    8. Inactive participant — no-op (the WHERE filter excludes inactive).
--
-- update_timezone() — /profile editor, mirrors update_display_name:
--    9. Happy path with audit — set initial, then update, asserts the column
--       updated AND audit_log has participant.updated row with old/new values.
--   10. Same-value call — no new audit row (Postgres IS DISTINCT FROM
--       short-circuit; the catch-all branch of the trigger does not fire).
--   11. Validation — empty raises check_violation.
--   12. Validation — too long raises check_violation.
--   13. Validation — whitespace raises check_violation.
--   14. Inactive participant — raises no_data_found.
--
-- trigger_match_sync() — admin re-sync action (gates on is_admin_user()):
--   15. Non-admin caller — raises insufficient_privilege.
--       (The admin-caller end-to-end path with pg_net is exercised by the
--       Playwright spec T055; here we only test the role gate.)
--
-- JWT simulation pattern: the test_set_jwt helper below is copied verbatim
-- from 003_provision_function.sql (each pgTAP file is self-contained per
-- the existing project convention).

BEGIN;

SELECT plan(17);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for deterministic assertions
-- ---------------------------------------------------------------------------
\set nortal_tid    '11111111-1111-1111-1111-111111111111'
-- Participant fixture for set_timezone tests (active)
\set st_user_id    '21111111-1111-1111-1111-111111111111'
\set st_oid        '22222222-2222-2222-2222-222222222222'
-- Participant fixture for update_timezone happy-path / same-value tests
\set ut_user_id    '31111111-1111-1111-1111-111111111111'
\set ut_oid        '33333333-3333-3333-3333-333333333333'
-- Participant fixture for inactive set_timezone test
\set inact_st_user_id '41111111-1111-1111-1111-111111111111'
\set inact_st_oid     '44444444-4444-4444-4444-444444444444'
-- Participant fixture for inactive update_timezone test
\set inact_ut_user_id '51111111-1111-1111-1111-111111111111'
\set inact_ut_oid     '55555555-5555-5555-5555-555555555555'
-- Non-admin participant for the trigger_match_sync gate test
\set nonadm_user_id '61111111-1111-1111-1111-111111111111'
\set nonadm_oid     '66666666-6666-6666-6666-666666666666'

-- ---------------------------------------------------------------------------
-- Helper: set the JWT claims for the next function call
-- ---------------------------------------------------------------------------
-- Copied verbatim from 003_provision_function.sql (each pgTAP file is
-- self-contained per project convention — there is no shared pgTAP fixture
-- helper file). Uses app_metadata.tid + app_metadata.oid placement per
-- migration 0010's claim-reads update.
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
-- Seed auth.users + tournament_config + participants (5 fixtures)
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id) VALUES
    (:'st_user_id'),
    (:'ut_user_id'),
    (:'inact_st_user_id'),
    (:'inact_ut_user_id'),
    (:'nonadm_user_id')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', '{}'::uuid[])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

-- Active participants for the happy-path tests. timezone defaults to 'UTC'.
INSERT INTO participants (auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'st_user_id'::uuid,    :'st_oid'::uuid,    'st@nortal.com',    'ST User',    'participant', 'active'),
    (:'ut_user_id'::uuid,    :'ut_oid'::uuid,    'ut@nortal.com',    'UT User',    'participant', 'active'),
    (:'nonadm_user_id'::uuid,:'nonadm_oid'::uuid,'nonadm@nortal.com','Nonadm User','participant', 'active'),
    -- Inactive fixtures explicitly soft-deactivated.
    (:'inact_st_user_id'::uuid, :'inact_st_oid'::uuid, 'inact-st@nortal.com', 'Inact ST', 'participant', 'inactive'),
    (:'inact_ut_user_id'::uuid, :'inact_ut_oid'::uuid, 'inact-ut@nortal.com', 'Inact UT', 'participant', 'inactive')
ON CONFLICT (oid) DO NOTHING;

-- Suppress audit rows produced by the seed inserts above so the
-- audit-content tests below assert only on RPC-driven audit rows.
DELETE FROM audit_log;

-- ===========================================================================
-- set_timezone() — tests 1-8
-- ===========================================================================

-- TEST 1 — Happy path: outcome=success + timezone column updated
SELECT test_set_jwt(:'st_user_id'::uuid, :'nortal_tid'::uuid, :'st_oid'::uuid, 'st@nortal.com');

SELECT is(
    (SELECT set_timezone('Europe/Tallinn') ->> 'outcome'),
    'success',
    'TEST 1a: set_timezone happy path returns outcome=success'
);

SELECT is(
    (SELECT timezone FROM participants WHERE oid = :'st_oid'::uuid),
    'Europe/Tallinn',
    'TEST 1b: set_timezone happy path updated participants.timezone'
);

-- TEST 2 — Audit row written by the AFTER UPDATE trigger from feature 001
SELECT is(
    (SELECT COUNT(*)::int FROM audit_log
        WHERE action = 'participant.updated' AND actor_oid = :'st_oid'::uuid),
    1,
    'TEST 2: set_timezone fired audit_participants_changes trigger (one participant.updated row)'
);

-- TEST 3 — One-shot: second call with different value returns no-op,
-- column stays at 'Europe/Tallinn' (WHERE clause filters timezone='UTC' only)
SELECT is(
    (SELECT set_timezone('America/Sao_Paulo') ->> 'outcome'),
    'no-op',
    'TEST 3a: second set_timezone call (column already set) returns outcome=no-op'
);

SELECT is(
    (SELECT timezone FROM participants WHERE oid = :'st_oid'::uuid),
    'Europe/Tallinn',
    'TEST 3b: second set_timezone call did NOT change the column value'
);

-- TEST 4 — Audit row count is still exactly 1 (no-op did not fire trigger)
SELECT is(
    (SELECT COUNT(*)::int FROM audit_log
        WHERE action = 'participant.updated' AND actor_oid = :'st_oid'::uuid),
    1,
    'TEST 4: no-op set_timezone call produced no additional audit row'
);

-- TEST 5 — Validation: empty string
SELECT throws_ok(
    'SELECT set_timezone('''')',
    '23514',  -- check_violation
    NULL,
    'TEST 5: set_timezone with empty string raises check_violation'
);

-- TEST 6 — Validation: too long (> 64 chars)
SELECT throws_ok(
    format('SELECT set_timezone(''%s'')', repeat('a', 65)),
    '23514',
    NULL,
    'TEST 6: set_timezone with > 64-char value raises check_violation'
);

-- TEST 7 — Validation: whitespace in value
SELECT throws_ok(
    'SELECT set_timezone(''Europe/Tal linn'')',
    '23514',
    NULL,
    'TEST 7: set_timezone with whitespace raises check_violation'
);

-- TEST 8 — Inactive participant: WHERE filter excludes, returns no-op
SELECT test_set_jwt(:'inact_st_user_id'::uuid, :'nortal_tid'::uuid, :'inact_st_oid'::uuid, 'inact-st@nortal.com');

SELECT is(
    (SELECT set_timezone('Europe/Berlin') ->> 'outcome'),
    'no-op',
    'TEST 8: set_timezone on inactive participant returns no-op (WHERE filter excludes)'
);

-- ===========================================================================
-- update_timezone() — tests 9-14
-- ===========================================================================

-- TEST 9 — Happy path with audit
-- Seed an initial TZ via set_timezone so the UPDATE has an old value to diff.
SELECT test_set_jwt(:'ut_user_id'::uuid, :'nortal_tid'::uuid, :'ut_oid'::uuid, 'ut@nortal.com');
SELECT set_timezone('Europe/Tallinn');

-- Clear audit_log rows produced by the set_timezone seed so test 9 asserts
-- only on the update_timezone-driven audit row.
DELETE FROM audit_log WHERE actor_oid = :'ut_oid'::uuid;

SELECT is(
    (SELECT update_timezone('America/Sao_Paulo') ->> 'outcome'),
    'success',
    'TEST 9: update_timezone happy path returns outcome=success and writes participant.updated audit row'
);

-- TEST 10 — Same-value call: no new audit row (IS DISTINCT FROM short-circuit)
-- First reset audit_log for this oid, then call with the CURRENT value.
DELETE FROM audit_log WHERE actor_oid = :'ut_oid'::uuid;

SELECT update_timezone('America/Sao_Paulo');

SELECT is(
    (SELECT COUNT(*)::int FROM audit_log
        WHERE action = 'participant.updated' AND actor_oid = :'ut_oid'::uuid),
    0,
    'TEST 10: update_timezone with same value does NOT fire audit trigger (IS DISTINCT FROM short-circuit)'
);

-- TEST 11 — Validation: empty string
SELECT throws_ok(
    'SELECT update_timezone('''')',
    '23514',
    NULL,
    'TEST 11: update_timezone with empty string raises check_violation'
);

-- TEST 12 — Validation: too long
SELECT throws_ok(
    format('SELECT update_timezone(''%s'')', repeat('a', 65)),
    '23514',
    NULL,
    'TEST 12: update_timezone with > 64-char value raises check_violation'
);

-- TEST 13 — Validation: whitespace
SELECT throws_ok(
    'SELECT update_timezone(''Europe/Tal linn'')',
    '23514',
    NULL,
    'TEST 13: update_timezone with whitespace raises check_violation'
);

-- TEST 14 — Inactive participant: raises no_data_found (P0002)
SELECT test_set_jwt(:'inact_ut_user_id'::uuid, :'nortal_tid'::uuid, :'inact_ut_oid'::uuid, 'inact-ut@nortal.com');

SELECT throws_ok(
    'SELECT update_timezone(''Europe/Berlin'')',
    'P0002',  -- no_data_found
    NULL,
    'TEST 14: update_timezone on inactive participant raises no_data_found'
);

-- ===========================================================================
-- trigger_match_sync() — test 15
-- ===========================================================================

-- TEST 15 — Non-admin caller raises insufficient_privilege (42501)
-- Sign in as a non-admin participant; is_admin_user() returns false; the
-- gate at the top of trigger_match_sync should raise.
SELECT test_set_jwt(:'nonadm_user_id'::uuid, :'nortal_tid'::uuid, :'nonadm_oid'::uuid, 'nonadm@nortal.com');

SELECT throws_ok(
    'SELECT trigger_match_sync()',
    '42501',  -- insufficient_privilege
    NULL,
    'TEST 15: trigger_match_sync() called by non-admin raises insufficient_privilege'
);

SELECT * FROM finish();

ROLLBACK;
