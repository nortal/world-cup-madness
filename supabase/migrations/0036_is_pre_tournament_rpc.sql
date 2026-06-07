-- Migration: SECURITY DEFINER helper for the LeaderboardPage's pre-tournament
-- short-circuit (feature 004 follow-up, surfaced by US-LA Playwright run).
--
-- Why this exists
-- ---------------
-- The original FR-L07 short-circuit in LeaderboardPage.tsx queries
-- `score_events` directly to count rows. That works for the admin role
-- (FC-L6 + `score_events_select_admin` policy) but FAILS for a regular
-- participant: the `score_events_select_own` policy filters every other
-- participant's events out, so a fresh participant who has not yet scored
-- always sees count = 0 — forcing the page into permanent pre-tournament
-- state.
--
-- The fix: a tiny SECURITY DEFINER function `is_pre_tournament()` that
-- bypasses RLS to give the true global state. The Server Component swaps
-- its direct query for a single RPC call.
--
-- We restrict the function to `authenticated` (so admins + participants
-- can both reach it) and document it as read-only. It returns nothing
-- beyond a boolean — no per-participant data leaks.

CREATE OR REPLACE FUNCTION is_pre_tournament()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT NOT EXISTS (SELECT 1 FROM score_events);
$$;

REVOKE ALL ON FUNCTION is_pre_tournament() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_pre_tournament() TO authenticated;

COMMENT ON FUNCTION is_pre_tournament() IS
  'FR-L07 helper — true when no score_events row exists yet. SECURITY DEFINER so participants can read the global pre-tournament flag without RLS narrowing to their own row.';
