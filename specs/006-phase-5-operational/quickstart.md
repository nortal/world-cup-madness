# Quickstart — Feature 006 (Phase 5 Operational Readiness)

End-to-end bring-up of the Teams-notification path against the local Supabase stack.

## Prerequisites

- Local Supabase stack up: `npx supabase start` (per project README).
- pgTAP installed: `docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "CREATE EXTENSION IF NOT EXISTS pgtap;"`
- Node 20+ on PATH (project README has the version pin).
- pg_cron enabled (already on per Supabase Pro tier — confirm with `SELECT extname FROM pg_extension WHERE extname='pg_cron';`).

## One-time setup

### 1. Apply migrations 0039 + 0040

```bash
cd project-repos/world-cup-madness
npx supabase db reset
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "CREATE EXTENSION IF NOT EXISTS pgtap;"
```

Verifies migrations land and the CHECK constraint + functions exist:

```sql
-- Should return 20 (18 existing + 2 new)
SELECT count(*) FROM (
    SELECT unnest(regexp_split_to_array(
        regexp_replace(pg_get_constraintdef(oid), '^.*action IN \((.+)\)\)$', '\1'),
        ',\s*'
    )) FROM pg_constraint WHERE conname = 'audit_log_action_check'
) sub;

-- Should return TRUE for both
SELECT
    EXISTS(SELECT 1 FROM pg_proc WHERE proname='scrub_pii_for_teams'),
    EXISTS(SELECT 1 FROM pg_proc WHERE proname='notify_teams_on_runs_error'),
    EXISTS(SELECT 1 FROM pg_proc WHERE proname='reconcile_teams_notifications');

-- Should return 2 (the two triggers)
SELECT count(*) FROM pg_trigger WHERE tgname IN (
    'integration_runs_notify_teams',
    'scoring_runs_notify_teams'
);
```

### 2. Configure the Teams webhook URL

Two paths — pick one:

**Local dev (mock receiver path)**:

```sql
-- Set app.env to development so migration 0040's mock-inbox table exists
ALTER DATABASE postgres SET app.env = 'development';
-- Point the trigger at the mock receiver Edge Function
ALTER DATABASE postgres SET app.teams_webhook_url = 'http://127.0.0.1:54321/functions/v1/mock-teams-receiver?respond_with=200';
-- Reconnect for the setting to take effect on new sessions:
SELECT pg_reload_conf();
```

Start the mock receiver:

```bash
npx supabase functions serve mock-teams-receiver --env-file .env.local
```

**Production / staging**:

```bash
# Set the webhook URL as a Supabase project secret (NOT a database setting)
npx supabase secrets set TEAMS_WEBHOOK_URL='https://nortal.webhook.office.com/webhookb2/...'

# A small post-deploy migration reads this into app.teams_webhook_url on the
# DB session. Pattern is documented in supabase/migrations/0039_*.sql.
```

The URL never lands in any git-tracked file. CI verification: `git grep -F 'webhook.office.com' -- . :(exclude)docs/` should return zero matches.

## Smoke test (kickoff MUST path)

### 1. Trigger a synthetic notification

```sql
-- A fake error to exercise the integration_runs trigger.
INSERT INTO integration_runs (action, outcome, error_message, started_at)
VALUES (
    'bootstrap',
    'error',
    'Synthetic test from quickstart.md — alice@nortal.com on match 00112233-4455-6677-8899-aabbccddeeff failed.',
    now()
);
```

### 2. Verify the Teams payload landed at the mock receiver (or your real Teams channel)

Local dev:

```sql
SELECT id, body, received_at, status_sent
FROM _test_mock_teams_inbox
ORDER BY received_at DESC
LIMIT 1;
```

Expected:
- `body->>'text'` contains `**WCM integration_runs error**`, the PII-scrubbed message, and a link to `docs/runbooks/provider-sync-failure.md`.
- The original email + UUID in the input have been replaced by `[REDACTED]`.

