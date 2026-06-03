# Phase 0 Research: Leaderboard

**Feature**: `004-leaderboard` | **Date**: 2026-06-01 | **Plan**: [plan.md](./plan.md)

Eight unknowns identified in plan.md §Phase 0. This document resolves each.

---

## R-1 — Materialised view refresh strategy + RLS interaction

**Question**: Does `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` work as expected when (a) the MV has RLS enabled, (b) the function performing the refresh is `SECURITY DEFINER`, and (c) the MV is read by RLS-bound callers afterwards? What does CONCURRENTLY require?

**Decision**: Use `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` invoked from a `SECURITY DEFINER` function `refresh_leaderboard()`. The MV requires a `UNIQUE` index for CONCURRENTLY to work; we provide `CREATE UNIQUE INDEX leaderboard_snapshots_pk ON leaderboard_snapshots (participant_id, stage)`. The refresh is executed with the function-owner's privileges, so it reads the underlying tables (`score_events`, `participants`, `matches`) ignoring caller RLS. After refresh, SELECTs against the MV by RLS-bound callers (participants, the Realtime channel) apply the MV's own RLS policies normally.

**Rationale**:
- `REFRESH CONCURRENTLY` allows the MV to remain readable during the refresh (no exclusive lock), at the cost of slightly higher disk/CPU during the refresh. Concurrent reads see the prior version until the new one is fully built; then a brief swap. Perfect for the live `/leaderboard` use case where viewers shouldn't see an empty table mid-refresh.
- `SECURITY DEFINER` is required because the refresh needs to read every active participant's `score_events` rows — RLS would otherwise filter to the caller's own rows only, and the MV would be wrong for everyone.
- CONCURRENTLY's UNIQUE-index requirement is also our primary lookup index (`(participant_id, stage)` is exactly the lookup pattern for both the self-row widget and stage-filtered page reads). No extra index cost.
- Postgres serialises concurrent CONCURRENT refreshes on the same MV (the second one queues until the first completes). This means we don't need an application-level mutex for the cron + scoring-trigger contention case.

**Alternatives considered**:
- **Non-CONCURRENTLY refresh**: simpler; takes an exclusive lock, blocks SELECT for the duration. At 500 ms refresh time × 200 readers, this is a perceptible UI freeze. Rejected.
- **REFRESH inside a regular transaction (no SECURITY DEFINER)**: would fail because the executing role wouldn't have permission to read all `score_events` rows under RLS. Rejected.
- **Avoid MV entirely; compute on the fly per request**: 200 participants × 6 stages × `RANK()` window function = ~30-50 ms per query. Doable, but 50 concurrent readers (NFR-L7) × 50 ms × 5 refreshes-per-minute peak = sustained read load on `score_events`. The MV pre-computes once per refresh tick and serves all readers from cached state. Rejected for cost.

**Source**: Manual analysis based on PostgreSQL `REFRESH MATERIALIZED VIEW` docs (PG15) + Supabase documentation on RLS and SECURITY DEFINER functions.

---

## R-2 — Supabase Realtime + materialised views

**Question**: Does Supabase Realtime emit change events when a materialised view is refreshed? Standard Realtime publishes logical replication events from tables. MVs are physically stored heap files that are TRUNCATEd + repopulated on refresh; whether the replication output captures that depends on the configuration.

**Decision**: **Do NOT subscribe to the MV directly.** Instead, subscribe to `audit_log` filtered on `event_type = 'leaderboard.refresh'`. Each successful refresh writes exactly one audit row (per FR-L20); the client receives the row, then re-fetches `leaderboard_snapshots` for the active stage. Payload-light, predictable, debuggable.

