import { getTranslations } from 'next-intl/server';

import { lockBadgeState, type LockBadge as LockBadgeKind, type MatchStatus } from '@/lib/matches/lock-badge';

/**
 * Lock-state badge for a match row (FR-M08).
 *
 * Server Component — wraps the pure derivation helper `lockBadgeState()` from
 * `lib/matches/lock-badge.ts` and renders one of three badge states:
 * `UPCOMING`, `LOCKED`, or `FINISHED`. All lock math (including the inverted
 * BR-LOCK-003 boundary at kickoff − 60min inclusive) lives in that helper; this
 * component is intentionally thin and never recomputes lock state inline.
 *
 * Server Component on purpose — `getTranslations` (from `next-intl/server`) is
 * used instead of the client `useTranslations` hook so the badge can render
 * inside Server Components (`MatchCard.tsx` / `MatchDetailCard.tsx` / the
 * dashboard widget) without forcing a `'use client'` boundary on any caller.
 * The detail page additionally renders `LockCountdownTicker.tsx` (Client
 * Component, T032) which is hydrated with the initial badge state computed
 * server-side, so the client ticker only re-renders the badge when the
 * 60-minute boundary is actually crossed.
 *
 * `nowUtc` is injected by the caller (rather than read here via `new Date()`)
 * so the derivation is deterministic and the page-level `revalidate: 60`
 * caching keys naturally on the same trusted server time the page used to
 * fetch its data.
 *
 * Accessibility (NFR-M3 / WCAG 2.1 AA): the visible badge text — not the
 * background color — is the source of truth, and `role="status"` lets screen
 * readers announce the new state when a re-render swaps the badge.
 *
 * Translation namespace: `matches.badge` (keys: `upcoming`, `locked`,
 * `finished`).
 */

type LockBadgeProps = {
  kickoffUtc: Date | null;
  status: MatchStatus;
  nowUtc: Date;
};

const BADGE_STYLES: Record<LockBadgeKind, string> = {
  UPCOMING: 'bg-blue-100 text-blue-800',
  LOCKED: 'bg-amber-100 text-amber-800',
  FINISHED: 'bg-slate-200 text-slate-700',
};

const BADGE_LABEL_KEYS: Record<LockBadgeKind, 'upcoming' | 'locked' | 'finished'> = {
  UPCOMING: 'upcoming',
  LOCKED: 'locked',
  FINISHED: 'finished',
};

export default async function LockBadge({ kickoffUtc, status, nowUtc }: LockBadgeProps) {
  const t = await getTranslations('matches.badge');
  const state = lockBadgeState(kickoffUtc, status, nowUtc);

  return (
    <span
      role="status"
      className={`inline-block rounded-md px-2 py-1 text-xs font-semibold uppercase tracking-wide ${BADGE_STYLES[state]}`}
    >
      {t(BADGE_LABEL_KEYS[state])}
    </span>
  );
}
