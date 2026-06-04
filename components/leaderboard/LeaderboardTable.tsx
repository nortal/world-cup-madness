import { getTranslations } from 'next-intl/server';

import { formatRank } from '@/lib/leaderboard/format-rank';
import type { LeaderboardRow } from '@/lib/leaderboard/types';

/**
 * Leaderboard ranking table (feature 004 US-LA T013 / FR-L01-L03, FR-L09, FR-L15).
 *
 * Pure presentational Server Component. The data fetch lives in the parent
 * composer (LeaderboardPage T015); this component renders an accessible
 * `<table>` from the supplied `rows` prop. Tailwind utility classes keep
 * the layout usable at the 360 px minimum mobile width (FR-L15) — the
 * rank + name + points columns are sized to fit without horizontal scroll.
 *
 * Self-row identification:
 *   - The `<tr>` for the authenticated participant carries
 *     `data-self="true"` so the client-side "Show my rank" button
 *     (T014) can locate it via `document.querySelector('[data-self="true"]')`.
 *   - A visually-hidden screen-reader span announces "Your rank" on the
 *     self row (a11y for FR-L09).
 *
 * The `rank_is_shared` flag drives the `=` suffix rendering via
 * `formatRank()` (FR-L03 + spec.md §8 UX); it's computed server-side in
 * the materialised view so the client never has to determine sharedness.
 */

type LeaderboardTableProps = {
  stage: string;
  page: number;
  rows: readonly LeaderboardRow[];
  selfParticipantId: string | null;
  locale: string;
};

export default async function LeaderboardTable({
  stage,
  page,
  rows,
  selfParticipantId,
  // `locale` is part of the contract for future formatting needs
  // (e.g. tabular-numbers for points in pt-BR); kept on the prop list
  // so the parent (T015) doesn't refactor when US-LE adds locale-aware
  // count formatting.
  locale: _locale,
}: LeaderboardTableProps): Promise<React.ReactElement> {
  const t = await getTranslations('leaderboard');

  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">
          {t('pageHeading')} — {stage}, {t('pageIndicator', { page })}
        </caption>
        <thead>
          <tr className="border-b border-gray-300">
            <th scope="col" className="py-2 pr-3 font-semibold tabular-nums">
              {t('rankColumn')}
            </th>
            <th scope="col" className="py-2 pr-3 font-semibold">
              {t('nameColumn')}
            </th>
            <th scope="col" className="py-2 text-right font-semibold tabular-nums">
              {t('pointsColumn')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isSelf =
              selfParticipantId !== null && row.participant_id === selfParticipantId;
            // `rank_is_shared` and `rank` come from the MV's RANK() window
            // function — both are NOT NULL at the SQL level, but the
            // generated row type allows null because Supabase's view-type
            // generator can't infer NOT NULL across the MV's UNION ALL.
            const rankValue = row.rank ?? 0;
            const isShared = row.rank_is_shared ?? false;
            return (
              <tr
                key={`${row.participant_id ?? 'unknown'}-${row.stage ?? stage}`}
                id={isSelf ? 'self-row' : undefined}
                data-self={isSelf ? 'true' : undefined}
                className={
                  isSelf
                    ? 'border-b border-amber-200 bg-amber-50/50'
                    : 'border-b border-gray-100'
                }
              >
                <td className="py-2 pr-3 tabular-nums">
                  {formatRank(rankValue, isShared)}
                  {isSelf && <span className="sr-only"> — {t('yourRankSrLabel')}</span>}
                </td>
                <td className="py-2 pr-3 break-words">{row.display_name ?? ''}</td>
                <td className="py-2 text-right tabular-nums">{row.total_points ?? 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
