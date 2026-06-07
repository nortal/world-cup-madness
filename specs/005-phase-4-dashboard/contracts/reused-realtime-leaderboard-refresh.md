# Contract — `leaderboard-refresh` Realtime channel (REUSED from feature 004)

**Type**: Supabase Realtime channel (`postgres_changes` filter on `audit_log`)
**Source**: Feature 004, migrations `0033_refresh_leaderboard_rpc.sql` + `0037_leaderboard_audit_realtime.sql`
**Status**: REUSED — no changes for feature 005

## Purpose

`DashboardRealtime` subscribes to this channel so all dashboard widgets refresh in lock-step with the leaderboard whenever a scoring event commits. Sharing the channel with `/leaderboard` (FC-D4) means the user sees consistent state across both surfaces without separate plumbing.

## Channel

| Property | Value |
|---|---|
| Channel name | `leaderboard-refresh` (constant, shared with feature 004's `LeaderboardRealtime`) |
| Event type | `postgres_changes` |
| Schema | `public` |
| Table | `audit_log` |
| Filter | `action=eq.leaderboard.refresh` |
| Payload | `audit_log` INSERT row (caller_kind + refreshed_at in `new_value` jsonb; no participant data) |
| RLS gate | `audit_log_leaderboard_refresh_select` (granted to `anon, authenticated`) |
| Publication | `supabase_realtime` (audit_log added in migration 0037) |

## Subscription pattern (extends feature 004)

```ts
const channel = supabase
  .channel('leaderboard-refresh')
  .on(
    'postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'audit_log', filter: 'action=eq.leaderboard.refresh' },
    () => debouncedRefetch(),
  )
  .subscribe((status) => {
    // SUBSCRIBED → clear ReconnectingIndicator timer
    // anything else > 10 s → show ReconnectingIndicator
  });
```

## Debounce (NEW for feature 005)

- 300 ms ± 50 ms tolerance (NFR-D06)
- Implementation: `setTimeout` ref cleared on each event; fires `refetch()` 300 ms after the most recent event
- 5 events arriving within 200 ms → exactly 1 refetch
- 5 events arriving 500 ms apart → 5 refetches (each one a separate debounce window)

## Failure modes

| Scenario | Behaviour |
|---|---|
| Channel SUBSCRIBED → fires events normally | Widgets refresh via stale-while-revalidate (FR-D19) |
| Channel disconnects for < 10 s | Transparent — no UI affordance; reconnect succeeds before chip threshold |
| Channel disconnects for 10-60 s | `ReconnectingIndicator` chip surfaces; widgets stale; channel reconnects via Supabase backoff |
| Channel disconnects for > 60 s (FR-D21 extended outage) | Same as above; chip stays visible; no polling fallback; no forced reload; on reconnect, one catch-up refetch fires |
| INSERT row matches the filter but RLS rejects the read | Realtime suppresses the event (this was the feature 004 bug fixed by migration 0037 — see `audit_log_leaderboard_refresh_select` granted to `anon, authenticated`) |

## Test coverage

- `e2e/tests/dashboard-realtime.spec.ts` — TC-D12 (debounce burst), TC-D16 (refreshing chip + zero CLS), extended-outage simulation
- Feature 004's existing tests cover the channel + publication + RLS topology (pgTAP 020-024 + Playwright `leaderboard-realtime.spec.ts`).
