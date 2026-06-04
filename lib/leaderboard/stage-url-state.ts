/**
 * URL-state helpers for the `/leaderboard` stage tab strip (feature 004
 * US-LB T019).
 *
 * The leaderboard stage filter (FR-L04 / FR-L05) is reflected in the URL
 * via `?stage=<code>` so that:
 *   - Reloading the page preserves the filter (TC-L13).
 *   - Deep links to a specific stage's ranking are shareable.
 *   - The Server Component composer can read the filter from `searchParams`
 *     without any client-side state plumbing.
 *
 * Validation is strict: unknown / unsupported / wrong-case values collapse
 * to `'all'`. The MV uses short stage codes (`group`, `r16`, `quarter`,
 * `semi`, `final`) — distinct from the long labels stored in
 * `matches.stage` (`group`, `round-of-16`, `quarter-final`, …). The CTE
 * mapping is handled inside the MV definition; this module only deals in
 * the MV codes.
 */

export const STAGES = ['all', 'group', 'r16', 'quarter', 'semi', 'final'] as const;

export type Stage = (typeof STAGES)[number];

export function parseStage(param: string | null | undefined): Stage {
  if (param === null || param === undefined) return 'all';
  if ((STAGES as readonly string[]).includes(param)) {
    return param as Stage;
  }
  return 'all';
}

export function formatStageHref(stage: Stage, page?: number): string {
  const base = `/leaderboard?stage=${stage}`;
  if (page !== undefined && page > 1) {
    return `${base}&page=${page}`;
  }
  return base;
}
