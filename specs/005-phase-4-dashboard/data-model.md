# Phase 1 Data Model — Feature 005 Dashboard Polish + Mobile UX

**Branch**: `005-phase-4-dashboard`
**Date**: 2026-06-06
**Status**: Complete

---

## 1. Scope

**Zero new persistent entities.** This feature is a frontend rework that reads from existing tables, views, and the materialised view shipped by features 001-004. It introduces:

- 7 read queries (documented as contracts)
- 0 migrations
- 0 new RPCs
- 0 changes to the `audit_log`, RLS policies, or grants

The "data model" for this feature is the **query catalogue** below.

---

## 2. Query Catalogue

### 2.1 Auth-gate query (existing pattern from feature 004)

**Purpose**: Resolve the active participant for the auth gate + downstream queries.

**SQL shape** (issued by `DashboardPage.tsx` server-side via Supabase client):
```sql
SELECT id, status, timezone, display_name, role
FROM participants
WHERE auth_user_id = auth.uid()
  AND status = 'active'
LIMIT 1;
```

**RLS**: existing `participants_select_own` policy. Unchanged.
**Used by**: Auth gate at top of `DashboardPage` (redirect to `/` if no row).

---

### 2.2 Self rank fetch

**Purpose**: Drive the existing `RankWidget` embedded in the Today tab.

**SQL shape**:
```sql
SELECT rank, total_points, exact_hits, outcome_hits, final_points, rank_is_shared
FROM leaderboard_self
WHERE stage = 'all'
LIMIT 1;
```

**RLS**: existing `leaderboard_self` view (`security_invoker = false`) — the `auth.uid()` WHERE-pin returns only the caller's own row.
**Used by**: `RankWidget` (no change from feature 004) + `NeighborhoodWidget` (to compute the centre row).

---

### 2.3 Neighborhood window slice

**Purpose**: Render the participant's local leaderboard ±5 rows with hybrid clamp.

**SQL shape**:
```sql
SELECT participant_id, stage, display_name, total_points, rank, rank_is_shared
FROM leaderboard_snapshots
WHERE stage = 'all'
ORDER BY rank, display_name
LIMIT 11
OFFSET <computeNeighborhoodWindow(selfRank, totalParticipants).startRank - 1>;
```

The `OFFSET` is derived in JS by the `computeNeighborhoodWindow(selfRank, totalParticipants)` pure helper, which returns `{startRank, endRank, sliceCount}` per FR-D10's hybrid rule:
- If `selfRank ≤ 6` and `totalParticipants ≥ 11`: `startRank=1`, `endRank=11` (top-clamp).
- Else if `selfRank + 5 ≥ totalParticipants`: `startRank=max(1, totalParticipants-10)`, `endRank=totalParticipants` (bottom-clamp).
- Else: `startRank=selfRank-5`, `endRank=selfRank+5` (centre).
- If `totalParticipants < 11`: `startRank=1`, `endRank=totalParticipants` (small-pool collapse).

**RLS**: existing column-level GRANT on `leaderboard_snapshots` (public projection only).
**Used by**: `NeighborhoodWidget`.

---

### 2.4 Current rankings (all participants) — for movers

**Purpose**: Provide the current full ranking for the on-demand 24-hour movers calculation (R-4).

**SQL shape**:
```sql
SELECT participant_id, display_name, total_points, rank, rank_is_shared
FROM leaderboard_snapshots
WHERE stage = 'all'
ORDER BY rank, display_name;
```

**Row count estimate**: up to 200 (NFR-D01 scale assumption).
**RLS**: column-level GRANT.
**Used by**: `MoversWidget` (paired with 2.5 — points-awarded delta).

---

### 2.5 Last-24-hour points delta per participant

**Purpose**: Provide per-participant point gain in the trailing 24 hours so JS can derive a synthetic "rank 24h ago" and compute the delta (R-4 + FR-D12).

**SQL shape** (PostgREST aggregator preferred):
```sql
SELECT participant_id, SUM(points) AS delta_24h
FROM score_events
WHERE awarded_at >= NOW() - INTERVAL '24 hours'
GROUP BY participant_id;
```

