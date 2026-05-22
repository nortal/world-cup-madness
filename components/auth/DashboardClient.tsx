'use client';

import type { ReactNode } from 'react';

import WelcomeModal from './WelcomeModal';

/**
 * Dashboard client wrapper (US5 / T058 — FR-A3).
 *
 * Sole responsibility: decide whether to mount `<WelcomeModal />`. The
 * dashboard page (Server Component) derives `isFirstLogin` from the
 * participant row (`welcome_dismissed_at === null`) and passes the boolean
 * here so the modal can be mounted from a Client Component boundary — the
 * modal itself uses hooks + the browser supabase client and cannot live in
 * the Server Component tree.
 *
 * The original dashboard subtree (greeting, admin nav link, empty state) is
 * passed through `children` so it stays fully server-rendered. Only the
 * modal-mounting decision crosses the client boundary; the dashboard content
 * does NOT need to re-hydrate as a Client Component.
 *
 * Why a wrapper instead of conditionally rendering `<WelcomeModal />` as a
 * sibling on the page: `<WelcomeModal />` is a Client Component, so the
 * dashboard page (Server Component) can already import and conditionally
 * render it directly. The wrapper exists per T058's contract so future US5
 * follow-ups (e.g. mounting other client-only dashboard widgets gated on
 * participant state) have a single attachment point.
 */
type DashboardClientProps = {
  isFirstLogin: boolean;
  children: ReactNode;
};

export default function DashboardClient({ isFirstLogin, children }: DashboardClientProps) {
  return (
    <>
      {children}
      {isFirstLogin && <WelcomeModal />}
    </>
  );
}
