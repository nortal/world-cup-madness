# Contract: `audit_log` event variants — `leaderboard.refresh` + `leaderboard.refresh_failed`

**Feature**: 004 | **Migration**: 0033 | **Spec**: FR-L12, FR-L20, FC-L2

## Background

Feature 001 created `audit_log` as an append-only table keyed by `event_type` (TEXT). Feature 004 adds two new event_type values:

| Value | Written by |
|---|---|
| `leaderboard.refresh` | `refresh_leaderboard()` on the success path |
| `leaderboard.refresh_failed` | `refresh_leaderboard()` on the exception path |

The existing `audit_log_event_type_check` constraint is ALTERed to include these two values.

## Row shapes

### `leaderboard.refresh`

| Column | Value | Notes |
|---|---|---|
| `event_type` | `'leaderboard.refresh'` | |
| `entity_type` | `'leaderboard_snapshots'` | The MV being refreshed. |
| `entity_id` | NULL | MV has no row-level identity. |
| `actor_id` | NULL | System action; not attributable to a user. |
| `new_value` | JSONB | `{caller_kind, duration_ms, participant_count, scoring_run_id}` |
| `created_at` | DEFAULT `now()` | |

`new_value` payload:
```json
{
  "caller_kind": "admin" | "trigger" | "cron",
  "duration_ms": 142,
  "participant_count": 200,
  "scoring_run_id": "5a3f...uuid-or-null"
}
```

`scoring_run_id` is populated when `caller_kind='trigger'` (carried via the `app.scoring_run_id` GUC set by the scoring trigger function); NULL otherwise.

### `leaderboard.refresh_failed`

| Column | Value | Notes |
|---|---|---|
| `event_type` | `'leaderboard.refresh_failed'` | |
| `entity_type` | `'leaderboard_snapshots'` | |
| `entity_id` | NULL | |
| `actor_id` | NULL | |
| `new_value` | JSONB | `{caller_kind, sqlstate, sqlerrm, scoring_run_id}` |
| `created_at` | DEFAULT `now()` | |

`new_value` payload:
```json
{
  "caller_kind": "admin" | "trigger" | "cron",
  "sqlstate": "55P03",
  "sqlerrm": "could not obtain lock on materialized view leaderboard_snapshots",
  "scoring_run_id": "5a3f...uuid-or-null"
}
```

## Invariants

- For every successful `refresh_leaderboard()` call (excluding cron-skipped), exactly one `leaderboard.refresh` row is written. No more, no less.
- For every failed `refresh_leaderboard()` call (excluding cron-skipped), exactly one `leaderboard.refresh_failed` row is written. No more, no less.
- Cron-skipped calls write NEITHER. Operators monitoring "is the refresh healthy?" should query for the most recent `leaderboard.refresh` row's timestamp; a stale value indicates a quiet period (expected) or a stuck refresh (incident).
- `scoring_run_id` is FK-consistent: when set, the referenced `scoring_runs.id` exists at audit-write time.

## RLS

The `audit_log` table inherits feature 001's RLS:
- Admins (`is_admin_user()`) can SELECT all rows.
- Participants can SELECT only rows where `actor_id = self.id`. Since `leaderboard.refresh` rows have `actor_id = NULL`, participants do NOT see them — keeps the audit log focused on participant-visible activity.

The Realtime channel that the page subscribes to (see [realtime-channel-leaderboard-snapshots.md](./realtime-channel-leaderboard-snapshots.md)) is a custom-publication subset that exposes only the EXISTENCE of `leaderboard.refresh` events (no row payload), so the participant doesn't see admin/trigger metadata.

## Operator queries

```sql
-- Most recent successful refresh:
SELECT created_at, new_value->>'caller_kind' AS caller, (new_value->>'duration_ms')::INT AS ms
FROM audit_log
WHERE event_type = 'leaderboard.refresh'
ORDER BY created_at DESC
LIMIT 1;

-- Recent failures (incident investigation):
SELECT created_at, new_value->>'sqlstate' AS sqlstate, new_value->>'sqlerrm' AS message
FROM audit_log
WHERE event_type = 'leaderboard.refresh_failed'
  AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;

-- Refresh rate over the last 24 hours:
SELECT date_trunc('hour', created_at) AS hour, count(*) AS refreshes
FROM audit_log
WHERE event_type = 'leaderboard.refresh'
  AND created_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 1;
```

## pgTAP coverage (test/pgtap/022_*.sql + 023_*.sql)

Implicit in the `refresh_leaderboard()` test coverage — every assertion that "a refresh occurred" or "a refresh failed" is verified by checking these rows.
