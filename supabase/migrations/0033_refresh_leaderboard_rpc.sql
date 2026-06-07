-- Migration: refresh_leaderboard() RPC + should_refresh_leaderboard() predicate
--             + audit_log.action CHECK extension (feature 004 US-L, T004)
--
-- Per data-model.md §3, §4, §6 + contracts/rpc-refresh-leaderboard.md +
-- contracts/audit-event-leaderboard-refresh.md.
--
-- Satisfies: FR-L11, FR-L12, FR-L17, FR-L19, FR-L20, FR-L21, FR-L22,
--            FC-L1, FC-L2.
--
-- SCHEMA NOTE on audit_log column naming: the feature 004 spec uses
-- `event_type` and `created_at` for clarity, but the actual table (migration
-- 0004) has the columns `action` and `occurred_at` (feature 001 chose those
-- names). This migration uses the actual column names — every INSERT and the
-- CHECK extension target `action`, not a renamed `event_type`. The semantic
-- contract from the spec (`'leaderboard.refresh'` / `'leaderboard.refresh_failed'`
-- as the discriminator value) is preserved.
--
-- Caller-kind detection (data-model §3.2):
--   - pg_cron job sets `app.cron_caller = 'true'` GUC before invoking us.
--   - Scoring triggers (feature 003) set `app.scoring_run_id` GUC to the
--     scoring_runs.id of the in-progress run before PERFORM refresh_leaderboard().
--   - All other callers (PostgREST RPC) are treated as admin direct calls and
--     hit the is_admin_user() gate.
--
-- Failure decoupling (FC-L2): the EXCEPTION block writes a
-- `leaderboard.refresh_failed` audit row and returns a non-error jsonb
-- describing the failure. The exception does NOT propagate, so a scoring
-- transaction that PERFORM-ed us still commits cleanly.

-- ---------------------------------------------------------------------------
-- 1. audit_log.action CHECK extension — add the two leaderboard events
-- ---------------------------------------------------------------------------
-- Preserves all 15 prior values from features 001 + 003 (migration 0019) and
-- adds two new feature-004 values. Postgres can't ALTER a CHECK in place, so
-- DROP + ADD inside one transaction.
ALTER TABLE audit_log
    DROP CONSTRAINT audit_log_action_check;

ALTER TABLE audit_log
    ADD CONSTRAINT audit_log_action_check CHECK (
        action = ANY (ARRAY[
            -- feature 001
            'participant.created',
            'participant.updated',
            'participant.deactivated',
            'participant.role-changed',
            'auth.rejected',
            'auth.provider-error',
            -- feature 003
            'prediction.created',
            'prediction.updated',
            'final_prediction.created',
            'final_prediction.updated',
            'admin.match-result-override',
            'admin.tournament-winner-set',
            'admin.recalc-all',
            'scoring.match',
            'scoring.final',
            -- feature 004
            'leaderboard.refresh',
            'leaderboard.refresh_failed'
        ])
    );

-- ---------------------------------------------------------------------------
-- 2. should_refresh_leaderboard() — pg_cron gating predicate (R-5)
-- ---------------------------------------------------------------------------
-- Returns TRUE if the cron tick should perform a refresh, FALSE if it should
-- skip. Pulled out of refresh_leaderboard() so pgTAP can exercise the gate at
-- synthetic clock states without invoking the heavy REFRESH.
--
-- Gate ladder (data-model §4):
--   1. score_events empty → FALSE (FR-L22 pre-tournament)
--   2. any non-cancelled match within now() ± 90 min → TRUE (match window)
--   3. no prior 'leaderboard.refresh' audit row OR last one older than 60 min → TRUE
--   4. otherwise → FALSE
CREATE OR REPLACE FUNCTION should_refresh_leaderboard()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_last_refresh TIMESTAMPTZ;
BEGIN
    -- FR-L22: pre-tournament short-circuit
    IF NOT EXISTS (SELECT 1 FROM score_events LIMIT 1) THEN
        RETURN false;
    END IF;

    -- Match-window: any non-cancelled match within now() ± 90 min
    IF EXISTS (
        SELECT 1 FROM matches
        WHERE status <> 'cancelled'
          AND kickoff_utc BETWEEN now() - interval '90 minutes' AND now() + interval '90 minutes'
    ) THEN
        RETURN true;
    END IF;

    -- Quiet-period: refresh if no prior refresh OR last is older than 60 min
    SELECT max(occurred_at) INTO v_last_refresh
        FROM audit_log
        WHERE action = 'leaderboard.refresh';

    IF v_last_refresh IS NULL THEN
        RETURN true;  -- first-time refresh
    END IF;

    RETURN v_last_refresh < now() - interval '60 minutes';
END;
$$;

REVOKE ALL ON FUNCTION should_refresh_leaderboard() FROM PUBLIC;
-- Not GRANTed to authenticated; only refresh_leaderboard() (SECURITY DEFINER,
-- runs as owner) consults it.

COMMENT ON FUNCTION should_refresh_leaderboard() IS
    'feature 004 US-L: gating predicate for pg_cron ticks. STABLE so the planner caches within a single statement. Pulled out of refresh_leaderboard() to allow synthetic-clock pgTAP coverage.';

