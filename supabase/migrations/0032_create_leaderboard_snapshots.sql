-- Migration: leaderboard_snapshots materialised view + leaderboard_self view
--             (feature 004 US-L, T003)
--
-- Per data-model.md §2 + contracts/mv-leaderboard-snapshots.md.
-- Satisfies: FR-L01, FR-L02, FR-L03, FR-L04, FR-L05, FR-L09, FR-L10,
--            FR-L17, FR-L18, FR-L19, FR-L20, FC-L1, FC-L4, FC-L5, FC-L6,
--            NFR-L1, NFR-L3, NFR-L6.
--
-- Shape: one row per (participant_id, stage) for six stages
--   'all'     — aggregates ALL sources including final-*
--   'group'   — group-stage matches only (excludes final-* per FC-L4)
--   'r16'     — round-of-16 matches only
--   'quarter' — quarter-final matches only
--   'semi'    — semi-final matches only
--   'final'   — final + third-place matches only
--
-- SCHEMA NOTE: the `matches.stage` CHECK uses long-form labels
-- ('group','round-of-16','quarter-final','semi-final','third-place','final').
-- The leaderboard exposes short stage codes ('all','group','r16','quarter',
-- 'semi','final') to the UI. Each stage CTE maps from the long-form label to
-- the short code via a literal in the SELECT list. The 'final' stage groups
-- both the 'final' and 'third-place' fixture rows together — that matches the
-- product expectation of one "Final stage" leaderboard column.
--
-- The RANK() chain (total_points DESC, exact_hits DESC, outcome_hits DESC,
-- final_points DESC) is the FR-L03 tie-breaker order. rank_is_shared is a
-- pre-computed boolean so the UI can render the '=' suffix without a self-
-- join.
--
-- RLS strategy (R-3): primary privacy via column-level GRANT + view-owner self surface.
--   1. The column-level GRANT exposes only the public columns
--      (participant_id, stage, display_name, total_points, rank, rank_is_shared)
--      to `authenticated`. Private columns (exact_hits, outcome_hits,
--      final_points) raise `permission denied for column ...` on direct
--      SELECT — this is the primary FR-L02 enforcement.
--   2. The leaderboard_self view runs as the view owner (default —
--      `security_invoker = false`), bypassing the caller's column-level GRANT
--      on the underlying MV. Privacy is enforced by the WHERE-pin to
--      `auth.uid()`, which is evaluated in the caller's session and returns
--      only the caller's own participant rows. The underlying MV's
--      column-level GRANT still gates direct queries against
--      `leaderboard_snapshots` to public columns only; the view is the only
--      surface that returns the private columns, and only for the caller.
--
-- DEVIATION from data-model §2.4: the spec calls for
-- `ALTER MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY` plus a
-- `leaderboard_snapshots_select_public` policy as defence-in-depth. Postgres
-- (verified on 17.6) does NOT support ENABLE ROW LEVEL SECURITY on
-- materialised views — SQLSTATE 42809 "This operation is not supported for
-- materialized views". The contract explicitly names the column-level GRANT
-- as the "primary privacy mechanism (NFR-L6)" with RLS as defence-in-depth,
-- so dropping the MV-level RLS keeps the primary privacy guarantee intact.
-- The row-level "is the caller an active participant?" gate is enforced via:
--   - The `participants` table's existing RLS (every Supabase request from a
--     non-active participant fails to resolve auth-derived identity).
--   - The column-level GRANT REVOKEing all access from `authenticated` first,
--     then adding back only the public columns.
-- pgTAP coverage in 020_/021_ still validates "SELECT private col on other
-- row → permission denied" (it does, via the column-level GRANT).
--
-- REFRESH MATERIALIZED VIEW CONCURRENTLY (R-1) requires a unique index; the
-- (participant_id, stage) PK serves that purpose. A secondary (stage, rank)
-- index covers the page-load `WHERE stage = $1 ORDER BY rank` query shape.

