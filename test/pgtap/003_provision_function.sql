-- pgTAP test: provision_participant_from_jwt() SECURITY DEFINER RPC
--
-- Source migration: supabase/migrations/0006_provision_function.sql
-- Spec references:
--   specs/001-authentication-and-participant/data-model.md
--     §"SECURITY DEFINER Functions -> provision_participant_from_jwt()" (lines 204-283)
--   specs/001-authentication-and-participant/contracts/rpc-provision-participant.md
--   specs/001-authentication-and-participant/spec.md (FC-1, FC-2)
--
-- Invariants under test (5 scenarios):
--   1. Eligible user (new)        -> outcome=success, participant created, audit row written
--   2. Returning eligible user    -> outcome=success, last_login_at updated, no new row
--   3. Ineligible user (new)      -> outcome=rejected, NO participant row (FC-2), auth.rejected audit
--   4. Tenant departure           -> outcome=rejected, status flipped to inactive,
--                                    both participant.deactivated AND auth.rejected audit rows
--   5. FC-1 missing config        -> outcome=error, NO participant row,
--                                    auth.provider-error audit row
--
-- JWT simulation pattern (Supabase):
--   auth.jwt()  reads current_setting('request.jwt.claims', true)::jsonb
--   auth.uid()  reads (current_setting('request.jwt.claim.sub', true))::uuid
--                or current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
--   We set both to be safe.

BEGIN;

SELECT plan(22);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for deterministic assertions
-- ---------------------------------------------------------------------------
-- Tenant configured as the canonical Nortal tenant
\set nortal_tid    '11111111-1111-1111-1111-111111111111'
-- Eligible user (Test 1, Test 2)
\set eligible_oid  '22222222-2222-2222-2222-222222222222'
\set eligible_sub  '22222222-2222-2222-2222-222222222220'
-- Ineligible new user (Test 3)
\set ineligible_oid_new  '33333333-3333-3333-3333-333333333333'
\set ineligible_sub_new  '33333333-3333-3333-3333-333333333330'
-- Tenant departure (Test 4) — previously eligible, now coming back with a different tid
\set departed_oid  '44444444-4444-4444-4444-444444444444'
\set departed_sub  '44444444-4444-4444-4444-444444444440'
-- Foreign tenant for ineligible JWTs
\set foreign_tid   '99999999-9999-9999-9999-999999999999'
-- Missing-config eligible user (Test 5)
\set fc1_oid       '55555555-5555-5555-5555-555555555555'
\set fc1_sub       '55555555-5555-5555-5555-555555555550'

-- ---------------------------------------------------------------------------
-- Helper: set the JWT claims + auth.uid() for the next function call
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
        'sub',           p_sub::text,
        'tid',           p_tid::text,
        'email',         p_email,
        'name',          p_name,
        'app_metadata',  jsonb_build_object('oid', p_oid::text)
    );
    PERFORM set_config('request.jwt.claims',     v_claims::text, true);
    PERFORM set_config('request.jwt.claim.sub',  p_sub::text,    true);
    PERFORM set_config('role',                   'authenticated', true);
END $$;

-- ---------------------------------------------------------------------------
-- Seed auth.users (FK target for participants.auth_user_id)
-- ---------------------------------------------------------------------------
-- The auth.users table is owned by the auth schema in a real Supabase project.
-- For local pgTAP runs we INSERT only the minimal columns the FK requires.
-- If any column is NOT NULL beyond `id`, the test environment seed should
-- include those defaults; this insert pattern matches the standard
-- Supabase local stack `auth.users` table (id is the only NOT NULL without default).
INSERT INTO auth.users (id) VALUES
    (:'eligible_sub'),
    (:'ineligible_sub_new'),
    (:'departed_sub'),
    (:'fc1_sub')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed tournament_config (FC-1: nortal_tenant_id present)
-- ---------------------------------------------------------------------------
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', '{}'::uuid[])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

-- ===========================================================================
-- TEST 1 — Eligible user, first sign-in: outcome=success
-- ===========================================================================
SELECT test_set_jwt(
    :'eligible_sub'::uuid,
    :'nortal_tid'::uuid,
    :'eligible_oid'::uuid,
    'alice@nortal.com',
    'Alice Example'
);

-- 1a. outcome=success
SELECT is(
    (SELECT provision_participant_from_jwt() ->> 'outcome'),
    'success',
    'TEST 1: eligible new user returns outcome=success'
);

