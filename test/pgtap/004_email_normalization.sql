-- pgTAP test: Email normalization on `public.participants`
--
-- Source migration: supabase/migrations/0003_create_participants.sql
-- Spec references:  specs/001-authentication-and-participant/spec.md §TC-13
--                   specs/001-authentication-and-participant/research.md §R-4
--                   specs/001-authentication-and-participant/data-model.md
--                     §"Tables -> participants" (citext column + trim trigger)
--
-- Invariants under test:
--   * The first insert with a given canonical email succeeds and the trim
--     trigger strips leading/trailing whitespace before storage.
--   * The trim trigger does NOT change letter case — case-insensitive
--     uniqueness is provided by the `citext` column type, not by the
--     trigger (R-4 / data-model.md §74-83). The stored value preserves
--     the original case as supplied by the caller (after trimming).
--   * A second insert whose email differs ONLY by letter case collides
--     via the citext UNIQUE constraint (SQLSTATE 23505).
--   * A third insert whose email differs ONLY by letter case AND
--     surrounding whitespace ALSO collides (trim trigger + citext
--     together collapse it to the same canonical comparison value).
--
-- These invariants together back TC-13: "the same human always maps to
-- the same participant row regardless of Microsoft sending
-- Mike@Nortal.com vs mike@nortal.com vs MIKE@NORTAL.COM".

BEGIN;

SELECT plan(5);

-- Seed prerequisite auth.users rows for the FK
-- (participants.auth_user_id REFERENCES auth.users(id) ON DELETE RESTRICT).
-- Test 1 uses the only row that will actually be persisted; tests 2 and 3
-- use distinct auth_user_id values so the email UNIQUE collision is the
-- only constraint that can fail. (oid is also UNIQUE; we vary it too.)
INSERT INTO auth.users (id, instance_id, aud, role)
VALUES
    ('11111111-1111-1111-1111-111111111111'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated'),
    ('22222222-2222-2222-2222-222222222222'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated'),
    ('33333333-3333-3333-3333-333333333333'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, 'authenticated', 'authenticated');

------------------------------------------------------------------------
-- Test 1: First insert with mixed-case email succeeds.
------------------------------------------------------------------------
SELECT lives_ok(
    $$INSERT INTO public.participants (auth_user_id, oid, email, display_name)
      VALUES (
          '11111111-1111-1111-1111-111111111111'::uuid,
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
          'Mike@Nortal.com'::citext,
          'Mike Hitchcock'
      )$$,
    'first insert with mixed-case email Mike@Nortal.com succeeds'
);

------------------------------------------------------------------------
-- Test 2: The trim trigger stores the value with whitespace removed but
-- letter case preserved. (Trigger is trim-only per R-4; citext gives
-- case-insensitive comparison without rewriting case on insert.)
------------------------------------------------------------------------
SELECT is(
    (
        SELECT email::text
        FROM public.participants
        WHERE oid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
    ),
    'Mike@Nortal.com',
    'stored email preserves original case after trim (trigger is trim-only; citext handles case-insensitive comparison)'
);

------------------------------------------------------------------------
-- Test 3: Second insert with the same email differing only by case
-- collides on the citext UNIQUE constraint (SQLSTATE 23505).
------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.participants (auth_user_id, oid, email, display_name)
      VALUES (
          '22222222-2222-2222-2222-222222222222'::uuid,
          'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,
          'mike@nortal.com'::citext,
          'Mike Hitchcock (lower)'
      )$$,
    '23505',
    NULL,
    'inserting mike@nortal.com (lowercase) collides with Mike@Nortal.com via citext UNIQUE'
);

------------------------------------------------------------------------
-- Test 4: Third insert with leading/trailing whitespace AND uppercase
-- also collides — proves the trim trigger and citext together collapse
-- "  MIKE@NORTAL.COM  " to the same canonical comparison value.
------------------------------------------------------------------------
SELECT throws_ok(
    $$INSERT INTO public.participants (auth_user_id, oid, email, display_name)
      VALUES (
          '33333333-3333-3333-3333-333333333333'::uuid,
          'cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid,
          '  MIKE@NORTAL.COM  '::citext,
          'Mike Hitchcock (whitespace+upper)'
      )$$,
    '23505',
    NULL,
    'inserting "  MIKE@NORTAL.COM  " (whitespace + uppercase) collides after trim + citext canonicalisation'
);

------------------------------------------------------------------------
-- Test 5: Exactly one participant row exists for this canonical email.
-- Defence-in-depth: confirms the failed inserts in tests 3 and 4 did
-- NOT leave behind partial rows.
------------------------------------------------------------------------
SELECT is(
    (
        SELECT COUNT(*)::int
        FROM public.participants
        WHERE email = 'mike@nortal.com'::citext  -- citext comparison is case-insensitive
    ),
    1,
    'exactly one participant row exists for the canonical email mike@nortal.com'
);

SELECT * FROM finish();

ROLLBACK;
