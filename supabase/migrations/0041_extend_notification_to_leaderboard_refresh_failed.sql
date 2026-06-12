-- Migration 0041 — extend the Teams notification family to cover
-- `audit_log` rows where `action='leaderboard.refresh_failed'` (feature
-- 006 US3 / FR-O09).
--
-- Feature 004's leaderboard MV refresh runs inside `pg_cron`'s
-- `leaderboard-refresh-tick` job. When that REFRESH errors, the cron
-- function inserts an `audit_log` row with `action='leaderboard.refresh_failed'`
-- (per feature 004 FC-L2 / migration 0034). Without this extension that
-- row sits silently — the ops admin would only see it in the
-- match-window-readiness query (pane 3) and only after the next manual
-- check.
--
-- Design choice: a SEPARATE trigger function on `audit_log`, NOT a further
-- branch in `notify_teams_on_runs_error()`. Why:
--   - The `WHEN (NEW.action = 'leaderboard.refresh_failed')` clause filters
--     at trigger level — we never run any payload-building code for the
--     other 19 action values, including our own `notification.teams.*`
--     rows that this trigger would otherwise loop on.
--   - The runbook URL routing differs: `leaderboard.refresh_failed` points
--     at `docs/runbooks/mv-refresh-stuck.md` (US4 follow-on), not at
--     either `*_runs` runbook.
--
-- Loop safety: the WHEN clause filters out our own `notification.teams.sent`
-- and `notification.teams.failed` rows BEFORE the function body runs.
-- Verified by pgTAP 029.
--
-- References: FR-O09 + feature 004 FC-L2 audit-log contract +
-- contracts/trigger-notify-on-runs-error.md.

CREATE OR REPLACE FUNCTION notify_teams_on_audit_refresh_failed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net, pg_temp
AS $$
DECLARE
    v_webhook_url   text;
    v_payload       jsonb;
    v_req_id        bigint;
    v_scrubbed_msg  text;
BEGIN
    -- Defensive: the WHEN clause already filters but the function is
    -- callable by hand (e.g. from tests). Guard against any unrelated
    -- action being supplied here.
    IF NEW.action <> 'leaderboard.refresh_failed' THEN
        RETURN NEW;
    END IF;

    v_webhook_url := current_setting('app.teams_webhook_url', true);
    IF v_webhook_url IS NULL OR v_webhook_url = '' THEN
        -- Misconfiguration — silent skip, matches the *_runs trigger.
        RETURN NEW;
    END IF;

    -- The error context lives inside new_value JSON. Stringify and
    -- scrub before embedding in the Teams text.
    v_scrubbed_msg := scrub_pii_for_teams(NEW.new_value::text);

    v_payload := jsonb_build_object(
        'text',
        format(
            E'**WCM leaderboard.refresh_failed** — audit row %s | occurred %s\n\n%s\n\nRunbook: https://github.com/nortal/world-cup-madness/blob/main/docs/runbooks/mv-refresh-stuck.md',
            NEW.id::text,
            to_char(NEW.occurred_at, 'YYYY-MM-DD HH24:MI:SS UTC'),
            v_scrubbed_msg
        )
    );

    SELECT net.http_post(
        url     := v_webhook_url,
        body    := v_payload,
        headers := '{"Content-Type": "application/json"}'::jsonb
    ) INTO v_req_id;

    INSERT INTO audit_log (action, entity_type, entity_id, new_value)
    VALUES (
        'notification.teams.sent',
        'audit_log',
        NULL,  -- audit_log.id is bigint, entity_id is uuid → can't link
        jsonb_build_object(
            'run_table',    'audit_log',
            'run_id',       NEW.id::text,
            'req_id',       v_req_id,
            'attempted_at', now(),
            'http_status',  NULL
        )
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION notify_teams_on_audit_refresh_failed() FROM PUBLIC;

DROP TRIGGER IF EXISTS audit_log_notify_teams_refresh_failed ON audit_log;
CREATE TRIGGER audit_log_notify_teams_refresh_failed
    AFTER INSERT ON audit_log
    FOR EACH ROW
    WHEN (NEW.action = 'leaderboard.refresh_failed')
    EXECUTE FUNCTION notify_teams_on_audit_refresh_failed();

COMMENT ON FUNCTION notify_teams_on_audit_refresh_failed() IS
    'feature 006 FR-O09 / US3: emit a Teams webhook POST + notification.teams.sent audit row for each leaderboard.refresh_failed audit_log row. WHEN clause on the trigger filters out our own notification.teams.* rows so no loop.';