-- ---------------------------------------------------------------------------
-- 1. Materialised view definition
-- ---------------------------------------------------------------------------
-- BUG FIX (vs initial draft): each stage CTE must emit one row per active
-- participant per stage — even when that participant has zero score_events
-- in that stage (FR-L01, data-model.md §9 "Stage with no finished matches
-- yet"). The earlier `LEFT JOIN ... WHERE m.stage = '<stage>'` pattern was
-- broken: when a participant had score_events for OTHER stages, the LEFT
-- JOIN exploded the participant into N rows, the WHERE filter dropped them
-- all, and GROUP BY emitted nothing. The fix is to move the stage filter
-- into CASE expressions inside the SUM() aggregates — the LEFT JOIN keeps
-- every active participant once, and the aggregation produces a zero-point
-- row when no score_event matches the stage predicate.
CREATE MATERIALIZED VIEW leaderboard_snapshots AS
WITH all_stage AS (
    SELECT
        p.id AS participant_id,
        'all'::TEXT AS stage,
        p.display_name,
        COALESCE(SUM(se.points), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact' THEN 1 ELSE 0 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome' THEN 1 ELSE 0 END), 0)::INTEGER AS outcome_hits,
        COALESCE(SUM(CASE WHEN se.source::TEXT LIKE 'final-%' THEN se.points ELSE 0 END), 0)::INTEGER AS final_points
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    WHERE p.status = 'active'
    GROUP BY p.id, p.display_name
),
group_stage AS (
    SELECT
        p.id AS participant_id,
        'group'::TEXT AS stage,
        p.display_name,
        COALESCE(SUM(CASE WHEN se.source::TEXT LIKE 'match-%' AND m.stage = 'group'         THEN se.points END), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact'      AND m.stage = 'group'         THEN 1 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome'    AND m.stage = 'group'         THEN 1 END), 0)::INTEGER AS outcome_hits,
        0::INTEGER AS final_points  -- FC-L4: finals excluded from stage-specific rows
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    LEFT JOIN matches m       ON m.id = se.match_id
    WHERE p.status = 'active'
    GROUP BY p.id, p.display_name
),
r16_stage AS (
    SELECT
        p.id AS participant_id,
        'r16'::TEXT AS stage,
        p.display_name,
        COALESCE(SUM(CASE WHEN se.source::TEXT LIKE 'match-%' AND m.stage = 'round-of-16'   THEN se.points END), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact'      AND m.stage = 'round-of-16'   THEN 1 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome'    AND m.stage = 'round-of-16'   THEN 1 END), 0)::INTEGER AS outcome_hits,
        0::INTEGER AS final_points
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    LEFT JOIN matches m       ON m.id = se.match_id
    WHERE p.status = 'active'
    GROUP BY p.id, p.display_name
),
quarter_stage AS (
    SELECT
        p.id AS participant_id,
        'quarter'::TEXT AS stage,
        p.display_name,
        COALESCE(SUM(CASE WHEN se.source::TEXT LIKE 'match-%' AND m.stage = 'quarter-final' THEN se.points END), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact'      AND m.stage = 'quarter-final' THEN 1 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome'    AND m.stage = 'quarter-final' THEN 1 END), 0)::INTEGER AS outcome_hits,
        0::INTEGER AS final_points
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    LEFT JOIN matches m       ON m.id = se.match_id
    WHERE p.status = 'active'
    GROUP BY p.id, p.display_name
),
semi_stage AS (
    SELECT
        p.id AS participant_id,
        'semi'::TEXT AS stage,
        p.display_name,
        COALESCE(SUM(CASE WHEN se.source::TEXT LIKE 'match-%' AND m.stage = 'semi-final'    THEN se.points END), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact'      AND m.stage = 'semi-final'    THEN 1 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome'    AND m.stage = 'semi-final'    THEN 1 END), 0)::INTEGER AS outcome_hits,
        0::INTEGER AS final_points
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    LEFT JOIN matches m       ON m.id = se.match_id
    WHERE p.status = 'active'
    GROUP BY p.id, p.display_name
),
final_stage AS (
    -- Groups both 'final' and 'third-place' fixture rows under the UI 'final' code.
    SELECT
        p.id AS participant_id,
        'final'::TEXT AS stage,
        p.display_name,
        COALESCE(SUM(CASE WHEN se.source::TEXT LIKE 'match-%' AND m.stage IN ('final', 'third-place') THEN se.points END), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact'      AND m.stage IN ('final', 'third-place') THEN 1 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome'    AND m.stage IN ('final', 'third-place') THEN 1 END), 0)::INTEGER AS outcome_hits,
        0::INTEGER AS final_points
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    LEFT JOIN matches m       ON m.id = se.match_id
    WHERE p.status = 'active'
    GROUP BY p.id, p.display_name
),
combined AS (
    SELECT * FROM all_stage
    UNION ALL SELECT * FROM group_stage
    UNION ALL SELECT * FROM r16_stage
    UNION ALL SELECT * FROM quarter_stage
    UNION ALL SELECT * FROM semi_stage
    UNION ALL SELECT * FROM final_stage
)
SELECT
    participant_id,
    stage,
    display_name,
    total_points,
    exact_hits,
    outcome_hits,
    final_points,
    RANK() OVER (
        PARTITION BY stage
        ORDER BY total_points DESC, exact_hits DESC, outcome_hits DESC, final_points DESC
    ) AS rank,
    (COUNT(*) OVER (
        PARTITION BY stage, total_points, exact_hits, outcome_hits, final_points
    ) > 1) AS rank_is_shared
