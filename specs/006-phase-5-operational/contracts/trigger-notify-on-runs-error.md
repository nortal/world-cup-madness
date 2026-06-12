# Contract — `notify_teams_on_runs_error()` trigger + reconciler

## Trigger function

**Name**: `notify_teams_on_runs_error()`
**Returns**: `TRIGGER`
**Security**: `SECURITY DEFINER` — runs as the migration owner so it can read `app.teams_webhook_url` setting and INSERT into `audit_log` regardless of who triggered the parent INSERT.
**Volatility**: `VOLATILE` (default) — calls `pg_net.http_post` and INSERTs.
**Search path**: `public, net, pg_temp`

## When it fires

| Table | Event | Filter |
|---|---|---|
| `integration_runs` | `AFTER INSERT FOR EACH ROW` | `NEW.outcome = 'error'` (checked inside the function — early return otherwise) |
| `scoring_runs` | `AFTER INSERT FOR EACH ROW` | `NEW.outcome = 'error'` (same) |

It does **not** fire on UPDATEs. Both `integration_runs` and `scoring_runs` are append-only by feature 002 / 003 contract — the function ASSUMES insert-only behavior. If a future spec changes that, this contract must be updated.

## Branches

```
IF NEW.outcome <> 'error'      THEN RETURN NEW;  -- FR-O07 / TC-O8
IF webhook_url not configured  THEN RETURN NEW;  -- silent skip on misconfiguration
ELSE
    payload := build_teams_message(NEW)          -- contracts/teams-webhook-payload.md
    req_id := net.http_post(webhook_url, payload, headers)
    INSERT audit_log (action='notification.teams.sent', http_status=null, ...)
```

## What it does NOT do

- Does not retry on failure (FR-O03c).
- Does not block the inserting transaction beyond the cost of `net.http_post` (which is `O(1)` enqueue + the audit insert).
- Does not consume the HTTP response — that's the reconciler's job.
- Does not modify the inserting row (`RETURNS NEW` unchanged).
- Does not emit any other audit_log rows.

## Reconciler

**Name**: `reconcile_teams_notifications()`
**Returns**: `void`
**Security**: `SECURITY DEFINER`
**Volatility**: `VOLATILE`
**Schedule**: every 60 seconds via `pg_cron` job `'reconcile-teams-notifications'` (added by migration 0039)

### Algorithm

```
1. Read the last-reconciled mark from a session-local setting OR from
   max(occurred_at) of the most recent notification.teams.{sent,failed}.
2. Scan net._http_response WHERE created_at > mark.
3. For each response row:
   a. Find the matching audit_log row by req_id (action='notification.teams.sent',
      new_value->>'req_id'::bigint = response.id).
      If none → log a structured warning, skip (orphaned response — should never happen
      but defensive).
   b. IF response.status_code BETWEEN 200 AND 299:
        UPDATE audit_log SET new_value = new_value || jsonb_build_object('http_status', response.status_code)
        WHERE id = matching_sent_id;
   c. ELIF response.status_code >= 400 OR response.error_msg IS NOT NULL:
        INSERT INTO audit_log (action, entity_type, entity_id, new_value) VALUES (
            'notification.teams.failed',
            <matched entity_type>,
            <matched entity_id>,
            jsonb_build_object(
                'run_table',       <matched>,
                'run_id',          <matched>,
                'req_id',          response.id,
                'attempted_at',    <copied from sent row>,
                'completed_at',    response.created_at,
                'http_status',     response.status_code,    -- may be null for transport error
                'error_msg',       scrub_pii_for_teams(
                                       COALESCE(response.error_msg, response.content)
                                   ),
                'retry_attempted', false
            )
        );
4. Update the last-reconciled mark to max(response.created_at) processed.
```

### Test handle

For Playwright tests that need deterministic reconciler behavior, the migration exposes a wrapper `SELECT reconcile_teams_notifications_now();` that calls the same function synchronously. Tests skip the 60-s cron wait by invoking the wrapper directly via service-role RPC.

## Test coverage

| Test | Type | Asserts |
|---|---|---|
| pgTAP `026_audit_log_action_extension.sql` | unit | CHECK constraint accepts both new action values; rejects unknown values |
| pgTAP `027_scrub_pii_for_teams.sql` | unit | Pure-function input → output for 12 cases (email / UUID / nortal.com / mixed / empty / null / truncation) |
| pgTAP `028_notify_teams_on_runs_error.sql` | integration | Triggers fire on outcome='error', skip on outcome='success' or 'skipped'; emit exactly one sent row; payload shape; web-hook-not-configured path |
| Playwright `notification-teams-end-to-end.spec.ts` | E2E | Full path with mock receiver; TC-O1, TC-O2, TC-O9, TC-O10, TC-O11, TC-O12 |
