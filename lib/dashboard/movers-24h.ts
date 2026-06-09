/**
 * Pure helper — derive the trailing-24-h climbers for the Movers widget
 * (feature 005 US-DC, FR-D08 / FR-D09).
 *
 * The widget joins two server-side inputs in JS rather than asking
 * Postgres to compute "rank 24 h ago" (which would require a second
 * materialised view or a window-function CTE per call):
 *   1. `currentRankings` — the rows we already have from
 *      `leaderboard_snapshots` (per-participant rank + total).
 *   2. `deltas` — output of the `get_movers_24h_aggregate` RPC: one
 *      `(participant_id, delta_24h)` row per participant who has earned
 *      points in the trailing 24 h.
 *
 * We synthesise each participant's "total 24 h ago" as
 * `current_total − delta_24h`, re-rank on that synthetic total, then
 * delegate the up/down/flat semantics to feature 004's
 * `computeDelta()`. Output is filtered to climbers (`direction === 'up'`)
 * and sorted by descending magnitude with `currentRank ASC` as the
 * tie-breaker (better-ranked climber wins on equal magnitude).
 *
 * Privacy: the helper does not look up emails or PII — only the
 * `display_name` already exposed by the MV (FC-L3 / FC-D3).
 */

import { computeDelta } from '@/lib/leaderboard/compute-delta';

import type { MoverRow } from '@/lib/dashboard/types';

export type CurrentRanking = {
  participant_id: string;
  display_name: string;
  total_points: number;
  rank: number;
};

export type DeltaRow = {
  participant_id: string;
  delta_24h: number;
};

export function computeMovers(
  currentRankings: CurrentRanking[],
  deltas: DeltaRow[],
): MoverRow[] {
  if (currentRankings.length === 0) return [];

  const deltaMap = new Map(deltas.map((d) => [d.participant_id, d.delta_24h]));

  /* Synthetic previous totals (current − delta). Participants without a
   * delta row are treated as `delta = 0` (i.e. no movement). */
  type Synthetic = CurrentRanking & { previousTotal: number };
  const synthetic: Synthetic[] = currentRankings.map((r) => ({
    ...r,
    previousTotal: r.total_points - (deltaMap.get(r.participant_id) ?? 0),
  }));

  /* Derive rank-24-h-ago via descending sort on `previousTotal`,
   * secondary stable sort on `display_name` (deterministic / matches
   * the MV's tie-breaker style — see feature 004 data-model.md §2.2).
   * RANK() semantics: tied rows share a rank; the next distinct total
   * gets the gap-after rank. */
  const sortedPrev = [...synthetic].sort((a, b) => {
    if (b.previousTotal !== a.previousTotal) return b.previousTotal - a.previousTotal;
    return a.display_name.localeCompare(b.display_name);
  });

  const previousRankMap = new Map<string, number>();
  let lastRank = 0;
  let lastTotal: number | null = null;
  let index = 0;
  for (const row of sortedPrev) {
    index += 1;
    if (row.previousTotal !== lastTotal) {
      lastRank = index;
      lastTotal = row.previousTotal;
    }
    previousRankMap.set(row.participant_id, lastRank);
  }

  /* Build MoverRow[] for everyone, then filter to climbers and sort. */
  return currentRankings
    .map((r): MoverRow => {
      const previousRank = previousRankMap.get(r.participant_id) ?? r.rank;
      return {
        participantId: r.participant_id,
        displayName: r.display_name,
        currentRank: r.rank,
        previousRank,
        delta: computeDelta(previousRank, r.rank),
      };
    })
    .filter((row) => row.delta.direction === 'up')
    .sort((a, b) => {
      if (b.delta.magnitude !== a.delta.magnitude) return b.delta.magnitude - a.delta.magnitude;
      return a.currentRank - b.currentRank;
    });
}
