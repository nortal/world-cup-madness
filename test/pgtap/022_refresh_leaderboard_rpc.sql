-- pgTAP test: T008 — refresh_leaderboard() RPC caller-kind paths +
--                    FC-L2 decoupling guarantee (feature 004 US-L)
--
-- Source migration:
--   supabase/migrations/0033_refresh_leaderboard_rpc.sql
--     (refresh_leaderboard() + should_refresh_leaderboard() +
--      audit_log.action CHECK extension for 'leaderboard.refresh' /
--      'leaderboard.refresh_failed')
--
-- Spec references:
--   specs/004-leaderboard/contracts/rpc-refresh-leaderboard.md
--   specs/004-leaderboard/data-model.md §3.2, §4, §6
--
-- FR / FC references:
--   FR-L17 — Admin direct invocation gated by is_admin_user().
--   FR-L19 — Successful refresh writes a 'leaderboard.refresh' audit row.
--   FR-L20 — Audit payload records caller_kind (admin / cron / trigger),
--            duration_ms, participant_count, scoring_run_id (when trigger).
--   FR-L21 — Cron callers respect should_refresh_leaderboard(). When the
--            predicate returns false the call returns {outcome:'skipped',...}
--            AND emits NO audit row.
--   FR-L22 — Pre-tournament short-circuit: should_refresh_leaderboard() is
--            false when score_events is empty.
--   FC-L2  — Refresh failure decoupling: an exception inside the REFRESH
--            (or anywhere in the body) is CAUGHT — the function writes a
--            'leaderboard.refresh_failed' audit row and RETURNS a non-error
--            jsonb. The exception does NOT propagate, so a scoring
--            transaction that PERFORM-ed us still commits cleanly.
--
-- ACTUAL RPC SHAPE (verified against migration 0033, NOT the spec's prose):
--   - audit_log columns are `action` / `occurred_at` / `entity_type` /
--     `entity_id` / `new_value` (NOT event_type / created_at / target_table /
--     target_id). The CHECK constraint name is `audit_log_action_check`.
--   - Success outcome string is 'success' (NOT 'refreshed').
--   - Error outcome string is 'error' (NOT 'failed'). The exception is
--     swallowed; the function returns {outcome:'error', sqlstate, sqlerrm,
--     caller_kind}.
--   - Skipped outcome shape: {outcome:'skipped', reason:'gated', caller_kind:'cron'}.
--   - Caller-kind detection: GUC `app.cron_caller='true'` → 'cron';
--     non-empty/parseable `app.scoring_run_id` → 'trigger'; else admin path
--     (is_admin_user() gate, raises 42501 'FORBIDDEN' on failure).
--   - The trigger + cron paths bypass the admin gate; in production those
--     callers run inside SECURITY DEFINER contexts (postgres owner role)
--     without JWT claims. We mirror that here by running those assertions
--     as the test owner (no `SET LOCAL ROLE authenticated`).
--
-- Asserts (15 total) — order rationale below the list:
--    1. Admin direct call returns outcome='success'.
--    2. Audit row was emitted with action='leaderboard.refresh'.
--    3. Audit payload caller_kind='admin'.
--    4. Non-admin direct call raises 42501 (FORBIDDEN).
--    5. Cron context, predicate=true → outcome='success'.
--    6. Cron context, predicate=true → audit payload caller_kind='cron'.
--    7. Trigger context (scoring_run_id GUC set) → outcome='success'.
--    8. Trigger context → audit payload caller_kind='trigger'.
--    9. Trigger context → audit payload scoring_run_id = <fixture uuid>.
--   10. Forced REFRESH failure → outcome='error' (exception swallowed).
--   11. Forced REFRESH failure → 'leaderboard.refresh_failed' audit row emitted.
--   12. FC-L2 decoupling: outer transaction remains writable AFTER the
--       refresh failure — an INSERT issued on the same connection succeeds.
--   13. FC-L2: the same call also returns caller_kind in the failure jsonb
--       (lets a scoring trigger correlate the failure with its run).
--   14. Cron context, predicate=false (empty score_events) → outcome='skipped'.
--   15. Cron context, predicate=false → NO audit row emitted (FR-L21).
--
-- ORDER NOTES:
--   - The cron-skip pair runs LAST because it must DELETE all score_events to
--     force the FR-L22 short-circuit; doing it earlier would either require a
--     ROLLBACK TO SAVEPOINT (which rolls back pgTAP's internal test counter
--     and desyncs the planned-vs-ran tally — see the 017_prediction_rpcs.sql
--     TEST 26 comment) or a re-seed of score_events with `ON CONFLICT` against
--     a partial UNIQUE index. Running last side-steps both.
--   - Between caller-kind tests we explicitly `RESET app.cron_caller` and
--     `RESET app.scoring_run_id`. `RELEASE SAVEPOINT` does NOT undo SET LOCAL,
--     and the RPC's caller-kind detection is order-sensitive (cron wins over
--     trigger if both GUCs are set), so a stale GUC from a prior savepoint
--     silently misroutes later tests. Original failure observed during T008
--     authoring: TEST 10/15 reported caller_kind='cron' because TEST 7's
--     `SET LOCAL app.cron_caller='true'` survived its RELEASE.

