import DashboardPage from '@/components/dashboard/DashboardPage';

/**
 * `/dashboard` route — feature 005 US-DA T011.
 *
 * Thin route wrapper that delegates to `<DashboardPage/>` (the Server
 * Component composer). All prior dashboard content — greeting, admin nav,
 * predictions nav, RankWidget, UpcomingMatchesWidget, TimezoneAutoDetect,
 * welcome-flow `<DashboardClient/>` — now lives inside the composer so the
 * Today / Pool tab slots and the desktop grid can wrap them per FR-D01..D05
 * while preserving every existing surface (FR-D18).
 *
 * `dynamic = 'force-dynamic'` — matches feature 004's LeaderboardPage. The
 * page reads the participant's auth session + `leaderboard_self` view +
 * `?tab=` query param on every request, none of which are cacheable across
 * users. Replaces the previous `revalidate = 60` ISR window: with the new
 * Realtime widgets (US-DD) and per-user data dependencies, ISR would
 * either serve a stale tab state or leak another participant's snapshot.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardRoute({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}): Promise<React.ReactElement> {
  return <DashboardPage searchParams={searchParams} />;
}
