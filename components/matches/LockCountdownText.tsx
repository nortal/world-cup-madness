import { getTranslations } from 'next-intl/server';

/**
 * Server-rendered lock countdown text (FR-M09).
 *
 * Server Component — renders the supporting "Locks in 2h 14m" text that sits
 * next to the `UPCOMING` `LockBadge` on match list cards and on the dashboard
 * "next matches" widget. The badge is the visual anchor; this text is
 * secondary, hence the muted `text-sm text-gray-600` styling.
 *
 * Boundary semantics (BR-LOCK-003): the lock fires at kickoff − 60min
 * INCLUSIVE — at exactly that instant a match is already `LOCKED`. Internally
 * we shift the comparison by subtracting 60 minutes from the remaining
 * kickoff delta, so `remainingMs` here is "time until the lock boundary,"
 * not "time until kickoff." When that hits zero the badge has already
 * flipped to `LOCKED` and the caller should no longer render this component;
 * the `remainingMs <= 0` early-return is purely defensive.
 *
 * The match DETAIL page renders `LockCountdownTicker.tsx` (T032) instead —
 * that variant is a Client Component that ticks per-second (including a
 * `m s` template) and updates `aria-live`. This text variant intentionally
 * never renders seconds: a server-rendered page is cached on a `revalidate:
 * 60` cadence, so second-level precision would be misleading.
 *
 * The `lockingNow` fallback covers the narrow window where hours and
 * minutes both floor to zero — i.e. the page was rendered up to ~60s before
 * the boundary and is being read just before the next revalidation. Showing
 * "Locking now" is more honest than "Locks in 0m".
 *
 * Translation namespace: `matches.countdown` (keys: `locksIn`,
 * `hoursMinutes`, `minutesOnly`, `lockingNow`).
 */

type LockCountdownTextProps = {
  kickoffUtc: Date;
  nowUtc: Date;
};

const LOCK_WINDOW_MS = 60 * 60 * 1000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export default async function LockCountdownText({ kickoffUtc, nowUtc }: LockCountdownTextProps) {
  const remainingMs = kickoffUtc.getTime() - nowUtc.getTime() - LOCK_WINDOW_MS;

  if (remainingMs <= 0) {
    return null;
  }

  const t = await getTranslations('matches.countdown');

  const hours = Math.floor(remainingMs / HOUR_MS);
  const minutes = Math.floor((remainingMs % HOUR_MS) / MINUTE_MS);

  let time: string;
  if (hours > 0) {
    time = t('hoursMinutes', { hours, minutes });
  } else if (minutes > 0) {
    time = t('minutesOnly', { minutes });
  } else {
    time = t('lockingNow');
  }

  return <span className="text-sm text-gray-600">{t('locksIn', { time })}</span>;
}