Production:
- A message appears in the configured Teams channel within 5 minutes (NFR-O01).

### 3. Verify the audit row

```sql
SELECT id, action, entity_type, entity_id, new_value, occurred_at
FROM audit_log
WHERE action LIKE 'notification.teams.%'
ORDER BY occurred_at DESC
LIMIT 5;
```

Expected:
- One row with `action='notification.teams.sent'`, `entity_type='integration_runs'`, `new_value->>'req_id'` is a bigint, `new_value->>'http_status'` is `null` (will become `'200'` after the reconciler ticks).

### 4. Force-tick the reconciler (skip the 60-s wait)

```sql
SELECT reconcile_teams_notifications_now();
```

Re-query the audit row from step 3 — `new_value->>'http_status'` should now be `'200'`. No new `notification.teams.failed` row.

## Failure smoke test

### 1. Point at a returning-410 mock to simulate a revoked webhook

```sql
ALTER DATABASE postgres SET app.teams_webhook_url = 'http://127.0.0.1:54321/functions/v1/mock-teams-receiver?respond_with=410';
SELECT pg_reload_conf();
```

### 2. Insert another synthetic error

```sql
INSERT INTO scoring_runs (action, outcome, error_message, started_at)
VALUES (
    'recalc-all',
    'error',
    'Synthetic test — SQLSTATE 23503 on participant 00112233-4455-6677-8899-aabbccddeeff',
    now()
);
```

### 3. Force-tick the reconciler

```sql
SELECT reconcile_teams_notifications_now();
```

### 4. Verify the failure audit row

```sql
SELECT action, entity_type, new_value
FROM audit_log
WHERE action='notification.teams.failed'
ORDER BY occurred_at DESC
LIMIT 1;
```

Expected:
- One row with `new_value->>'http_status' = '410'`, `new_value->>'error_msg'` non-null and PII-scrubbed (mock receiver returned the request body, which now appears as `[REDACTED]` for the participant_id).
- The corresponding `notification.teams.sent` row STILL exists with `http_status` either null or `'410'` (depending on reconciler update path).

### 5. Verify no retry

Wait 60 seconds (or force a second `reconcile_teams_notifications_now()` call). The count of `notification.teams.failed` rows for the same `req_id` is still **1** — FR-O03c.

## Run the tests

```bash
# pgTAP
docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -X -q \
    < test/pgtap/026_audit_log_action_extension.sql
docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -X -q \
    < test/pgtap/027_scrub_pii_for_teams.sql
docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -X -q \
    < test/pgtap/028_notify_teams_on_runs_error.sql

# Playwright (against npm run build + npm start as usual)
npx playwright test e2e/tests/notification-teams-end-to-end.spec.ts --project=chromium
```

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| Teams message does not arrive in channel | Webhook URL revoked OR app.teams_webhook_url unset | `SELECT current_setting('app.teams_webhook_url', true);` — if NULL, configure per § 2. If set but Teams shows nothing, the next reconciler tick will surface a `notification.teams.failed` row. |
| pgTAP `028_*.sql` fails on "trigger did not fire" | `pg_net` not enabled OR `app.teams_webhook_url` unset (silent skip per spec) | Confirm `SELECT extname FROM pg_extension WHERE extname='pg_net';` returns one row. Set `app.teams_webhook_url` per § 2. |
| `_test_mock_teams_inbox` table missing | `app.env` not set to `'development'` at migration 0040 apply time | `ALTER DATABASE postgres SET app.env = 'development'; npx supabase db reset` |
| Reconciler ticks but no audit row UPDATEs | `pg_cron` not enabled in this DB | `SELECT extname FROM pg_extension WHERE extname='pg_cron';` — must return one row. Pro tier required. |
| `git grep` finds webhook URL in the repo | Quickstart instructions ignored | DELETE the file, rotate the URL, follow § 2 properly. |
