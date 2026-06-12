# Runbook — Realtime Channel Drop

**Triggered by**: `ReconnectingIndicator` chip stays visible on `/dashboard` or `/leaderboard` for > 60 seconds. Source: Supabase Realtime channel `leaderboard-refresh` disconnected and the supabase-js client hasn't auto-recovered.

**Who you are**: the ops admin.

**What you'll do**: confirm Realtime is alive at the platform level, then either wait (transient blip) or restart Realtime in Studio (sustained drop).

---

## Step 1 — confirm the channel-refresh audit trail

If the `audit_log` stream is still landing `leaderboard.refresh` rows, Realtime is broken for the CLIENT but the DB-side cron + audit pipeline still works. Clients will catch up on reconnect.

```sql
SELECT id, action, occurred_at, new_value
FROM audit_log
WHERE action IN ('leaderboard.refresh', 'leaderboard.refresh_failed')
  AND occurred_at > now() - interval '10 minutes'
ORDER BY occurred_at DESC;
```

| Pattern | Means |
|---|---|
| At least one `leaderboard.refresh` row in the last 10 min | Cron is healthy. The break is on the Realtime delivery side. Go to Step 2. |
| `leaderboard.refresh_failed` row in the last 10 min | MV refresh itself is broken. See `mv-refresh-stuck.md`. |
| No rows at all in last 10 min | Cron is stuck OR refresh predicate gates everything off. See `mv-refresh-stuck.md` Step 2. |

## Step 2 — inspect Realtime subscription telemetry

```sql
-- How many active Realtime subscriptions are there?
SELECT count(*) AS active_subscriptions FROM realtime.subscription;
```

Empty subscription table is normal during a quiet hour. > 1,000 rows suggests stuck subscriptions (one row per (client, channel) tuple that never cleaned up).

```sql
-- Are there any error rows in the Realtime extension's log?
SELECT count(*) FROM pg_stat_database WHERE datname='realtime';
```

## Step 3 — restart Realtime

Open Supabase Studio:
1. Project Settings → API
2. Scroll to **Realtime** section
3. Click **Reset Realtime**

This rotates the Realtime jwt and forces all clients to reconnect. Expect 30–60 seconds of channel re-subscribe activity. The `ReconnectingIndicator` should clear within 2 minutes on participant browsers.

## Step 4 — verify recovery

Open `/dashboard` and `/leaderboard` in two browser tabs. The `ReconnectingIndicator` should NOT be visible. Force a refresh event:

```sql
SELECT refresh_leaderboard();
```

Both tabs should re-render within 5 seconds. The "Refreshing…" chip should briefly appear on the dashboard.

---

## References

- [Feature 004 — Leaderboard](../../specs/004-leaderboard/spec.md) — Realtime channel `leaderboard-refresh` + audit-event proxy pattern (R-2)
- [Feature 005 — Dashboard](../../specs/005-phase-4-dashboard/spec.md) — `<DashboardRealtime>` wrapper + `ReconnectingIndicator` reuse
- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O10
