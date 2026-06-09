import { getTranslations } from 'next-intl/server';

import { computeMovers } from '@/lib/dashboard/movers-24h';
import type { MoverRow } from '@/lib/dashboard/types';
import { createClient } from '@/lib/supabase/server';

/**
 * `<MoversWidget/>` — Pool-tab top-3 climbers in the trailing 24 hours
 * (feature 005 US-DC T028 / FR-D11 + FR-D12).
 *
 * Server Component. Renders two sub-sections inside one card:
 *
 *   1. "Top 3 in pool" — the three highest-magnitude up-movers globally.
 *      Powered by the `get_movers_24h_aggregate()` SECURITY DEFINER RPC
 *      (migration 0038) that aggregates `score_events` deltas across all
 *      participants without surfacing per-event PII.
 *   2. "Top 3 near you" — the same list filtered to the caller's current
 *      neighborhood window (the participant IDs are passed in by the
 *      parent composer, which derived them from the neighborhood query).
 *
 * Empty section → "No movers in the last 24 hours" message (FR-D11
 * fallback behaviour).
 *
 * Both PostgREST/RPC calls are fired in parallel via `Promise.all`. The
 * pure `computeMovers` helper does the synthetic "previous rank" math —
 * see `contracts/query-movers-global.md` for the derivation rules.
 */

type MoversWidgetProps = {
  selfParticipantId: string;
  neighborhoodParticipantIds: string[];
  locale: string;
};

export default async function MoversWidget({
  selfParticipantId,
  neighborhoodParticipantIds,
  // `locale` is part of the prop contract for future locale-aware
  // formatting of the magnitude / arrow text; not consumed directly yet.
  locale: _locale,
}: MoversWidgetProps): Promise<React.ReactElement> {
  const t = await getTranslations('dashboard');
  const supabase = await createClient();

  const [rankingsRes, deltasRes] = await Promise.all([
    supabase
      .from('leaderboard_snapshots')
      .select('participant_id, display_name, total_points, rank')
      .eq('stage', 'all')
      .order('rank', { ascending: true }),
    supabase.rpc('get_movers_24h_aggregate'),
  ]);

  if (rankingsRes.error !== null) {
    console.error('MoversWidget: current-rankings query failed', {
      code: rankingsRes.error.code,
      message: rankingsRes.error.message,
    });
  }
  if (deltasRes.error !== null) {
    console.error('MoversWidget: movers RPC failed', {
      code: deltasRes.error.code,
      message: deltasRes.error.message,
    });
  }

  // The pure helper expects fully-populated rows (the MV columns are NOT
  // NULL at the SQL level but the generated row type allows null because
  // Supabase can't infer NOT NULL across the MV's UNION ALL). Filter to
  // rows that have everything we need before handing off.
  const currentRankings = (rankingsRes.data ?? [])
    .filter(
      (
        r,
      ): r is {
        participant_id: string;
        display_name: string;
        total_points: number;
        rank: number;
      } =>
        r.participant_id !== null &&
        r.display_name !== null &&
        r.total_points !== null &&
        r.rank !== null,
    );

  const deltas = (deltasRes.data ?? []).map((d) => ({
    participant_id: d.participant_id,
    delta_24h: d.delta_24h,
  }));

  const allMovers = computeMovers(currentRankings, deltas);
  const globalTop3 = allMovers.slice(0, 3);
  const neighborhoodSet = new Set(neighborhoodParticipantIds);
  const neighborhoodTop3 = allMovers
    .filter((m) => neighborhoodSet.has(m.participantId))
    .slice(0, 3);

  return (
    <section
      className="mt-4 rounded-md border border-gray-200 bg-white p-3 shadow-sm"
      aria-labelledby="movers-heading"
    >
      <h2 id="movers-heading" className="text-base font-semibold">
        {t('moversHeading')}
      </h2>
      <div className="mt-2 space-y-3">
        <div>
          <h3 className="text-sm font-medium text-gray-600">{t('moversGlobalSubheading')}</h3>
          {globalTop3.length === 0 ? (
            <p className="mt-1 text-sm text-gray-500">{t('moversEmptyState')}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {globalTop3.map((m) => (
                <MoverRowItem
                  key={`global-${m.participantId}`}
                  mover={m}
                  isSelf={m.participantId === selfParticipantId}
                />
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-600">
            {t('moversNeighborhoodSubheading')}
          </h3>
          {neighborhoodTop3.length === 0 ? (
            <p className="mt-1 text-sm text-gray-500">{t('moversEmptyState')}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {neighborhoodTop3.map((m) => (
                <MoverRowItem
                  key={`neighborhood-${m.participantId}`}
                  mover={m}
                  isSelf={m.participantId === selfParticipantId}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Single row in either sub-section. Renders display name, current rank,
 * and a green up-arrow with the magnitude. The self row is amber-tinted
 * to match feature 004's `data-self` convention.
 */
function MoverRowItem({ mover, isSelf }: { mover: MoverRow; isSelf: boolean }): React.ReactElement {
  return (
    <li
      data-self={isSelf ? 'true' : undefined}
      className={
        isSelf
          ? 'flex items-baseline justify-between gap-3 rounded bg-amber-50/50 px-2 py-1 text-sm'
          : 'flex items-baseline justify-between gap-3 px-2 py-1 text-sm'
      }
    >
      <span className="truncate text-gray-900">{mover.displayName}</span>
      <span className="flex items-baseline gap-2 text-gray-700">
        <span className="tabular-nums text-xs text-gray-500">#{mover.currentRank}</span>
        <span className="font-medium text-green-600 tabular-nums">↑ {mover.delta.magnitude}</span>
      </span>
    </li>
  );
}
