import { getTranslations } from 'next-intl/server';

import {
  formatCountdownTarget,
  formatRelativeCountdown,
} from '@/lib/leaderboard/countdown-time';

/**
 * Pre-tournament / empty-stage leaderboard placeholder (feature 004 US-LE T036).
 *
 * Server Component. Two render branches:
 *
 *   1. `firstKickoffUtc === null` — no future match scheduled yet (or the
 *      entire match catalog is empty). Renders the localized
 *      `leaderboard.emptyMessage` fallback, same as the US-LA T012 shell.
 *
 *   2. `firstKickoffUtc !== null` — pre-tournament countdown body
 *      (FR-L07 / TC-L3). Renders:
 *        - `<h2>` with the localized `leaderboard.opensAt` heading
 *        - semantic `<time dateTime={ISO}>` with the absolute kickoff
 *          time formatted in the participant's IANA timezone + locale
 *          (`formatCountdownTarget`). The `dateTime` attribute carries the
 *          machine-readable ISO timestamp for assistive tech / scrapers,
 *          while the text body is the human-readable localized rendering.
 *        - `<p>` with the relative phrase ("in 5 days" / etc.) via
 *          `formatRelativeCountdown` evaluated against `new Date()` at
 *          render time — the page is server-rendered, so the relative
 *          phrase reflects the request time; client refresh / re-render
 *          (e.g. via the Realtime audit-event channel) re-evaluates.
 *
 * Accessibility: WCAG 2.1 AA — the `<time>` element with a `dateTime`
 * attribute is the canonical semantic convention for screen-reader date
 * announcements. `aria-live="polite"` on the outer section keeps the
 * countdown swap announced without interrupting other regions.
 */

type EmptyLeaderboardStateProps = {
  firstKickoffUtc: Date | null;
  userTz: string;
  locale: string;
};

export default async function EmptyLeaderboardState({
  firstKickoffUtc,
  userTz,
  locale,
}: EmptyLeaderboardStateProps): Promise<React.ReactElement> {
  const t = await getTranslations('leaderboard');

  if (firstKickoffUtc === null) {
    return (
      <section
        className="mx-auto mt-8 max-w-md rounded-md border border-gray-200 bg-gray-50 p-6 text-center"
        aria-live="polite"
      >
        <p className="text-base text-gray-700">{t('emptyMessage')}</p>
      </section>
    );
  }

  const absoluteLabel = formatCountdownTarget(firstKickoffUtc, userTz, locale);
  const relativeLabel = formatRelativeCountdown(firstKickoffUtc, new Date(), locale);

  return (
    <section
      className="mx-auto mt-8 max-w-md rounded-md border border-gray-200 bg-gray-50 p-6 text-center"
      aria-live="polite"
    >
      <h2 className="text-lg font-semibold text-gray-900">{t('opensAt')}</h2>
      <time
        dateTime={firstKickoffUtc.toISOString()}
        className="mt-2 block text-base text-gray-700 tabular-nums"
      >
        {absoluteLabel}
      </time>
      <p className="mt-2 text-sm text-gray-600">{relativeLabel}</p>
    </section>
  );
}
