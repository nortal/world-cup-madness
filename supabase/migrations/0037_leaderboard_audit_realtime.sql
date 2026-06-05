-- Migration: surface `leaderboard.refresh` audit rows over Supabase Realtime
-- to non-admin participants (feature 004 follow-up, surfaced by TC-L4).
--
-- Why this exists
-- ---------------
-- The "Realtime over audit-event proxy" pattern (constitution-backend.md +
-- contracts/realtime-channel-leaderboard-snapshots.md) calls for every
-- authenticated participant to subscribe to `audit_log` INSERTs filtered
-- by `action=eq.leaderboard.refresh`. As shipped, two things blocked this:
--
--   1. `audit_log` was not part of the `supabase_realtime` publication, so
--      Postgres never sent the WAL events to the Realtime gateway.
--   2. The only SELECT policy on `audit_log` was `audit_log_admin_select`
--      (admin-only). Realtime suppresses delivery of rows the subscriber
--      cannot SELECT, so non-admin participants would never get the
--      broadcast even after fix (1).
--
-- The fix has two parts:
--   - Add `audit_log` to the publication (gated DO block — re-running the
--     migration is safe).
--   - Add a narrow SELECT policy that lets `authenticated` read only the
--     leaderboard refresh / refresh_failed rows. These rows carry no
--     participant data (only caller_kind + refreshed_at metadata) so the
--     broadened surface is privacy-safe per FC-L3 + NFR-L6.

-- ---------------------------------------------------------------------------
-- 1. Publication membership
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'audit_log'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE audit_log;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. SELECT policy for leaderboard refresh events
-- ---------------------------------------------------------------------------
-- Drop-then-create so the migration is idempotent.
DROP POLICY IF EXISTS audit_log_leaderboard_refresh_select ON audit_log;

CREATE POLICY audit_log_leaderboard_refresh_select
  ON audit_log
  FOR SELECT
  TO authenticated
  USING (action IN ('leaderboard.refresh', 'leaderboard.refresh_failed'));

COMMENT ON POLICY audit_log_leaderboard_refresh_select ON audit_log IS
  'Lets authenticated participants observe leaderboard refresh events via Supabase Realtime. Rows carry only caller_kind + refreshed_at metadata; no participant data (FC-L3 / NFR-L6).';
