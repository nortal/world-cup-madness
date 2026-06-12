-- pgTAP test: notify_teams_on_runs_error() trigger (feature 006, T010)
--
-- Source migration: supabase/migrations/0039_audit_log_action_extension_and_notifications.sql
-- Contract: specs/006-phase-5-operational/contracts/trigger-notify-on-runs-error.md
--
-- Spec references:
--   FR-O01 — On integration_runs INSERT with status='error', enqueue a Teams
--            webhook POST via pg_net AND record a notification.teams.sent
--            audit_log row in the same transaction.
--   FR-O02 — Same behaviour for scoring_runs (the trigger is wired to both
--            telemetry tables; runbook URL is selected by TG_TABLE_NAME).
--   FR-O07 / TC-O8 — Trigger MUST NOT fire on status IN ('success','skipped');
--            early RETURN NEW with no side effects.
--   FR-O05 — When app.teams_webhook_url is NULL or empty, trigger silently
--            skips: no enqueue, no audit row (deployment-misconfig is not a
--            notification event).
--   research.md §R-1 — Single migration so the new audit_log.action enum
--            values are valid BEFORE the trigger that emits them runs.
--
-- COLUMN-NAME NOTE: integration_runs and scoring_runs both expose a `status`
-- column (NOT `outcome`). The trigger function branches on NEW.status<>'error'.
-- Inserts below all use status=...
--
-- TABLE CONSTRAINT NOTES (discovered while writing this test):
--   - integration_runs has a partial UNIQUE index ((1)) WHERE finished_at IS
--     NULL — at most ONE in-flight row across the whole table. Each test must
--     set finished_at on every INSERT so subsequent tests don't collide.
--   - scoring_runs has the same shape keyed on (action) (per-action mutex);
--     same workaround.
--   - scoring_runs.error_message_for_error_status CHECK requires
--     (status='error') = (error_message IS NOT NULL). status='error' INSERTs
--     must set error_message; status='success' MUST leave it NULL.
--   - net.http_request_queue.body is bytea (NOT jsonb) — payload assertions
--     decode via convert_from(body, 'UTF8')::jsonb.
--
-- ROLLBACK NOTE: pg_net's enqueue is fully transactional in the local
-- Supabase stack — a manual smoke test confirmed that ROLLBACK clears the
-- queue row AND the audit row. The BEGIN/ROLLBACK frame is therefore
-- hermetic; we don't need to mop the queue at the end.
--
-- Assertion plan (12 total):
--   1.  success status does NOT enqueue (FR-O07)
--   2.  skipped status does NOT enqueue (FR-O07)
--   3.  error status DOES enqueue exactly one row (FR-O01)
--   4.  notification.teams.sent audit row created with parseable req_id
--   5.  integration_runs error: entity_id is NULL (bigint can't fit in UUID)
--   6.  scoring_runs error DOES enqueue (FR-O02)
--   7.  scoring_runs error: entity_id IS populated (id is UUID)
--   8.  scoring_runs success does NOT enqueue
--   9.  Webhook URL empty → silent skip (FR-O05): no queue row
--   10. Webhook URL empty → silent skip (FR-O05): no audit row
--   11. integration_runs payload references the provider-sync-failure runbook
--   12. scoring_runs payload references the scoring-failure runbook
--       + payload Content-Type header asserts as application/json
--       + error_message PII (email) scrubbed to [REDACTED]
--       + http_status in audit row is NULL at enqueue time
-- (Tests 11-12 batch the payload structural asserts via ok() because each
-- payload check uses the same queue row.)

BEGIN;

SELECT plan(12);

-- Configure the webhook URL for the enqueue-path tests. SET LOCAL keeps the
-- value scoped to this transaction; ROLLBACK clears it.
SET LOCAL app.teams_webhook_url = 'http://127.0.0.1:54321/functions/v1/mock-teams-receiver?respond_with=200';

-- ---------------------------------------------------------------------------
-- Capture pre-test baseline counts so each test asserts on a DELTA.
-- The DB is shared with other tests / dev state, so we can't assume empty.
-- Stash baselines in a TEMP table (rolled back with the rest of the txn).
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE t_baseline (
    queue_count   BIGINT,
    audit_sent    BIGINT
) ON COMMIT DROP;

INSERT INTO t_baseline (queue_count, audit_sent)
SELECT
    (SELECT count(*) FROM net.http_request_queue),
    (SELECT count(*) FROM audit_log WHERE action = 'notification.teams.sent');

-- ===========================================================================
-- TEST 1 — success status on integration_runs does NOT enqueue (FR-O07)
-- ===========================================================================
INSERT INTO integration_runs (provider, action, status, finished_at)
VALUES ('football-data.org', 'manual-resync', 'success', now());

SELECT is(
    (SELECT count(*) FROM net.http_request_queue)
        - (SELECT queue_count FROM t_baseline),
    0::bigint,
    'TEST 1: status=success on integration_runs does NOT enqueue (FR-O07)'
);

-- ===========================================================================
-- TEST 2 — skipped status on integration_runs does NOT enqueue (FR-O07)
-- ===========================================================================
INSERT INTO integration_runs (provider, action, status, finished_at)
VALUES ('football-data.org', 'manual-resync', 'skipped', now());

SELECT is(
    (SELECT count(*) FROM net.http_request_queue)
        - (SELECT queue_count FROM t_baseline),
    0::bigint,
    'TEST 2: status=skipped on integration_runs does NOT enqueue (FR-O07)'
);

-- ===========================================================================
-- TEST 3 — error status on integration_runs DOES enqueue exactly one row
--          (FR-O01). The error_message contains an email so TEST 12 can
--          later assert PII scrubbing on the same queue row.
-- ===========================================================================
INSERT INTO integration_runs (provider, action, status, finished_at, error_message)
VALUES ('football-data.org', 'incremental-sync', 'error', now(),
        'Provider 503 from football-data.org for ops@nortal.com');

SELECT is(
    (SELECT count(*) FROM net.http_request_queue)
        - (SELECT queue_count FROM t_baseline),
    1::bigint,
    'TEST 3: status=error on integration_runs enqueues exactly one net.http_request_queue row (FR-O01)'
);

-- ===========================================================================
-- TEST 4 — notification.teams.sent audit row is created with a req_id
--          that parses as bigint and ties to the queue row inserted above.
-- ===========================================================================
SELECT is(
    (
        SELECT count(*)
        FROM audit_log a
        JOIN net.http_request_queue q
          ON (a.new_value->>'req_id')::bigint = q.id
        WHERE a.action = 'notification.teams.sent'
          AND a.entity_type = 'integration_runs'
          AND a.id > (
              SELECT COALESCE(MAX(id), 0) FROM audit_log
              WHERE action = 'notification.teams.sent'
                AND occurred_at < (SELECT now() - interval '1 second')
          )
    ),
    1::bigint,
    'TEST 4: notification.teams.sent audit row created with req_id matching the enqueued net.http_request_queue.id'
);

-- ===========================================================================
-- TEST 5 — integration_runs.id is BIGSERIAL → audit_log.entity_id (UUID)
--          MUST be NULL; back-reference lives in new_value->>''run_id''.
-- ===========================================================================
SELECT is(
    (
        SELECT entity_id IS NULL AND (new_value->>'run_id') ~ '^[0-9]+$'
        FROM audit_log
        WHERE action = 'notification.teams.sent'
          AND entity_type = 'integration_runs'
        ORDER BY id DESC LIMIT 1
    ),
    true,
    'TEST 5: integration_runs trigger leaves audit_log.entity_id NULL and stores bigint id in new_value->>run_id'
);

-- ---------------------------------------------------------------------------
-- Capture queue + audit counts before the scoring_runs branch so the
-- per-test delta assertions don't accidentally include integration_runs.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE t_after_integration (
    queue_count   BIGINT,
    audit_sent    BIGINT
) ON COMMIT DROP;

