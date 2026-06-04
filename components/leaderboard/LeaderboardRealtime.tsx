'use client';

import { useEffect, useRef, useState } from 'react';

import LeaderboardTable from '@/components/leaderboard/LeaderboardTable';
import ReconnectingIndicator from '@/components/leaderboard/ReconnectingIndicator';
import type { Stage } from '@/lib/leaderboard/stage-url-state';
import type { LeaderboardRow } from '@/lib/leaderboard/types';
import { createClient } from '@/lib/supabase/client';

/**
 * `<LeaderboardRealtime/>` — Client wrapper around `<LeaderboardTable/>`
 * that keeps the visible rankings in sync with `leaderboard_snapshots`
 * MV refreshes (feature 004 US-LC T027 / FR-L06, FR-L16-L18, NFR-L2).
 *
 * Why a Client Component wraps a Server one:
 *   - The Server `<LeaderboardPage/>` does the cold-paint fetch from
 *     `leaderboard_snapshots`, so the first byte to the browser already
 *     contains a ranked table (NFR-L1 / SEO).
 *   - On mount, this wrapper takes over: opens a Realtime channel, and
 *     on every `audit_log INSERT WHERE action='leaderboard.refresh'`
 *     event, re-fetches the page slice for the active stage and swaps
 *     it into local state. The table re-renders in place — no page
 *     reload (NFR-L2 ≤ 5 s from scoring commit).
 *
 * Channel + filter contract (matches `<RankWidget/>` verbatim so both
 * surfaces share the same Realtime topology):
 *   - Channel name: `leaderboard-refresh`
 *   - Filter:       `action=eq.leaderboard.refresh`
 *
 * IMPORTANT — column-name deviation from the original sketch:
 *   The live `audit_log` schema names the event-discriminator column
 *   `action` (not `event_type`). The Realtime filter uses
 *   `action=eq.<event>`. See feature 004 contracts +
 *   migration 0034.
 *
 * Reconnect indicator (FR-L18):
 *   `@supabase/supabase-js` reconnects with exponential backoff. We
 *   start a 10-second `setTimeout` whenever the subscribe status leaves
 *   `SUBSCRIBED`, and clear it when the status comes back. If the timer
 *   fires before we recover, we flip `reconnecting=true` and the chip
 *   appears. On recovery we clear the timer, flip the flag back, and
 *   trigger one extra re-fetch to catch up on anything we missed.
 *
 * Stage / page changes (FR-L17):
 *   The effect's dep list includes `activeStage` and `currentPage`, so
 *   when the URL changes (server-side push from `<StageTabStrip/>` or
 *   pagination link), this wrapper re-mounts the channel against the
 *   new slice. The previous channel is unsubscribed cleanly. Strictly
 *   the channel could be a singleton (the filter is stage-agnostic),
 *   but tearing down + reopening keeps the re-fetch closure trivially
 *   correct and avoids leaked listeners — same trade-off captured in
 *   contracts/realtime-channel-leaderboard-snapshots.md.
 */

const REALTIME_CHANNEL = 'leaderboard-refresh';
const REALTIME_FILTER = 'action=eq.leaderboard.refresh';
const ROWS_PER_PAGE = 25;
const RECONNECT_THRESHOLD_MS = 10_000;

type LeaderboardRealtimeProps = {
  initialRows: LeaderboardRow[];
  activeStage: Stage;
  currentPage: number;
  locale: string;
  selfParticipantId: string | null;
};

export default function LeaderboardRealtime({
  initialRows,
  activeStage,
  currentPage,
  locale,
  selfParticipantId,
}: LeaderboardRealtimeProps): React.ReactElement {
  const [rows, setRows] = useState<LeaderboardRow[]>(initialRows);
  const [reconnecting, setReconnecting] = useState<boolean>(false);

  // Hold the 10s-threshold timer so the cleanup path can clear it.
  // Using a ref (not state) avoids re-rendering when the timer is
  // started or stopped.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track the last `initialRows` reference via state. When the parent
  // delivers fresh SSR rows (e.g. on stage / page change before the
  // Realtime channel has re-fetched), the comparison below schedules
  // a state reset for the next render — this is the React-idiomatic
  // "reset state when a prop changes" pattern from
  // https://react.dev/learn/you-might-not-need-an-effect#resetting-all-state-when-a-prop-changes
  // and avoids both the `react-hooks/set-state-in-effect` and
  // `react-hooks/refs` lints.
  const [lastInitialRows, setLastInitialRows] = useState<LeaderboardRow[]>(initialRows);
  if (lastInitialRows !== initialRows) {
    setLastInitialRows(initialRows);
    setRows(initialRows);
  }

  useEffect(() => {
    const supabase = createClient();

    const refetch = async (): Promise<void> => {
      const offset = (currentPage - 1) * ROWS_PER_PAGE;
      const { data, error } = await supabase
        .from('leaderboard_snapshots')
        .select('participant_id, stage, display_name, total_points, rank, rank_is_shared')
        .eq('stage', activeStage)
        .order('rank', { ascending: true })
        .order('display_name', { ascending: true })
        .range(offset, offset + ROWS_PER_PAGE - 1);

      if (error !== null) {
        // Stale rows are preferable to a half-rendered table. Log
        // structured context per Constitution §1.3. The next refresh
        // event will re-attempt.
        console.error('LeaderboardRealtime: re-fetch failed', {
          code: error.code,
          message: error.message,
          stage: activeStage,
          page: currentPage,
        });
        return;
      }

      setRows((data ?? []) as LeaderboardRow[]);
    };

    const clearReconnectTimer = (): void => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const startReconnectTimer = (): void => {
      // Only one pending timer at a time — if we are already waiting
      // for the threshold, don't restart it.
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
          void refetch();
        },
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearReconnectTimer();
          if (reconnecting) {
            // Recovered after surfacing the chip — clear it and
            // catch up on any events we missed while offline.
            setReconnecting(false);
            void refetch();
          }
        } else {
          // TIMED_OUT, CLOSED, CHANNEL_ERROR — channel is unhealthy.
          // Start the 10s threshold timer; if we don't recover by
          // then, show the chip.
          startReconnectTimer();
        }
      });

    return () => {
      clearReconnectTimer();
      void channel.unsubscribe();
    };
    // `reconnecting` is intentionally excluded from the dep list: it
    // is set/read inside the same effect closure via the subscribe
    // callback and the timer. Re-subscribing the channel every time
    // the chip toggles would be a feedback loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeStage, currentPage]);

  return (
    <>
      <ReconnectingIndicator visible={reconnecting} />
      <LeaderboardTable
        stage={activeStage}
        page={currentPage}
        rows={rows}
        selfParticipantId={selfParticipantId}
        locale={locale}
      />
    </>
  );
}
