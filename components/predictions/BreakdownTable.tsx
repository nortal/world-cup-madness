import { getTranslations } from 'next-intl/server';

import { formatScoreSource, type ScoreEventSource, type BreakdownLocale } from '@/lib/predictions/scoring-display';

/**
 * Personal score breakdown table (feature 003 US-PD / FR-P27).
 *
 * Server Component. Renders an accessible <table> of the participant's
 * score events (match label, source label, points) plus a running total
 * via a semantic <output>. Empty-state message when there are no events.
 */

export type BreakdownRow = {
  id: string;
  source: ScoreEventSource;
  points: number;
  matchLabel: string | null; // "ENG vs FRA" or null for final-prediction rows
};

type BreakdownTableProps = {
  rows: readonly BreakdownRow[];
  totalPoints: number;
  locale: BreakdownLocale;
};

export default async function BreakdownTable({ rows, totalPoints, locale }: BreakdownTableProps) {
  const t = await getTranslations('predictions');

  if (rows.length === 0) {
    return (
      <p className="mt-6 text-base text-gray-600">{t('breakdown.emptyState')}</p>
    );
  }

  return (
    <div className="mt-6">
      <table className="w-full border-collapse text-left text-sm">
        <caption className="sr-only">{t('breakdown.tableCaption')}</caption>
        <thead>
          <tr className="border-b border-gray-300">
            <th scope="col" className="py-2 pr-4 font-semibold">{t('breakdown.colMatch')}</th>
            <th scope="col" className="py-2 pr-4 font-semibold">{t('breakdown.colResult')}</th>
            <th scope="col" className="py-2 text-right font-semibold">{t('breakdown.colPoints')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-gray-100">
              <td className="py-2 pr-4">{row.matchLabel ?? t('breakdown.finalPredictionLabel')}</td>
              <td className="py-2 pr-4">{formatScoreSource(row.source, locale)}</td>
              <td className="py-2 text-right tabular-nums">{row.points}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-gray-300">
            <td className="py-2 pr-4 font-semibold" colSpan={2}>{t('breakdown.totalLabel')}</td>
            <td className="py-2 text-right font-semibold tabular-nums">
              <output aria-label={t('breakdown.totalLabel')}>{totalPoints}</output>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
