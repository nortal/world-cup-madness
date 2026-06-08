'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';

import { formatTabHref, TABS, type DashboardTab } from '@/lib/dashboard/tab-url-state';

/**
 * `<DashboardTabStrip/>` — WAI-ARIA tabs pattern for the mobile dashboard
 * (feature 005 US-DA T008 / FR-D02 + research §R-3).
 *
 * Client Component because of keyboard navigation + `router.push`. Wrapped
 * in `block md:hidden` so the strip only appears on mobile (≤ 768 px); the
 * desktop grid (md+) shows all six widgets at once with no tab strip.
 *
 * Keyboard model — WAI-ARIA "manual activation":
 *   - Arrow Left / Arrow Right move focus between tabs (no auto-activate).
 *   - Home / End move focus to the first / last tab.
 *   - Enter / Space activate the currently focused tab (one router.push).
 *
 * Mirrors feature 004's StageTabStrip pattern; only the tab set differs.
 */

type DashboardTabStripProps = {
  activeTab: DashboardTab;
  labels: Record<DashboardTab, string>;
  ariaLabel: string;
};

export default function DashboardTabStrip({
  activeTab,
  labels,
  ariaLabel,
}: DashboardTabStripProps): React.ReactElement {
  const router = useRouter();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function activate(tab: DashboardTab): void {
    router.push(formatTabHref(tab));
  }

  function focusTab(index: number): void {
    const wrapped = (index + TABS.length) % TABS.length;
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
        focusTab(TABS.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        activate(TABS[index]);
        break;
      default:
        break;
    }
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className="block md:hidden mt-4">
      <div className="flex items-center gap-2">
        {TABS.map((tab, index) => {
          const isActive = tab === activeTab;
          return (
            <button
              key={tab}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              onClick={() => activate(tab)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={
                'flex-1 rounded-md px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500 ' +
                (isActive
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200')
              }
            >
              {labels[tab]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
