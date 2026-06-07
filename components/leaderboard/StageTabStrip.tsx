'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';

import { formatStageHref, STAGES, type Stage } from '@/lib/leaderboard/stage-url-state';

/**
 * `<StageTabStrip/>` — WAI-ARIA tabs pattern for the leaderboard stage
 * filter (feature 004 US-LB T021 / FR-L04, FR-L05, TC-L7, TC-L8).
 *
 * Client Component because of keyboard navigation + `router.push`. The
 * active stage is passed in by the Server Component composer based on the
 * URL `?stage=` param (so reloading the page preserves the selection per
 * TC-L13).
 *
 * Keyboard model — WAI-ARIA "manual activation" pattern:
 *   - Arrow Left / Arrow Right move focus between tabs (no auto-activate).
 *   - Home / End move focus to the first / last tab.
 *   - Enter / Space activate the currently focused tab.
 * "Manual activation" avoids navigating every time the user arrows past a
 * tab — important here because each activation triggers a network round
 * trip (`router.push` re-renders the Server Component).
 *
 * Horizontal scroll on narrow viewports (FR-L15 — must work at 360px); the
 * `overflow-x-auto` wrapper keeps all 6 tabs reachable on mobile.
 */

type StageTabStripProps = {
  activeStage: Stage;
  baseHref: string;
  labels: Record<Stage, string>;
  ariaLabel: string;
};

export default function StageTabStrip({
  activeStage,
  baseHref: _baseHref,
  labels,
  ariaLabel,
}: StageTabStripProps): React.ReactElement {
  const router = useRouter();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function activate(stage: Stage): void {
    router.push(formatStageHref(stage));
  }

  function focusTab(index: number): void {
    const wrapped = (index + STAGES.length) % STAGES.length;
    tabRefs.current[wrapped]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab(index + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(STAGES.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        activate(STAGES[index]);
        break;
      default:
        break;
    }
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className="-mx-4 mt-6 overflow-x-auto px-4">
      <div className="flex min-w-max items-center gap-2">
        {STAGES.map((stage, index) => {
          const isActive = stage === activeStage;
          return (
            <button
              key={stage}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls="leaderboard-table"
              tabIndex={isActive ? 0 : -1}
              onClick={() => activate(stage)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={
                'rounded-md px-3 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500 ' +
                (isActive
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
              }
            >
              {labels[stage]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
