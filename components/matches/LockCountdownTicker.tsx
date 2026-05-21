'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/**
 * Per-second lock countdown ticker for the match detail page (FR-M10).
 *
 * Client Component, deliberately presentational only (NFR-M2 / BR-LOCK-001):
 * the authoritative lock state lives in Postgres and is computed at render
 * time by the server-rendered `LockBadge` on the same page. This ticker
 * hydrates with that same `initialBadge` and only re-renders the badge once
 * the per-second countdown locally crosses zero. The next page navigation
 * (or `revalidate: 60` re-render) re-syncs to the server's source of truth,
 * so a wrong system clock at worst desyncs the visible badge for one render
 * cycle — it cannot grant or revoke prediction edit rights, which are
 * enforced by RLS on the server.
 *
 * Drift compensation: the initial countdown value comes from `serverNowUtc`
 * and `kickoffUtc` (both ISO strings from the server — pure inputs). Once
 * the interval starts inside `useEffect` (the only place React's rules
 * permit impure calls), we measure wall time elapsed since mount via
 * `Date.now() - mountClientMs` and add that to the server time we rendered
 * against. This anchors the countdown to server time regardless of how the
 * client clock drifts later — and naturally absorbs the small drift that
 * exists at mount.
 *
 * `aria-live="polite"`: screen readers should announce updates without
 * interrupting other content. The countdown updates once per second, which
 * is too noisy for `aria-live="assertive"` but useful enough to surface
 * politely so AT users hear the impending lock window.
 *
 * Boundary semantics (BR-LOCK-003 inverted): lock fires at kickoff − 60min
 * inclusive. Internally we tick down "time until the lock boundary," so
 * `remaining` hitting zero IS the lock event.
 *
 * Translation namespaces:
 *   - `matches.countdown` (`minutesSeconds`)
 *   - `matches.badge` (`upcoming`, `locked`, `finished`)
 */

type LockCountdownTickerBadge = 'UPCOMING' | 'LOCKED' | 'FINISHED';

type LockCountdownTickerProps = {
  /** ISO 8601 kickoff time. Server Components serialise `Date` → string when
   *  passing props across the Server/Client boundary, so we accept the wire
   *  shape directly. */
  kickoffUtc: string;
  /** ISO of server time at render — used as the anchor for drift compensation. */
  serverNowUtc: string;
  /** Server-authoritative initial badge from `lockBadgeState()`. */
  initialBadge: LockCountdownTickerBadge;
};

const LOCK_WINDOW_MS = 60 * 60 * 1000;
const MINUTE_SEC = 60;

const BADGE_STYLES: Record<LockCountdownTickerBadge, string> = {
  UPCOMING: 'bg-blue-100 text-blue-800',
  LOCKED: 'bg-amber-100 text-amber-800',
  FINISHED: 'bg-slate-200 text-slate-700',
};

const BADGE_LABEL_KEYS: Record<LockCountdownTickerBadge, 'upcoming' | 'locked' | 'finished'> = {
  UPCOMING: 'upcoming',
  LOCKED: 'locked',
  FINISHED: 'finished',
};

/**
 * Pure helper: compute seconds remaining until the lock boundary given a
 * kickoff timestamp and an "effective server now" (the server time we
 * rendered against, plus client-measured wall time elapsed since mount).
 * Returns a non-negative integer; zero means the boundary has been reached.
 */
function computeRemainingSec(kickoffMs: number, effectiveServerNowMs: number): number {
  return Math.max(
    0,
    Math.floor((kickoffMs - LOCK_WINDOW_MS - effectiveServerNowMs) / 1000),
  );
}

export default function LockCountdownTicker({
  kickoffUtc,
  serverNowUtc,
  initialBadge,
}: LockCountdownTickerProps) {
  const tBadge = useTranslations('matches.badge');
  const tCountdown = useTranslations('matches.countdown');

  // Pure lazy initialisers: `new Date(string).getTime()` is referentially
  // transparent. Both useState values stay constant for the component's
  // lifetime — a fresh server render produces a fresh component instance.
  const [kickoffMs] = useState<number>(() => new Date(kickoffUtc).getTime());
  const [serverNowMs] = useState<number>(() => new Date(serverNowUtc).getTime());

  // Initial `remaining` is computed PURELY from the two server-supplied
  // timestamps — no `Date.now()` needed for the initial render, which keeps
  // the lazy initialiser pure (react-hooks/purity compliant).
  const [remaining, setRemaining] = useState<number>(() =>
    computeRemainingSec(kickoffMs, serverNowMs),
  );

  const [badge, setBadge] = useState<LockCountdownTickerBadge>(initialBadge);

  useEffect(() => {
    // Terminal badges (LOCKED/FINISHED) don't tick — no interval needed.
    if (badge !== 'UPCOMING') return;

    // Capture mount-time client clock inside the effect (the only place
    // React's rules permit impure calls like `Date.now()`). `elapsedMs`
    // measured against this snapshot gives wall time since mount; adding
    // it to `serverNowMs` produces "effective server time now" without
    // requiring the client clock to be accurate in absolute terms.
    const mountClientMs = Date.now();

    const intervalId = window.setInterval(() => {
      const elapsedMs = Date.now() - mountClientMs;
      const effectiveServerNowMs = serverNowMs + elapsedMs;
      const next = computeRemainingSec(kickoffMs, effectiveServerNowMs);
      if (next <= 0) {
        setBadge('LOCKED');
        setRemaining(0);
        window.clearInterval(intervalId);
        return;
      }
      setRemaining(next);
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [badge, kickoffMs, serverNowMs]);

  const minutes = Math.floor(remaining / MINUTE_SEC);
  const seconds = remaining % MINUTE_SEC;

  return (
    <span className="inline-flex items-center gap-2">
      <span
        role="status"
        className={`inline-block rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide ${BADGE_STYLES[badge]}`}
      >
        {tBadge(BADGE_LABEL_KEYS[badge])}
      </span>

      {badge === 'UPCOMING' && (
        <span aria-live="polite" className="text-sm text-gray-600 tabular-nums">
          {remaining >= MINUTE_SEC
            ? tCountdown('minutesSeconds', { minutes, seconds })
            : `${seconds}s`}
        </span>
      )}
    </span>
  );
}
