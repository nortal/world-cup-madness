# Runbook — Leaderboard MV Refresh Stuck

**Triggered by**: `match-window-readiness.md` pane 4 shows `failed_notifications_24h > 0` with most recent action `leaderboard.refresh_failed`. OR you ran `SELECT refresh_leaderboard();` manually and it errored. OR Realtime is healthy but the `/leaderboard` page shows stale ranks.

**Who you are**: the ops admin.

**What you'll do**: confirm pg_cron is ticking, decide whether the gating predicate is hiding a legitimate skip, then either wait (data-driven skip) or force-refresh (actual error).

---

## Step 1 — confirm pg_cron is ticking

```sql
SELECT jobid, jobname, schedule, active, last_run_start
FROM cron.job
WHERE jobname = 'leaderboard-refresh-tick';
```

| Pattern | Means |
|---|---|
| `active=true` AND `last_run_start` within last 10 min | Cron is healthy. Skip to Step 2. |
| `active=false` | Cron job was disabled. `SELECT cron.alter_job(<jobid>, active := true);` to re-enable. |
| `last_run_start` > 30 min stale | pg_cron worker stuck. Last-resort: restart Supabase Postgres via Studio. |

## Step 2 — consult the gating predicate

```sql
SELECT should_refresh_leaderboard() AS predicate_says_refresh;
```

`should_refresh_leaderboard()` (feature 004 R-5) returns FALSE when:
- The tournament hasn't started (pre-tournament — `is_pre_tournament()` is TRUE).
- The last refresh was within the throttle window (currently 5 min per feature 004 default).
- No new `score_events` have landed since the last refresh.

If predicate returns FALSE during a known active match window, recent scoring may not have committed. Cross-check:

```sql
SELECT count(*) AS recent_score_events
FROM score_events
WHERE awarded_at > now() - interval '15 minutes';
```

If `recent_score_events = 0` during a match window, that's a feature 003 scoring failure — see `scoring-failure.md`.

## Step 3 — inspect the last failed refresh

```sql
\x on
SELECT id, occurred_at, new_value
FROM audit_log
WHERE action = 'leaderboard.refresh_failed'
ORDER BY occurred_at DESC
LIMIT 3;
```

The `new_value->>'error'` field usually carries the underlying Postgres error. Common patterns:

| Pattern | Means | Fix |
|---|---|---|
| `conflict on materialized view` | CONCURRENTLY refresh deadlocked with an in-flight scoring trigger | Go to Step 4 Branch A — non-concurrent refresh. |
| `out of memory` | MV is too large for the shared-buffer pool | Escalate to Supabase support; consider promoting tier. |
| (anything else) | Unfamiliar error — escalate to engineering. | Capture the full `new_value` JSON in the escalation. |

## Step 4 — pick a recovery branch

### Branch A — non-concurrent refresh

Use when Step 3 showed a CONCURRENTLY conflict. A non-concurrent refresh takes an exclusive lock (briefly blocks reads) but completes in seconds.

```sql
REFRESH MATERIALIZED VIEW leaderboard_snapshots;
```

After completion, force one normal refresh through the audit pipeline to land a `leaderboard.refresh` audit row + Realtime broadcast:

```sql
SELECT refresh_leaderboard();
```

### Branch B — force a normal refresh

```sql
SELECT refresh_leaderboard();
```

Re-check `audit_log` per Step 3 — a `leaderboard.refresh` row (not `_failed`) should appear within seconds.

## Step 5 — confirm participant visibility

Open `/leaderboard` in an incognito window. Top-rank participant should be the one with most recent scoring. The `Refreshing…` chip on `/dashboard` (if any open client tabs) should appear briefly via the Realtime broadcast.

---

## References

- [Feature 004 — Leaderboard](../../specs/004-leaderboard/spec.md) — MV + cron + gating predicate (R-5)
- [Feature 004 dod-verification](../../specs/004-leaderboard/dod-verification.md) — known MV behaviour
- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O09 (this audit action is what triggers the Teams ping) + FR-O10
