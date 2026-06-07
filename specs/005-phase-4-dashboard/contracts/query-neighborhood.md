# Contract — Neighborhood slice query (NEW)

**Type**: PostgREST read query
**Source target**: `leaderboard_snapshots` MV (feature 004)
**Status**: NEW for feature 005 — uses existing column-level GRANT, no schema change

## Purpose

Render the participant's local leaderboard ±5 rows in the `NeighborhoodWidget` (Pool tab). Hybrid clamp per FR-D10.

## Signature

```ts
// Inside NeighborhoodWidget.tsx (Server Component)
const window = computeNeighborhoodWindow(selfRank, totalParticipants);

const { data: rows, error } = await supabase
  .from('leaderboard_snapshots')
  .select('participant_id, stage, display_name, total_points, rank, rank_is_shared')
  .eq('stage', 'all')
  .order('rank', { ascending: true })
  .order('display_name', { ascending: true })
  .range(window.startRank - 1, window.endRank - 1);
```

## `computeNeighborhoodWindow` rule (FR-D10)

```ts
function computeNeighborhoodWindow(
  selfRank: number,
  totalParticipants: number,
): { startRank: number; endRank: number; sliceCount: number; clampMode: 'top' | 'centre' | 'bottom' | 'small-pool' } {
  if (totalParticipants < 11) return { startRank: 1, endRank: totalParticipants, sliceCount: totalParticipants, clampMode: 'small-pool' };
  if (selfRank <= 6) return { startRank: 1, endRank: 11, sliceCount: 11, clampMode: 'top' };
  if (selfRank + 5 >= totalParticipants) return { startRank: totalParticipants - 10, endRank: totalParticipants, sliceCount: 11, clampMode: 'bottom' };
  return { startRank: selfRank - 5, endRank: selfRank + 5, sliceCount: 11, clampMode: 'centre' };
}
```

## Invariants

| Invariant | Check |
|---|---|
| Row count | `≤ 11` (always); equal to `min(totalParticipants, 11)` |
| Ordering | `rank ASC, display_name ASC` (stable secondary sort matches feature 004) |
| Self row marker | The row where `participant_id === selfParticipantId` MUST render with `data-self="true"` |
| Column projection | Only the public projection (no `exact_hits`/`outcome_hits`/`final_points` for non-self rows) |
| RLS | Column-level GRANT enforces FR-L02; this query doesn't bypass anything |

## Failure modes

| Scenario | Behaviour |
|---|---|
| `totalParticipants === 0` (pre-tournament, MV empty) | `NeighborhoodWidget` renders `<PreTournamentPlaceholder/>` instead of issuing the query (FR-D14) |
| `selfParticipantId` not in the result set (rank changed mid-render) | Render the slice as-is; no error toast (stale-while-revalidate semantics) |
| Query error | Log structured JSON via `console.error`; render `PreTournamentPlaceholder` as a safe fallback |

## Test coverage

- `e2e/tests/dashboard-neighborhood.spec.ts`
  - TC-D6 — participant at rank 2 of N ≥ 11 → ranks 1-11 visible
  - TC-D7 — participant at rank 50 of N ≥ 100 → ranks 45-55 visible
  - TC-D8 — participant at last rank N → ranks N-10..N visible
  - Small-pool edge case (8 participants) → all 8 rendered, no padding
- `lib/dashboard/__tests__/neighborhood-window.test.ts` — pure-helper coverage of all four clamp modes + boundary cases (selfRank=6, selfRank=7, totalParticipants=10, totalParticipants=11)
