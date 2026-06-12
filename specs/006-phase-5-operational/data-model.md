# Data Model — Feature 006 (Phase 5 Operational Readiness)

**Date**: 2026-06-12
**Companion to**: [plan.md](./plan.md), [research.md](./research.md)

Feature 006 introduces **zero new tables** and **zero new columns**. The entire data model change is one CHECK constraint extension on `audit_log.action` (migration 0039), plus a dev-only test inbox table (migration 0040) gated by `current_setting('app.env')='development'`.

---

## 1. Modified: `audit_log.action` CHECK enum (migration 0039)

### Current enum (feature 001 + 003 + 004)

```
'participant.created', 'participant.updated', 'participant.deactivated', 'participant.role-changed',
'auth.rejected', 'auth.provider-error', 'tenant.departure',
'prediction.created', 'prediction.updated',
'final_prediction.created', 'final_prediction.updated',
'scoring.match', 'scoring.final',
'admin.match-result-override', 'admin.recalc-all', 'admin.tournament-winner-set',
'leaderboard.refresh', 'leaderboard.refresh_failed'
```

### Extension (feature 006)

Two new values:

```
'notification.teams.sent',     -- emitted at enqueue time per FR-O03b
'notification.teams.failed'    -- emitted at reconcile time per FR-O03b + R-5
```

### Migration shape

```sql
ALTER TABLE audit_log
    DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_action_check
    CHECK (action IN (
        -- existing 18 values, listed verbatim from features 001 + 003 + 004
        'participant.created', 'participant.updated', 'participant.deactivated', 'participant.role-changed',
        'auth.rejected', 'auth.provider-error', 'tenant.departure',
        'prediction.created', 'prediction.updated',
        'final_prediction.created', 'final_prediction.updated',
        'scoring.match', 'scoring.final',
        'admin.match-result-override', 'admin.recalc-all', 'admin.tournament-winner-set',
        'leaderboard.refresh', 'leaderboard.refresh_failed',
        -- feature 006 additions
        'notification.teams.sent',
        'notification.teams.failed'
    ));
```

The migration MUST verify the prior 18 values are all preserved — a pgTAP assertion in `test/pgtap/026_audit_log_action_extension.sql` lists them and asserts each one passes the new constraint.

## 2. `new_value` JSONB shape per new action

The `audit_log.new_value` column is already `JSONB NOT NULL` (per feature 001 migration 0004). Feature 006 standardizes the keyset for each new action.

### `notification.teams.sent`

Emitted at the enqueue moment (the trigger calls `pg_net.http_post` and inserts this row in the same transaction).

```jsonc
{
    "run_table":     "integration_runs" | "scoring_runs" | "audit_log",
    "run_id":        <int|uuid as text>,
    "req_id":        <int>,                  // pg_net request id, used by the reconciler
    "attempted_at":  "<ISO-8601 UTC>",       // timestamp the trigger fired
    "http_status":   null                    // populated by the reconciler at success
}
```

After the 60-second reconciler runs and the HTTP response is 2xx, this row is UPDATEd in place: `new_value.http_status` is set to the actual status code. No new audit row is emitted on success.

### `notification.teams.failed`

Emitted ONLY by the reconciler, when the HTTP response is non-2xx OR a transport-level `error_msg` is populated in `net._http_response`. A failure does NOT delete the corresponding `notification.teams.sent` row — the sent row remains as the attempt audit trail, and this new row is the failure signal that FR-O08's health check scans for.

```jsonc
{
    "run_table":          "integration_runs" | "scoring_runs" | "audit_log",
    "run_id":             <int|uuid as text>,
    "req_id":             <int>,                  // ties back to the sent row
    "attempted_at":       "<ISO-8601 UTC>",       // copy of the sent row's attempted_at
    "completed_at":       "<ISO-8601 UTC>",       // when the reconciler observed the response
    "http_status":        <int|null>,             // 4xx/5xx code OR null if transport-error
    "error_msg":          "<scrubbed string>",    // pg_net's error_msg OR the response body, truncated to 500 chars + PII-scrubbed via scrub_pii_for_teams()
    "retry_attempted":    false                   // per FR-O03c — always false in v1
}
```