INSERT INTO t_after_integration (queue_count, audit_sent)
SELECT
    (SELECT count(*) FROM net.http_request_queue),
    (SELECT count(*) FROM audit_log WHERE action = 'notification.teams.sent');

-- ===========================================================================
-- TEST 6 — error status on scoring_runs DOES enqueue (FR-O02).
--          admin-recalc-all is the only action that doesn't need match_id.
-- ===========================================================================
INSERT INTO scoring_runs (action, status, finished_at, error_message)
VALUES ('admin-recalc-all', 'error', now(), 'recalc transaction aborted');

SELECT is(
    (SELECT count(*) FROM net.http_request_queue)
        - (SELECT queue_count FROM t_after_integration),
    1::bigint,
    'TEST 6: status=error on scoring_runs enqueues exactly one net.http_request_queue row (FR-O02)'
);

-- ===========================================================================
-- TEST 7 — scoring_runs.id is UUID → audit_log.entity_id IS populated and
--          equals NEW.id. (Different code path from TEST 5.)
-- ===========================================================================
SELECT is(
    (
        SELECT entity_id IS NOT NULL
               AND entity_id::text = (new_value->>'run_id')
        FROM audit_log
        WHERE action = 'notification.teams.sent'
          AND entity_type = 'scoring_runs'
        ORDER BY id DESC LIMIT 1
    ),
    true,
    'TEST 7: scoring_runs trigger populates audit_log.entity_id with the UUID and stores it in new_value->>run_id'
);

-- ===========================================================================
-- TEST 8 — scoring_runs status=success does NOT enqueue (mirrors TEST 1
--          for the second trigger registration).
-- ---------------------------------------------------------------------------
-- Capture pre-state for the success path.
CREATE TEMP TABLE t_before_scoring_success (
    queue_count   BIGINT
) ON COMMIT DROP;

INSERT INTO t_before_scoring_success (queue_count)
SELECT (SELECT count(*) FROM net.http_request_queue);

-- 'trigger-config-change' is a status='success'-compatible action that does
-- NOT require match_id.
INSERT INTO scoring_runs (action, status, finished_at)
VALUES ('trigger-config-change', 'success', now());

