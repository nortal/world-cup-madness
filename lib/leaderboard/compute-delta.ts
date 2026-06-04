/**
 * Pure helper — compute the rank movement between two snapshots for the
 * `<RankWidget/>` (feature 004 US-LD T030 / FR-L08).
 *
 * The widget compares the participant's previous rank (held in component
 * state — i.e. the value seen at the time of the last render) against the
 * current rank (just fetched after a `leaderboard.refresh` audit event)
 * and surfaces an inline up/down/flat indicator.
 *
 * Semantics:
 *   - `previousRank === null` → `{direction: 'first', magnitude: 0}` —
 *     first paint after the page mounts; we don't know the prior rank yet.
 *     Rendered as a neutral em-dash, not as a "no change" message, because
 *     "no change" implies we have a comparison.
 *   - Equal ranks → `{direction: 'flat', magnitude: 0}` — comparison made,
 *     no movement.
 *   - `previousRank > currentRank` → `{direction: 'up', magnitude: diff}` —
 *     rank numbers go DOWN as the participant climbs (rank 12 → 10 is "up
 *     2"); this matches the visual `↑` arrow convention.
 *   - `previousRank < currentRank` → `{direction: 'down', magnitude: diff}`.
 *
 * The helper is total — every numeric input combination produces a defined
 * output, no throws. Magnitude is always non-negative.
 */
export type RankDelta = {
  direction: 'up' | 'down' | 'flat' | 'first';
  magnitude: number;
};

export function computeDelta(previousRank: number | null, currentRank: number): RankDelta {
  if (previousRank === null) return { direction: 'first', magnitude: 0 };
  if (previousRank === currentRank) return { direction: 'flat', magnitude: 0 };
  if (previousRank > currentRank) return { direction: 'up', magnitude: previousRank - currentRank };
  return { direction: 'down', magnitude: currentRank - previousRank };
}
