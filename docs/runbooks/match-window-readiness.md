# Runbook — Match-Window Readiness Check

**When to read this**: ~30 minutes before any known match kickoff. Or ad-hoc to confirm the system is healthy. Or whenever you suspect notifications are silently failing (e.g., you haven't seen a Teams ping in a while but you can't tell if that means "no errors" or "channel is broken").

**Who you are**: the ops admin.

**What you'll do**: paste a single SQL block into Supabase Studio's SQL Editor. It returns 6 result panes. Every pane green = ready for the match window. Any red row → consult the corresponding runbook.

---

## The query bundle

```sql
-- Pane 1 — latest provider sync.
-- GREEN: latest row is recent (last 30 min for an in-progress tournament,
-- last 12 h otherwise) AND status='success'.
-- RED:   latest row is status='error' OR no row in the last 24 h.
SELECT id, action, status, started_at, finished_at, records_processed
FROM integration_runs
ORDER BY started_at DESC
LIMIT 1;
\g

-- Pane 2 — latest scoring run.
-- GREEN: latest row is status='success' (or no rows at all if no admin
--        action has been taken in last 24 h).
-- RED:   latest row is status='error'.
SELECT id, action, status, started_at
FROM scoring_runs
ORDER BY started_at DESC
LIMIT 1;
\g

-- Pane 3 — error-shaped audit_log rows in the trailing 24 h.
-- GREEN: 0.
-- RED:   any non-zero. Read the rows directly to identify the affected
--        feature (auth, scoring, leaderboard, ...).
SELECT count(*) AS error_rows_24h
FROM audit_log
WHERE (action LIKE '%error%' OR action LIKE '%fail%' OR action LIKE '%failed%')
  AND occurred_at > now() - interval '24 hours';
\g

-- Pane 4 — Teams notification delivery failures in the trailing 24 h.
-- GREEN: 0.
-- RED:   any non-zero. The webhook URL may have been revoked or expired
--        (Teams returns 410). Open the most_recent row's new_value->>'http_status'
--        to triage — read docs/runbooks/README.md for the relevant runbook.
SELECT count(*)                  AS failed_notifications_24h,
       max(occurred_at)          AS most_recent
FROM audit_log
WHERE action = 'notification.teams.failed'
  AND occurred_at > now() - interval '24 hours';
\g

-- Pane 5 — match volume in the next 4 hours.
-- INFORMATIONAL: tells you how busy the next 4 h are. If 0, this readiness
-- check has nothing to anchor on; if > 1, expect a steady stream of
-- scoring + leaderboard refresh activity.
SELECT count(*) AS upcoming_4h
FROM matches
WHERE status NOT IN ('cancelled', 'finished')
  AND kickoff_utc BETWEEN now() AND now() + interval '4 hours';
\g

-- Pane 6 — pre-tournament gating predicate (feature 004).
-- GREEN before-tournament: TRUE means leaderboard widgets render the
-- countdown card; participants haven't started scoring yet.
-- GREEN during-tournament: FALSE means leaderboard is live; widgets
-- render normally.
-- RED:   TRUE during the tournament window — score_events table is
--        unexpectedly empty (data loss?).
SELECT is_pre_tournament() AS pre_tournament;
\g
```

## Reading the result

| Pane | Green | Red → consult |
|---|---|---|
| 1 | `status='success'` AND recent | `docs/runbooks/provider-sync-failure.md` |
| 2 | `status='success'` OR no row | `docs/runbooks/scoring-failure.md` |
| 3 | 0 | open the audit_log rows directly; map by action prefix to feature |
| 4 | 0 | `docs/runbooks/README.md` § Teams webhook URL stuck or revoked |
| 5 | (informational only) | n/a |
| 6 | matches the calendar | data integrity escalation — out of scope of this runbook |

## Why it exists

Per spec FR-O08, the operational layer is "monitoring stack = Supabase Studio dashboards only". This SQL block IS the dashboard. The admin runs it before each match window and on first sign of a Teams notification backlog (e.g., expected to see 5 Teams messages, only saw 2 — pane 4 will surface the missing 3 as `failed_notifications_24h > 0`).

---

## References

- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O08 + Scenario C
- [Feature 004 — Leaderboard](../../specs/004-leaderboard/spec.md) — `is_pre_tournament()` helper
- [Feature 006 DoD](../../specs/006-phase-5-operational/dod-verification.md) — gate for FR-O08 in the Phase 5 follow-on DoD set
