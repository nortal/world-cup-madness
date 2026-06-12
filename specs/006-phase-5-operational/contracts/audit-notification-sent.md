# Contract — `audit_log` row with `action='notification.teams.sent'`

**Action**: `notification.teams.sent`
**Emitter**: `notify_teams_on_runs_error()` trigger function — runs synchronously in the same transaction as the `*_runs` INSERT.
**Lifecycle**: inserted once per triggering `*_runs.outcome='error'` row; potentially UPDATEd later by the reconciler when the HTTP response lands.

## Row shape

| Column | Value |
|---|---|
| `id` | bigserial — auto |
| `occurred_at` | `now()` at trigger time |
| `action` | `'notification.teams.sent'` |
| `actor_kind` | `'system'` (matches existing audit_log conventions for trigger-emitted rows) |
| `actor_id` | `NULL` (no acting participant — system event) |
| `entity_type` | `'integration_runs'` OR `'scoring_runs'` OR `'audit_log'` (the third only via FR-O09 follow-on) |
| `entity_id` | `NEW.id::text` — the failing `*_runs` row id |
| `old_value` | `NULL` |
| `new_value` | JSONB per § new_value shape below |

## `new_value` shape

```jsonc
{
    "run_table":     "integration_runs" | "scoring_runs" | "audit_log",
    "run_id":        "<text repr of NEW.id>",
    "req_id":        <bigint>,           // pg_net request id, used by the reconciler
    "attempted_at":  "<ISO-8601 UTC>",
    "http_status":   null                // initial value; reconciler may UPDATE to actual 2xx code
}
```

### Invariants

- `req_id` is the bigint returned by `pg_net.http_post(...)`. The reconciler joins this audit row to `net._http_response.id = req_id` to resolve the eventual HTTP outcome.
- `http_status` is `null` at insert. The reconciler UPDATEs this column in place when a 2xx response arrives. **A non-null `http_status` here means the message was delivered successfully.**
- If the reconciler observes a non-2xx response or a transport error, this row is NOT modified. A separate `notification.teams.failed` row is inserted (see [audit-notification-failed.md](./audit-notification-failed.md)). Both rows coexist: the `sent` row records the attempt; the `failed` row records the bad outcome.

## How FR-O08's health check reads this

The match-window-readiness query bundle (follow-on FR-O08) runs:

```sql
SELECT count(*) AS pending_or_unconfirmed
FROM audit_log
WHERE action = 'notification.teams.sent'
  AND (new_value->>'http_status') IS NULL
  AND occurred_at > now() - interval '15 minutes';
```

A non-zero result means notifications are queued but not yet confirmed delivered — could indicate a stuck pg_net worker.

## Test coverage

- **TC-O10 (Playwright)**: insert `integration_runs.outcome='error'` → assert one `notification.teams.sent` audit row exists with `entity_type='integration_runs'`, `entity_id=<the inserted id>`, `new_value->>'req_id'` is a bigint, and `new_value->>'http_status'` is `null` within 2 s of the insert.
- **TC-O10 reconcile path (Playwright + pg_cron force-run)**: after the mock receiver acknowledges 200, force-run `reconcile_teams_notifications()` and assert the same row now has `new_value->>'http_status' = '200'`.
- **pgTAP `026_audit_log_action_extension.sql`**: validates the action value passes the new CHECK constraint.
