import { getTranslations } from 'next-intl/server';

import { computeNeighborhoodWindow } from '@/lib/dashboard/neighborhood-window';
import { formatRank } from '@/lib/leaderboard/format-rank';
import { createClient } from '@/lib/supabase/server';

/**
 * `<NeighborhoodWidget/>` — Pool-tab ±5 leaderboard slice (feature 005
 * US-DC T027 / FR-D10).
 *
 * Server Component. Renders an HTML `<table>` containing up to 11 rows
 * from `leaderboard_snapshots` centred on the caller's current rank. The
 * window is computed by the pure `computeNeighborhoodWindow` helper —
 * which selects between four clamp modes (small-pool, top, centre,
 * bottom) per `contracts/query-neighborhood.md`.
 *
 * The caller's own row carries `data-self="true"` plus an amber Tailwind
 * tint, matching feature 004's LeaderboardTable convention so any
 * downstream "Show my rank" client behaviour can find the row via the
 * same selector.
 *
 * `selfRank === null` is a defensive guard — FR-D14 says the whole widget
 * gets replaced by `<PreTournamentPlaceholder/>` upstream, but we still
 * render a graceful empty card here if the caller has no MV row (e.g. a
 * just-provisioned participant before the first refresh).
 */

type NeighborhoodWidgetProps = {
  selfParticipantId: string;
  selfRank: number | null;
  locale: string;
};

export default async function NeighborhoodWidget({
  selfParticipantId,
  selfRank,
  // `locale` is reserved for future locale-aware number formatting; not
  // used directly yet but part of the prop contract so the parent
  // composer doesn't churn when locale-aware count formatting wires in.
  locale: _locale,
}: NeighborhoodWidgetProps): Promise<React.ReactElement> {
  const t = await getTranslations('dashboard');

  // Defensive empty-state guard. The upstream composer should replace
  // this widget with a PreTournamentPlaceholder when the caller has no MV
  // row; this branch only fires if the prop wiring lets a null through.
  if (selfRank === null) {
    return (
      <section
        className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4 text-center"
        aria-labelledby="neighborhood-heading"
      >
        <h2 id="neighborhood-heading" className="text-base font-semibold">
          {t('neighborhoodHeading')}
        </h2>
        <p className="mt-2 text-sm text-gray-600">{t('neighborhoodEmpty')}</p>
      </section>
    );
  }

  const supabase = await createClient();

  // Total participant count via a HEAD-only count query — no row payload,
  // just the `count` header. The `stage='all'` filter matches the MV
  // partition we're slicing into below.
  const { count: totalParticipantsRaw, error: countError } = await supabase
    .from('leaderboard_snapshots')
    .select('participant_id', { head: true, count: 'exact' })
    .eq('stage', 'all');

  if (countError !== null) {
    console.error('NeighborhoodWidget: count query failed', {
      code: countError.code,
      message: countError.message,
    });
  }

  const totalParticipants = totalParticipantsRaw ?? 0;

  if (totalParticipants === 0) {
    return (
      <section
        className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-4 text-center"
        aria-labelledby="neighborhood-heading"
      >
        <h2 id="neighborhood-heading" className="text-base font-semibold">
          {t('neighborhoodHeading')}
        </h2>
        <p className="mt-2 text-sm text-gray-600">{t('neighborhoodEmpty')}</p>
      </section>
    );
  }

  const window = computeNeighborhoodWindow(selfRank, totalParticipants);

  // PostgREST `range` is 0-indexed inclusive on both ends; the helper
  // emits 1-based ranks so we subtract 1 for both bounds.
  const { data: rows, error: rowsError } = await supabase
    .from('leaderboard_snapshots')
    .select('participant_id, stage, display_name, total_points, rank, rank_is_shared')
    .eq('stage', 'all')
    .order('rank', { ascending: true })
    .order('display_name', { ascending: true })
    .range(window.startRank - 1, window.endRank - 1);

  if (rowsError !== null) {
    console.error('NeighborhoodWidget: slice query failed', {
      code: rowsError.code,
      message: rowsError.message,
    });
  }

  const slice = rows ?? [];

  return (
    <section
      className="mt-4 rounded-md border border-gray-200 bg-white p-3 shadow-sm"
      aria-labelledby="neighborhood-heading"
    >
      <h2 id="neighborhood-heading" className="text-base font-semibold">
        {t('neighborhoodHeading')}
      </h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <caption className="sr-only">{t('neighborhoodAriaLabel')}</caption>
          <thead>
            <tr className="border-b border-gray-300">
              <th scope="col" className="py-2 pr-3 font-semibold tabular-nums">
                {t('neighborhoodRankColumn')}
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                {t('neighborhoodNameColumn')}
              </th>
              <th scope="col" className="py-2 text-right font-semibold tabular-nums">
                {t('neighborhoodPointsColumn')}
              </th>
            </tr>
          </thead>
          <tbody>
            {slice.map((row) => {
              const isSelf = row.participant_id === selfParticipantId;
              const rankValue = row.rank ?? 0;
              const isShared = row.rank_is_shared ?? false;
              return (
                <tr
                  key={`${row.participant_id ?? 'unknown'}-${row.stage ?? 'all'}`}
                  data-self={isSelf ? 'true' : undefined}
                  className={
                    isSelf
                      ? 'border-b border-amber-200 bg-amber-50/50'
                      : 'border-b border-gray-100'
                  }
                >
                  <td className="py-2 pr-3 tabular-nums">
                    {formatRank(rankValue, isShared)}
                    {isSelf && (
                      <span className="sr-only"> — {t('neighborhoodYourRowSrLabel')}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 break-words">{row.display_name ?? ''}</td>
                  <td className="py-2 text-right tabular-nums">{row.total_points ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