-- 1b. Exactly one participant row exists for this oid
SELECT is(
    (SELECT COUNT(*)::int FROM participants WHERE oid = :'eligible_oid'::uuid),
    1,
    'TEST 1: exactly one participants row created for eligible oid'
);

-- 1c. is_first_login=true on first sign-in (welcome_dismissed_at IS NULL)
SELECT test_set_jwt(
    :'eligible_sub'::uuid,
    :'nortal_tid'::uuid,
    :'eligible_oid'::uuid,
    'alice@nortal.com',
    'Alice Example'
);
-- Note: cannot reliably re-call here without changing state; instead assert the
-- audit row produced by the trigger on the original INSERT.
SELECT is(
    (SELECT COUNT(*)::int FROM audit_log
        WHERE action = 'participant.created' AND actor_oid = :'eligible_oid'::uuid),
    1,
    'TEST 1: audit_log has exactly one participant.created row for eligible oid'
);

-- 1d. Role defaulted to 'participant' (oid not in admin_oids)
SELECT is(
    (SELECT role FROM participants WHERE oid = :'eligible_oid'::uuid),
    'participant',
    'TEST 1: new eligible user assigned role=participant by default'
);

-- 1e. Status active
SELECT is(
    (SELECT status FROM participants WHERE oid = :'eligible_oid'::uuid),
    'active',
    'TEST 1: new eligible user has status=active'
);

-- ===========================================================================
-- TEST 2 — Returning eligible user: idempotent, last_login_at updated
-- ===========================================================================
-- Force last_login_at backward so we can detect the update.
UPDATE participants
   SET last_login_at = '2000-01-01T00:00:00Z'::timestamptz
 WHERE oid = :'eligible_oid'::uuid;

SELECT test_set_jwt(
    :'eligible_sub'::uuid,
    :'nortal_tid'::uuid,
    :'eligible_oid'::uuid,
    'alice@nortal.com',
    'Alice Example'
);

-- 2a. Second call still returns success
SELECT is(
    (SELECT provision_participant_from_jwt() ->> 'outcome'),
    'success',
    'TEST 2: returning eligible user returns outcome=success'
);

-- 2b. Still exactly one participants row (no duplicate)
SELECT is(
    (SELECT COUNT(*)::int FROM participants WHERE oid = :'eligible_oid'::uuid),
    1,
    'TEST 2: returning eligible user does NOT create a duplicate participants row'
);

-- 2c. last_login_at advanced past the artificial 2000 baseline
SELECT ok(
    (SELECT last_login_at > '2020-01-01T00:00:00Z'::timestamptz
       FROM participants WHERE oid = :'eligible_oid'::uuid),
    'TEST 2: returning eligible user has last_login_at refreshed to now()'
);

-- 2d. No additional participant.created audit row from the second call
SELECT is(
    (SELECT COUNT(*)::int FROM audit_log
       WHERE action = 'participant.created' AND actor_oid = :'eligible_oid'::uuid),
    1,
    'TEST 2: no additional participant.created audit row from re-provision'
);

-- ===========================================================================
-- TEST 3 — Ineligible user (new): outcome=rejected, FC-2 (no participant row)
-- ===========================================================================
SELECT test_set_jwt(
    :'ineligible_sub_new'::uuid,
    :'foreign_tid'::uuid,            -- mismatched tid
    :'ineligible_oid_new'::uuid,
    'mallory@evil.example',
    'Mallory External'
);

-- 3a. outcome=rejected
SELECT is(
    (SELECT provision_participant_from_jwt() ->> 'outcome'),
    'rejected',
    'TEST 3: ineligible new user returns outcome=rejected'
);

-- 3b. reason=tenant.mismatch
SELECT is(
    (SELECT (provision_participant_from_jwt() ->> 'reason')),
    'tenant.mismatch',
    'TEST 3: ineligible new user returns reason=tenant.mismatch'
);

-- 3c. FC-2: NO participants row created for ineligible oid
SELECT is(
    (SELECT COUNT(*)::int FROM participants WHERE oid = :'ineligible_oid_new'::uuid),
    0,
    'TEST 3 (FC-2): NO participants row exists for ineligible new user'
);

-- 3d. auth.rejected audit row written with attempted_tid populated
SELECT ok(
    (SELECT EXISTS (
        SELECT 1 FROM audit_log
         WHERE action        = 'auth.rejected'
           AND actor_oid     = :'ineligible_oid_new'::uuid
           AND attempted_tid = :'foreign_tid'::uuid
           AND reason        = 'tenant.mismatch'
    )),
    'TEST 3: audit_log has auth.rejected row with attempted_tid + reason for ineligible new user'
);

