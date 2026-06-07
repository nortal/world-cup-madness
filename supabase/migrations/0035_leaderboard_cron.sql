-- Migration: schedule the `leaderboard-refresh-tick` pg_cron job (feature 004 US-LE, T038)
--
-- Per data-model.md §7 + contracts/cron-leaderboard-refresh-tick.md.
--
-- Satisfies: FR-L21 (cron tick is a no-op when there is nothing meaningful to
--            refresh), FR-L22 (pre-tournament short-circuit), NFR-L4 (efficient
--            cron — heavy REFRESH MATERIALIZED VIEW CONCURRENTLY only fires
--            when should_refresh_leaderboard() returns true).
--
-- Design notes:
--   - The schedule body sets `app.cron_caller = 'true'` so that
--     refresh_leaderboard() (migration 0033) routes to the cron caller-kind
--     branch and consults should_refresh_leaderboard() before invoking the
--     heavy REFRESH. See refresh_leaderboard() body in 0033.
--   - pg_cron jobs run as the postgres superuser, which bypasses RLS — matching
--     the SECURITY DEFINER posture of refresh_leaderboard(). No additional
--     grants required.
--   - Cadence: every 5 min. Effective cadence: 5 min in match windows (any
--     non-cancelled match within now() ± 90 min); ~60 min in quiet periods;
--     fully skipped in pre-tournament (score_events empty).

-- ---------------------------------------------------------------------------
-- 1. Ensure pg_cron is available
-- ---------------------------------------------------------------------------
-- pg_cron is bundled with Supabase (local + Cloud Pro tier). We CREATE IF NOT
-- EXISTS here defensively — if a prior migration already enabled it, this is
-- a no-op; if not, this is the canonical enable site for the feature.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ---------------------------------------------------------------------------
-- 2. Schedule the tick
-- ---------------------------------------------------------------------------
-- The body uses `SET LOCAL` so the GUC scope is limited to the cron job's
-- transaction. pg_cron executes each job body in its own transaction, so
-- SET LOCAL here is sufficient — the GUC is set before the SELECT call and
-- automatically cleared at transaction end.
--
-- Idempotency: cron.schedule with the same jobname replaces the existing
-- schedule. So re-running this migration via `supabase db reset` is safe.
SELECT cron.schedule(
    'leaderboard-refresh-tick',
    '*/5 * * * *',
    $cron$
        SET LOCAL app.cron_caller = 'true';
        SELECT refresh_leaderboard();
    $cron$
);

COMMENT ON EXTENSION pg_cron IS
    'feature 004 US-LE: scheduling for leaderboard-refresh-tick. See migration 0035.';