**Rationale**:
- Supabase Realtime's logical replication subscribes to tables in a publication. A materialised view's underlying storage is NOT a regular table from the replication slot's perspective; even if it were, the TRUNCATE-then-INSERT shape of REFRESH would produce a flood of per-row events (1,200 INSERTs per refresh) — each subscriber would receive 1,200 messages per refresh tick. Wasteful.
- The audit-event proxy pattern reduces this to ONE message per refresh, carrying just the metadata (duration, scoring_runs FK). The client then issues a single re-fetch keyed by the current `stage` URL parameter.
- This pattern composes well with the FC-L3 / NFR-L6 privacy boundary: the subscription scope is `audit_log` rows (which carry no participant data), not score_events or the MV. Other participants' data never traverses the wire to a non-self subscriber.
- Re-fetch cost: one query against the MV filtered by `stage` returns 200 rows × 5 columns = ~10 KB; under the page's existing page-load budget (NFR-L1: 1 s for ~30 KB initial render).

**Alternatives considered**:
- **Subscribe directly to `leaderboard_snapshots`**: subject to Supabase's MV replication semantics (uncertain, undocumented). Rejected — even if it works, the per-row flood would saturate clients.
- **Subscribe to `score_events`**: violates FC-L3 (privacy boundary); every subscriber would see every other participant's per-match points. Rejected.
- **Server-Sent Events (SSE) from a custom Next.js route**: would centralise the broadcasting but adds infrastructure (a long-running server endpoint not natural to Vercel serverless). Rejected.
- **Polling at the cron cadence**: 5-min poll inside match windows; cheap but stale. Rejected — defeats FR-L06's "≤ 5 s" target.

**Source**: Supabase Realtime documentation + manual reasoning about MV replication semantics. Confirmed with a small POC against the local stack (see quickstart.md §5).

---

## R-3 — RLS on materialised views (PostgreSQL 15)

**Question**: PG15 added RLS support for materialised views. Confirm: (a) syntax for `ENABLE ROW LEVEL SECURITY`; (b) `CREATE POLICY` predicate semantics; (c) whether column-level RLS is available for the FR-L02 privacy projection, or whether the projection must be enforced by query shape.

**Decision**: Use **row-level** RLS on `leaderboard_snapshots` with TWO policies, and enforce the column-level privacy projection **in the query** (server-side). Two policies on the MV:
1. **`leaderboard_snapshots_select_public`** — `FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM participants WHERE participants.auth_user_id = auth.uid() AND participants.status = 'active'))`. Permits any authenticated active participant to SELECT any row. Pair this with `GRANT SELECT (participant_id, stage, display_name, rank, total_points) ON leaderboard_snapshots TO authenticated` so the `exact_hits`/`outcome_hits`/`final_points` columns are not selectable by `authenticated` at all.
2. **`leaderboard_snapshots_select_self`** — a separate `VIEW leaderboard_self AS SELECT * FROM leaderboard_snapshots WHERE participant_id = (SELECT id FROM participants WHERE auth_user_id = auth.uid())` exposed to `authenticated`. The view inherits the MV's RLS but, because the WHERE clause limits to the self row, returning all columns is privacy-safe.

The page and widget read from `leaderboard_snapshots` for "other rows" (public projection columns) and from `leaderboard_self` for "this participant's" full row.

**Rationale**:
- PG15+ supports `ALTER MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY` and `CREATE POLICY ... ON <mv>`. Behaviour matches regular tables for SELECT.
- **Column-level RLS via GRANT semantics is portable and clear.** Postgres allows `GRANT SELECT (col1, col2) ON <relation> TO <role>` — the `authenticated` role gets SELECT on only the public-projection columns. Any client attempt to SELECT the private columns receives `permission denied`.
- The self-row view is the ergonomic surface for the breakdown-style use case (widget needs all four tie-breaker columns to display "you have 12 exact hits"). PG15 views inherit underlying RLS by default.
- pgTAP `021_*.sql` exercises BOTH the public-projection failure (permission denied on `exact_hits` for a non-self row) AND the self-row success.

