# Contract: Supabase Realtime subscription via `audit_log` event proxy

**Feature**: 004 | **Spec**: FR-L06, FR-L16, FR-L17, FR-L18, FC-L3 | **Research**: R-2

## Pattern

Per R-2, the page does NOT subscribe directly to `leaderboard_snapshots`. Instead, it subscribes to `audit_log` rows filtered by `event_type IN ('leaderboard.refresh', 'leaderboard.refresh_failed')`. On each event, the client re-fetches `leaderboard_snapshots` for the active stage tab (and the dashboard widget re-fetches its own self-row).

## Why this shape

- Materialised view refresh emits ~1,200 per-row replication events (one per row in the refreshed MV) — overwhelming for clients.
- The audit-event proxy reduces this to ONE event per refresh, carrying just metadata. Client does one re-fetch to pick up the new state.
- The wire payload contains only the audit_log row fields (event_type, created_at, new_value) — NEVER any participant points or rankings. FC-L3 / NFR-L6 enforced at the wire level.

## Subscription scope

```ts
const channel = supabase
  .channel('leaderboard-refresh')
  .on(
    'postgres_changes',
    {
      event: 'INSERT',
      schema: 'public',
      table: 'audit_log',
      filter: 'event_type=eq.leaderboard.refresh',
    },
    (payload) => {
      // payload.new = {event_type, entity_type, entity_id, actor_id, new_value, created_at}
      // Re-fetch the leaderboard for the active stage.
      void refetchActiveStageRanking();
    },
  )
  .subscribe();
```

Failure events (`leaderboard.refresh_failed`) are NOT subscribed to by the page — failures are operator concerns, not participant-facing.

## Reconnection (FR-L18)

`@supabase/supabase-js` Realtime reconnects automatically with exponential backoff. The client tracks the channel state via the `status` parameter of `subscribe((status) => {...})`:

- `SUBSCRIBED` — healthy
- `TIMED_OUT` or `CLOSED` — connection lost; reconnect attempts ongoing
- After 10 s in non-SUBSCRIBED state → show `<ReconnectingIndicator/>` chip
- Once back to `SUBSCRIBED` → hide indicator + force one re-fetch to catch up

## Channel-cancellation on stage change (FR-L17)

When the active stage tab changes, the previous channel is cancelled and a new one opened — actually unnecessary in this implementation because the channel is the SAME for all stages (it's a generic `leaderboard.refresh` event listener); only the re-fetch query differs by active stage. So strictly: one channel for the whole page lifetime, with the re-fetch closure capturing the current stage. The `cancelPreviousSubscription` requirement in FR-L17 is satisfied at the *re-fetch-closure* level rather than the channel level. Documented in `<LeaderboardRealtime/>` Component.

## Payload sizes

- Per event: ~150 bytes (event_type, created_at, new_value JSONB stub).
- Per re-fetch: ~10 KB (200 rows × 5 columns × ~10 bytes/column).
- Cron tick at 5-min cadence × 50 concurrent subscribers = 50 events/min, 500 KB/min total. Well within Supabase Realtime free-tier limits.

## Privacy validation (TC-L12)

The wire payload contains ONLY the audit_log row, never participant scores. Verified by `leaderboard-privacy.spec.ts`:
1. Open `/leaderboard` as participant A.
2. Trigger a scoring event for participant B.
3. Capture the Realtime WebSocket frame.
4. Assert: frame contains `audit_log` row metadata; does NOT contain any `exact_hits`, `outcome_hits`, `final_points`, or per-source score data.

## pgTAP coverage

The Realtime publication is database-configured (Supabase Realtime infrastructure); no pgTAP test for the subscription itself. Indirectly tested:
- `022_*.sql` asserts the audit row exists with the right `event_type`.
- Playwright `leaderboard-realtime.spec.ts` asserts end-to-end: scoring trigger fires → audit row inserted → client receives event → re-fetch → table updates (NFR-L2: ≤ 5 s).