-- ---------------------------------------------------------------------------
-- 3. refresh_leaderboard() — the RPC
-- ---------------------------------------------------------------------------
-- Caller kinds:
--   'cron'    — pg_cron job (gated via should_refresh_leaderboard())
--   'trigger' — feature 003 scoring trigger (refresh decoupled from scoring commit)
--   'admin'   — PostgREST RPC from admin console (is_admin_user() gate)
--
-- Returns a jsonb summary. Never raises (except for the admin-gate FORBIDDEN
-- case, which intentionally surfaces as HTTP 403 to PostgREST callers).
CREATE OR REPLACE FUNCTION refresh_leaderboard()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller_kind    TEXT;
    v_started_at     TIMESTAMPTZ := clock_timestamp();
    v_duration_ms    INTEGER;
    v_participants   INTEGER;
    v_scoring_run    UUID;
    v_cron_caller    TEXT;
    v_scoring_run_setting TEXT;
BEGIN
    -- ---- Caller-kind detection via GUCs ----
    -- current_setting(..., true) returns NULL if the GUC is unset (rather
    -- than raising). 'true' literal means missing_ok=true.
    v_cron_caller := current_setting('app.cron_caller', true);
    v_scoring_run_setting := current_setting('app.scoring_run_id', true);

    IF v_scoring_run_setting IS NOT NULL AND v_scoring_run_setting <> '' THEN
        BEGIN
            v_scoring_run := v_scoring_run_setting::UUID;
        EXCEPTION WHEN invalid_text_representation THEN
            v_scoring_run := NULL;
        END;
    END IF;

    IF v_cron_caller = 'true' THEN
        v_caller_kind := 'cron';
    ELSIF v_scoring_run IS NOT NULL THEN
        v_caller_kind := 'trigger';
    ELSE
        -- Admin-direct invocation: enforce admin gate.
        IF NOT is_admin_user() THEN
            RAISE EXCEPTION 'FORBIDDEN'
                USING ERRCODE = 'insufficient_privilege',
                      HINT = 'refresh_leaderboard requires an admin participant.';
        END IF;
        v_caller_kind := 'admin';
    END IF;

    -- ---- Cron gating short-circuit (FR-L21 + FR-L22) ----
    IF v_caller_kind = 'cron' AND NOT should_refresh_leaderboard() THEN
        -- Skipped calls emit NO audit row per FR-L21.
        RETURN jsonb_build_object(
            'outcome', 'skipped',
            'reason', 'gated',
            'caller_kind', v_caller_kind
        );
    END IF;

    -- ---- Heavy lifting (R-1: Postgres serialises CONCURRENTLY at MV level) ----
    BEGIN
        REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;

        v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_started_at))::INTEGER;
        SELECT count(DISTINCT participant_id) INTO v_participants
            FROM leaderboard_snapshots;

        INSERT INTO audit_log (action, entity_type, entity_id, new_value)
            VALUES (
                'leaderboard.refresh',
                'leaderboard_snapshots',
                NULL,
                jsonb_build_object(
                    'caller_kind', v_caller_kind,
                    'duration_ms', v_duration_ms,
                    'participant_count', v_participants,
                    'scoring_run_id', v_scoring_run
                )
            );

        RETURN jsonb_build_object(
            'outcome', 'success',
            'caller_kind', v_caller_kind,
            'duration_ms', v_duration_ms,
            'participant_count', v_participants
        );

    EXCEPTION WHEN OTHERS THEN
        -- FC-L2: decouple refresh failure from any calling transaction.
        -- Audit the failure and return a non-error jsonb. Do NOT re-raise.
        INSERT INTO audit_log (action, entity_type, entity_id, new_value)
            VALUES (
                'leaderboard.refresh_failed',
                'leaderboard_snapshots',
                NULL,
                jsonb_build_object(
                    'caller_kind', v_caller_kind,
                    'sqlstate', SQLSTATE,
                    'sqlerrm', SQLERRM,
                    'scoring_run_id', v_scoring_run
                )
            );

        RETURN jsonb_build_object(
            'outcome', 'error',
            'caller_kind', v_caller_kind,
            'sqlstate', SQLSTATE,
            'sqlerrm', SQLERRM
        );
    END;
END;
$$;

REVOKE ALL ON FUNCTION refresh_leaderboard() FROM PUBLIC;
-- Match the repo pattern for admin RPCs (e.g. set_tournament_winner,
-- recalculate_all_scores in 0028): GRANT EXECUTE to authenticated so
-- PostgREST can reach the function, then the function's internal
-- is_admin_user() gate decides whether to accept the call. Cron + trigger
-- invocations come through the postgres owner role and skip the gate.
GRANT EXECUTE ON FUNCTION refresh_leaderboard() TO authenticated;

COMMENT ON FUNCTION refresh_leaderboard() IS
    'feature 004 US-L: refresh leaderboard_snapshots MV. Caller kind detected via GUCs (app.cron_caller, app.scoring_run_id); admin-direct calls gated by is_admin_user(). FC-L2: refresh failures are audited but never re-raised, so scoring transactions still commit.';