BEGIN;

SELECT plan(15);

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for deterministic assertions
-- ---------------------------------------------------------------------------
\set nortal_tid          '11111111-1111-1111-1111-111111111111'

-- Participant A — active, role=participant (regular)
\set a_user_id           '21111111-1111-1111-1111-111111111111'
\set a_oid               '22222222-2222-2222-2222-222222222222'
\set a_part_id           'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

-- Admin participant — active, role=admin (is_admin_user() returns true)
\set adm_user_id         '41111111-1111-1111-1111-111111111111'
\set adm_oid             '44444444-4444-4444-4444-444444444444'
\set adm_part_id         'dddddddd-dddd-dddd-dddd-dddddddddddd'

-- Teams + match seed (FK target for match-source score_events)
\set home_team_id        '51111111-1111-1111-1111-111111111111'
\set away_team_id        '52222222-2222-2222-2222-222222222222'
\set match_id            '5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

-- Deterministic scoring_runs UUID for the trigger-context test.
\set scoring_run_id      '6ccccccc-cccc-cccc-cccc-cccccccccccc'

-- ---------------------------------------------------------------------------
-- Helper: set the JWT claims + auth.uid() for the next call
-- (copied verbatim from 017_prediction_rpcs.sql / 021_rls_leaderboard_snapshots.sql)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION test_set_jwt(
    p_sub   UUID,
    p_tid   UUID,
    p_oid   UUID,
    p_email TEXT,
    p_name  TEXT DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_claims JSONB;
BEGIN
    v_claims := jsonb_build_object(
        'sub',            p_sub::text,
        'email',          p_email,
        'app_metadata',   jsonb_build_object(
                              'tid', p_tid::text,
                              'oid', p_oid::text
                          ),
        'user_metadata',  jsonb_build_object('name', p_name)
    );
    PERFORM set_config('request.jwt.claims',     v_claims::text, true);
    PERFORM set_config('request.jwt.claim.sub',  p_sub::text,    true);
END $$;

-- ---------------------------------------------------------------------------
-- Seed auth.users (FK target for participants.auth_user_id)
-- ---------------------------------------------------------------------------
INSERT INTO auth.users (id) VALUES
    (:'a_user_id'),
    (:'adm_user_id')
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed tournament_config — admin_oids contains the admin oid (kept consistent
-- with sibling test files; is_admin_user() itself only checks participants.role).
-- ---------------------------------------------------------------------------
INSERT INTO tournament_config (id, nortal_tenant_id, admin_oids)
VALUES (1, :'nortal_tid', ARRAY[:'adm_oid'::uuid])
ON CONFLICT (id) DO UPDATE
    SET nortal_tenant_id = EXCLUDED.nortal_tenant_id,
        admin_oids       = EXCLUDED.admin_oids;

-- ---------------------------------------------------------------------------
-- Seed participants — A as regular, the admin row with role='admin' so
-- is_admin_user() returns true for the admin JWT.
-- ---------------------------------------------------------------------------
INSERT INTO participants (id, auth_user_id, oid, email, display_name, role, status)
VALUES
    (:'a_part_id'::uuid,   :'a_user_id'::uuid,   :'a_oid'::uuid,   'a@nortal.com',   'Participant A', 'participant', 'active'),
    (:'adm_part_id'::uuid, :'adm_user_id'::uuid, :'adm_oid'::uuid, 'adm@nortal.com', 'Admin User',    'admin',       'active')
ON CONFLICT (oid) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed teams + one finished group-stage match (FK target for score_events).
-- ---------------------------------------------------------------------------
INSERT INTO teams (id, name, tla, provider_team_id)
VALUES
    (:'home_team_id'::uuid, 'Home XI', 'HOM', 9001),
    (:'away_team_id'::uuid, 'Away XI', 'AWY', 9002)
ON CONFLICT (provider_team_id) DO NOTHING;

INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage,
                     group_label, kickoff_utc, venue, status,
                     score_home, score_away)
