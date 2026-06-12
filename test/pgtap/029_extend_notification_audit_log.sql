-- pgTAP test: feature 006 US3 / FR-O09 — extending Teams notifications
-- to `audit_log.action='leaderboard.refresh_failed'`.
--
-- Source migration: supabase/migrations/0041_extend_notification_to_leaderboard_refresh_failed.sql
-- Contract: specs/006-phase-5-operational/spec.md FR-O09 +
--           specs/006-phase-5-operational/data-model.md § Relationships
--
-- Asserts:
--   1  : inserting an audit_log row with action='leaderboard.refresh_failed'
--        enqueues exactly one row in net.http_request_queue.
--   2  : the same insert creates exactly one notification.teams.sent
--        audit row with entity_type='audit_log'.
--   3  : the notification audit row carries a numeric req_id.
--   4  : the notification audit row's http_status starts NULL (the
--        reconciler sets it on response).
--   5  : LOOP SAFETY — inserting a notification.teams.sent row does NOT
--        enqueue another http_post (filtered by the WHEN clause on the
--        trigger).
--   6  : LOOP SAFETY — inserting a notification.teams.failed row likewise
--        does NOT enqueue.
--   7  : inserting an audit_log row with action='leaderboard.refresh'
--        (the SUCCESS case) does NOT fire the trigger.
--   8  : an UNRELATED action ('participant.created') does NOT fire the
--        trigger either.
--
-- Frame: SET LOCAL app.teams_webhook_url at the top so the trigger fires;
-- BEGIN/ROLLBACK so the test leaves no residue (and the pg_net enqueue
-- gets rolled back too — pg_net's enqueue is transactional).

BEGIN;

SET LOCAL app.teams_webhook_url = 'http://kong:8000/functions/v1/mock-teams-receiver?respond_with=200';

SELECT plan(8);

-- ---------------------------------------------------------------------------
-- Baseline counts.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _t_baselines AS
SELECT
    (SELECT count(*) FROM net.http_request_queue) AS http_queue_baseline,
    (SELECT count(*) FROM audit_log
        WHERE action = 'notification.teams.sent'
          AND entity_type = 'audit_log')           AS sent_baseline;

-- ---------------------------------------------------------------------------
-- TEST 1 + 2 + 3 + 4 — refresh_failed fires the trigger
-- ---------------------------------------------------------------------------

INSERT INTO audit_log (action, entity_type, new_value)
VALUES (
    'leaderboard.refresh_failed',
    'leaderboard_snapshots',
    '{"caller_kind":"cron","error":"REFRESH MATERIALIZED VIEW CONCURRENTLY conflict"}'::jsonb
);

SELECT is(
    (SELECT count(*) FROM net.http_request_queue) - (SELECT http_queue_baseline FROM _t_baselines),
    1::bigint,
    'TEST 1: leaderboard.refresh_failed enqueues exactly one http_post'
);

SELECT is(
    (SELECT count(*) FROM audit_log
        WHERE action = 'notification.teams.sent'
          AND entity_type = 'audit_log')
    - (SELECT sent_baseline FROM _t_baselines),
    1::bigint,
    'TEST 2: leaderboard.refresh_failed creates one notification.teams.sent row with entity_type=audit_log'
);

SELECT ok(
    EXISTS(
        SELECT 1 FROM audit_log
        WHERE action = 'notification.teams.sent'
          AND entity_type = 'audit_log'
          AND (new_value->>'req_id')::bigint IS NOT NULL
    ),
    'TEST 3: notification audit row carries a numeric req_id'
);

SELECT is(
    (SELECT new_value->>'http_status' FROM audit_log
        WHERE action = 'notification.teams.sent'
          AND entity_type = 'audit_log'
        ORDER BY occurred_at DESC LIMIT 1),
    NULL,
    'TEST 4: notification audit row http_status is NULL at enqueue time'
);

-- ---------------------------------------------------------------------------
-- TEST 5 + 6 — loop safety: notification.teams.* rows do NOT re-fire
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _t_loop_check AS
SELECT (SELECT count(*) FROM net.http_request_queue) AS queue_pre;

INSERT INTO audit_log (action, entity_type, new_value)
VALUES ('notification.teams.sent', 'audit_log', '{"loop_safety_test":"sent"}'::jsonb);

SELECT is(
    (SELECT count(*) FROM net.http_request_queue) - (SELECT queue_pre FROM _t_loop_check),
    0::bigint,
    'TEST 5: inserting a notification.teams.sent row does NOT enqueue (loop safety)'
);

INSERT INTO audit_log (action, entity_type, new_value)
VALUES ('notification.teams.failed', 'audit_log', '{"loop_safety_test":"failed"}'::jsonb);

SELECT is(
    (SELECT count(*) FROM net.http_request_queue) - (SELECT queue_pre FROM _t_loop_check),
    0::bigint,
    'TEST 6: inserting a notification.teams.failed row does NOT enqueue (loop safety)'
);

-- ---------------------------------------------------------------------------
-- TEST 7 — leaderboard.refresh (success) does NOT fire
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _t_success_check AS
SELECT (SELECT count(*) FROM net.http_request_queue) AS queue_pre;

INSERT INTO audit_log (action, entity_type, new_value)
VALUES ('leaderboard.refresh', 'leaderboard_snapshots',
        '{"caller_kind":"cron","refreshed_at":"2026-06-12T20:00:00Z"}'::jsonb);

SELECT is(
    (SELECT count(*) FROM net.http_request_queue) - (SELECT queue_pre FROM _t_success_check),
    0::bigint,
    'TEST 7: leaderboard.refresh (the SUCCESS variant) does NOT enqueue'
);

-- ---------------------------------------------------------------------------
-- TEST 8 — unrelated action does NOT fire
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _t_unrelated_check AS
SELECT (SELECT count(*) FROM net.http_request_queue) AS queue_pre;

INSERT INTO audit_log (action, entity_type, new_value)
VALUES ('participant.created', 'participants', '{"display_name":"alice"}'::jsonb);

SELECT is(
    (SELECT count(*) FROM net.http_request_queue) - (SELECT queue_pre FROM _t_unrelated_check),
    0::bigint,
    'TEST 8: unrelated audit action (participant.created) does NOT enqueue'
);

SELECT * FROM finish();

ROLLBACK;
