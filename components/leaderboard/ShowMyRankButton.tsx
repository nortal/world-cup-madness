'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * "Show my rank" button (feature 004 US-LA T014 / FR-L09, TC-L9).
 *
 * Client Component. Computes the paginated location of the participant's
 * row, navigates there if necessary, then scrolls the self row into view
 * and briefly highlights it. Hidden entirely when the participant has no
 * rank yet (pre-tournament / not yet scored).
 *
 * Navigation:
 *   1. Compute `targetPage = ceil(selfRank / rowsPerPage)` — the page that
 *      contains the self row given the current pagination size.
 *   2. `router.push(${baseHref}?stage=${activeStage}&page=${targetPage}#self-row)`
 *      to update the URL.
 *   3. After navigation, locate the `<tr data-self="true">` and
 *      `scrollIntoView({ behavior: 'smooth', block: 'center' })`.
 *   4. Apply a 1.5s Tailwind ring highlight (`ring-2 ring-amber-400`) then
 *      remove it via `setTimeout`.
 *
 * Because the self row may not exist in the DOM yet (the navigation may
 * still be in flight when the click handler resolves), the scroll +
 * highlight are scheduled with a short `requestAnimationFrame` deferral so
 * the new page's table has had at least one render tick to mount.
 */

type ShowMyRankButtonProps = {
  selfRank: number | null;
  rowsPerPage: number;
  activeStage: string;
  baseHref: string;
};

const HIGHLIGHT_CLASS_NAMES = ['ring-2', 'ring-amber-400'] as const;
const HIGHLIGHT_DURATION_MS = 1_500;

export default function ShowMyRankButton({
  selfRank,
  rowsPerPage,
  activeStage,
  baseHref,
}: ShowMyRankButtonProps): React.ReactElement | null {
  const router = useRouter();
  const t = useTranslations('leaderboard');

  if (selfRank === null) {
    // Pre-tournament or participant not yet ranked. Hide the button entirely
    // rather than disable it — there is no row to jump to.
    return null;
  }

  const handleClick = (): void => {
    const targetPage = Math.max(1, Math.ceil(selfRank / rowsPerPage));
    const href = `${baseHref}?stage=${encodeURIComponent(activeStage)}&page=${targetPage}#self-row`;
    router.push(href);

    // Defer the scroll + highlight one paint so the destination row has had
    // a chance to render. We use rAF rather than a fixed timeout so the
    // behaviour adapts to the actual render latency.
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const selfRow = document.querySelector<HTMLElement>('[data-self="true"]');
        if (selfRow === null) {
          return;
        }
        selfRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
        selfRow.classList.add(...HIGHLIGHT_CLASS_NAMES);
        window.setTimeout(() => {
          selfRow.classList.remove(...HIGHLIGHT_CLASS_NAMES);
        }, HIGHLIGHT_DURATION_MS);
      });
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
    >
      {t('showMyRank')}
    </button>
  );
}