-- ===========================================================================
-- TEST 4 — Tenant departure: previously-eligible user, now ineligible
-- ===========================================================================
-- Seed an active participant for the "departed" user via the function itself
-- to keep the audit trail consistent with production behaviour.
SELECT test_set_jwt(
    :'departed_sub'::uuid,
    :'nortal_tid'::uuid,             -- starts eligible
    :'departed_oid'::uuid,
    'bob@nortal.com',
    'Bob Departing'
);
SELECT provision_participant_from_jwt();  -- creates active participant

-- Now Bob comes back with a foreign tid (tenant departure)
SELECT test_set_jwt(
    :'departed_sub'::uuid,
    :'foreign_tid'::uuid,            -- mismatched on return
    :'departed_oid'::uuid,
    'bob@nortal.com',
    'Bob Departing'
);

-- 4a. outcome=rejected
SELECT is(
    (SELECT provision_participant_from_jwt() ->> 'outcome'),
    'rejected',
    'TEST 4: tenant-departure user returns outcome=rejected'
);

-- 4b. Existing participant row flipped to inactive
SELECT is(
    (SELECT status FROM participants WHERE oid = :'departed_oid'::uuid),
    'inactive',
    'TEST 4: previously-active participant now status=inactive after tenant departure'
);

-- 4c. participant.deactivated audit row written by trigger with reason=tenant.departure
SELECT ok(
    (SELECT EXISTS (
        SELECT 1 FROM audit_log
         WHERE action    = 'participant.deactivated'
           AND actor_oid = :'departed_oid'::uuid
           AND reason    = 'tenant.departure'
    )),
    'TEST 4: audit_log has participant.deactivated row (reason=tenant.departure)'
);

-- 4d. auth.rejected audit row also written for this attempt
SELECT ok(
    (SELECT EXISTS (
        SELECT 1 FROM audit_log
         WHERE action        = 'auth.rejected'
           AND actor_oid     = :'departed_oid'::uuid
           AND attempted_tid = :'foreign_tid'::uuid
           AND reason        = 'tenant.mismatch'
    )),
    'TEST 4: audit_log has auth.rejected row for tenant-departure attempt'
);

-- 4e. Still exactly one participants row for departed oid (deactivated, not duplicated)
SELECT is(
    (SELECT COUNT(*)::int FROM participants WHERE oid = :'departed_oid'::uuid),
    1,
    'TEST 4: tenant departure does NOT create a duplicate participants row'
);

-- ===========================================================================
-- TEST 5 — FC-1: missing config (nortal_tenant_id IS NULL) -> outcome=error
-- ===========================================================================
-- Because of the NOT NULL constraint on tournament_config.nortal_tenant_id,
-- we cannot NULL it directly. We simulate FC-1 by deleting the row entirely,
-- which exercises the `NOT FOUND OR ... IS NULL` branch identically.
DELETE FROM tournament_config WHERE id = 1;

SELECT test_set_jwt(
    :'fc1_sub'::uuid,
    :'nortal_tid'::uuid,            -- a tid that *would* match if config existed
    :'fc1_oid'::uuid,
    'carol@nortal.com',
    'Carol FC1'
);

-- 5a. outcome=error
SELECT is(
    (SELECT provision_participant_from_jwt() ->> 'outcome'),
    'error',
    'TEST 5 (FC-1): missing config returns outcome=error'
);

-- 5b. reason=config.missing
SELECT is(
    (SELECT (provision_participant_from_jwt() ->> 'reason')),
    'config.missing',
    'TEST 5 (FC-1): missing config returns reason=config.missing'
);

-- 5c. FC-1: NO participant row created when config is missing
SELECT is(
    (SELECT COUNT(*)::int FROM participants WHERE oid = :'fc1_oid'::uuid),
    0,
    'TEST 5 (FC-1): NO participants row created when tournament_config missing'
);

-- 5d. auth.provider-error audit row written
SELECT ok(
    (SELECT EXISTS (
        SELECT 1 FROM audit_log
         WHERE action    = 'auth.provider-error'
           AND actor_oid = :'fc1_oid'::uuid
           AND reason    = 'config.missing'
    )),
    'TEST 5 (FC-1): audit_log has auth.provider-error row with reason=config.missing'
);

SELECT * FROM finish();

ROLLBACK;
