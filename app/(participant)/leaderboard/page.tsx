import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import LeaderboardPage from '@/components/leaderboard/LeaderboardPage';

/**
 * `/leaderboard` route (feature 004 US-LA T016).
 *
 * Thin Server Component shell mounting the `<LeaderboardPage/>` composer.
 *
 * `dynamic = 'force-dynamic'` opts out of ISR for this surface — unlike
 * `/matches` and `/dashboard` (which set `revalidate = 60` to absorb
 * sub-minute Supabase blips), the leaderboard's freshness model is the
 * Supabase Realtime channel that lands in US-LC. The Realtime emit
 * re-fetches the MV on each `leaderboard.refresh` audit row, so a cached
 * HTML snapshot would just create a staleness gap before the client takes
 * over. Per plan.md §Constitution Check (frontend §IX — Read-path caching
 * deviation).
 */

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('leaderboard');
  return {
    title: t('pageTitle'),
  };
}

type LeaderboardRouteProps = {
  searchParams: Promise<{ stage?: string; page?: string }>;
};

export default async function LeaderboardRoute({
  searchParams,
}: LeaderboardRouteProps): Promise<React.ReactElement> {
  return <LeaderboardPage searchParams={searchParams} />;
}
