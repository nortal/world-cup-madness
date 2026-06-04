import { getTranslations } from 'next-intl/server';

/**
 * Pre-tournament / empty-stage leaderboard placeholder (feature 004 US-LA T012).
 *
 * Server Component shell. Currently renders a single i18n message —
 * `leaderboard.emptyMessage`. The richer countdown body (formatted
 * "Leaderboard opens at [time in user TZ]" + relative countdown) ships in
 * US-LE T036 alongside the `lib/leaderboard/countdown-time.ts` helpers.
 *
 * The `firstKickoffUtc` prop is accepted now (even though it's unused) so
 * that the parent composer (LeaderboardPage T015) and the future US-LE
 * implementation share the same component contract — no parent-side
 * refactor needed when T036 lands.
 */

type EmptyLeaderboardStateProps = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  firstKickoffUtc: Date | null;
};

export default async function EmptyLeaderboardState(
  _props: EmptyLeaderboardStateProps,
): Promise<React.ReactElement> {
  const t = await getTranslations('leaderboard');

  return (
    <section
      className="mx-auto mt-8 max-w-md rounded-md border border-gray-200 bg-gray-50 p-6 text-center"
      aria-live="polite"
    >
      <p className="text-base text-gray-700">{t('emptyMessage')}</p>
    </section>
  );
}
