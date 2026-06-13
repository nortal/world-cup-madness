'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

/**
 * `<GlobalNav/>` — top-level navigation rendered above every authenticated
 * participant route via `app/(participant)/layout.tsx`.
 *
 * Client Component because:
 *   1. `usePathname()` is needed to highlight the active route (Next.js
 *      pulls this from the App Router state, not from request headers).
 *   2. The Sign out gesture is a `<form action="/auth/sign-out" method="POST">`
 *      — CSRF-safer than a GET link per the auth/sign-out route's docstring,
 *      and rendering the form body needs no client state but `<form>` inside
 *      a Server Component is fine. We keep the whole nav as one Client
 *      Component for code locality.
 *
 * Items rendered (in order):
 *   - Dashboard, Matches, Leaderboard, Final predictions, Your breakdown,
 *     Profile — visible to every authenticated participant.
 *   - Admin console — visible only when `isAdmin === true` (computed in the
 *     parent Server Component layout from `participants.role`).
 *   - Sign out (rightmost, separated visually) — always visible.
 *
 * Active highlighting: the link whose `href` matches `usePathname()` gets
 * `aria-current="page"` + a Tailwind background change. Nested routes
 * (e.g., `/matches/abc-123` under `/matches`) light up the parent link too
 * via `pathname.startsWith(href)`.
 *
 * The wrapping `<nav aria-label="Main navigation">` exposes the landmark to
 * screen readers. The active link's `aria-current="page"` is the WAI-ARIA
 * pattern for "this is the current location" — no extra `aria-label` needed.
 */

type GlobalNavProps = {
  displayName: string;
  isAdmin: boolean;
};

type NavItem = {
  href: string;
  labelKey: 'dashboard' | 'matches' | 'leaderboard' | 'finalPredictions' | 'breakdown' | 'profile';
};

const BASE_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', labelKey: 'dashboard' },
  { href: '/matches', labelKey: 'matches' },
  { href: '/leaderboard', labelKey: 'leaderboard' },
  { href: '/predictions/final', labelKey: 'finalPredictions' },
  { href: '/predictions/breakdown', labelKey: 'breakdown' },
  { href: '/profile', labelKey: 'profile' },
] as const;

function isActive(pathname: string | null, href: string): boolean {
  if (pathname === null) return false;
  if (pathname === href) return true;
  // `/matches/abc-123` lights up `/matches`. Don't false-positive on
  // `/predictions/final` matching `/predictions/breakdown` — the explicit
  // exact match above handles those.
  return pathname.startsWith(href + '/');
}

export default function GlobalNav({ displayName, isAdmin }: GlobalNavProps): React.ReactElement {
  const t = useTranslations('nav');
  const pathname = usePathname();

  const linkClasses = (active: boolean): string =>
    'rounded-md px-3 py-1.5 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-blue-500 ' +
    (active
      ? 'bg-blue-600 text-white shadow-sm'
      : 'text-gray-700 hover:bg-gray-100');

  return (
    <nav
      aria-label={t('ariaLabel')}
      className="border-b border-gray-200 bg-white"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
        {/* Left cluster — every-participant routes */}
        <ul className="flex flex-wrap items-center gap-1">
          {BASE_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={linkClasses(active)}
                >
                  {t(item.labelKey)}
                </Link>
              </li>
            );
          })}
          {isAdmin && (
            <li>
              <Link
                href="/admin"
                aria-current={isActive(pathname, '/admin') ? 'page' : undefined}
                className={linkClasses(isActive(pathname, '/admin'))}
              >
                {t('adminConsole')}
              </Link>
            </li>
          )}
        </ul>

        {/* Right cluster — identity + sign out. Pushed to the right via
            `ml-auto` so the visible nav balances at any viewport width. */}
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-sm text-gray-600 sm:inline" aria-hidden="true">
            {displayName}
          </span>
          <form action="/auth/sign-out" method="POST">
            <button
              type="submit"
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {t('signOut')}
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
