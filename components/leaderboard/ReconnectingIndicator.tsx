'use client';

import { useTranslations } from 'next-intl';

/**
 * `<ReconnectingIndicator/>` — small status chip surfaced when the
 * leaderboard's Realtime channel has been in a non-`SUBSCRIBED` state
 * for more than 10 seconds (feature 004 US-LC T026 / FR-L18).
 *
 * Render rules:
 *   - `visible === false`: returns `null` — no DOM, no a11y noise. The
 *     chip is suppressed for the common case where the channel is
 *     healthy.
 *   - `visible === true`: renders a single `<div role="status">` chip in
 *     the top-right corner. `role="status"` carries `aria-live="polite"`
 *     by default per WCAG, so screen readers announce the reconnection
 *     attempt without interrupting other content.
 *
 * The decision to show / hide and the 10-second threshold live in the
 * parent `<LeaderboardRealtime/>`; this component is intentionally a
 * pure presentational view of one boolean.
 */

type ReconnectingIndicatorProps = {
  visible: boolean;
};

export default function ReconnectingIndicator({
  visible,
}: ReconnectingIndicatorProps): React.ReactElement | null {
  const t = useTranslations('leaderboard');

  if (!visible) {
    return null;
  }

  return (
    <div
      role="status"
      className="fixed right-4 top-4 z-50 rounded-md bg-amber-100 px-3 py-1 text-sm text-amber-800 shadow-md"
    >
      {t('reconnecting')}
    </div>
  );
}
