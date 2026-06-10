/**
 * Shared TypeScript types for feature 005 dashboard widgets (US-DC).
 *
 * Derived where possible from generated Database types in
 * `lib/supabase/database.types.ts` (use `Pick<…>` rather than redefining
 * field shapes — keeps the helpers honest if the MV columns drift).
 *
 * See `specs/005-phase-4-dashboard/data-model.md` §4.
 */

import type { Database as _Database } from '@/lib/supabase/database.types';

/* Re-export the Database type so consumers don't have to dual-import.
 * The unused import warning is silenced by the underscore prefix; the
 * helpers and widgets in this feature use the type indirectly via the
 * shapes below, while still anchoring the file to the generated source.
 */
export type Database = _Database;

/**
 * Output of `computeNeighborhoodWindow(selfRank, totalParticipants)` —
 * the inclusive 1-based rank window the neighborhood widget will pull
 * from the materialised view.
 *
 * `clampMode` records which branch produced the window so the widget
 * can render an explanatory caption (e.g. "Top 11" vs "Bottom 11").
 */
export type NeighborhoodWindow = {
  startRank: number;
  endRank: number;
  sliceCount: number;
  clampMode: 'top' | 'centre' | 'bottom' | 'small-pool';
};

/**
 * One row in the Movers widget — a single climber over the trailing 24 h.
 *
 * `delta` reuses feature 004's `RankDelta` shape from
 * `lib/leaderboard/compute-delta.ts`; the structural type is duplicated
 * here so consumers can import a single dashboard module rather than
 * pulling from two locations.
 */
export type MoverRow = {
  participantId: string;
  displayName: string;
  currentRank: number;
  previousRank: number;
  delta: { direction: 'up' | 'down' | 'flat' | 'first'; magnitude: number };
};

/**
 * Caller-scoped weekly digest aggregation (Monday-Sunday UTC).
 *
 * `bestSingleScore` / `worstSingleScore` are `null` when there are no
 * match-scoring events in the window (FR-D13 excludes final-prediction
 * events from these aggregates).
 */
export type DigestSummary = {
  totalPoints: number;
  matchCount: number;
  bestSingleScore: number | null;
  worstSingleScore: number | null;
};

/**
 * Combined payload for the Snapshot widget — the left card shows the
 * most recent finished match the caller predicted; the right card shows
 * the next upcoming match the caller predicted. Either side may be
 * `null` (early tournament / late tournament edges).
 */
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