The `retry_attempted` field is present for forward-compatibility if DD-O1 (dedup) or a future retry-policy lands. v1 always emits `false`.

## 3. Added (dev-only): `_test_mock_teams_inbox` table (migration 0040)

Dev-only test fixture. Captures payloads from the mock Teams receiver Edge Function for Playwright assertions.

```sql
-- Migration 0040 — gated to development only.
DO $$
BEGIN
    IF current_setting('app.env', true) = 'development' THEN
        CREATE TABLE IF NOT EXISTS _test_mock_teams_inbox (
            id           BIGSERIAL PRIMARY KEY,
            body         JSONB NOT NULL,
            headers      JSONB NOT NULL DEFAULT '{}'::jsonb,
            status_sent  INT NOT NULL DEFAULT 200,
            received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- No RLS — dev-only, service-role-only writes from the mock receiver.
    END IF;
END;
$$ LANGUAGE plpgsql;
```

| Column | Type | Purpose |
|---|---|---|
| `id` | bigserial PK | Insert order; tests assert "exactly N rows arrived". |
| `body` | jsonb | The mock receiver parses the incoming JSON and stores it here verbatim — tests assert on `body->>'run_id'`, `body->>'error_message'` (which should be `[REDACTED]`), etc. |
| `headers` | jsonb | The incoming HTTP headers — tests assert `Content-Type` is `application/json`. |
| `status_sent` | int | The status code the mock returned (e.g., 200 or 410 for revoked-webhook scenarios). |
| `received_at` | timestamptz | Insert time — tests can compute latency from `*_runs.started_at` to `received_at`. |

This table is NEVER created in production builds because `app.env` defaults to `'production'` in Supabase Cloud.

## 4. Functions

### `scrub_pii_for_teams(input text) RETURNS text` (migration 0039)

```sql
CREATE OR REPLACE FUNCTION scrub_pii_for_teams(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
    out text := COALESCE(input, '');
BEGIN
    -- 1. Emails (RFC 5322-ish)
    out := regexp_replace(out, '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[REDACTED]', 'g');
    -- 2. UUIDs (oid, participant_id, player_id, match_id — all UUID-shaped)
    out := regexp_replace(out, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', '[REDACTED]', 'g');
    -- 3. Bare nortal.com mentions outside email pattern
    out := regexp_replace(out, '\mnortal\.com\M', '[REDACTED]', 'g');
    -- Truncate to 500 chars after scrubbing
    RETURN substr(out, 1, 500);
END;
$$;
```

`IMMUTABLE` because the output depends only on the input (no clock, no SELECT, no SET). This permits pgTAP to test it with `is(scrub_pii_for_teams(...), expected, '...')` directly.

### `notify_teams_on_runs_error()` trigger function (migration 0039)

