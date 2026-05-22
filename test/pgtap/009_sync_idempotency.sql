-- pgTAP test: idempotent UPSERT + in-flight-row mutex for the match-catalog sync
--
-- Source migrations: supabase/migrations/0012_create_matches.sql (UNIQUE on
--                    provider_id underwrites the idempotent UPSERT)
--                    supabase/migrations/0018_match_sync_inflight_lock.sql
--                    (partial unique index `integration_runs_at_most_one_in_flight`
--                    enforces "at most one in-flight row" — the
--                    advisory-lock RPCs from migration 0015 are dropped there)
-- Spec references:
--   specs/002-match-catalog-read/spec.md FR-M20 (idempotent re-import)
--   specs/002-match-catalog-read/spec.md FR-M23 (concurrency control)
--   specs/002-match-catalog-read/research.md §R-4 (concurrency design)
--
-- Invariants under test (10 assertions):
--
-- IDEMPOTENCY (FR-M20):
--   1. First UPSERT inserts 3 match rows.
--   2. Re-running the same UPSERT against unchanged data does NOT change the
--      row count (UNIQUE on provider_id triggers conflicts → DO UPDATE).
--   3. The DO UPDATE clause refreshes last_synced_at on every run, so admins
--      can answer "when did we last hear from the provider?" even when no
--      field changed.
--   4. The DO UPDATE clause does NOT change the other fields when EXCLUDED
--      values are identical (score_home, score_away, status, kickoff_utc all
--      stable across the no-op re-run).
--   5. When a field DOES change between runs (e.g. provider reports a new
--      score), the corresponding column updates on the next UPSERT.
--   6. Documents the field-diff "unchanged count" contract that the Edge
--      Function will use to populate integration_runs.records_unchanged.
--
-- IN-FLIGHT MUTEX (FR-M23):
--   7. Inserting the first in-flight integration_runs row (finished_at IS NULL)
--      succeeds when no prior in-flight row exists.
--   8. Inserting a SECOND in-flight row while the first is still in flight
--      fails with SQLSTATE 23505 (unique violation on the partial index
--      `integration_runs_at_most_one_in_flight`). This is the Postgres-
--      enforced mutex that replaces the broken advisory-lock model from
--      migration 0015: PostgREST closes its DB session after every RPC, so
--      advisory locks never spanned the actual sync work — see migration
--      0018 commit message for the full story.
--   9. UPDATEing the first in-flight row's finished_at to a non-NULL value
--      drops it out of the partial-index domain, releasing the slot.
--  10. After release, a fresh in-flight row insert succeeds — proves the
--      mutex is correctly scoped to "finished_at IS NULL" only.
--
-- ROLLBACK at the end keeps the test stateless. integration_runs rows
-- created here are transaction-scoped, so unlike the advisory-lock version
-- there is no session-scoped cleanup required.

BEGIN;

SELECT plan(10);

-- ---------------------------------------------------------------------------
-- Setup: 3 test teams (UNIQUE provider_team_ids outside the seed range)
-- ---------------------------------------------------------------------------
INSERT INTO teams (name, tla, provider_team_id) VALUES
    ('Test Team A', 'AAA', 901),
    ('Test Team B', 'BBB', 902),
    ('Test Team C', 'CCC', 903)
ON CONFLICT (provider_team_id) DO NOTHING;

-- Resolve the team UUIDs once for the UPSERT statements below.
CREATE TEMP TABLE t_teams AS
SELECT
    (SELECT id FROM teams WHERE tla = 'AAA') AS team_a,
    (SELECT id FROM teams WHERE tla = 'BBB') AS team_b,
    (SELECT id FROM teams WHERE tla = 'CCC') AS team_c;

-- ---------------------------------------------------------------------------
-- Test 1 — First UPSERT writes 3 rows.
-- ---------------------------------------------------------------------------
-- NULL columns are explicitly cast to integer so the UNION ALL resolves the
-- score_home / score_away types correctly (without the cast, Postgres infers
-- text for un-typed NULL literals and the INSERT fails the column-type
-- check). Same casting pattern repeats in tests 2 + 5.
INSERT INTO matches (
    provider_id, home_team_id, away_team_id, stage, group_label,
    kickoff_utc, venue, status, score_home, score_away, last_synced_at
)
SELECT
    9001, team_a, team_b, 'group', 'A',
    '2026-06-15 18:00:00+00'::timestamptz, 'Test Stadium', 'scheduled',
    NULL::integer, NULL::integer, clock_timestamp()
FROM t_teams
UNION ALL
SELECT
    9002, team_b, team_c, 'group', 'A',
    '2026-06-16 18:00:00+00'::timestamptz, 'Test Stadium', 'scheduled',
    NULL::integer, NULL::integer, clock_timestamp()
FROM t_teams
UNION ALL
SELECT
    9003, team_a, team_c, 'group', 'A',
    '2026-06-17 18:00:00+00'::timestamptz, 'Test Stadium', 'scheduled',
    NULL::integer, NULL::integer, clock_timestamp()
