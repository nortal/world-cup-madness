import { getTranslations } from 'next-intl/server';

/**
 * Read-only view of a participant's prediction after the lock has fired
 * (feature 003 US-PA / FR-P05).
 *
 * Server Component — pure render. Uses semantic <dl> + <dd> (not styled
 * disabled inputs) so axe-core a11y check passes (disabled inputs are
 * announced confusingly by screen readers when used as data display).
 *
 * Rendered by app/(participant)/matches/[id]/page.tsx when the server-side
 * lock check (`kickoff_utc - now() <= 60 minutes`) is true AND the
 * participant has submitted a prediction. The locked-but-no-prediction
 * case is handled inside <PredictionForm/> itself (it renders a static
 * message instead of the form).
 */

type LockedPredictionDisplayProps = {
  prediction: { home: number; away: number };
};

export default async function LockedPredictionDisplay({
  prediction,
}: LockedPredictionDisplayProps) {
  const t = await getTranslations('predictions');

  return (
    <section
      aria-labelledby="locked-prediction-heading"
      className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4"
    >
      <h2 id="locked-prediction-heading" className="text-lg font-semibold">
        {t('lockedHeading')}
      </h2>

      <dl className="mt-4 flex items-center gap-4 text-xl">
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">{t('homeLabel')}</dt>
          <dd className="mt-1 font-semibold tabular-nums">{prediction.home}</dd>
        </div>
        <span aria-hidden="true" className="text-gray-400">–</span>
        <div>
          <dt className="text-xs uppercase tracking-wide text-gray-500">{t('awayLabel')}</dt>
          <dd className="mt-1 font-semibold tabular-nums">{prediction.away}</dd>
        </div>
      </dl>

      <p className="mt-3 text-sm text-amber-700">{t('lockedNowMessage')}</p>
    </section>
  );
}