**Fallback** (if PostgREST aggregator unavailable):
```sql
SELECT participant_id, points, awarded_at
FROM score_events
WHERE awarded_at >= NOW() - INTERVAL '24 hours';
```
…then aggregate in JS.

**Performance estimate**: ~2000 rows max (200 participants × ~10 events each), indexed scan via `score_events_awarded_at_idx`.
**RLS**: existing `score_events_select_own` policy is **narrowing** here — but the WAL CDC / Realtime concerns don't apply because this is a PostgREST read, not a subscription. The fallback aggregation in JS will receive only the caller's own rows under that RLS, breaking the global movers feature.

**Mitigation**: This requires a **SECURITY DEFINER helper RPC** or a broadening RLS policy for read-only aggregation. **Decision (see contracts/query-movers-global.md)**: add a small migration `0038_movers_24h_rpc.sql` that exposes a read-only `get_movers_24h_aggregate()` SECURITY DEFINER function returning `(participant_id, delta_24h)` rows. The function is gated by `authenticated` role (no anon read) and contains no scoring logic — it's a pure aggregator. This breaks the spec's "zero migrations" stance but **only by one read-only helper**; updating the spec / Deferred Decisions §1 accordingly.

> **NOTE (deviation from spec)**: This is the first deviation from the spec's "no new schema" stance (FC-D1). Documented here for the implementation phase to ratify; the migration is minimal and read-only. If the team rejects this deviation, the alternative is to scrap the global-movers feature and ship only the neighborhood-movers sub-section (which can be computed from the caller's own RLS-filtered events). Flag this for the user to confirm before `/ai1st-dev-tasks`.

**Used by**: `MoversWidget` (combined with 2.4 + the `computeMovers` pure helper).

---

### 2.6 Weekly digest events (caller-scoped)

**Purpose**: Aggregate the caller's points earned this calendar week (Mon-Sun UTC) — total, count, best, worst (FR-D13).

**SQL shape**:
```sql
SELECT points, awarded_at, match_id
FROM score_events
WHERE participant_id = <selfParticipantId>
  AND awarded_at >= <startOfCurrentWeekUTC>
ORDER BY points DESC;
```

**Row count estimate**: 7-20 rows per week per participant.
**RLS**: existing `score_events_select_own` — the WHERE-clause is redundant with RLS but explicit for clarity.
**Used by**: `DigestWidget`.

---

### 2.7 Last finished match prediction (caller-scoped)

**Purpose**: Surface the participant's most recent prediction + points awarded in the Snapshot widget (FR-D09 "last" card).

**SQL shape** (one round-trip via PostgREST embed):
```sql
SELECT
  p.predicted_home_score,
  p.predicted_away_score,
  m.id AS match_id,
  m.kickoff_utc,
  m.score_home,
  m.score_away,
  ht.name AS home_team_name,
  at.name AS away_team_name,
  COALESCE(se.points, 0) AS points_awarded
FROM predictions p
JOIN matches m ON m.id = p.match_id
JOIN teams ht ON ht.id = m.home_team_id
JOIN teams at ON at.id = m.away_team_id
LEFT JOIN score_events se ON se.match_id = m.id AND se.participant_id = p.participant_id AND se.source LIKE 'match-%'
WHERE p.participant_id = <selfParticipantId>
  AND m.status = 'finished'
ORDER BY m.kickoff_utc DESC
LIMIT 1;
```

**RLS**: existing `predictions_select_own` + `matches_select_eligible` + `score_events_select_own`. All policies cover the caller's own row.
**Used by**: `SnapshotWidget` ("last" card).

---

### 2.8 Upcoming match prediction (caller-scoped)

**Purpose**: Surface the participant's prediction for the next upcoming match in the Snapshot widget (FR-D09 "next" card) AND drive the inline-edit defaults in the expandable upcoming-match card.

