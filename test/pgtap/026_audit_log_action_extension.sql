-- pgTAP test: audit_log.action CHECK enum extension (feature 006, T008).
--
-- Source migration: supabase/migrations/0039_audit_log_action_extension_and_notifications.sql
-- Contract: specs/006-phase-5-operational/data-model.md § 1
-- Spec references: FR-O03b. Established precedent: features 003 + 004 (now
-- codified as a backend-constitution stack row — "audit_log.action enum
-- extension per feature").
--
-- Asserts:
--   1-20  : each of the 20 allowed action values accepts an INSERT.
--   21    : the constraint name is exactly 'audit_log_action_check'.
--   22    : an unknown action value raises SQLSTATE 23514 (CHECK violation).
--
-- Frame: BEGIN/ROLLBACK so the test leaves zero audit_log residue.

BEGIN;

SELECT plan(22);

-- ---------------------------------------------------------------------------
-- TESTs 1-20 — every allowed value accepts an INSERT.
-- The list MUST match data-model.md § 1 verbatim. If a future feature
-- extends the enum and updates this list, both the test name and the count
-- in plan() above need to move in lockstep.
-- ---------------------------------------------------------------------------

SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('participant.created',         '{}'::jsonb)$$,
    'TEST 1: participant.created accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('participant.updated',         '{}'::jsonb)$$,
    'TEST 2: participant.updated accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('participant.deactivated',     '{}'::jsonb)$$,
    'TEST 3: participant.deactivated accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('participant.role-changed',    '{}'::jsonb)$$,
    'TEST 4: participant.role-changed accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('auth.rejected',               '{}'::jsonb)$$,
    'TEST 5: auth.rejected accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('auth.provider-error',         '{}'::jsonb)$$,
    'TEST 6: auth.provider-error accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('tenant.departure',            '{}'::jsonb)$$,
    'TEST 7: tenant.departure accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('prediction.created',          '{}'::jsonb)$$,
    'TEST 8: prediction.created accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('prediction.updated',          '{}'::jsonb)$$,
    'TEST 9: prediction.updated accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('final_prediction.created',    '{}'::jsonb)$$,
    'TEST 10: final_prediction.created accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('final_prediction.updated',    '{}'::jsonb)$$,
    'TEST 11: final_prediction.updated accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('scoring.match',               '{}'::jsonb)$$,
    'TEST 12: scoring.match accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('scoring.final',               '{}'::jsonb)$$,
    'TEST 13: scoring.final accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('admin.match-result-override', '{}'::jsonb)$$,
    'TEST 14: admin.match-result-override accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('admin.recalc-all',            '{}'::jsonb)$$,
    'TEST 15: admin.recalc-all accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('admin.tournament-winner-set', '{}'::jsonb)$$,
    'TEST 16: admin.tournament-winner-set accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('leaderboard.refresh',         '{}'::jsonb)$$,
    'TEST 17: leaderboard.refresh accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('leaderboard.refresh_failed',  '{}'::jsonb)$$,
    'TEST 18: leaderboard.refresh_failed accepted'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('notification.teams.sent',     '{}'::jsonb)$$,
    'TEST 19: notification.teams.sent accepted (feature 006 addition)'
);
SELECT lives_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('notification.teams.failed',   '{}'::jsonb)$$,
    'TEST 20: notification.teams.failed accepted (feature 006 addition)'
);

-- ---------------------------------------------------------------------------
-- TEST 21 — constraint name is canonical
-- ---------------------------------------------------------------------------

SELECT is(
    (SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.audit_log'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%notification.teams.sent%'
        LIMIT 1),
    'audit_log_action_check',
    'TEST 21: extended CHECK constraint is named audit_log_action_check'
);

-- ---------------------------------------------------------------------------
-- TEST 22 — unknown action value is rejected (SQLSTATE 23514)
-- ---------------------------------------------------------------------------

SELECT throws_ok(
    $$INSERT INTO audit_log (action, new_value) VALUES ('not.a.real.action', '{}'::jsonb)$$,
    '23514',
    NULL,
    'TEST 22: unknown action value rejected with SQLSTATE 23514 (CHECK violation)'
);

SELECT * FROM finish();

ROLLBACK;