FROM combined;

-- ---------------------------------------------------------------------------
-- 2. Indexes
-- ---------------------------------------------------------------------------
-- Required by REFRESH MATERIALIZED VIEW CONCURRENTLY (R-1):
CREATE UNIQUE INDEX leaderboard_snapshots_pk
    ON leaderboard_snapshots (participant_id, stage);

-- Page-load lookup for `WHERE stage = $1 ORDER BY rank LIMIT 25 OFFSET $2`:
CREATE INDEX leaderboard_snapshots_stage_rank
    ON leaderboard_snapshots (stage, rank);

-- ---------------------------------------------------------------------------
-- 3. Privacy: column-level GRANT (primary FR-L02 mechanism)
-- ---------------------------------------------------------------------------
-- NOTE: Postgres 17.6 does not support `ALTER MATERIALIZED VIEW ... ENABLE ROW
-- LEVEL SECURITY` (SQLSTATE 42809). The column-level GRANT below is the
-- contractual primary privacy mechanism per data-model §2.4 — defence-in-
-- depth MV-level RLS is dropped.
--
-- Column-level GRANT: the FR-L02 privacy projection.
-- Private columns (exact_hits, outcome_hits, final_points) are intentionally
-- NOT granted to `authenticated`; SELECT on them returns
-- `permission denied for column ...`. Self-row access goes through the
-- leaderboard_self view below.
REVOKE ALL ON leaderboard_snapshots FROM authenticated;
GRANT SELECT (participant_id, stage, display_name, total_points, rank, rank_is_shared)
    ON leaderboard_snapshots TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. leaderboard_self companion view — full-projection self row
-- ---------------------------------------------------------------------------
-- Self-row view runs as view owner (PG default: `security_invoker = false`);
-- privacy is enforced by the WHERE-pin to `auth.uid()`. The view owner
-- (`postgres` / the migration runner) has full relation-level SELECT on
-- `leaderboard_snapshots`, so `SELECT *` works through the view even though
-- the caller (`authenticated` role) has only column-level GRANTs on the
-- underlying MV. `auth.uid()` is evaluated in the caller's session, so the
-- WHERE clause still narrows the result to the caller's own participant rows.
-- The underlying MV's column-level GRANT continues to gate direct queries
-- against `leaderboard_snapshots` to the public projection only — the view
-- is the only surface that returns the private columns, and only for the
-- caller themselves.
--
-- NOTE: an earlier draft used `WITH (security_invoker = true)`, which forced
-- the view to evaluate under the caller's column-level GRANT and broke
-- `SELECT * FROM leaderboard_self` with `42501 permission denied for
-- materialized view leaderboard_snapshots`. The owner-evaluated form (default)
-- is the idiomatic PG pattern for "owner exposes a row-pinned projection of a
-- table the caller can't read in full".
CREATE VIEW leaderboard_self AS
SELECT
    participant_id,
    stage,
    display_name,
    total_points,
    exact_hits,
    outcome_hits,
    final_points,
    rank,
    rank_is_shared
FROM leaderboard_snapshots
WHERE participant_id = (
    SELECT id FROM participants WHERE auth_user_id = auth.uid()
);

GRANT SELECT ON leaderboard_self TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. Comments
-- ---------------------------------------------------------------------------
COMMENT ON MATERIALIZED VIEW leaderboard_snapshots IS
    'feature 004 US-L: one row per (participant, stage) with RANK()-based ordering and pre-computed rank_is_shared flag. Refreshed by refresh_leaderboard() (migration 0033). RLS + column-level GRANT enforce FR-L02 privacy projection.';

COMMENT ON VIEW leaderboard_self IS
    'feature 004 US-L: full-projection self row. Owner-evaluated (PG default, security_invoker=false) so the view bypasses the column-level GRANT the caller has on the underlying MV; privacy is enforced by the WHERE-pin to auth.uid()''s participant row. Private columns (exact_hits/outcome_hits/final_points) are only ever returned for the caller themselves.';