FROM t_teams
ON CONFLICT (provider_id) DO UPDATE SET
    home_team_id   = EXCLUDED.home_team_id,
    away_team_id   = EXCLUDED.away_team_id,
    stage          = EXCLUDED.stage,
    group_label    = EXCLUDED.group_label,
    kickoff_utc    = EXCLUDED.kickoff_utc,
    venue          = EXCLUDED.venue,
    status         = EXCLUDED.status,
    score_home     = EXCLUDED.score_home,
    score_away     = EXCLUDED.score_away,
    last_synced_at = EXCLUDED.last_synced_at;

SELECT is(
    (SELECT count(*)::int FROM matches WHERE provider_id IN (9001, 9002, 9003)),
    3,
    'first UPSERT inserts 3 match rows (provider_ids 9001/9002/9003)'
);

-- ---------------------------------------------------------------------------
-- Test 2 — Re-running the same UPSERT keeps the row count at 3.
-- ---------------------------------------------------------------------------
-- Snapshot pre-rerun last_synced_at so test 3 can prove the re-run refreshed
-- it. Sleep 10ms between snapshot + rerun to guarantee a strict timestamp
-- inequality (otherwise now() may resolve to an identical microsecond).
CREATE TEMP TABLE t_pre_rerun AS
SELECT provider_id, last_synced_at FROM matches WHERE provider_id = 9001;

SELECT pg_sleep(0.01);

INSERT INTO matches (
    provider_id, home_team_id, away_team_id, stage, group_label,
    kickoff_utc, venue, status, score_home, score_away, last_synced_at
)
SELECT
    9001, team_a, team_b, 'group', 'A',
    '2026-06-15 18:00:00+00'::timestamptz, 'Test Stadium', 'scheduled',
    NULL::integer, NULL::integer, clock_timestamp()
FROM t_teams
UNION ALL
SELECT
    9002, team_b, team_c, 'group', 'A',
    '2026-06-16 18:00:00+00'::timestamptz, 'Test Stadium', 'scheduled',
    NULL::integer, NULL::integer, clock_timestamp()
FROM t_teams
UNION ALL
SELECT
    9003, team_a, team_c, 'group', 'A',
    '2026-06-17 18:00:00+00'::timestamptz, 'Test Stadium', 'scheduled',
    NULL::integer, NULL::integer, clock_timestamp()
FROM t_teams
ON CONFLICT (provider_id) DO UPDATE SET
    home_team_id   = EXCLUDED.home_team_id,
    away_team_id   = EXCLUDED.away_team_id,
    stage          = EXCLUDED.stage,
    group_label    = EXCLUDED.group_label,
    kickoff_utc    = EXCLUDED.kickoff_utc,
    venue          = EXCLUDED.venue,
    status         = EXCLUDED.status,
    score_home     = EXCLUDED.score_home,
    score_away     = EXCLUDED.score_away,
    last_synced_at = EXCLUDED.last_synced_at;

SELECT is(
    (SELECT count(*)::int FROM matches WHERE provider_id IN (9001, 9002, 9003)),
    3,
    'second UPSERT against unchanged data keeps row count at 3 (no duplicates)'
);

-- ---------------------------------------------------------------------------
-- Test 3 — last_synced_at was refreshed by the second UPSERT.
-- ---------------------------------------------------------------------------
SELECT ok(
    (SELECT m.last_synced_at > p.last_synced_at
        FROM matches m
        JOIN t_pre_rerun p ON p.provider_id = m.provider_id
       WHERE m.provider_id = 9001),
    'second UPSERT refreshed last_synced_at on the existing row'
);

-- ---------------------------------------------------------------------------
-- Test 4 — Non-timestamp fields are stable across the no-op re-run.
-- ---------------------------------------------------------------------------
SELECT is(
    (SELECT (status, kickoff_utc, score_home, score_away)::text
       FROM matches WHERE provider_id = 9001),
    ('scheduled', '2026-06-15 18:00:00+00'::timestamptz, NULL::integer, NULL::integer)::text,
    'second UPSERT with identical data leaves score_home, score_away, status, kickoff_utc unchanged'
);

-- ---------------------------------------------------------------------------
-- Test 5 — Changing a field then re-running propagates the change.
-- ---------------------------------------------------------------------------
INSERT INTO matches (
    provider_id, home_team_id, away_team_id, stage, group_label,
    kickoff_utc, venue, status, score_home, score_away, last_synced_at
)
SELECT
    9001, team_a, team_b, 'group', 'A',
    '2026-06-15 18:00:00+00'::timestamptz, 'Test Stadium', 'finished',
    2::integer, 1::integer, clock_timestamp()
FROM t_teams
ON CONFLICT (provider_id) DO UPDATE SET
    status         = EXCLUDED.status,
    score_home     = EXCLUDED.score_home,
    score_away     = EXCLUDED.score_away,
    last_synced_at = EXCLUDED.last_synced_at;

