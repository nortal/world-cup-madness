/**
 * Pure helper — compute the inclusive 1-based rank window the
 * Neighborhood widget will fetch from `leaderboard_snapshots`
 * (feature 005 US-DC, FR-D05 / FR-D06).
 *
 * Rule (verbatim from `contracts/query-neighborhood.md`):
 *   - `totalParticipants < 11` → small-pool: return the entire pool.
 *   - `selfRank ≤ 6`          → top-clamp:   ranks 1-11.
 *   - `selfRank + 5 ≥ totalParticipants` → bottom-clamp:
 *                                          last 11 ranks of the pool.
 *   - else                    → centre:     `selfRank − 5 … selfRank + 5`.
 *
 * The helper is total — every numeric input combination produces a
 * defined output, no throws. `sliceCount` is always `endRank − startRank
 * + 1`.
 *
 * @see `lib/dashboard/types.ts` for the `NeighborhoodWindow` shape.
 */

import type { NeighborhoodWindow } from '@/lib/dashboard/types';

export function computeNeighborhoodWindow(
  selfRank: number,
  totalParticipants: number,
): NeighborhoodWindow {
  if (totalParticipants < 11) {
    return {
      startRank: 1,
      endRank: totalParticipants,
      sliceCount: totalParticipants,
      clampMode: 'small-pool',
    };
  }
  if (selfRank <= 6) {
    return { startRank: 1, endRank: 11, sliceCount: 11, clampMode: 'top' };
  }
  if (selfRank + 5 >= totalParticipants) {
    return {
      startRank: totalParticipants - 10,
      endRank: totalParticipants,
      sliceCount: 11,
      clampMode: 'bottom',
    };
  }
  return {
    startRank: selfRank - 5,
    endRank: selfRank + 5,
    sliceCount: 11,
    clampMode: 'centre',
  };
}