**SQL shape**:
```sql
SELECT
  p.predicted_home_score,
  p.predicted_away_score,
  m.id AS match_id,
  m.kickoff_utc,
  ht.name AS home_team_name,
  at.name AS away_team_name
FROM matches m
JOIN teams ht ON ht.id = m.home_team_id
JOIN teams at ON at.id = m.away_team_id
LEFT JOIN predictions p ON p.match_id = m.id AND p.participant_id = <selfParticipantId>
WHERE m.status = 'scheduled'
  AND m.kickoff_utc > NOW()
ORDER BY m.kickoff_utc ASC
LIMIT 1;
```

A `NULL` `predicted_home_score`/`predicted_away_score` indicates no prediction yet ("No pick yet" prompt per FR-D09).
**RLS**: same as 2.7.
**Used by**: `SnapshotWidget` ("next" card) + `ExpandableMatchCard` (inline-edit pre-fill).

---

## 3. Existing entities referenced (no changes)

| Entity | Origin | Role in this feature |
|---|---|---|
| `participants` | Feature 001 | Auth gate + display_name + timezone (used by countdown formatting) |
| `matches` | Feature 002 | Upcoming + last finished match metadata |
| `teams` | Feature 002 | Team name lookup for the Snapshot widget cards |
| `predictions` | Feature 003 | Prediction snapshots + inline-edit defaults |
| `score_events` | Feature 003 | 24-hour movers delta + weekly digest aggregation |
| `leaderboard_snapshots` MV | Feature 004 | Current rankings (Neighborhood + Movers) |
| `leaderboard_self` view | Feature 004 | Self rank for RankWidget + Neighborhood centre |
| `audit_log` | Features 001 + 004 | `leaderboard-refresh` Realtime channel source (no new events; existing channel reused) |
| `lock_prediction()` RPC | Feature 003 | Inline-edit save handler |

---

## 4. JS-side derived types

These TypeScript types are introduced in `lib/dashboard/types.ts` (new):

```ts
export type NeighborhoodWindow = {
  startRank: number;
  endRank: number;
  sliceCount: number;
  clampMode: 'top' | 'centre' | 'bottom' | 'small-pool';
};

export type MoverRow = {
  participantId: string;
  displayName: string;
  currentRank: number;
  previousRank: number;
  delta: { direction: 'up' | 'down' | 'flat' | 'first'; magnitude: number };
};

export type DigestSummary = {
  totalPoints: number;
  matchCount: number;
  bestSingleScore: number | null;
  worstSingleScore: number | null;
};

export type SnapshotData = {
  lastFinished: {
    matchId: string;
    homeTeamName: string;
    awayTeamName: string;
    kickoffUtc: string;
    predictedHomeScore: number | null;
    predictedAwayScore: number | null;
    actualHomeScore: number | null;
    actualAwayScore: number | null;
    pointsAwarded: number;
  } | null;
  nextUpcoming: {
    matchId: string;
    homeTeamName: string;
    awayTeamName: string;
    kickoffUtc: string;
    predictedHomeScore: number | null;
    predictedAwayScore: number | null;
  } | null;
};
```

All types are derived from the existing generated `Database` types in `lib/supabase/database.types.ts` where possible (use `Pick<…>` rather than redefining shapes).

---

## 5. Open question for ratification before /ai1st-dev-tasks

> **Movers RLS deviation (§2.5)**: The global-movers calculation needs a `SECURITY DEFINER` helper RPC to aggregate `score_events.points` across all participants. The current spec (FC-D1) says zero new schema. Implementation will need to either:
>
> (a) Add a minimal migration `0038_movers_24h_rpc.sql` (one read-only function, ~15 lines including REVOKE/GRANT), OR
> (b) Drop the **global** movers sub-section of FR-D11 and ship only the **neighborhood** movers (which can be computed from the caller's own RLS-filtered events).
>
> Flag for the user to choose during `/ai1st-dev-tasks` task generation. The recommended path is (a) — a single read-only aggregator is a small, well-contained departure from FC-D1 that unblocks a key engagement widget without introducing persistent state.

---

## Summary

- 8 read queries documented (one per widget surface + auth).
- 0 new persistent entities, 0 RLS changes — with one outstanding deviation flagged in §2.5 / §5 for ratification.
- 4 new derived TypeScript types in `lib/dashboard/types.ts`.

Proceed to `contracts/` for per-query contract documents.
