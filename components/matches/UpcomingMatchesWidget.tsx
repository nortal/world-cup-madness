import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import MatchCard from '@/components/matches/MatchCard';
import { type Locale } from '@/lib/matches/format-kickoff';
import type { MatchStatus } from '@/lib/matches/lock-badge';
import { createClient } from '@/lib/supabase/server';

/**
 * Upcoming matches dashboard widget (FR-M12).
 *
 * Server Component — renders the "Upcoming matches" widget on the participant
 * dashboard. REPLACES the feature-001 empty-state placeholder that previously
 * lived inside `<section aria-labelledby="upcoming-matches-heading">` in
 * `app/(participant)/dashboard/page.tsx` (the heading id is preserved so any
 * screen-reader bookmarks or landmark navigation from the US1 release keep
 * working).
 *
 * Query shape:
 *   - `status = 'scheduled'` AND `kickoff_utc > now() + 60 minutes`
 *     (the 60-minute future floor matches BR-LOCK-002 — any fixture whose
 *     prediction window has already closed is, by definition, no longer an
 *     "upcoming" candidate for the dashboard and is filtered out at the DB
 *     layer so the widget never has to second-guess lock state client-side).
 *   - Ordered by kickoff ASC, LIMIT 3.
 *   - Joined to `teams` twice via the named FK constraints
 *     (`matches_home_team_id_fkey`, `matches_away_team_id_fkey`) so the embed
 *     shape stays unambiguous in `database.types.ts`.
 *
 * Rendering rules:
 *   - Always render the heading and the "View all matches" link, even when
 *     zero matches come back. A participant arriving on an empty dashboard
 *     still needs a discoverable path into the full `/matches` catalog —
 *     hiding the link on the empty state would strand users who joined
 *     before the schedule is published.
 *   - When fewer than 3 rows match, render whatever is available; the spec
 *     does not require padding. The empty-state paragraph is only shown when
 *     the result list is empty.
 *
 * `nowUtc` is computed once and shared across every `<MatchCard/>` so all
 * cards' lock-badge math derives from the same trusted instant — consistent
 * with the MatchCard contract that `nowUtc` is injected by the caller rather
 * than read inside the card.
 *
 * Caching: page-level revalidate (`revalidate = 60`) on the dashboard route
 * is the dashboard page's responsibility (T036) — this component does not
 * declare its own `revalidate` because cache cadence is a page concern, not
 * a component concern.
 *
 * Translation namespace: `matches` (keys: `dashboardWidget.heading`,
 * `dashboardWidget.emptyState`, `viewAllMatches`).
 */

type UpcomingMatchesWidgetProps = {
  participantTz: string;
  locale: Locale;
};

export default async function UpcomingMatchesWidget({
  participantTz,
  locale,
}: UpcomingMatchesWidgetProps) {
  const t = await getTranslations('matches');
  const supabase = await createClient();

  // 60-minute future floor — kickoffs inside the lock window are not
  // "upcoming" from the participant's editing perspective, so we exclude
  // them at the DB layer rather than in the render path (BR-LOCK-002).
  const nowUtc = new Date();
  const lockHorizonIso = new Date(nowUtc.getTime() + 60 * 60 * 1000).toISOString();

  // Named FK embeds: the constraint names come from migration 0012 and are
  // confirmed in `database.types.ts` (Relationships block on `matches`).
  const { data: rows, error } = await supabase
    .from('matches')
    .select(
      `id, provider_id, kickoff_utc, status, score_home, score_away, group_label,
       home_team:teams!matches_home_team_id_fkey(tla, name),
       away_team:teams!matches_away_team_id_fkey(tla, name)`,
    )
    .eq('status', 'scheduled')
    .gt('kickoff_utc', lockHorizonIso)
    .order('kickoff_utc', { ascending: true })
    .limit(3);

  if (error !== null) {
    // Unexpected DB error — log with structured context (no PII) and fall
    // through to the empty state rather than crashing the dashboard.
    console.error('UpcomingMatchesWidget: failed to load upcoming matches', {
      message: error.message,
      code: error.code,
    });
  }

  const matches = rows ?? [];

  return (
    <section className="mt-10" aria-labelledby="upcoming-matches-heading">
      <h2
        id="upcoming-matches-heading"
        className="text-lg font-semibold"
      >
        {t('dashboardWidget.heading')}
      </h2>

      {matches.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {matches.map((row) => (
            <li key={row.id}>
              <MatchCard
                match={{
                  id: row.id,
                  kickoffUtc: row.kickoff_utc !== null ? new Date(row.kickoff_utc) : null,
                  // The query filters to `status='scheduled'`, so the DB
                  // value is guaranteed to be a valid MatchStatus literal.
                  status: row.status as MatchStatus,
                  scoreHome: row.score_home,
                  scoreAway: row.score_away,
                  groupLabel: row.group_label,
                  homeTeam: { tla: row.home_team.tla, name: row.home_team.name },
                  awayTeam: { tla: row.away_team.tla, name: row.away_team.name },
                }}
                nowUtc={nowUtc}
                participantTz={participantTz}
                locale={locale}
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 rounded-md border border-dashed border-gray-300 px-6 py-8 text-center text-sm text-gray-600">
          {t('dashboardWidget.emptyState')}
        </p>
      )}

      <div className="mt-4">
        <Link
          href="/matches"
          className="text-sm font-medium text-blue-600 hover:text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {t('viewAllMatches')}
        </Link>
      </div>
    </section>
  );
}
