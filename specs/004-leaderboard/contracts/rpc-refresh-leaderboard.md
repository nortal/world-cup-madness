# Contract: `refresh_leaderboard()` RPC

**Feature**: 004 | **Migration**: 0033 | **Spec**: FR-L11, FR-L12, FR-L19, FR-L20, FR-L21, FC-L1, FC-L2

## Signature

```sql
CREATE OR REPLACE FUNCTION refresh_leaderboard()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION refresh_leaderboard() FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION refresh_leaderboard() TO postgres;
```

## Callers

| Caller | Context | Admin gate? |
|---|---|---|
| Admin via PostgREST `POST /rpc/refresh_leaderboard` | Direct invocation | YES — `is_admin_user()` check |
| Scoring trigger functions (feature 003) | `PERFORM refresh_leaderboard()` from `calculate_match_points()`, `calculate_final_points()`, `recalculate_all_scores()` | NO — detected via `app.scoring_run_id` GUC |
| `pg_cron` job `leaderboard-refresh-tick` | `SET LOCAL app.cron_caller = 'true'; SELECT refresh_leaderboard();` | NO — gated by `should_refresh_leaderboard()` instead |

## Behaviour

1. **Identify caller kind** by inspecting GUCs (`app.cron_caller`, `app.scoring_run_id`).
2. **Admin gate** (admin direct calls only): `RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege'` if `is_admin_user()` returns false.
3. **Cron gating** (cron calls only): consult `should_refresh_leaderboard()`. If it returns false, return `{outcome: 'skipped', reason: 'gated'}` and write NO audit row.
4. **Refresh**: `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` — serialised by Postgres at the MV level; concurrent callers queue.
5. **Audit success**: write one `audit_log` row with `event_type='leaderboard.refresh'`, carrying caller kind, duration, participant count, scoring_run FK (if applicable).
6. **Exception path** (FC-L2): if the REFRESH or anything else throws, write one `audit_log` row with `event_type='leaderboard.refresh_failed'` carrying caller kind, SQLSTATE, SQLERRM, scoring_run FK. Return `{outcome: 'error', sqlstate, sqlerrm}`. The exception does NOT propagate to the caller (so scoring still commits).

## Response shapes

### Success

```json
{
  "outcome": "success",
  "duration_ms": 142,
  "participant_count": 200
}
```

### Skipped (cron-gated)

```json
{
  "outcome": "skipped",
  "reason": "gated"
}
```

### Error (caught and decoupled)

```json
{
  "outcome": "error",
  "sqlstate": "55P03",
  "sqlerrm": "could not obtain lock on materialized view ..."
}
```

### Error (admin gate failure — propagated as HTTP 403)

PostgREST translates `RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege'` into HTTP 403 with body `{"code":"42501","message":"FORBIDDEN",...}`.

## Side effects

| Effect | When |
|---|---|
| `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` | Every non-skipped call |
| `INSERT INTO audit_log (event_type='leaderboard.refresh', ...)` | Successful refresh |
| `INSERT INTO audit_log (event_type='leaderboard.refresh_failed', ...)` | Exception path |
| Supabase Realtime emit on `audit_log` event | Implicit, via logical replication |

## Concurrency

- Within Postgres: `REFRESH MATERIALIZED VIEW CONCURRENTLY` is itself serialised on the MV (only one at a time per MV; second queues). No app-level mutex needed.
- Between caller kinds: scoring triggers commit BEFORE invoking the refresh; the refresh runs synchronously but its failure doesn't propagate (FC-L2). Cron calls are gated separately.

## pgTAP coverage (test/pgtap/022_*.sql)

| Test | Asserts |
|---|---|
| Admin direct call → success + audit row | FR-L19 + FR-L20 |
| Non-admin direct call → FORBIDDEN | Admin gate |
| Cron-gated call (predicate=false) → skipped, no audit row | FR-L21 + FR-L22 |
| Cron-gated call (predicate=true) → success + audit row with `caller_kind='cron'` | FR-L21 |
| Trigger-context call → success + audit row with `scoring_run_id` populated | FR-L20 |
| Forced REFRESH failure (DROP UNIQUE index trick) → exception caught + failure audit row + scoring commits | FC-L2 + FR-L20 |
| Two concurrent calls serialise via Postgres CONCURRENTLY | R-1 |
| Idempotent: 10 consecutive calls leave MV in identical state | NFR-L3 |