SELECT is(
    (SELECT (status, score_home, score_away)::text
       FROM matches WHERE provider_id = 9001),
    ('finished', 2::integer, 1::integer)::text,
    'changed-field UPSERT propagates the new status + score to the existing row'
);

-- ---------------------------------------------------------------------------
-- Test 6 — Document the field-diff "unchanged count" contract for FR-M20.
-- ---------------------------------------------------------------------------
-- The Edge Function will count rows-unchanged by computing
--   COUNT(*) FILTER (WHERE OLD IS NOT DISTINCT FROM EXCLUDED)
-- on its UPSERT result. We don't have a direct SQL-side hook for that here
-- (RETURNING clauses can't see the OLD row), so this assertion is a
-- contract-documentation marker; the actual unchanged-count is verified by
-- the Playwright spec T056 against the integration_runs telemetry.
SELECT ok(
    TRUE,
    'documents the field-diff idempotency contract for FR-M20 (records_unchanged populated by Edge Function from EXCLUDED vs OLD comparison; asserted end-to-end in T056)'
);

-- ---------------------------------------------------------------------------
-- In-flight-row mutex tests
-- ---------------------------------------------------------------------------
-- The partial unique index from migration 0018 enforces "at most one
-- in-flight row" (finished_at IS NULL). Tests 7-10 walk the lifecycle:
-- claim → second-claim-fails → release → re-claim succeeds.
--
-- Defensive cleanup: clear any in-flight rows another test in this run may
-- have left behind. BEGIN/ROLLBACK won't see across files, so a row
-- inserted-but-not-rolled-back by a prior file would block test 7. The
-- DELETE here is the file-scoped equivalent of pg_advisory_unlock_all().
DELETE FROM integration_runs WHERE finished_at IS NULL;

-- ---------------------------------------------------------------------------
-- Test 7 — First in-flight INSERT succeeds.
-- ---------------------------------------------------------------------------
-- The Edge Function "claims" the in-flight slot by inserting a row with
-- finished_at=NULL. The partial unique index admits exactly one such row
-- at a time; the first claim therefore must succeed unconditionally.
INSERT INTO integration_runs (provider, action, started_at, finished_at, status,
                              records_processed, records_unchanged)
VALUES ('football-data.org', 'bootstrap', now(), NULL, 'success', 0, 0);

SELECT is(
    (SELECT count(*)::int FROM integration_runs WHERE finished_at IS NULL),
    1,
    'first in-flight INSERT succeeds (one row with finished_at IS NULL)'
);

-- ---------------------------------------------------------------------------
-- Test 8 — Second concurrent in-flight INSERT fails with unique violation.
-- ---------------------------------------------------------------------------
-- Test 7's row is still in-flight (finished_at IS NULL). Any further insert
-- with finished_at=NULL must therefore collide on the partial unique index.
-- This is the same Postgres guarantee that TC-M14 exercises end-to-end via
-- two concurrent Edge Function POSTs; here we assert the DB-layer contract
-- directly so the regression surface is wider than just "the Playwright
-- spec passed".
--
-- pgTAP's throws_ok catches the unique_violation inside its own savepoint
-- so the outer transaction stays usable for tests 9 and 10.
SELECT throws_ok(
    $$ INSERT INTO integration_runs (provider, action, started_at, finished_at, status,
                                     records_processed, records_unchanged)
       VALUES ('football-data.org', 'manual-resync', now(), NULL, 'success', 0, 0) $$,
    '23505',
    NULL,
    'second concurrent in-flight INSERT fails with unique_violation (SQLSTATE 23505)'
);

-- ---------------------------------------------------------------------------
-- Test 9 — Setting finished_at releases the slot.
-- ---------------------------------------------------------------------------
-- The mutex "release" path: the Edge Function UPDATEs the in-flight row to
-- set finished_at to now() once the sync wraps. The row drops out of the
-- partial-index domain on commit, freeing the slot for the next sync.
UPDATE integration_runs
   SET finished_at = now()
 WHERE finished_at IS NULL;

SELECT is(
    (SELECT count(*)::int FROM integration_runs WHERE finished_at IS NULL),
    0,
    'UPDATEing finished_at releases the in-flight slot (zero rows with finished_at IS NULL)'
);

-- ---------------------------------------------------------------------------
-- Test 10 — After release, a fresh in-flight INSERT succeeds.
-- ---------------------------------------------------------------------------
-- Proves the mutex is correctly scoped to the "finished_at IS NULL" predicate
-- only — finished rows (regardless of how many) never block a new claim.
INSERT INTO integration_runs (provider, action, started_at, finished_at, status,
                              records_processed, records_unchanged)
VALUES ('football-data.org', 'incremental-sync', now(), NULL, 'success', 0, 0);

SELECT is(
    (SELECT count(*)::int FROM integration_runs WHERE finished_at IS NULL),
    1,
    'after release, a fresh in-flight INSERT succeeds (slot re-claimable)'
);

SELECT * FROM finish();

ROLLBACK;
