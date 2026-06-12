-- Migration: extend audit_log.action CHECK + Microsoft Teams notification
--             primitives (feature 006 Phase 5 Operational Readiness, T004)
--
-- Per specs/006-phase-5-operational/data-model.md §1, §2, §4 +
-- contracts/function-scrub-pii.md + contracts/trigger-notify-on-runs-error.md +
-- contracts/audit-notification-sent.md + contracts/audit-notification-failed.md.
--
-- Satisfies: FR-O01 (Teams notifications on integration_runs + scoring_runs
--            failures), FR-O02 (PII-scrubbed payload), FR-O03 (audit trail of
--            every attempt), FR-O03b (sent + failed audit actions), FR-O03c
--            (no retry in v1), FR-O05 (silent skip on misconfigured webhook),
--            FR-O06 (60-s reconciler reads net._http_response), FR-O07 (only
--            fires on status='error') + research.md R-1 (single migration so
--            new audit values are valid BEFORE the trigger that uses them
--            runs) + R-5 (reconciler runs on a 60-s pg_cron tick to observe
--            eventual HTTP response from pg_net's async queue).
--
-- ESTABLISHED PATTERN (features 003 + 004): DROP CONSTRAINT IF EXISTS + ADD
-- CONSTRAINT with the full enumeration of all action values (existing + new).
-- Postgres does not support ALTER CONSTRAINT in place. Migration 0019
-- established this pattern for feature 003; migration 0037 extended it for
-- feature 004. Feature 006 follows the same shape.
--
-- COLUMN-TYPE CONSTRAINT — audit_log.entity_id is UUID (migration 0004).
--   - scoring_runs.id is UUID → can populate entity_id directly.
--   - integration_runs.id is BIGSERIAL (bigint) → cannot populate entity_id;
--     leave NULL and rely on new_value->>'run_id' for the back-reference.
-- The trigger function below branches on TG_TABLE_NAME accordingly.
--
-- RECONCILER STATE — we hold the "last reconciled net._http_response.id" mark
-- in a small one-row table (notification_reconcile_state). A session-local
-- GUC would not survive across cron invocations (each pg_cron job runs in its
-- own transaction). One row + UPDATE-in-place is the simplest durable mark.

-- ============================================================================
-- 1. CHECK enum extension — preserves all 18 prior values from features 001 +
--    003 + 004, appends 2 new feature-006 values.
-- ============================================================================
ALTER TABLE audit_log
    DROP CONSTRAINT IF EXISTS audit_log_action_check;

ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_action_check CHECK (
        action IN (
            -- feature 001 (migration 0004 baseline)
            'participant.created',
            'participant.updated',
            'participant.deactivated',
            'participant.role-changed',
            'auth.rejected',
            'auth.provider-error',
            'tenant.departure',
            -- feature 003 (migration 0019)
            'prediction.created',
            'prediction.updated',
            'final_prediction.created',
            'final_prediction.updated',
            'scoring.match',
            'scoring.final',
            'admin.match-result-override',
            'admin.recalc-all',
            'admin.tournament-winner-set',
            -- feature 004 (migration 0037)
            'leaderboard.refresh',
            'leaderboard.refresh_failed',
            -- feature 006 (this migration)
            'notification.teams.sent',
            'notification.teams.failed'
        )
    );

-- ============================================================================
-- 2. scrub_pii_for_teams(text) — PII redaction helper
-- ============================================================================
-- IMMUTABLE so pgTAP can assert determinism (input -> output) without
-- planner-cache surprises. SET search_path = pg_temp is defensive — there are
-- no public references inside the body but the migration owner may run with a
-- broader path otherwise. NULL input coalesces to empty string at the function
-- head to avoid NULL propagation into the eventual JSON payload.
CREATE OR REPLACE FUNCTION scrub_pii_for_teams(input text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_temp
AS $$
DECLARE
    out text := COALESCE(input, '');
BEGIN
    -- 1. Emails (RFC 5322-ish). TLD {2,} guards against trailing punctuation.
    out := regexp_replace(
        out,
        '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',
        '[REDACTED]',
        'g'
    );
    -- 2. UUIDs (oid, participant_id, player_id, match_id — all UUID-shaped).
    out := regexp_replace(
        out,
        '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
        '[REDACTED]',
        'g'
    );
    -- 3. Bare nortal.com mentions outside email pattern. \m / \M are
    -- PostgreSQL POSIX word boundaries (alphanumeric-or-underscore).
    out := regexp_replace(
        out,
        '\mnortal\.com\M',
        '[REDACTED]',
        'g'
    );
    -- Truncate to 500 chars AFTER scrubbing so we never half-redact a UUID
    -- at the truncation boundary.
    RETURN substr(out, 1, 500);
END;
$$;

COMMENT ON FUNCTION scrub_pii_for_teams(text) IS
    'feature 006 FR-O02: redact emails, UUIDs, and bare nortal.com mentions from a string before it lands in a Microsoft Teams notification payload. IMMUTABLE; 500-char truncation after scrubbing.';

-- ============================================================================
-- 3. notify_teams_on_runs_error() trigger function
-- ============================================================================
-- AFTER INSERT trigger on integration_runs + scoring_runs. Early-return on
-- status<>'error' (FR-O07) and on missing webhook config (FR-O05). Builds the
-- Teams payload via scrub_pii_for_teams() + format(), enqueues a POST through
-- pg_net (async — returns a bigint request id immediately), and audits the
-- attempt with action='notification.teams.sent' + http_status=NULL. The
-- reconciler (below) flips http_status to the real 2xx code or emits a
-- separate 'notification.teams.failed' row.
--
-- search_path = public, net, pg_temp — net is needed for net.http_post; pg_temp
-- closes a SECURITY DEFINER hijack vector.
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
    v_run_table     text := TG_TABLE_NAME;
    v_scrubbed_msg  text;
    v_entity_id     uuid;
BEGIN
    -- FR-O07 / TC-O8: only fire on the error outcome.
    IF NEW.status <> 'error' THEN
        RETURN NEW;
    END IF;

    -- FR-O05: silent skip on missing webhook configuration. Deployment misconfig
    -- is NOT a notification event — do not audit, do not raise.
    v_webhook_url := current_setting('app.teams_webhook_url', true);
    IF v_webhook_url IS NULL OR v_webhook_url = '' THEN
        RETURN NEW;
    END IF;

    -- Build the Teams payload per contracts/teams-webhook-payload.md. The
    -- runbook URL is derived from TG_TABLE_NAME so each table points at its
    -- own troubleshooting page.
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

    -- Enqueue the async POST. net.http_post returns a bigint request id; the
    -- actual HTTP exchange completes some time later and lands in
    -- net._http_response — observed by the reconciler below.
    SELECT net.http_post(
        url     := v_webhook_url,
        body    := v_payload,
        headers := '{"Content-Type": "application/json"}'::jsonb
    ) INTO v_req_id;

    -- audit_log.entity_id is UUID. integration_runs.id is bigint (cannot fit);
    -- scoring_runs.id is UUID (fits). For the bigint case we leave entity_id
    -- NULL and keep the back-reference in new_value->>'run_id'.
    IF v_run_table = 'scoring_runs' THEN
        v_entity_id := NEW.id;
    ELSE
        v_entity_id := NULL;
    END IF;

    INSERT INTO audit_log (action, entity_type, entity_id, new_value)
    VALUES (
        'notification.teams.sent',
        v_run_table,
        v_entity_id,
        jsonb_build_object(
            'run_table',    v_run_table,
            'run_id',       NEW.id::text,
            'req_id',       v_req_id,
            'attempted_at', now(),
            'http_status',  NULL
        )
    );

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION notify_teams_on_runs_error() IS
    'feature 006 FR-O01/O02/O03/O05/O07: AFTER INSERT trigger on integration_runs + scoring_runs. On status=error, scrubs the error message, builds a Teams payload, enqueues via pg_net (async), audits as notification.teams.sent (http_status=NULL). Silent skip on missing webhook config. SECURITY DEFINER.';

-- ============================================================================
-- 4. AFTER INSERT triggers on integration_runs + scoring_runs
-- ============================================================================
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

-- ============================================================================
-- 5. Reconciler — durable mark table + scan/match function + cron job
-- ============================================================================
-- notification_reconcile_state holds the highest net._http_response.id we have
-- already processed. One row, updated in place. Initialised to 0 so the first
-- reconcile pass picks up every response. We choose a table (not a GUC)
-- because pg_cron jobs run in their own transactions — a session-local GUC
-- would not persist between ticks.
CREATE TABLE IF NOT EXISTS notification_reconcile_state (
    -- singleton lock: only one row permitted.
    id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_response_id    BIGINT NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO notification_reconcile_state (id, last_response_id)
    VALUES (1, 0)
    ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE notification_reconcile_state IS
    'feature 006: singleton mark table for reconcile_teams_notifications(). Stores the highest net._http_response.id already reconciled, so each cron tick only scans new responses.';

CREATE OR REPLACE FUNCTION reconcile_teams_notifications()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
DECLARE
    v_last_mark       bigint;
    v_new_mark        bigint;
    v_resp            RECORD;
    v_sent_row_id     bigint;
    v_sent_new_value  jsonb;
    v_entity_type     text;
    v_entity_id       uuid;
    v_run_id          text;
    v_attempted_at    text;
    v_error_text      text;
BEGIN
    -- 1. Read the last-reconciled mark. WHERE clause is mandatory under
    -- supautils (Supabase blocks unqualified UPDATE/DELETE — SQLSTATE 21000).
    SELECT last_response_id INTO v_last_mark
        FROM notification_reconcile_state
        WHERE id = 1
        FOR UPDATE;

    IF v_last_mark IS NULL THEN
        v_last_mark := 0;
    END IF;
    v_new_mark := v_last_mark;

    -- 2. Scan net._http_response for rows newer than the mark. pg_net writes
    -- one row per completed (or transport-failed) request. Ordering by id is
    -- equivalent to ordering by created_at because id is monotonically issued.
    FOR v_resp IN
        SELECT id, status_code, content, error_msg, created
            FROM net._http_response
            WHERE id > v_last_mark
            ORDER BY id ASC
    LOOP
        -- Advance the mark for every observed response, even orphans.
        IF v_resp.id > v_new_mark THEN
            v_new_mark := v_resp.id;
        END IF;

        -- 2a. Find the matching sent row by req_id.
        SELECT id, new_value, entity_type, entity_id
            INTO v_sent_row_id, v_sent_new_value, v_entity_type, v_entity_id
            FROM audit_log
            WHERE action = 'notification.teams.sent'
              AND (new_value->>'req_id')::bigint = v_resp.id
            ORDER BY id DESC
            LIMIT 1;

        IF v_sent_row_id IS NULL THEN
            -- Orphan response — log a NOTICE for ops and move on. Should not
            -- happen in practice unless another caller posts via pg_net using
            -- the same request id namespace.
            RAISE NOTICE 'reconcile_teams_notifications: orphan net._http_response id=% (no notification.teams.sent row matches)', v_resp.id;
            CONTINUE;
        END IF;

        v_run_id       := v_sent_new_value->>'run_id';
        v_attempted_at := v_sent_new_value->>'attempted_at';

        IF v_resp.status_code BETWEEN 200 AND 299 THEN
            -- 2b. Success path: UPDATE the sent row's http_status in place.
            -- WHERE id = v_sent_row_id is REQUIRED (supautils 21000 guard).
            UPDATE audit_log
                SET new_value = new_value
                    || jsonb_build_object('http_status', v_resp.status_code)
                WHERE id = v_sent_row_id;

        ELSIF v_resp.status_code >= 400
              OR v_resp.error_msg IS NOT NULL THEN
            -- 2c. Failure path: INSERT a new notification.teams.failed row.
            -- error_msg is scrubbed (FR-O02) and falls back to the response
            -- body when the transport itself did not error out.
            v_error_text := scrub_pii_for_teams(
                COALESCE(v_resp.error_msg, v_resp.content)
            );

            INSERT INTO audit_log (action, entity_type, entity_id, new_value)
            VALUES (
                'notification.teams.failed',
                v_entity_type,
                v_entity_id,
                jsonb_build_object(
                    'run_table',       v_entity_type,
                    'run_id',          v_run_id,
                    'req_id',          v_resp.id,
                    'attempted_at',    v_attempted_at,
                    'completed_at',    v_resp.created,
                    'http_status',     v_resp.status_code,
                    'error_msg',       v_error_text,
                    'retry_attempted', false
                )
            );
        END IF;
    END LOOP;

    -- 3. Persist the advanced mark. WHERE id = 1 is REQUIRED (supautils).
    IF v_new_mark > v_last_mark THEN
        UPDATE notification_reconcile_state
            SET last_response_id = v_new_mark,
                updated_at       = now()
            WHERE id = 1;
    END IF;
END;
$$;

COMMENT ON FUNCTION reconcile_teams_notifications() IS
    'feature 006 FR-O03b/O06 + R-5: scan net._http_response for new rows since the last mark, join to notification.teams.sent audit rows by req_id, UPDATE on 2xx (set http_status), INSERT notification.teams.failed on non-2xx or transport error (with PII scrub). Mark persisted in notification_reconcile_state. SECURITY DEFINER; pg_cron tick (every minute).';

-- Wrapper used by tests to skip the 60-s cron wait.
CREATE OR REPLACE FUNCTION reconcile_teams_notifications_now()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM reconcile_teams_notifications();
END;
$$;

COMMENT ON FUNCTION reconcile_teams_notifications_now() IS
    'feature 006: synchronous wrapper around reconcile_teams_notifications() for Playwright / pgTAP tests that need deterministic reconciler behaviour without waiting for the pg_cron tick.';

-- ============================================================================
-- 6. pg_cron schedule — every minute (finest granularity pg_cron supports;
--    close enough to the 60-s contract in R-5).
-- ============================================================================
-- pg_cron is bundled with Supabase. Feature 004 migration 0035 already enables
-- the extension; CREATE IF NOT EXISTS is defensive and idempotent.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Idempotent: cron.schedule with an existing jobname replaces the schedule.
SELECT cron.schedule(
    'reconcile-teams-notifications',
    '* * * * *',
    $cron$SELECT reconcile_teams_notifications();$cron$
);

-- ============================================================================
-- 7. Lock down callable surface — trigger + cron internals, never app-facing.
-- ============================================================================
REVOKE ALL ON FUNCTION scrub_pii_for_teams(text)             FROM PUBLIC;
REVOKE ALL ON FUNCTION notify_teams_on_runs_error()           FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_teams_notifications()        FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_teams_notifications_now()    FROM PUBLIC;
-- No GRANT EXECUTE TO authenticated: these functions are trigger/cron
-- internals. notify_teams_on_runs_error() fires from the trigger as the
-- SECURITY DEFINER owner; the reconciler is invoked by pg_cron (postgres
-- superuser) and by the test wrapper via service-role RPC.