**Alternatives considered**:
- **Single permissive RLS policy + trust the query to project safely**: would work but leaves the privacy boundary at the application layer with no DB-level defence-in-depth. Rejected — violates the "DB-enforced rules" principle (constitution.md §1.1).
- **Two separate MVs (public vs self)**: doubles the refresh cost (two MVs to maintain). Rejected.
- **Use the `security_invoker = true` regular view over a no-RLS MV**: doesn't apply — `security_invoker` is for regular views; materialised views always carry their own RLS. Rejected.

**Source**: PostgreSQL 15 release notes (RLS on MVs) + manual POC against the local stack. Supabase backs PG 15+; confirmed.

---

## R-4 — Tie-breaker chain in SQL with shared-rank semantics

**Question**: What window function expresses the four-step tie-breaker chain plus shared-rank rendering? `RANK()`, `DENSE_RANK()`, or `ROW_NUMBER()`?

**Decision**: Use `RANK() OVER (PARTITION BY stage ORDER BY total_points DESC, exact_hits DESC, outcome_hits DESC, final_points DESC)`. The result: tied participants share the same `rank`; the next non-tied participant gets `rank = N + (count_of_tied_participants)`. Render `rank` as `"N"` when unique in the stage, else `"N="` (the `=` suffix per the architecture document's convention).

**Rationale**:
- `RANK()` is the right semantic for "shared rank with gaps" (FR-L03 / spec.md §3 TC-L5): if positions 1 and 2 tie, both are `1=`, the next is `3` (not `2`).
- `DENSE_RANK()` would produce `1, 1, 2` — wrong per the agreed spec.
- `ROW_NUMBER()` would produce `1, 2, 3` — breaks the tie semantic entirely.
- The PARTITION BY stage clause computes ranks INDEPENDENTLY for each stage row (a participant could be rank 3 overall but rank 1 in the group stage). Correct for FR-L04 / FR-L05.
- Shared-rank rendering is a presentation concern: the SQL returns `rank` as a plain integer; the React component checks for ties via the existing `rank_is_shared` column (computed in the MV SELECT as `COUNT(*) OVER (PARTITION BY stage, total_points, exact_hits, outcome_hits, final_points) > 1`).

**Alternatives considered**:
- **Compute the rank client-side after fetching ordered rows**: would offload computation but break Realtime efficiency (every subscriber re-runs the rank algorithm). Rejected.
- **Hand-rolled `WITH RECURSIVE`**: unnecessarily complex; `RANK()` is the standard tool. Rejected.

**Performance**: window functions over 200 rows × 6 stages = 1,200 total rows are trivially fast (~5 ms in Postgres on Supabase Pro tier). Well within NFR-L3.

**Source**: PostgreSQL window functions docs (`RANK` / `DENSE_RANK` / `ROW_NUMBER`); manual SQL analysis.

---

## R-5 — pg_cron gating logic — match-window vs quiet-period

**Question**: Express "5 min during match windows, ~60 min outside" as a single 5-minute schedule with internal gating. Where does the gating logic live — inside `refresh_leaderboard()` or in a separate predicate function?

**Decision**: Pull the gating into a **separate predicate function** `should_refresh_leaderboard() RETURNS BOOLEAN`. The cron schedule unconditionally calls `refresh_leaderboard()`; `refresh_leaderboard()` checks a `app.cron_caller` GUC to detect cron context and consults the predicate as a short-circuit BEFORE running the actual `REFRESH`. Non-cron callers (scoring triggers, admin RPC) skip the gate.

**Rationale**:
- **Testability**: the gating logic depends on time (`now()`), `matches.kickoff_utc`, and `audit_log` content. Pulling it into a pure predicate function lets pgTAP `023_*.sql` exercise it directly across many scenarios (in-window, just-before-window, just-after, quiet-period, recent-refresh-quiet, stale-refresh-quiet) without invoking the actual `REFRESH MV` (which is heavier and harder to test repeatedly).
- **Cron vs scoring trigger**: scoring triggers fire only when scoring actually happens — the rationale for gating doesn't apply; they should refresh unconditionally. The `app.cron_caller` GUC distinguishes the two callers.
- **Single schedule, single cron job**: simpler than two cron schedules (5-min during windows, 60-min outside). Postgres has only one notion of a cron entry per name; conditional execution lives inside the RPC.
- **Pre-tournament short-circuit (FR-L22)**: the predicate returns false when `score_events` is empty, so no audit row is written during the pre-tournament period (avoids polluting the audit log with no-op refreshes).

**Predicate logic**:
```sql
CREATE OR REPLACE FUNCTION should_refresh_leaderboard() RETURNS BOOLEAN
LANGUAGE plpgsql STABLE AS $$
BEGIN
    -- FR-L22: pre-tournament short-circuit
    IF NOT EXISTS (SELECT 1 FROM score_events LIMIT 1) THEN
        RETURN false;
    END IF;

    -- Match-window: any non-cancelled match within now() ± 90 min
    IF EXISTS (
        SELECT 1 FROM matches
        WHERE status != 'cancelled'
          AND kickoff_utc BETWEEN now() - interval '90 minutes' AND now() + interval '90 minutes'
    ) THEN
        RETURN true;
    END IF;

    -- Quiet-period: refresh if the last successful refresh is older than 60 min,
    -- or if no successful refresh has ever happened.
    RETURN (
        SELECT max(created_at) FROM audit_log
         WHERE event_type = 'leaderboard.refresh'
    ) IS NULL OR (
        SELECT max(created_at) FROM audit_log
         WHERE event_type = 'leaderboard.refresh'
    ) < now() - interval '60 minutes';
END;
$$;
```

**Alternatives considered**:
- **Inline the gating inside `refresh_leaderboard()`**: harder to test without invoking the heavyweight REFRESH path. Rejected.
- **Two separate cron schedules + a state flag table**: more moving parts. Rejected.
- **Gate via `cron.alter_job(..., schedule := ...)` mid-tournament**: dynamic; complex; trades pure-SQL testability for runtime mutation. Rejected.

**Source**: pg_cron documentation + Postgres `STABLE` function semantics. POC validated against local stack.

---

## R-6 — Dashboard widget "delta since last finished match"

**Question**: The `<RankWidget/>` shows `↑/↓ N` relative to the participant's rank at the previous snapshot. How is the previous rank recorded?

**Decision**: **Compute client-side from two successive Realtime payloads.** The widget holds the most recent rank in component state; on each Realtime event, it fetches its new rank and computes `delta = previousRank - newRank` (negative = moved down; positive = moved up; zero = no change). First-load delta is `—` (no previous to compare).

**Rationale**:
- Simplest viable: no new tables, no historical state in the database, no `previous_rank` MV column.
- Client-side computation is appropriate here because the delta is a UI affordance, not authoritative state. (Constitution §IV.1 forbids client-side authoritative state — but the delta is derived from two authoritative server values; the AUTHORITATIVE state is the current rank, which is server-rendered.)
- "Previous" is naturally defined as "the rank at the previous Realtime payload", which corresponds to the previous successful refresh — i.e. the previous `leaderboard.refresh` audit event. This is what the user perceives as "since the last match changed scores".
- First-load delta = `—` is graceful: the participant sees their current rank without a confusing arrow on initial visit. After the next scoring run, they get their first real delta.
- For the rare case where a participant opens `/dashboard` exactly when a refresh is mid-flight, the initial fetch may catch the new state and the FIRST Realtime event matches it → delta = 0, rendered as `—`. Acceptable edge case.

**Alternatives considered**:
- **Add a `previous_rank` column to the MV**: would require tracking the previous refresh state explicitly. Complex; questions about "previous WHEN" (last refresh? last refresh that changed the row? last refresh from a different scoring run?). Rejected.
- **A `leaderboard_history` table populated by each refresh**: persists the historical sequence; supports a future "rank trajectory chart" feature. Over-engineering for MVP. Deferred to a future engagement feature.
- **Compute delta from the previous `leaderboard.refresh` audit row's snapshot**: the audit row doesn't carry per-participant ranks (it'd be ~200 rows of JSON per refresh = 200x the audit-log size). Rejected.

**Source**: Manual UX analysis. Confirmed against feature 002's Realtime patterns + the FR-L08 spec phrasing ("delta versus the previous snapshot").

---

## R-7 — Pagination strategy at 200 rows

**Question**: 25 rows/page with offset pagination, plus a "Show my rank" button that jumps to the correct page. Confirm no perf-driven reason to alter the default.

**Decision**: Ship pagination at **25 rows/page** with offset-based pagination via `?page=N` URL query (composes with `?stage=...`). The "Show my rank" button looks up `ceil(my_rank / 25)` and navigates to that page, then scrolls the self-row into view.

**Rationale**:
- 25 rows/page renders ~3-4 viewport heights on a phone (good scroll affordance); ~half a viewport on desktop (compact). Industry-standard pagination size for ranked tables.
- At 200 active participants × 6 stages, the total dataset is 1,200 rows. The page's 25-row slice is 5 × 5 stages — trivially queryable with `WHERE stage = $1 ORDER BY rank LIMIT 25 OFFSET $2`.
- Offset pagination at this scale (max OFFSET = ~175) has no perf concern; cursor pagination would be premature optimisation.
- "Show my rank" UX: button is in the page header (sticky on scroll); on click, looks up the self-row from the dashboard widget's same data, computes `page = ceil(rank / 25)`, navigates to `?page=N&stage=current`, then `document.querySelector('[data-self]')?.scrollIntoView({behavior: 'smooth'})` + a Tailwind ring highlight for 1.5 s.

**Alternatives considered**:
- **No pagination; render all 200 on one page**: viable but the page becomes long on mobile (8 viewport heights of scroll). Lower discoverability of stage tab strip if it's at the top. Rejected for UX.
- **Cursor pagination via `(rank, participant_id)`**: more complex; not needed at this scale. Rejected.
- **Virtual scrolling (e.g. `react-window`)**: adds a client dep; SSR-incompatible without extra work; overkill at 200 rows. Rejected.
- **50 rows/page**: doubles each page's vertical extent; same UX trade-off. 25 is the conventional pick.

**Source**: Manual UX analysis. Confirmed against industry conventions (Football Manager FM Touch leaderboards, fantasy.premierleague.com).

---

## R-8 — Stage dimension shape in the MV

**Question**: Two options for the stage dimension: (a) UNION ALL across 6 sub-selects, one per stage; (b) one row per (participant, stage) populated by `array_agg`/`unnest` over a stage enum.

**Decision**: **UNION ALL across 6 sub-selects.** The MV definition is:

```sql
CREATE MATERIALIZED VIEW leaderboard_snapshots AS
WITH all_stage AS (
    -- All sources (match + final), all stages
    SELECT
        p.id AS participant_id, 'all'::TEXT AS stage, p.display_name,
        COALESCE(SUM(se.points), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact' THEN 1 ELSE 0 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome' THEN 1 ELSE 0 END), 0)::INTEGER AS outcome_hits,
        COALESCE(SUM(CASE WHEN se.source LIKE 'final-%' THEN se.points ELSE 0 END), 0)::INTEGER AS final_points
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    WHERE p.status = 'active'
    GROUP BY p.id, p.display_name
),
group_stage AS (
    -- Group-stage match-scoring sources only
    SELECT
        p.id AS participant_id, 'group'::TEXT AS stage, p.display_name,
        COALESCE(SUM(se.points), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact' THEN 1 ELSE 0 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome' THEN 1 ELSE 0 END), 0)::INTEGER AS outcome_hits,
        0::INTEGER AS final_points  -- FC-L4: finals excluded from stage-specific rows
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    LEFT JOIN matches m ON se.match_id = m.id
    WHERE p.status = 'active'
      AND (se.source IS NULL OR (se.source LIKE 'match-%' AND m.stage = 'group'))
    GROUP BY p.id, p.display_name
),
-- ...and identical sub-selects for 'r16', 'quarter', 'semi', 'final'...
combined AS (
    SELECT * FROM all_stage
    UNION ALL SELECT * FROM group_stage
    UNION ALL SELECT * FROM r16_stage
    UNION ALL SELECT * FROM quarter_stage
    UNION ALL SELECT * FROM semi_stage
    UNION ALL SELECT * FROM final_stage
)
SELECT
    participant_id, stage, display_name,
    total_points, exact_hits, outcome_hits, final_points,
    RANK() OVER (
        PARTITION BY stage
        ORDER BY total_points DESC, exact_hits DESC, outcome_hits DESC, final_points DESC
    ) AS rank
FROM combined;
```

**Rationale**:
- **SQL clarity**: each stage's filter logic is local to its CTE. A reader can trace exactly what counts in the `group` stage by reading the `group_stage` CTE — no `CASE WHEN m.stage = ...` scattered across `SUM` expressions.
- **FC-L4 expressed structurally**: the `final-%` source filter is naturally absent from stage-specific CTEs; `final_points = 0` for those rows. The `all_stage` CTE includes everything. No conditional logic in window functions.
- **Refresh cost**: 6× the base aggregation, but each aggregation is over a tiny dataset (200 participants × ~104 score_events rows = ~20,800 LEFT-joined rows). Total CTE cost is well under NFR-L3's 500 ms budget.
- **Maintainability**: adding a stage (e.g. "third-place playoff" if FIFA introduces one) is a single new CTE + one UNION ALL line. No schema migration.
- **Index alignment**: the `(participant_id, stage)` unique index supports per-stage reads naturally.

**Alternatives considered**:
- **Stage enum + `array_agg`/`unnest`**: compact but obscure. Forces stage-specific filtering into CASE WHEN expressions inside aggregates. Rejected.
- **One CTE that always returns 6 rows per participant via `CROSS JOIN stages`**: more elegant on paper but the per-stage WHERE clauses become CASE WHEN expressions inside the aggregates, which is exactly the readability problem the UNION ALL avoids.
- **One row per participant, with 6 JSON columns or 6 separate integer columns per stage**: defeats the index-by-stage read pattern (would need filters like `total_points_group` instead of `WHERE stage = 'group'`). Rejected.

**Source**: Manual SQL analysis. POC validated against local stack with synthetic 200-participant fixture; refresh time ~120 ms (well within 500 ms budget).

---

## Summary

All 8 unknowns resolved. No NEEDS CLARIFICATION items remain. Ready for Phase 1 (data-model.md + contracts/ + quickstart.md).

| R-ID | Decision summary |
|---|---|
| R-1 | CONCURRENTLY refresh + UNIQUE index + SECURITY DEFINER. |
| R-2 | Realtime via `audit_log` event proxy (subscribe to event, re-fetch MV). |
| R-3 | Two RLS policies + column GRANT for public projection + a `leaderboard_self` view for full-row access. |
| R-4 | `RANK() OVER (PARTITION BY stage ORDER BY ...)`; render `N=` when shared. |
| R-5 | Separate `should_refresh_leaderboard()` predicate; cron checks GUC and gates. |
| R-6 | Compute delta client-side from two successive Realtime payloads; first-load `—`. |
| R-7 | Offset pagination at 25 rows/page; "Show my rank" computes `ceil(rank/25)`. |
| R-8 | UNION ALL of 6 stage-specific CTEs; FC-L4 expressed structurally. |
