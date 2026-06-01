import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import LockBadge from '@/components/matches/LockBadge';
import LockCountdownText from '@/components/matches/LockCountdownText';
import { formatKickoff } from '@/lib/matches/format-kickoff';
import { lockBadgeState, type MatchStatus } from '@/lib/matches/lock-badge';

/**
 * Shared match card (FR-M01, FR-M04, FR-M08, FR-M09, FR-M11).
 *
 * Server Component — the single visual unit rendered both by the `/matches`
 * catalog list (FR-M01) and the dashboard "Upcoming matches" widget
 * (FR-M11). Centralising the card here means the badge / kickoff / score
 * presentation stays in lock-step across both surfaces; FR-M04 (kickoff
 * display), FR-M08 (lock badge), and FR-M09 (lock countdown text) all
 * compose into the same row.
 *
 * The whole card is wrapped in a single `next/link` `<Link>` so the row is
 * one tab-stop for keyboard users (better UX than a nested "View details"
 * button, which would either steal focus or create two competing tab-stops
 * per row). The visible content — team names, kickoff time, lock state —
 * is descriptive enough to act as the link's accessible name, so no extra
 * `aria-label` is needed (Frontend Constitution §VII).
 *
 * `nowUtc` is injected by the caller (not read via `new Date()` here) so
 * derivation stays deterministic and aligns with the page-level
 * `revalidate: 60` cadence; the same trusted timestamp the page used to
 * fetch its rows also drives the badge math (mirrors the LockBadge contract).
 *
 * Translation namespace: `matches` (keys: `vs`, `groupLabel`,
 * `detail.finalScore`). Badge and countdown text use their own nested
 * namespaces inside their respective components.
 */

import type { Locale } from '@/lib/matches/format-kickoff';

type MatchCardData = {
  id: string;
  kickoffUtc: Date | null;
  status: MatchStatus;
  scoreHome: number | null;
  scoreAway: number | null;
  groupLabel: string | null;
  homeTeam: { tla: string; name: string };
  awayTeam: { tla: string; name: string };
};

type MatchCardProps = {
  match: MatchCardData;
  nowUtc: Date;
  participantTz: string;
  locale: Locale;
};

export default async function MatchCard({
  match,
  nowUtc,
  participantTz,
  locale,
}: MatchCardProps) {
  const t = await getTranslations('matches');

  const state = lockBadgeState(match.kickoffUtc, match.status, nowUtc);
  const kickoffDisplay = formatKickoff(match.kickoffUtc, participantTz, locale);

  return (
    <Link
      href={`/matches/${match.id}`}
      className="block rounded-lg border border-gray-200 p-4 hover:bg-gray-50 focus-within:ring-2 focus-within:ring-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <div className="flex items-baseline gap-2 text-base">
        <strong className="font-semibold">{match.homeTeam.name}</strong>
        <span className="text-xs uppercase text-gray-500">{match.homeTeam.tla}</span>
        <span className="text-gray-500">{t('vs')}</span>
        <strong className="font-semibold">{match.awayTeam.name}</strong>
        <span className="text-xs uppercase text-gray-500">{match.awayTeam.tla}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-700">
        {kickoffDisplay !== '' && <span>{kickoffDisplay}</span>}
        {match.groupLabel !== null && (
          <span>{t('groupLabel', { letter: match.groupLabel })}</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <LockBadge
          kickoffUtc={match.kickoffUtc}
          status={match.status}
          nowUtc={nowUtc}
        />
        {state === 'UPCOMING' && match.kickoffUtc !== null && (
          <LockCountdownText kickoffUtc={match.kickoffUtc} nowUtc={nowUtc} />
        )}
        {state === 'FINISHED' &&
          match.scoreHome !== null &&
          match.scoreAway !== null && (
            <span className="text-sm text-gray-700">
              <span className="font-medium">{t('detail.finalScore')}: </span>
              <span>
                {match.scoreHome} – {match.scoreAway}
              </span>
            </span>
          )}
      </div>
    </Link>
  );
}
