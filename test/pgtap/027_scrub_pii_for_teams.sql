-- pgTAP test: scrub_pii_for_teams(text) PL/pgSQL function (feature 006, T009)
--
-- Source migration: supabase/migrations/0039_scrub_pii_for_teams.sql
-- Contract: specs/006-phase-5-operational/contracts/function-scrub-pii.md
--
-- Spec references:
--   FR-O03a — Operational notifications must redact PII before egress to
--             Microsoft Teams (emails, UUIDs, bare nortal.com mentions).
--   research.md §R-3 — Regex chain: email → UUID → nortal.com word-boundary,
--                      then substr(out, 1, 500) truncation. Case-sensitive by
--                      design (cases 11 + 12 document the trade-off).
--
-- Assertion plan (12 total): NULL / empty / no-match passthrough +
-- individual pattern matches (email, UUID, bare nortal.com) +
-- mid-string substitution + multi-PII + multi-pattern composition +
-- 500-char truncation + two documented case-sensitivity limitations.
--
-- The function is IMMUTABLE — no DB state changes. ROLLBACK is defensive.

BEGIN;

SELECT plan(12);

-- ===========================================================================
-- TEST 1 — NULL input returns empty string (COALESCE at function head)
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams(NULL),
    '',
    'TEST 1: NULL input returns empty string'
);

-- ===========================================================================
-- TEST 2 — empty string input returns empty string
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams(''),
    '',
    'TEST 2: empty string input returns empty string'
);

-- ===========================================================================
-- TEST 3 — no PII passthrough: input unchanged when no patterns match
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('no pii here'),
    'no pii here',
    'TEST 3: non-matching input returned verbatim'
);

-- ===========================================================================
-- TEST 4 — email is fully redacted
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('alice@nortal.com'),
    '[REDACTED]',
    'TEST 4: email is fully redacted'
);

-- ===========================================================================
-- TEST 5 — standalone lowercase UUID is fully redacted
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('00112233-4455-6677-8899-aabbccddeeff'),
    '[REDACTED]',
    'TEST 5: standalone lowercase UUID is fully redacted'
);

-- ===========================================================================
-- TEST 6 — bare nortal.com mention is redacted in-place via \m..\M boundary
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('tenant nortal.com filter failed'),
    'tenant [REDACTED] filter failed',
    'TEST 6: bare nortal.com mention is redacted in-place (word boundary)'
);

-- ===========================================================================
-- TEST 7 — email embedded mid-string is redacted, surrounding text preserved
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('predicted alice@nortal.com chose 2-1'),
    'predicted [REDACTED] chose 2-1',
    'TEST 7: mid-string email redacted, surrounding text preserved'
);

-- ===========================================================================
-- TEST 8 — two UUIDs in one string both redacted; SQLSTATE token preserved
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('participant 00112233-4455-6677-8899-aabbccddeeff match ffeeddcc-bbaa-9988-7766-554433221100 SQLSTATE 23503'),
    'participant [REDACTED] match [REDACTED] SQLSTATE 23503',
    'TEST 8: two UUIDs both redacted; SQLSTATE code preserved'
);

-- ===========================================================================
-- TEST 9 — email + UUID composition: both patterns redact independently
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('alice@nortal.com 00112233-4455-6677-8899-aabbccddeeff'),
    '[REDACTED] [REDACTED]',
    'TEST 9: email and UUID in same string both redacted'
);

-- ===========================================================================
-- TEST 10 — post-scrub truncation to exactly 500 characters
--           Input: 'a@a.aa ' repeated 86 times = 602 chars (still > 500
--           after scrubbing each email to [REDACTED]). Function applies
--           substr(out, 1, 500) AFTER scrubbing, so final length must be 500.
-- ===========================================================================
SELECT is(
    length(scrub_pii_for_teams(repeat('a@a.aa ', 86))),
    500,
    'TEST 10: output truncated to exactly 500 chars after scrubbing'
);

-- ===========================================================================
-- TEST 11 — documented limitation: uppercase 'NORTAL.COM' is NOT redacted
--           (regex is case-sensitive by design — see contract notes)
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('NORTAL.COM'),
    'NORTAL.COM',
    'TEST 11: uppercase NORTAL.COM unchanged (documented case-sensitivity limitation)'
);

-- ===========================================================================
-- TEST 12 — documented limitation: uppercase UUID hex digits NOT redacted
--           (UUIDs in Postgres error_message strings are lowercase by
--           convention — see contract notes)
-- ===========================================================================
SELECT is(
    scrub_pii_for_teams('00112233-4455-6677-8899-AABBCCDDEEFF'),
    '00112233-4455-6677-8899-AABBCCDDEEFF',
    'TEST 12: uppercase-hex UUID unchanged (documented case-sensitivity limitation)'
);

SELECT * FROM finish();

ROLLBACK;
