'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';

import InlinePredictionForm from '@/components/matches/InlinePredictionForm';

/**
 * Inline-expandable wrapper around an upcoming-match row (feature 005 US-DB
 * / T014 + T016).
 *
 * Client Component. Wraps the existing `<MatchCard/>` markup (passed in
 * as `children`) with:
 *   1. An expand toggle button on the right side (visible only when the
 *      card is not locked-without-prediction).
 *   2. A `max-h` Tailwind transition that reveals the expanded body — no
 *      JS-measured height (research §R-1: avoids CLS spikes).
 *   3. A sticky lock-countdown badge at the top of the expanded body that
 *      ticks every second and flips to "Locked" once the boundary fires.
 *   4. `<InlinePredictionForm/>` (T013) hosting the score inputs.
 *
 * Lock authority (BR-LOCK-001 / Constitution §IV.1):
 *   - The `locked` prop is computed server-side from the same kickoff_utc
 *     used by the row render — the server is the security boundary.
 *   - The countdown ticker on the client may flip the badge visual to
 *     "Locked" before the next page revalidate, but the actual save is
 *     gated by the `submit_prediction()` RPC (which raises
 *     `PREDICTION_LOCKED` if the server clock disagrees). The
 *     `<InlinePredictionForm/>` therefore receives the OR of server-`locked`
 *     and the client-derived `clientSideLocked` to disable the Save button
 *     visually — neither is authoritative.
 *
 * Spec references: FR-D06, FR-D07, FR-D08; research §R-1.
 *
 * Translation namespace: `dashboard`.
 */

const LOCK_WINDOW_MS = 60 * 60 * 1000;
const COUNTDOWN_TICK_MS = 1000;

type ExpandableMatchCardProps = {
  matchId: string;
  kickoffUtc: string;
  initialHomeScore: number | null;
  initialAwayScore: number | null;
  /** Server-derived lock state. The server is the authority for actually
   *  rejecting saves; this prop only governs initial UI affordance state. */
  locked: boolean;
  /** The existing collapsed-row JSX from the parent (e.g. `<MatchCard/>`).
   *  Rendered unchanged inside the expand toggle so the visual shape of
   *  the row is preserved when collapsed (per task constraint). */
  children: React.ReactNode;
};

export default function ExpandableMatchCard({
  matchId,
  kickoffUtc,
  initialHomeScore,
  initialAwayScore,
  locked,
  children,
}: ExpandableMatchCardProps) {
  const t = useTranslations('dashboard');
  const reactId = useId();
  const panelId = `expand-${reactId}`;

  // The expand affordance is disabled only when the match is locked AND
  // the participant has no existing prediction — there's nothing to read
  // and nothing to save, so the form would serve no purpose.
  const hasExistingPrediction = initialHomeScore !== null && initialAwayScore !== null;
  const isExpandDisabled = locked && !hasExistingPrediction;

  const [isExpanded, setIsExpanded] = useState(false);
  const [clientSideLocked, setClientSideLocked] = useState<boolean>(locked);
  const [countdownText, setCountdownText] = useState<string>(() =>
    initialCountdownText(kickoffUtc, t),
  );

  useEffect(() => {
    // Once locked we stop ticking — the badge text is static "Locked".
    if (clientSideLocked) {
      return;
    }

    function tick() {
      const remainingMs = remainingMsUntilLock(kickoffUtc);
      if (remainingMs <= 0) {
        setClientSideLocked(true);
        setCountdownText(t('lockedBadge'));
        return;
      }
      setCountdownText(t('unlockedBadgeCountdown', { time: formatRemaining(remainingMs) }));
    }

    tick();
    const intervalId = window.setInterval(tick, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [clientSideLocked, kickoffUtc, t]);

  function handleSaved() {
    setIsExpanded(false);
  }

  return (
    <article className="rounded-md border border-gray-200 bg-white">
      <div className="flex w-full items-stretch">
        <div className="min-w-0 flex-1">{children}</div>
        <button
          type="button"
          aria-expanded={isExpanded}
          aria-controls={panelId}
          aria-label={isExpanded ? t('inlineEditCollapse') : t('inlineEditExpand')}
          onClick={() => setIsExpanded((prev) => !prev)}
          disabled={isExpandDisabled}
          className="flex shrink-0 items-center justify-center px-3 text-sm font-medium text-blue-600 hover:text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:text-gray-400"
        >
          {isExpanded ? t('inlineEditCollapse') : t('inlineEditExpand')}
        </button>
      </div>

      <div
        id={panelId}
        className={
          'overflow-hidden transition-all duration-200 ease-in-out ' +
          (isExpanded ? 'max-h-[40rem]' : 'max-h-0')
        }
      >
        {isExpanded && (
          <div className="border-t border-gray-200">
            <div
              role="status"
              aria-live="polite"
              className={
                'sticky top-0 z-10 px-3 py-2 text-sm font-medium ' +
                (clientSideLocked
                  ? 'bg-amber-100 text-amber-800'
                  : 'bg-blue-50 text-blue-800')
              }
            >
              {countdownText}
            </div>

            <InlinePredictionForm
              matchId={matchId}
              initialHomeScore={initialHomeScore}
              initialAwayScore={initialAwayScore}
              onSaved={handleSaved}
              disabled={clientSideLocked}
            />
          </div>
        )}
      </div>
    </article>
  );
}

function remainingMsUntilLock(kickoffUtc: string): number {
  const kickoff = new Date(kickoffUtc).getTime();
  if (Number.isNaN(kickoff)) {
    return 0;
  }
  return kickoff - LOCK_WINDOW_MS - Date.now();
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    return `${hours}h ${remMinutes}m ${seconds}s`;
  }
  return `${minutes}m ${seconds}s`;
}

function initialCountdownText(
  kickoffUtc: string,
  t: ReturnType<typeof useTranslations>,
): string {
  const remainingMs = remainingMsUntilLock(kickoffUtc);
  if (remainingMs <= 0) {
    return t('lockedBadge');
  }
  return t('unlockedBadgeCountdown', { time: formatRemaining(remainingMs) });
}