VALUES
    (:'match_id'::uuid, 99001, :'home_team_id'::uuid, :'away_team_id'::uuid,
     'group', 'A', '2026-06-15 18:00:00+00', 'Test Stadium', 'finished',
     2, 1)
ON CONFLICT (provider_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- score_events: NO explicit INSERT here.
--
-- The match seed above (status='finished' with both scores) trips the
-- AFTER INSERT trigger from migration 0030 (matches_trigger_scoring), which
-- calls calculate_match_points() and populates score_events with one
-- 'no-prediction' row per active participant. That's enough to make the
-- FR-L22 "score_events non-empty" predicate return true for the
-- cron-predicate=true test (TEST 7/8). A manual INSERT here would race
-- against that trigger's UNIQUE (participant_id, match_id) WHERE match_id IS
-- NOT NULL partial index.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Seed scoring_runs row for the trigger-context test. We need a real UUID
-- the RPC can record in the audit payload's scoring_run_id field.
-- (The RPC does not FK-check scoring_run_id, but we insert a real row so the
-- value matches an actual scoring run — consistent with how the production
-- trigger paths set this GUC.)
-- ---------------------------------------------------------------------------
INSERT INTO scoring_runs (id, action, started_at, status)
VALUES (:'scoring_run_id'::uuid, 'admin-recalc-all', now(), 'success')
ON CONFLICT (id) DO NOTHING;

-- Clear any audit rows from seed inserts so per-test counts are unambiguous.
DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';

-- Build the MV state once before tests so REFRESH ... CONCURRENTLY can run.
REFRESH MATERIALIZED VIEW leaderboard_snapshots;

-- ===========================================================================
-- 1-3: Admin direct call → success + audit row with caller_kind='admin'
-- ===========================================================================
SAVEPOINT sp_admin_call;

SELECT test_set_jwt(:'adm_user_id'::uuid, :'nortal_tid'::uuid, :'adm_oid'::uuid, 'adm@nortal.com');
SET LOCAL ROLE authenticated;

-- Assert 1: admin call returns outcome='success'.
SELECT is(
    (SELECT refresh_leaderboard() ->> 'outcome'),
    'success',
    'TEST 1 (FR-L17): admin direct call returns outcome=success'
);

RESET ROLE;

-- Assert 2: exactly one 'leaderboard.refresh' audit row was emitted.
SELECT is(
    (SELECT count(*)::int FROM audit_log WHERE action = 'leaderboard.refresh'),
    1,
    'TEST 2 (FR-L19): admin call emitted exactly one leaderboard.refresh audit row'
);

-- Assert 3: caller_kind on the audit row is 'admin'.
SELECT is(
    (SELECT new_value ->> 'caller_kind'
     FROM audit_log
     WHERE action = 'leaderboard.refresh'
     ORDER BY occurred_at DESC, id DESC LIMIT 1),
    'admin',
    'TEST 3 (FR-L20): audit payload records caller_kind=admin'
);

RELEASE SAVEPOINT sp_admin_call;

-- ===========================================================================
-- 4: Non-admin direct call → FORBIDDEN (42501)
-- ===========================================================================
SAVEPOINT sp_nonadmin_call;

SELECT test_set_jwt(:'a_user_id'::uuid, :'nortal_tid'::uuid, :'a_oid'::uuid, 'a@nortal.com');
SET LOCAL ROLE authenticated;

SELECT throws_ok(
    'SELECT refresh_leaderboard()',
    '42501',
    NULL,
    'TEST 4 (FR-L17 gate): non-admin direct call raises insufficient_privilege (FORBIDDEN)'
);

RESET ROLE;
-- Use RELEASE (not ROLLBACK TO SAVEPOINT) so pgTAP's internal test counter
-- stays in sync (per the comment in 017_prediction_rpcs.sql TEST 26). The
-- non-admin path raised inside throws_ok — pgTAP's wrapper caught it and the
-- outer transaction is still healthy.
RELEASE SAVEPOINT sp_nonadmin_call;

-- ===========================================================================
-- 5-6: Cron context with predicate=TRUE → success + caller_kind='cron'
--
-- Predicate returns true via the "no prior leaderboard.refresh audit row"
-- branch (data-model §4 gate ladder). score_events is non-empty (the match
-- seed's AFTER INSERT trigger populated it). We DELETE any prior
-- 'leaderboard.refresh' rows so v_last_refresh IS NULL → predicate true.
-- ===========================================================================
SAVEPOINT sp_cron_ok;

DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';
-- Cron path: GUC set, NO authenticated role (production cron runs as the
-- postgres owner). The admin gate is bypassed because v_caller_kind='cron'.
SET LOCAL app.cron_caller = 'true';

-- Assert 5: outcome='success'.
SELECT is(
    (SELECT refresh_leaderboard() ->> 'outcome'),
    'success',
    'TEST 5 (FR-L21): cron with predicate=true returns outcome=success'
);

-- Assert 6: audit row caller_kind='cron'.
SELECT is(
    (SELECT new_value ->> 'caller_kind'
     FROM audit_log
     WHERE action = 'leaderboard.refresh'
     ORDER BY occurred_at DESC, id DESC LIMIT 1),
    'cron',
    'TEST 6 (FR-L20): cron success audit payload records caller_kind=cron'
);

RELEASE SAVEPOINT sp_cron_ok;
-- CRITICAL: RELEASE keeps SET LOCAL changes alive in the outer transaction.
-- We must explicitly RESET so the next test's caller-kind detection isn't
-- misrouted to 'cron'.
RESET app.cron_caller;

-- ===========================================================================
-- 7-9: Trigger context → success + caller_kind='trigger' + scoring_run_id
-- ===========================================================================
SAVEPOINT sp_trigger_ok;

DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';
SET LOCAL app.scoring_run_id = '6ccccccc-cccc-cccc-cccc-cccccccccccc';

-- Assert 7: outcome='success'.
SELECT is(
    (SELECT refresh_leaderboard() ->> 'outcome'),
    'success',
    'TEST 7 (FR-L20): trigger-context call returns outcome=success'
);

-- Assert 8: audit payload caller_kind='trigger'.
SELECT is(
    (SELECT new_value ->> 'caller_kind'
     FROM audit_log
     WHERE action = 'leaderboard.refresh'
     ORDER BY occurred_at DESC, id DESC LIMIT 1),
    'trigger',
    'TEST 8 (FR-L20): trigger-context audit payload records caller_kind=trigger'
);

-- Assert 9: audit payload scoring_run_id matches the GUC.
SELECT is(
    (SELECT new_value ->> 'scoring_run_id'
     FROM audit_log
     WHERE action = 'leaderboard.refresh'
     ORDER BY occurred_at DESC, id DESC LIMIT 1),
    '6ccccccc-cccc-cccc-cccc-cccccccccccc',
    'TEST 9 (FR-L20): trigger-context audit payload carries the scoring_run_id'
);

RELEASE SAVEPOINT sp_trigger_ok;
-- The next FC-L2 test wants the trigger context too, so we intentionally
-- leave app.scoring_run_id set (TEST 12/13/15 expect caller_kind='trigger').
-- The cron-skip test at the END resets both GUCs explicitly.

-- ===========================================================================
-- 10-13: FC-L2 decoupling — forced REFRESH failure is caught, audited,
--                            and the outer transaction stays writable.
--
-- Trick: DROP the UNIQUE index that REFRESH MATERIALIZED VIEW CONCURRENTLY
-- requires. The REFRESH then raises (the REFRESH ... CONCURRENTLY statement
-- demands a UNIQUE index on the MV — without it Postgres errors). The RPC's
-- EXCEPTION WHEN OTHERS handler catches it, writes a
-- 'leaderboard.refresh_failed' audit row, and returns
-- {outcome:'error', sqlstate, sqlerrm, caller_kind}.
--
-- We invoke from the trigger context so the admin gate is bypassed without
-- needing JWT setup (matches the real scoring-trigger production path that
-- FC-L2 protects). The DROP INDEX persists for the rest of the test — the
-- outer BEGIN/ROLLBACK reverts it at file end. We use RELEASE (not ROLLBACK
-- TO SAVEPOINT) so pgTAP's planned-vs-ran counter stays in sync.
-- ===========================================================================
SAVEPOINT sp_decouple;

DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';

DROP INDEX leaderboard_snapshots_pk;

-- Assert 10: outcome='error' (exception caught and translated, NOT re-raised).
SELECT is(
    (SELECT refresh_leaderboard() ->> 'outcome'),
    'error',
    'TEST 10 (FC-L2): forced REFRESH failure returns outcome=error (exception swallowed)'
);

-- Assert 11: a 'leaderboard.refresh_failed' audit row was emitted.
SELECT is(
    (SELECT count(*)::int FROM audit_log WHERE action = 'leaderboard.refresh_failed'),
    1,
    'TEST 11 (FC-L2): failure path emitted a leaderboard.refresh_failed audit row'
);

-- Assert 12: the CRITICAL FC-L2 guarantee — the outer transaction is STILL
-- writable. If the RPC had re-raised, this INSERT would itself fail because
-- the surrounding transaction would be in the aborted state.
INSERT INTO audit_log(action, entity_type, entity_id, new_value)
    VALUES (
        'leaderboard.refresh',
        'leaderboard_snapshots',
        NULL,
        '{"smoke": true, "purpose": "FC-L2 smoke insert"}'::jsonb
    );

SELECT pass(
    'TEST 12 (FC-L2): outer transaction remains writable after refresh failure — scoring still commits'
);

-- Assert 13: the failure jsonb carries caller_kind so the calling trigger
-- can correlate the failure with its scoring_run.
SELECT is(
    (SELECT refresh_leaderboard() ->> 'caller_kind'),
    'trigger',
    'TEST 13 (FC-L2): failure jsonb carries caller_kind=trigger for correlation'
);

RELEASE SAVEPOINT sp_decouple;
RESET app.scoring_run_id;

-- ===========================================================================
-- 14-15: Cron context with predicate=FALSE → skipped + NO audit row
--
-- Runs LAST: this test must DELETE all score_events to trip the FR-L22
-- pre-tournament short-circuit in should_refresh_leaderboard(). Running it
-- earlier would either need ROLLBACK TO SAVEPOINT (pgTAP counter desync) or
-- a re-seed-with-conflict against score_events' partial UNIQUE index.
-- ===========================================================================
SAVEPOINT sp_cron_skip;

DELETE FROM audit_log WHERE action LIKE 'leaderboard.%';
DELETE FROM score_events;

SET LOCAL app.cron_caller = 'true';

-- Assert 14: predicate=false → outcome='skipped'.
SELECT is(
    (SELECT refresh_leaderboard() ->> 'outcome'),
    'skipped',
    'TEST 14 (FR-L21/L22): cron with empty score_events returns outcome=skipped'
);

-- Assert 15: skipped path emits NO audit row.
SELECT is(
    (SELECT count(*)::int FROM audit_log WHERE action LIKE 'leaderboard.%'),
    0,
    'TEST 15 (FR-L21): skipped cron call emits no audit row'
);

RELEASE SAVEPOINT sp_cron_skip;
RESET app.cron_caller;

SELECT * FROM finish();

ROLLBACK;
