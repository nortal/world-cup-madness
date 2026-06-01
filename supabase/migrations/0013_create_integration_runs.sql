-- Migration: integration_runs telemetry table (feature 002, T005, FR-M19 + FR-M23)
--
-- Records every provider catalog sync attempt — success, error, or skipped (when
-- the FR-M23 Postgres advisory lock is held by another in-flight invocation).
-- This is the operational visibility surface for the sync-matches Edge Function;
-- admins query it to answer "did the cron run?" and "why did my re-sync skip?".
--
-- BIGSERIAL (not UUID): telemetry rows are write-heavy and read by time ranges,
-- so a cheap monotonic key wins over the UUID convention used elsewhere.
--
-- error_message is dual-purpose by design:
--   - status='error'   → provider error body / exception message
--   - status='skipped' → ISO timestamp of the in-flight run's started_at, so an
--                        operator running R-7 scenario 3 ("cron tried but my
--                        re-sync was already running") can correlate to the
--                        blocking run in one query.
--   - status='success' → NULL.
-- Documented inline on the column. See specs/.../research.md §R-7 for the
-- full trigger-source × outcome matrix.
--
-- Scope of THIS migration:
--   - CREATE TABLE integration_runs with the three CHECK-bounded enums
--     (provider, action, status), BIGSERIAL PK, and two indexes that serve the
--     operator query patterns from R-7.
--
-- Out of scope (sibling migrations):
--   - RLS enable + is_admin_user() SELECT policy        -> 0016_match_rls.sql
--   - INSERT happens via service_role from the Edge Function — no authenticated
--     write policies are ever defined.
--
-- IF NOT EXISTS keeps `npx supabase db reset` idempotent during local dev.

CREATE TABLE IF NOT EXISTS integration_runs (
    -- BIGSERIAL (not UUID): write-heavy telemetry, read by timestamp ranges; a
    -- cheap monotonic key wins on both index size and insert throughput. The
    -- BIGSERIAL implicitly creates the PK index.
    id                  BIGSERIAL PRIMARY KEY,
    -- Single-value CHECK today; the constraint expands cleanly when we add a
    -- second provider (e.g. a paid-tier sport data source).
    provider            TEXT NOT NULL
                            CHECK (provider IN ('football-data.org')),
    -- Trigger source for the run; lets operators distinguish "cron fired" from
    -- "admin clicked manually" from "first-time bootstrap" in the same table.
    -- See research.md §R-7 for the operational rationale.
    action              TEXT NOT NULL
                            CHECK (action IN (
                                'bootstrap',
                                'incremental-sync',
                                'manual-resync'
                            )),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL while the run is in flight; set by the Edge Function when it writes
    -- the final telemetry row.
    finished_at         TIMESTAMPTZ NULL,
    -- 3-value status per spec §2 Session 2026-05-20 Q4 + R-7.
    status              TEXT NOT NULL
                            CHECK (status IN (
                                'success',
                                'error',
                                'skipped'
                            )),
    -- Count of matches/teams UPSERTed by this run. 0 for skipped rows.
    records_processed   INTEGER NOT NULL DEFAULT 0
                            CHECK (records_processed >= 0),
    -- Of the records_processed, how many were field-identical to existing rows
    -- (no UPDATE fired). TC-M13 asserts records_processed = records_unchanged
    -- after a no-op re-sync — that is the idempotency contract from FR-M20.
    records_unchanged   INTEGER NOT NULL DEFAULT 0
                            CHECK (records_unchanged >= 0),
    -- Dual-purpose per file header:
    --   error   → human-readable error message / provider response body
    --   skipped → ISO timestamp of the in-flight run's started_at (for triage)
    --   success → NULL
    error_message       TEXT NULL
);

-- "Show me the last 50 runs" admin queries scan by recency.
CREATE INDEX IF NOT EXISTS integration_runs_started_at_idx
    ON integration_runs (started_at DESC);

-- Composite index for R-7 scenario 3:
--   SELECT * FROM integration_runs
--     WHERE action = 'manual-resync' AND status = 'skipped'
--     ORDER BY started_at DESC;
-- Column order matches the WHERE predicate selectivity (action first because
-- the manual-resync subset is smaller than the cron subset) then status.
CREATE INDEX IF NOT EXISTS integration_runs_action_status_started_at_idx
    ON integration_runs (action, status, started_at DESC);
