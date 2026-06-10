-- Migration: read-only SECURITY DEFINER aggregator for the FR-D11 global
-- movers calculation on the dashboard `/dashboard` Pool tab (feature 005).
--
-- Spec carve-out: spec.md FC-D1 was amended on 2026-06-07 to permit this
-- single read-only function; see spec.md "Ratification" block. Pattern
-- mirrors feature 004's is_pre_tournament() helper (migration 0036).
--
-- Privacy: returns (participant_id, delta_24h) only — no PII, no display
-- names, no per-event detail. Display names are joined client-side via the
-- column-grant-gated `leaderboard_snapshots` MV.
--
-- Performance (NFR-D07): ≤ 250 ms p95 with 200 participants × ~10 events
-- each over a trailing 24 h window, served by the existing
-- `score_events_awarded_at_idx` DESC index.

CREATE OR REPLACE FUNCTION get_movers_24h_aggregate()
RETURNS TABLE (participant_id uuid, delta_24h smallint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    se.participant_id,
    COALESCE(SUM(se.points), 0)::smallint AS delta_24h
  FROM score_events se
  WHERE se.awarded_at >= NOW() - INTERVAL '24 hours'
  GROUP BY se.participant_id
$$;

REVOKE ALL ON FUNCTION get_movers_24h_aggregate() FROM PUBLIC;
-- Supabase pre-grants EXECUTE on public functions to anon by default. Strip
-- it explicitly so the contract guarantee ("Anon denied") is enforced.
REVOKE ALL ON FUNCTION get_movers_24h_aggregate() FROM anon;
GRANT EXECUTE ON FUNCTION get_movers_24h_aggregate() TO authenticated;

COMMENT ON FUNCTION get_movers_24h_aggregate() IS
  'FR-D11 / FR-D12 helper — global 24-h points delta per participant. SECURITY DEFINER so the dashboard movers widget can aggregate across participants without each one being narrowed by score_events_select_own RLS. Returns no PII. Anon denied; only authenticated may execute.';
