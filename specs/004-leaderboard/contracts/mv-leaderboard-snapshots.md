# Contract: `leaderboard_snapshots` materialised view + `leaderboard_self` companion view

**Feature**: 004 | **Migration**: 0032 | **Spec**: FR-L01, FR-L02, FR-L03, FR-L04, FR-L05, FR-L11, FC-L1, FC-L4, FC-L5, FC-L6, NFR-L1, NFR-L3, NFR-L6

## Purpose

Single authoritative read surface for participant rankings. Aggregates `score_events` into one row per `(participant_id, stage)` with the tie-breaker chain computed via `RANK()`.

## Definition (summary; full SQL in `data-model.md` §2.1)

UNION ALL of 6 stage-specific CTEs (`'all'`, `'group'`, `'r16'`, `'quarter'`, `'semi'`, `'final'`) over `participants LEFT JOIN score_events`, filtered by `participants.status = 'active'`. The `'all'` CTE counts all sources including `final-*`; the stage-specific CTEs exclude `final-*` per FC-L4 and filter `match-%` rows by `matches.stage`.

`rank` is computed as `RANK() OVER (PARTITION BY stage ORDER BY total_points DESC, exact_hits DESC, outcome_hits DESC, final_points DESC)`. `rank_is_shared` is `COUNT(*) OVER (PARTITION BY stage, total_points, exact_hits, outcome_hits, final_points) > 1`.

## Columns

| Column | Type | Constraint | Visible to authenticated? |
|---|---|---|---|
| `participant_id` | UUID | NOT NULL | YES |
| `stage` | TEXT | NOT NULL, IN ('all','group','r16','quarter','semi','final') | YES |
| `display_name` | TEXT | NOT NULL | YES |
| `total_points` | INTEGER | NOT NULL | YES |
| `exact_hits` | INTEGER | NOT NULL | NO (private; self only via `leaderboard_self`) |
| `outcome_hits` | INTEGER | NOT NULL | NO (private) |
| `final_points` | INTEGER | NOT NULL | NO (private; always 0 for non-`'all'` stages per FC-L4) |
| `rank` | INTEGER | NOT NULL | YES |
| `rank_is_shared` | BOOLEAN | NOT NULL | YES |

## Indexes

- **Unique**: `(participant_id, stage)` — required by `REFRESH CONCURRENTLY` (R-1); doubles as widget lookup index.
- **Secondary**: `(stage, rank)` — page-load `WHERE stage = $1 ORDER BY rank LIMIT 25 OFFSET $2`.

## RLS

```sql
ALTER MATERIALIZED VIEW leaderboard_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY leaderboard_snapshots_select_public
  ON leaderboard_snapshots FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM participants
            WHERE auth_user_id = auth.uid() AND status = 'active')
  );

REVOKE ALL ON leaderboard_snapshots FROM authenticated;
GRANT SELECT (participant_id, stage, display_name, total_points, rank, rank_is_shared)
  ON leaderboard_snapshots TO authenticated;
```

The column-level GRANT means a query like `SELECT exact_hits FROM leaderboard_snapshots WHERE participant_id = $other` errors with `permission denied for column exact_hits` regardless of the row-level policy verdict.

## `leaderboard_self` companion view

```sql
CREATE VIEW leaderboard_self AS
  SELECT * FROM leaderboard_snapshots
  WHERE participant_id = (
    SELECT id FROM participants WHERE auth_user_id = auth.uid()
  );
GRANT SELECT ON leaderboard_self TO authenticated;
```

The view inherits the underlying MV's RLS (`security_invoker` defaults to the view owner's perspective — but since the underlying MV's RLS is row-permissive for authenticated users, the WHERE clause does the filtering work). The participant gets all columns for their own row, with no risk of column leakage because the participant_id filter restricts to a single row.

## Refresh semantics

Refreshed via `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` invoked from `refresh_leaderboard()` (see [rpc-refresh-leaderboard.md](./rpc-refresh-leaderboard.md)). Failure does NOT roll back the calling transaction (FC-L2).

## pgTAP coverage (test/pgtap/020_*.sql + 021_*.sql)

| Test | Asserts |
|---|---|
| MV row count = active participants × 6 stages | Stage dimension shape correct |
| `RANK()` produces shared ranks on tied participants | FR-L03 / TC-L5 / TC-L6 |
| `final_points = 0` for all non-`'all'` rows | FC-L4 |
| Stage-specific `total_points` excludes `final-*` source rows | FC-L4 / FR-L05 |
| Refresh with no `score_events` rows leaves MV empty | FR-L07 / FR-L22 |
| Refresh after admin recalc-all reflects new state | TC-L15 |
| Idempotency: two consecutive refreshes produce identical state | NFR-L3 deterministic |
| RLS: participant SELECT on `exact_hits` for other row → permission denied | FR-L02 / NFR-L6 |
| RLS: participant SELECT on full row via `leaderboard_self` (own row) → succeeds | FR-L02 |
| RLS: admin sees same column set as participant | FC-L6 |
| Refresh duration < 500 ms @ 200-participant fixture | NFR-L3 |

## Read patterns

See data-model.md §8 for the three canonical query shapes used by the page server component, the Realtime re-fetch, and the dashboard widget.