SELECT is(
    (SELECT count(*) FROM net.http_request_queue)
        - (SELECT queue_count FROM t_before_scoring_success),
    0::bigint,
    'TEST 8: status=success on scoring_runs does NOT enqueue (FR-O07 across both tables)'
);

-- ===========================================================================
-- TEST 9 + TEST 10 — webhook URL empty → silent skip (FR-O05).
--   No enqueue, no audit row. We change app.teams_webhook_url to ''
--   for this scope, then restore it.
-- ===========================================================================
-- Snapshot pre-state for the silent-skip path.
CREATE TEMP TABLE t_before_silent_skip (
    queue_count   BIGINT,
    audit_sent    BIGINT
) ON COMMIT DROP;

INSERT INTO t_before_silent_skip (queue_count, audit_sent)
SELECT
    (SELECT count(*) FROM net.http_request_queue),
    (SELECT count(*) FROM audit_log WHERE action = 'notification.teams.sent');

SET LOCAL app.teams_webhook_url = '';

INSERT INTO integration_runs (provider, action, status, finished_at, error_message)
VALUES ('football-data.org', 'bootstrap', 'error', now(), 'unreachable');

SELECT is(
    (SELECT count(*) FROM net.http_request_queue)
        - (SELECT queue_count FROM t_before_silent_skip),
    0::bigint,
    'TEST 9: webhook URL empty + status=error → silent skip: NO enqueue (FR-O05)'
);

SELECT is(
    (SELECT count(*) FROM audit_log WHERE action = 'notification.teams.sent')
        - (SELECT audit_sent FROM t_before_silent_skip),
    0::bigint,
    'TEST 10: webhook URL empty + status=error → silent skip: NO audit_log row (FR-O05)'
);

-- Restore the webhook URL for the payload-routing tests below.
SET LOCAL app.teams_webhook_url = 'http://127.0.0.1:54321/functions/v1/mock-teams-receiver?respond_with=200';

-- ===========================================================================
-- TEST 11 — integration_runs error payload references the
--           provider-sync-failure runbook (TG_TABLE_NAME routing).
--           Also verifies the audit row's http_status is NULL at enqueue.
-- ===========================================================================
-- Insert a fresh integration_runs error and capture its req_id, then read
-- the body of the corresponding net.http_request_queue row.
WITH sent AS (
    INSERT INTO integration_runs (provider, action, status, finished_at, error_message)
    VALUES ('football-data.org', 'incremental-sync', 'error', now(),
            'Provider unreachable')
    RETURNING id
)
SELECT 1 FROM sent;  -- force evaluation

SELECT ok(
    (
        SELECT
            -- payload contains provider-sync-failure runbook URL
            (convert_from(q.body, 'UTF8')::jsonb->>'text')
                LIKE '%runbooks/provider-sync-failure.md%'
            -- and references the integration_runs table
            AND (convert_from(q.body, 'UTF8')::jsonb->>'text')
                LIKE '%WCM integration_runs error%'
            -- header is application/json
            AND (q.headers->>'Content-Type') = 'application/json'
            -- audit row http_status is NULL at enqueue time (reconciler sets it later)
            AND (a.new_value->>'http_status') IS NULL
        FROM audit_log a
        JOIN net.http_request_queue q
          ON (a.new_value->>'req_id')::bigint = q.id
        WHERE a.action = 'notification.teams.sent'
          AND a.entity_type = 'integration_runs'
        ORDER BY a.id DESC LIMIT 1
    ),
    'TEST 11: integration_runs error payload routes to provider-sync-failure runbook + Content-Type=application/json + http_status NULL at enqueue'
);

-- ===========================================================================
-- TEST 12 — scoring_runs error payload references the scoring-failure
--           runbook AND PII (email in error_message) is scrubbed via
--           scrub_pii_for_teams() before egress.
-- ===========================================================================
INSERT INTO scoring_runs (action, status, finished_at, error_message)
VALUES ('admin-recalc-all', 'error', now(),
        'recalc failed for participant ops@nortal.com');

SELECT ok(
    (
        SELECT
            -- routes to the scoring-failure runbook
            (convert_from(q.body, 'UTF8')::jsonb->>'text')
                LIKE '%runbooks/scoring-failure.md%'
            -- references the scoring_runs table
            AND (convert_from(q.body, 'UTF8')::jsonb->>'text')
                LIKE '%WCM scoring_runs error%'
            -- the email in error_message is scrubbed to [REDACTED] (FR-O03a)
            AND (convert_from(q.body, 'UTF8')::jsonb->>'text')
                LIKE '%[REDACTED]%'
            -- and the original email DOES NOT appear in the payload
            AND (convert_from(q.body, 'UTF8')::jsonb->>'text')
                NOT LIKE '%ops@nortal.com%'
        FROM audit_log a
        JOIN net.http_request_queue q
          ON (a.new_value->>'req_id')::bigint = q.id
        WHERE a.action = 'notification.teams.sent'
          AND a.entity_type = 'scoring_runs'
        ORDER BY a.id DESC LIMIT 1
    ),
    'TEST 12: scoring_runs error payload routes to scoring-failure runbook AND email PII in error_message is scrubbed to [REDACTED]'
);

SELECT * FROM finish();

ROLLBACK;
