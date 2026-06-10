/**
 * URL-state helpers for the `/dashboard` mobile tab strip (feature 005
 * US-DA T006).
 *
 * Mirrors feature 004's `lib/leaderboard/stage-url-state.ts` shape. The
 * dashboard mobile view (<= 768 px) splits into a "Today" tab (Upcoming
 * match + Rank + Snapshot) and a "Pool" tab (Neighborhood + Movers +
 * Digest). The active tab is reflected in the URL as `?tab=today`
 * (default) or `?tab=pool` so reload preserves the tab choice (FR-D02).
 *
 * Unknown / invalid / wrong-case values collapse to `'today'` per
 * spec.md Round 4 clarification.
 */

export const TABS = ['today', 'pool'] as const;
export type DashboardTab = (typeof TABS)[number];

export function parseTab(param: string | null | undefined): DashboardTab {
  if (param === null || param === undefined) return 'today';
  if ((TABS as readonly string[]).includes(param)) {
    return param as DashboardTab;
  }
  return 'today';
}

export function formatTabHref(tab: DashboardTab): string {
  return `/dashboard?tab=${tab}`;
}
