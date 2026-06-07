# Contract: `pg_cron` schedule `leaderboard-refresh-tick`

**Feature**: 004 | **Migration**: 0035 | **Spec**: FR-L21, FR-L22

## Schedule

```sql
SELECT cron.schedule(
    'leaderboard-refresh-tick',
    '*/5 * * * *',
    $$
        SET LOCAL app.cron_caller = 'true';
        SELECT refresh_leaderboard();
    $$
);
```

- **Cadence**: every 5 minutes (`*/5 * * * *`).
- **Effective cadence**: 5 min in match windows (any non-cancelled match within `now() ± 90 min`); ~60 min in quiet periods; skipped entirely during pre-tournament (FR-L22). See the gating predicate in [data-model.md §4](../data-model.md).
- **Owner**: postgres role (pg_cron's default).
- **GUC**: `SET LOCAL app.cron_caller = 'true'` signals to `refresh_leaderboard()` to consult the gating predicate.

## Gating semantics (R-5)

`should_refresh_leaderboard()` returns:
- `false` if `score_events` is empty (pre-tournament; FR-L22)
- `true` if any non-cancelled match has `kickoff_utc BETWEEN now() - interval '90 min' AND now() + interval '90 min'`
- `true` if the latest `audit_log` row with `event_type='leaderboard.refresh'` is more than 60 minutes old (or doesn't exist)
- `false` otherwise (quiet period and recent refresh exists)

## Lifecycle

| Phase | Behaviour |
|---|---|
| Pre-tournament (no score_events) | Every cron tick gates out via predicate → no MV churn, no audit log noise. |
| Pre-match window approaches | Within 90 min before kickoff, every tick refreshes. |
| Mid-match | Same — every tick refreshes. |
| Post-match | Within 90 min after final whistle, every tick refreshes (covers admin score corrections + late provider data). |
| Quiet period (no match within ±90 min) | Refreshes only if the last refresh is older than 60 min. |
| Tournament conclusion | Same quiet-period cadence; effectively ~60 min refreshes until the team disables the schedule. |

## Disabling / re-enabling

```sql
-- Disable (tournament over):
UPDATE cron.job SET active = false WHERE jobname = 'leaderboard-refresh-tick';

-- Re-enable:
UPDATE cron.job SET active = true WHERE jobname = 'leaderboard-refresh-tick';

-- Remove entirely:
SELECT cron.unschedule('leaderboard-refresh-tick');
```

## pgTAP coverage (test/pgtap/023_*.sql)

The schedule itself is verified ("entry exists, is active, has the expected command"); the gating PREDICATE is the substantive test surface.

| Test | Asserts |
|---|---|
| Cron job entry exists with expected schedule + command | Migration applied |
| `should_refresh_leaderboard()` returns false when `score_events` is empty | FR-L22 |
| Returns true when a match is within now() ± 90 min | Match-window gating |
| Returns true when last refresh > 60 min ago | Quiet-period gating |
| Returns false when last refresh ≤ 60 min ago AND no match in window | Quiet-period skip |
| Stable function classification — same query, same result within a statement | R-5 |
