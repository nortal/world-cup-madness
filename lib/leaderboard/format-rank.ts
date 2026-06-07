/**
 * Pure helper — render a leaderboard `rank` value with the shared-rank
 * suffix convention (FR-L03, spec.md §8 UX).
 *
 * Shared ranks are surfaced by appending `=` to the numeric rank — e.g.
 * two participants tied through every tie-breaker render as `1=`, `1=`,
 * and the next non-tied participant renders as `3` (RANK() gap-after-ties
 * semantics, see data-model.md §2.2 `rank_is_shared`).
 *
 * The decision of *whether* a rank is shared is made server-side via the
 * `rank_is_shared` column on the materialised view (computed via a
 * window-function COUNT — no client-side aggregation, in keeping with the
 * "authoritative state server-rendered" rule). This helper is purely
 * presentational.
 */
export function formatRank(rank: number, isShared: boolean): string {
  return isShared ? `${rank}=` : `${rank}`;
}
