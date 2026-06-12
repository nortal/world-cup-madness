# Contract — `audit_log` row with `action='notification.teams.failed'`

**Action**: `notification.teams.failed`
**Emitter**: `reconcile_teams_notifications()` — pg_cron job running every 60 seconds.
**Lifecycle**: inserted once per `*_runs.outcome='error'` row whose HTTP response was non-2xx OR which suffered a transport-level error. Coexists with the corresponding `notification.teams.sent` row (does NOT replace it).

## Row shape

| Column | Value |
|---|---|
| `id` | bigserial — auto |
| `occurred_at` | `now()` at reconciler tick time (not the HTTP response time) |
| `action` | `'notification.teams.failed'` |
| `actor_kind` | `'system'` |
| `actor_id` | `NULL` |
| `entity_type` | same as the matching `sent` row (`'integration_runs'` / `'scoring_runs'` / `'audit_log'`) |
| `entity_id` | same as the matching `sent` row |
| `old_value` | `NULL` |
| `new_value` | JSONB per § new_value shape below |

## `new_value` shape

```jsonc
{
    "run_table":      "integration_runs" | "scoring_runs" | "audit_log",
    "run_id":         "<text repr of NEW.id from the original *_runs row>",
    "req_id":         <bigint>,           // ties back to the matching sent row
    "attempted_at":   "<ISO-8601 UTC>",   // copied from the sent row
    "completed_at":   "<ISO-8601 UTC>",   // when the reconciler observed the response
    "http_status":    <int|null>,         // 4xx/5xx code; null if transport-error (e.g. DNS failure, TCP reset)
    "error_msg":      "<scrubbed string>", // pg_net's error_msg OR scrubbed response body; up to 500 chars
    "retry_attempted": false              // FR-O03c — v1 is one-shot; field present for forward-compatibility
}
```

### Invariants

- `req_id` is unique within this action — there is exactly one `failed` row per `req_id` (the reconciler dedups on its mark column).
- `http_status` is `null` only when the HTTP transport itself failed before reaching a response (DNS, TCP reset, timeout). When `http_status` is null, `error_msg` carries `pg_net.error_msg` verbatim (scrubbed).
- `error_msg` is ALWAYS PII-scrubbed via `scrub_pii_for_teams()` before insertion. Tests must verify this (TC-O11).
- `retry_attempted` is ALWAYS `false` in v1. If a future spec adds retry behavior, the same row schema can carry an integer attempt count instead.

## How FR-O08's health check reads this

```sql
SELECT
    count(*)                                          AS failed_count,
    max(occurred_at)                                  AS most_recent_failure
FROM audit_log
WHERE action = 'notification.teams.failed'
  AND occurred_at > now() - interval '24 hours';
```

Any non-zero `failed_count` in the trailing 24 hours signals the ops admin should check `docs/runbooks/README.md` for the "Teams webhook URL stuck or revoked" entry.

## Test coverage

- **TC-O11 (Playwright)**: configure the mock receiver to return HTTP 410; insert `integration_runs.outcome='error'`; force-run the reconciler (`SELECT reconcile_teams_notifications();`); assert a row with `action='notification.teams.failed'`, `new_value->>'http_status'='410'`, `new_value->>'error_msg'` is non-null and matches the mock receiver's response body after scrubbing.
- **TC-O11 transport-error variant**: stop the mock receiver process; insert `*_runs.outcome='error'`; force-run the reconciler; assert a row with `http_status=null` and `error_msg` carrying the pg_net transport error (also scrubbed).
- **TC-O12 (Playwright)**: configure mock to return HTTP 500; insert one `*_runs.outcome='error'` row; force-run reconciler; count `notification.teams.failed` rows for this `req_id` — exactly 1. Wait 60 more seconds (or force a second reconcile tick) — still exactly 1 (no retry).
- **pgTAP `026_audit_log_action_extension.sql`**: validates the action value passes the new CHECK constraint.
