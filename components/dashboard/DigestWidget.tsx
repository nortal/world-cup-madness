import { getTranslations } from 'next-intl/server';

import { computeDigestSummary, startOfCurrentWeekUTC } from '@/lib/dashboard/weekly-digest';
import { createClient } from '@/lib/supabase/server';

/**
 * `<DigestWidget/>` — Pool-tab caller-scoped weekly digest (feature 005
 * US-DC T029 / FR-D13).
 *
 * Server Component. Aggregates the caller's `score_events` from
 * `startOfCurrentWeekUTC()` to now and renders a 2×2 stat grid: total
 * points, match count, best single match, worst single match. The pure
 * `computeDigestSummary` helper excludes final-prediction events
 * (`match_id IS NULL`) — per FR-D13 the digest reports match scores only.
 *
 * Empty state (no match-scoring events this week) → renders the
 * `digestEmptyState` message instead of the grid.
 *
 * RLS: `score_events_select_own` already narrows the read to the caller;
 * the `participant_id = selfParticipantId` filter is kept as a defensive
 * second layer per the contract.
 */

type DigestWidgetProps = {
  selfParticipantId: string;
  locale: string;
};

export default async function DigestWidget({
  selfParticipantId,
  // `locale` reserved for future locale-aware number formatting on the
  // big stat values; not consumed yet.
  locale: _locale,
}: DigestWidgetProps): Promise<React.ReactElement> {
  const t = await getTranslations('dashboard');
  const supabase = await createClient();

  const weekStart = startOfCurrentWeekUTC();

  const { data: events, error } = await supabase
    .from('score_events')
    .select('points, match_id')
    .eq('participant_id', selfParticipantId)
    .gte('awarded_at', weekStart.toISOString())
    .order('points', { ascending: false });

  if (error !== null) {
    console.error('DigestWidget: weekly-digest query failed', {
      code: error.code,
      message: error.message,
    });
  }

  const summary = computeDigestSummary(events ?? []);

  return (
    <section
      className="mt-4 rounded-md border border-gray-200 bg-white p-3 shadow-sm"
      aria-labelledby="digest-heading"
    >
      <h2 id="digest-heading" className="text-base font-semibold">
        {t('digestHeading')}
      </h2>
      {summary.matchCount === 0 ? (
        <p className="mt-2 text-sm text-gray-500">{t('digestEmptyState')}</p>
      ) : (
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <div>
            <dt className="text-xs text-gray-500">{t('digestTotalLabel')}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{summary.totalPoints}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">{t('digestCountLabel')}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{summary.matchCount}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">{t('digestBestLabel')}</dt>
            <dd className="text-2xl font-semibold tabular-nums">
              {summary.bestSingleScore ?? '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">{t('digestWorstLabel')}</dt>
            <dd className="text-2xl font-semibold tabular-nums">
              {summary.worstSingleScore ?? '—'}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
