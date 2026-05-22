-- Migration: replace advisory-lock concurrency with a row-based mutex
-- (feature 002, T053 follow-up)
--
-- BACKGROUND
-- ----------
-- Migration 0015 introduced `acquire_match_sync_lock()` /
-- `release_match_sync_lock()` RPCs that wrap Postgres advisory locks
-- (`pg_try_advisory_lock(hashtext('match-catalog-sync'))`). The advisory
-- lock is SESSION-scoped, but the supabase-js client invokes each RPC over
-- a separate PostgREST HTTP request. PostgREST closes its DB session as
-- soon as the function returns, releasing the advisory lock immediately —
-- so the lock never spans the actual sync work, which lives in subsequent
-- HTTP calls from the Edge Function (INSERT integration_runs, UPSERT
-- matches + teams, UPDATE integration_runs).
--
-- TC-M14 caught this: two concurrent `manual-resync` POSTs both observed
-- the advisory lock as free at acquisition time and both completed the
-- sync end-to-end. The advisory lock did not serialise them.
--
-- FIX
-- ----
-- Use a Postgres-enforced row-based mutex: a partial UNIQUE index over
-- `integration_runs` that allows at most one row with `finished_at IS
-- NULL` (an "in-flight" run). The Edge Function tries to INSERT its
-- in-flight row directly; on unique-violation (SQLSTATE 23505) it knows
-- another sync is running, writes a `status='skipped'` row, and returns
-- without touching `matches`. The constraint is held for the lifetime of
-- the in-flight row (microseconds across all of the Edge Function's HTTP
-- calls), so the concurrency guarantee is exact rather than best-effort.
--
-- Tradeoff vs advisory locks: an in-flight row that gets stuck (Edge
-- Function crashes between INSERT and the final UPDATE) leaves a permanent
-- "in-flight" record that blocks subsequent runs. Mitigation: an admin
-- runbook step "delete rows where finished_at IS NULL AND started_at < now() - interval '1 hour'"
-- handles cleanup. The advisory-lock version had the same hazard with
-- different semantics (the lock was tied to whichever DB session happened
-- to call the RPC, which is itself non-deterministic), so this is a
-- strictly clearer model.
--
-- The two RPCs from migration 0015 are dropped — they no longer have a
-- caller and leaving dead RPCs around invites future drift.

-- ---------------------------------------------------------------------------
-- Partial unique index — at most one in-flight (finished_at IS NULL) row.
-- ---------------------------------------------------------------------------
-- `((1))` is the canonical "constant expression" trick: every row in the
-- partial set has the same key (the literal 1), so any attempt to insert
-- a second row into the set (i.e. with finished_at IS NULL) violates the
-- index. The expression must be parenthesised; bare `(1)` is a column
-- reference in Postgres index syntax.
CREATE UNIQUE INDEX integration_runs_at_most_one_in_flight
    ON integration_runs ((1))
    WHERE finished_at IS NULL;

-- ---------------------------------------------------------------------------
-- Drop the now-unused advisory-lock RPCs from migration 0015.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS acquire_match_sync_lock();
DROP FUNCTION IF EXISTS release_match_sync_lock();
