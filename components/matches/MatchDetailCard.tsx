import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import LockBadge from '@/components/matches/LockBadge';
import LockCountdownTicker from '@/components/matches/LockCountdownTicker';
import { formatKickoff } from '@/lib/matches/format-kickoff';
import { lockBadgeState, type MatchStatus } from '@/lib/matches/lock-badge';

/**
 * Full match detail surface for `/matches/[id]` (FR-M06, FR-M07, FR-M10).
 *
 * Server Component — the focal element of the match detail page. Mirrors the
 * compositional patterns of `MatchCard.tsx` (the compact list-view sibling)
 * but is intentionally more spacious and replaces the static lock-countdown
 * text variant with the per-second ticker.
 *
 * Why the ticker (T032) and not the static text (T028) here:
 *   The list-view card (FR-M09) opts for the static `LockCountdownText` so a
 *   page full of rows doesn't spawn one `setInterval` per row. The detail
 *   page (FR-M10) is different: a single match is in focus and the user
 *   typically lingers on the page deciding whether to predict, so a live
 *   countdown that visibly ticks toward the 60-minute lock window carries
 *   real UX value. We pay for one ticker, not 64.
 *
 * Lock state is NEVER computed inline — `lockBadgeState()` from
 * `lib/matches/lock-badge.ts` is the single authority (BR-LOCK-003 inverted
 * boundary lives there). The server-rendered initial badge is passed to the
 * ticker as `initialBadge` so hydration starts in sync with the server's
 * source of truth; the ticker only ever flips the badge when the per-second
 * countdown locally crosses zero. RLS in Postgres is the actual gate on
 * prediction edits (BR-LOCK-001 / NFR-M2), so a client clock that disagrees
 * cannot grant or revoke edit rights — it can at worst desync the visible
 * badge for one render cycle.
 *
 * Status branches:
 *   - `scheduled-tbd` (kickoffUtc === null): no kickoff anchor to count down
 *     against, so the ticker is bypassed and only `LockBadge` renders. The
 *     badge will resolve to UPCOMING via the helper's defensive NULL branch.
 *   - `finished` / `cancelled` (terminal states): also bypass the ticker —
 *     there's nothing to count down to once the match is over. `LockBadge`
 *     renders the FINISHED state directly, and (for `finished` with scores)
 *     the prominent score line above the meta info conveys the result.
 *
 * `nowUtc` is injected by the caller (typically the page's trusted server
 * time) so derivation stays deterministic and aligns with any page-level
 * `revalidate` cadence. The same trusted timestamp drives both the
 * server-rendered `LockBadge` initial state and the ticker's `serverNowUtc`
 * anchor, so the two never disagree at first paint.
 *
 * Accessibility: the meta info uses a definition list `<dl>/<dt>/<dd>` so
 * screen readers announce label/value pairs (mirrors the pattern from
 * `app/(participant)/profile/page.tsx`). The visible badge text — not its
 * background color — carries the lock state (NFR-M3 / WCAG 2.1 AA).
 *
 * Translation namespace: `matches` (keys: `vs`, `stages.*`, `groupLabel`,
 * `detail.backToList`, `detail.kickoff`, `detail.venue`, `detail.finalScore`).
 * Badge and countdown text use their own nested namespaces inside their
 * respective components.
 */

import type { Locale } from '@/lib/matches/format-kickoff';

type MatchDetailData = {
  id: string;
  kickoffUtc: Date | null;
  status: MatchStatus;
  scoreHome: number | null;
  scoreAway: number | null;
  stage: 'group' | 'round-of-16' | 'quarter-final' | 'semi-final' | 'third-place' | 'final';
  groupLabel: string | null;
  venue: string | null;
  homeTeam: { tla: string; name: string };
  awayTeam: { tla: string; name: string };
};

type MatchDetailCardProps = {
  match: MatchDetailData;
  nowUtc: Date;
  participantTz: string;
  locale: Locale;
};

export default async function MatchDetailCard({
  match,
  nowUtc,
  participantTz,
  locale,
}: MatchDetailCardProps) {
  const t = await getTranslations('matches');

  const state = lockBadgeState(match.kickoffUtc, match.status, nowUtc);
  const kickoffDisplay = formatKickoff(match.kickoffUtc, participantTz, locale);

  const isTerminal = match.status === 'finished' || match.status === 'cancelled';
  const isTbd = match.kickoffUtc === null;
  const showFinalScore =
    match.status === 'finished' &&
    match.scoreHome !== null &&
    match.scoreAway !== null;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <article className="space-y-6">
        <header className="space-y-1">
          <p className="text-sm font-medium uppercase tracking-wide text-gray-500">
            {t(`stages.${match.stage}`)}
            {match.groupLabel !== null && (
              <>
                {' · '}
                {t('groupLabel', { letter: match.groupLabel })}
              </>
            )}
          </p>
        </header>

        <section className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xl font-semibold">
            <span>{match.homeTeam.name}</span>
            <span className="text-sm uppercase text-gray-500">{match.homeTeam.tla}</span>
            <span className="text-gray-500">{t('vs')}</span>
            <span>{match.awayTeam.name}</span>
            <span className="text-sm uppercase text-gray-500">{match.awayTeam.tla}</span>
          </div>

          {showFinalScore && (
            <p className="text-3xl font-bold tabular-nums text-gray-900">
              {match.scoreHome} – {match.scoreAway}
            </p>
          )}
        </section>

        <section aria-label={t('detail.kickoff')}>
          <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="font-medium text-gray-900">{t('detail.kickoff')}</dt>
            <dd className="text-gray-700">
              {kickoffDisplay !== '' ? kickoffDisplay : '—'}
            </dd>

            {match.venue !== null && (
              <>
                <dt className="font-medium text-gray-900">{t('detail.venue')}</dt>
                <dd className="text-gray-700">{match.venue}</dd>
              </>
            )}
          </dl>
        </section>

        <section className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {isTerminal || isTbd ? (
            <LockBadge
              kickoffUtc={match.kickoffUtc}
              status={match.status}
              nowUtc={nowUtc}
            />
          ) : (
            <LockCountdownTicker
              kickoffUtc={match.kickoffUtc?.toISOString() ?? ''}
              serverNowUtc={nowUtc.toISOString()}
              initialBadge={state}
            />
          )}
        </section>

        <footer className="pt-4">
          <Link
            href="/matches"
            className="text-sm font-medium text-blue-600 hover:text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 rounded-sm"
          >
            {t('detail.backToList')}
          </Link>
        </footer>
      </article>
    </main>
  );
}