```sql
CREATE OR REPLACE FUNCTION notify_teams_on_runs_error()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
DECLARE
    v_webhook_url   text;
    v_payload       jsonb;
    v_req_id        bigint;
    v_run_table     text := TG_TABLE_NAME;  -- 'integration_runs' or 'scoring_runs'
    v_scrubbed_msg  text;
BEGIN
    -- FR-O07 + TC-O8 — only fire on outcome='error'
    IF NEW.outcome <> 'error' THEN
        RETURN NEW;
    END IF;

    -- Resolve the webhook URL from the secret store. In dev this returns the
    -- mock receiver URL. In prod this returns the Teams incoming-webhook URL.
    v_webhook_url := current_setting('app.teams_webhook_url', true);
    IF v_webhook_url IS NULL OR v_webhook_url = '' THEN
        -- Webhook not configured — skip notification AND do NOT audit-log
        -- (this is a deployment misconfiguration, not a notification event)
        RETURN NEW;
    END IF;

    -- Build the Teams payload per contracts/teams-webhook-payload.md
    v_scrubbed_msg := scrub_pii_for_teams(NEW.error_message);
    v_payload := jsonb_build_object(
        'text', format(
            E'**WCM %s error** — run %s | action `%s` | started %s\n\n%s\n\nRunbook: https://github.com/nortal/world-cup-madness/blob/main/docs/runbooks/%s.md',
            v_run_table,
            NEW.id::text,
            NEW.action,
            to_char(NEW.started_at, 'YYYY-MM-DD HH24:MI:SS UTC'),
            v_scrubbed_msg,
            CASE v_run_table
                WHEN 'integration_runs' THEN 'provider-sync-failure'
                WHEN 'scoring_runs'     THEN 'scoring-failure'
                ELSE 'README'
            END
        )
    );

    -- Enqueue the HTTP POST via pg_net (async)
    SELECT net.http_post(
        url     := v_webhook_url,
        body    := v_payload,
        headers := '{"Content-Type": "application/json"}'::jsonb
    ) INTO v_req_id;

    -- Audit the attempt
    INSERT INTO audit_log (action, entity_type, new_value)
    VALUES (
        'notification.teams.sent',
        v_run_table,
        jsonb_build_object(
            'run_table',     v_run_table,
            'run_id',        NEW.id::text,
            'req_id',        v_req_id,
            'attempted_at',  now(),
            'http_status',   NULL
        )
    );

    RETURN NEW;
END;
$$;

-- Wire to both telemetry tables
DROP TRIGGER IF EXISTS integration_runs_notify_teams ON integration_runs;
CREATE TRIGGER integration_runs_notify_teams
    AFTER INSERT ON integration_runs
    FOR EACH ROW
    EXECUTE FUNCTION notify_teams_on_runs_error();

DROP TRIGGER IF EXISTS scoring_runs_notify_teams ON scoring_runs;
CREATE TRIGGER scoring_runs_notify_teams
    AFTER INSERT ON scoring_runs
    FOR EACH ROW
    EXECUTE FUNCTION notify_teams_on_runs_error();
```

### `reconcile_teams_notifications()` cron job (migration 0039)

Runs every 60 seconds via `pg_cron`. Scans `net._http_response` for rows newer than the last reconcile mark, joins them to the most recent `notification.teams.sent` audit row by `req_id`, and emits `notification.teams.failed` for any non-2xx or transport-error response. Full body in contracts/trigger-notify-on-runs-error.md § Reconciler.

## 5. Relationships

```
integration_runs.outcome='error'  --AFTER INSERT-->  notify_teams_on_runs_error()
                                                            |
                                                            +-> net.http_post(...) --enqueue--> net.http_request_queue
                                                            +-> INSERT audit_log (notification.teams.sent, http_status=null)

scoring_runs.outcome='error'      --AFTER INSERT-->  notify_teams_on_runs_error()
                                                            (same downstream as above)

pg_cron every 60s: reconcile_teams_notifications()
                                                            |
                                                            +-> scan net._http_response (NEW since last mark)
                                                            +-> match by req_id to audit_log.new_value->>'req_id'
                                                            +-> UPDATE the sent row: set http_status if 2xx
                                                            +-> INSERT a new failed row if non-2xx OR error_msg present
                                                                (with scrub_pii_for_teams() applied to error_msg + response body)
```

The reconciler reuses the existing pg_cron infrastructure from feature 004 (`leaderboard-refresh-tick`). No new cron extension activation, no new cron-specific role.

## 6. RLS impact

None. The existing `audit_log` admin-read policy already covers the two new action values — RLS scopes on `auth_user_id IS NOT NULL AND is_admin_user(auth.uid())`, not on `action`. No new policy, no policy modification.

`_test_mock_teams_inbox` is dev-only and has no RLS (service-role writes only).

## 7. Migration ordering

| # | Migration | Purpose |
|---|---|---|
| 0039 | `audit_log_action_extension_and_notifications.sql` | Extends `audit_log.action` CHECK; adds `scrub_pii_for_teams()`, `notify_teams_on_runs_error()` trigger function, AFTER INSERT triggers on `integration_runs` + `scoring_runs`, `reconcile_teams_notifications()` cron job. Single migration so the new audit values are valid BEFORE the trigger that uses them runs. |
| 0040 | `dev_only_mock_teams_inbox.sql` | Dev-only test fixture table. Gated by `app.env='development'`. |
