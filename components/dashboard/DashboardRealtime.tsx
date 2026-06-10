'use client';

import { useRouter } from 'next/navigation';
import { createContext, useEffect, useRef, useState, useTransition } from 'react';

import ReconnectingIndicator from '@/components/leaderboard/ReconnectingIndicator';
import type { DashboardTab } from '@/lib/dashboard/tab-url-state';
import { createClient } from '@/lib/supabase/client';

/**
 * `<DashboardRealtime/>` — Client wrapper that keeps the dashboard's
 * Server-rendered widgets in sync with `leaderboard_snapshots` MV
 * refreshes (feature 005 US-DD T036 / FR-D15-D17).
 *
 * Stale-while-revalidate pattern (research §R-2):
 *   - Server Components render the cold-paint widget tree with fresh
 *     data on the route handler's request.
 *   - On mount, this wrapper opens the `leaderboard-refresh` Realtime
 *     channel (same topic + filter as `<LeaderboardRealtime/>` and
 *     `<RankWidget/>` so all three surfaces share one server-side
 *     subscription).
 *   - On each `audit_log INSERT WHERE action='leaderboard.refresh'`
 *     event, we DEBOUNCE 300 ms and then call `router.refresh()` inside
 *     `startTransition`. Next.js re-runs the route's Server Components
 *     with fresh data; the widget DOM updates in place — no unmount,
 *     zero CLS, no content flicker.
 *   - `useTransition`'s `isPending` flips true for the duration of the
 *     transition and back to false once the new tree commits — that's
 *     the exact source-of-truth the `<RefreshingChip/>` reads via the
 *     `DashboardRefreshContext` Provider below.
 *
 * Why a Context (not props): `<RefreshingChip/>` mounts in the page
 * header (above the tab strip), while the widgets it announces live
 * below this wrapper's `children`. The chip is rendered as a sibling
 * of the wrapper, so prop drilling would require lifting state into
 * DashboardPage (a Server Component — can't hold transition state). A
 * Context Provider here lets the chip subscribe from anywhere inside
 * the same subtree without DashboardPage owning the state.
 *
 * Reconnect indicator (FR-D17):
 *   Mirrors feature 004's `<LeaderboardRealtime/>`: we start a 10 s
 *   `setTimeout` whenever the channel leaves `SUBSCRIBED`, and clear
 *   it on recovery. If the timer fires, we flip `reconnecting=true`
 *   and `<ReconnectingIndicator/>` appears. On recovery we also fire
 *   one extra `router.refresh()` to catch up on missed events.
 */

const REALTIME_CHANNEL = 'leaderboard-refresh';
const REALTIME_FILTER = 'action=eq.leaderboard.refresh';
const DEBOUNCE_MS = 300;
const RECONNECT_THRESHOLD_MS = 10_000;

export const DashboardRefreshContext = createContext<{ isRefetching: boolean }>({
  isRefetching: false,
});

type DashboardRealtimeProps = {
  children: React.ReactNode;
  // `activeTab` is part of the prop contract per the T036 brief so a
  // future per-tab subscription scope can land without changing the
  // public surface. Currently unused — the channel filter is tab-
  // agnostic and one re-fetch refreshes both tab panels in lock-step.
  activeTab: DashboardTab;
};

export default function DashboardRealtime({
  children,
  activeTab: _activeTab,
}: DashboardRealtimeProps): React.ReactElement {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [reconnecting, setReconnecting] = useState<boolean>(false);

  // Debounce timer — burst of refresh events within 300 ms collapses to
  // one router.refresh().
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reconnect threshold timer — 10 s of no SUBSCRIBED before we surface
  // the chip.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const supabase = createClient();

    const fireRefresh = (): void => {
      startTransition(() => {
        router.refresh();
      });
    };

    const clearDebounceTimer = (): void => {
      if (debounceTimerRef.current !== null) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };

    const clearReconnectTimer = (): void => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const startReconnectTimer = (): void => {
      if (reconnectTimerRef.current !== null) return;
      reconnectTimerRef.current = setTimeout(() => {
        setReconnecting(true);
        reconnectTimerRef.current = null;
      }, RECONNECT_THRESHOLD_MS);
    };

    const channel = supabase
      .channel(REALTIME_CHANNEL)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'audit_log',
          filter: REALTIME_FILTER,
        },
        () => {
          clearDebounceTimer();
          debounceTimerRef.current = setTimeout(() => {
            debounceTimerRef.current = null;
            fireRefresh();
          }, DEBOUNCE_MS);
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearReconnectTimer();
          if (reconnecting) {
            setReconnecting(false);
            fireRefresh();
          }
        } else {
          startReconnectTimer();
        }
      });

    return () => {
      clearDebounceTimer();
      clearReconnectTimer();
      void channel.unsubscribe();
    };
    // `reconnecting` is intentionally excluded — see the matching
    // exclusion in `<LeaderboardRealtime/>`. Re-subscribing the channel
    // every time the chip toggles would be a feedback loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  return (
    <DashboardRefreshContext.Provider value={{ isRefetching: isPending }}>
      <ReconnectingIndicator visible={reconnecting} />
      {children}
    </DashboardRefreshContext.Provider>
  );
}
