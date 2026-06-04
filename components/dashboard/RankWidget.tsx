'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { computeDelta } from '@/lib/leaderboard/compute-delta';
import { createClient } from '@/lib/supabase/client';

/**
 * `<RankWidget/>` — compact dashboard rank card (feature 004 US-LD T032 /
 * FR-L08, TC-L10, TC-L11).
 *
 * Two render modes:
 *   1. Pre-tournament (`initialRank === null && initialFirstKickoffUtc !== null`):
 *      renders the localised "Leaderboard opens at <time>" message. No
 *      Realtime subscription is opened — there is nothing to update until
 *      the first match is scored (FR-L07 / FR-L22).
 *   2. Live (`initialRank !== null`, or both null — defensive): renders the
 *      current rank + delta arrow, subscribes to the `audit_log` event
 *      proxy channel for `action='leaderboard.refresh'` INSERTs, and on
 *      each event re-fetches the participant's own `leaderboard_self` row
 *      (stage = 'all') for the new rank. Delta is computed against the
 *      previously-rendered rank held in component state.
 *
 * Why the audit-event proxy (not direct MV subscription) — see feature 004
 * research §R-2 and contracts/realtime-channel-leaderboard-snapshots.md.
 * The MV refresh emits ~1,200 per-row replication events; the proxy
 * collapses each refresh into one event with no participant data on the
 * wire (FC-L3 / NFR-L6).
 *
 * IMPORTANT — column-name deviation: the live `audit_log` schema names the
 * event-discriminator column `action` (not `event_type` as the original
 * contract sketch shows). The Realtime filter uses `action=eq.<event>`.
 *
 * The widget is wrapped in a `<Link href="/leaderboard">` so the entire
 * card is a navigation target (matching the spec's "click to drill in"
 * behaviour). Inner spans handle screen-reader semantics for the delta
 * via `aria-label`.
 */

type RankWidgetProps = {
  initialRank: number | null;
  initialFirstKickoffUtc: string | null;
  locale: string;
};

const REALTIME_CHANNEL = 'leaderboard-refresh';

export default function RankWidget({
  initialRank,
  initialFirstKickoffUtc,
  locale,
}: RankWidgetProps): React.ReactElement | null {
  const t = useTranslations('leaderboard');

  // `previousRank` starts null on every mount — first paint has no
  // comparison point. We only assign a value when an inbound Realtime
  // event yields a new rank that differs from what we last rendered.
  const [previousRank, setPreviousRank] = useState<number | null>(null);
  const [currentRank, setCurrentRank] = useState<number | null>(initialRank);

  // Pre-tournament render: an authoritative `null` rank + a known first
  // kickoff means "we have no scoring data yet, here's the countdown
  // anchor". Format the kickoff time with the participant's UI locale
  // using the platform `Intl.DateTimeFormat` — no extra dependency, and
  // it respects the user's timezone via the browser default.
  const preTournamentTime = useMemo(() => {
    if (initialFirstKickoffUtc === null) return null;
    const parsed = new Date(initialFirstKickoffUtc);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(parsed);
  }, [initialFirstKickoffUtc, locale]);

  // Realtime subscription — only active when we have a rank (otherwise
  // the pre-tournament branch renders and there is nothing to refresh).
  useEffect(() => {
    if (currentRank === null) return;

    const supabase = createClient();
    const channel = supabase
      .channel(REALTIME_CHANNEL)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'audit_log',
          filter: 'action=eq.leaderboard.refresh',
        },
        () => {
          void (async () => {
            const { data, error } = await supabase
              .from('leaderboard_self')
              .select('rank')
              .eq('stage', 'all')
              .maybeSingle();

            if (error !== null) {
              // Surfacing the failure inline would be noisier than the
              // stale rank; the row will be re-tried on the next refresh
              // event. Log structured context for diagnosis per
              // constitution §1.3.
              console.error('RankWidget: leaderboard_self re-fetch failed', {
                code: error.code,
                message: error.message,
              });
              return;
            }

            const nextRank = data?.rank ?? null;
            if (nextRank === null) return;

            // Use the functional updater for `currentRank` so we read the
            // freshest value (avoids a stale closure when two refresh
            // events arrive close together). Promote the old current to
            // previous in lock-step so the delta computed on the next
            // render reflects the actual transition.
            setCurrentRank((latest) => {
              if (latest !== null && latest !== nextRank) {
                setPreviousRank(latest);
              }
              return nextRank;
            });
          })();
        },
      )
      .subscribe();

    return () => {
      void channel.unsubscribe();
    };
  }, [currentRank]);

  // Branch 1 — pre-tournament empty state.
  if (currentRank === null && preTournamentTime !== null) {
    return (
      <section
        aria-labelledby="rank-widget-heading"
        className="mt-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
      >
        <h2 id="rank-widget-heading" className="sr-only">
          {t('widgetRankLabel')}
        </h2>
        <p className="text-sm text-gray-700">
          {t('widgetPreTournament', { time: preTournamentTime })}
        </p>
      </section>
    );
  }

  // Defensive: rank null AND no kickoff time — render nothing rather than
  // a half-built card. The dashboard page has other widgets below.
  if (currentRank === null) {
    return null;
  }

  const delta = computeDelta(previousRank, currentRank);

  let deltaSymbol: string;
  let deltaClass: string;
  let deltaAriaLabel: string;
  switch (delta.direction) {
    case 'up':
      deltaSymbol = `↑ ${delta.magnitude}`;
      deltaClass = 'text-green-600';
      deltaAriaLabel = t('widgetDeltaUp', { n: delta.magnitude });
      break;
    case 'down':
      deltaSymbol = `↓ ${delta.magnitude}`;
      deltaClass = 'text-red-600';
      deltaAriaLabel = t('widgetDeltaDown', { n: delta.magnitude });
      break;
    case 'flat':
    case 'first':
    default:
      deltaSymbol = '—';
      deltaClass = 'text-gray-500';
      deltaAriaLabel = t('widgetDeltaFlat');
      break;
  }

  return (
    <Link
      href="/leaderboard"
      aria-labelledby="rank-widget-heading"
      className="mt-4 block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition hover:border-blue-300 hover:shadow focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      <h2 id="rank-widget-heading" className="sr-only">
        {t('widgetRankLabel')}
      </h2>
      <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-baseline sm:gap-3">
        <span className="text-gray-700">
          {t('widgetRankLabel')}: <strong className="text-2xl text-gray-900">{currentRank}</strong>
        </span>
        <span className={`text-base font-medium ${deltaClass}`} aria-label={deltaAriaLabel}>
          {deltaSymbol}
        </span>
      </div>
    </Link>
  );
}
