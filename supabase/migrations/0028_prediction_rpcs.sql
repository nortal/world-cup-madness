-- Migration: prediction + scoring RPCs (feature 003)
--
-- This migration is created in US-PA (T019) with submit_prediction only and
-- extended in later phases:
--   US-PA (T019)  — submit_prediction
--   US-PB (T037)  — submit_final_prediction
--   US-PC (T052)  — set_tournament_winner + recalculate_all_scores
--
-- All RPCs follow the convention established in features 001 + 002:
--   - SECURITY DEFINER + explicit SET search_path
--   - REVOKE ALL FROM PUBLIC + targeted GRANT EXECUTE
--   - Validate inputs at the entry; RAISE EXCEPTION with ERRCODE so PostgREST
--     surfaces structured 4xx errors
--   - Return jsonb shaped {outcome: 'success' | 'error', ...}
--
-- AUDIT TRAIL — each RPC emits an audit_log row directly (mirrors feature 001
-- submit_display_name pattern). The audit_log.action CHECK was extended in
-- migration 0019 to allow the new tags.
--
-- ============================================================================
-- submit_prediction(p_match_id UUID, p_home INTEGER, p_away INTEGER)
-- ============================================================================
-- Per contracts/rpc-submit-prediction.md. Lock check + range check + upsert
-- + audit emission in one transactional RPC.
--
-- Lock semantic (BR-LOCK-002+003): strict-greater-than. At exactly T-60min,
-- the prediction IS locked. The check `kickoff_utc - now() <= interval '60
-- minutes'` therefore rejects at -60min, accepts at -61min, rejects at -59min.
--
-- Authorisation:
--   Caller must be an active participant (auth.uid() resolves via
--   participants.auth_user_id). Cross-participant writes are blocked by RLS
--   (predictions_insert_own / _update_own use the same lookup), but we
--   resolve up front here for the friendly PARTICIPANT_NOT_FOUND error.
CREATE OR REPLACE FUNCTION submit_prediction(
    p_match_id UUID,
    p_home     INTEGER,
    p_away     INTEGER
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id          UUID := auth.uid();
    v_participant_id   UUID;
    v_kickoff_utc      TIMESTAMPTZ;
    v_match_status     TEXT;
    v_prediction_id    UUID;
    v_inserted         BOOLEAN;
    v_locks_at         TIMESTAMPTZ;
BEGIN
    -- 1. Resolve participant.
    SELECT id INTO v_participant_id
    FROM participants
    WHERE auth_user_id = v_user_id AND status = 'active';

    IF v_participant_id IS NULL THEN
        RAISE EXCEPTION 'PARTICIPANT_NOT_FOUND'
            USING ERRCODE = 'no_data_found',
                  HINT    = 'No active participant row for the current auth.uid().';
    END IF;

    -- 2. Load match (kickoff + status).
    SELECT kickoff_utc, status
    INTO   v_kickoff_utc, v_match_status
    FROM   matches
    WHERE  id = p_match_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'MATCH_NOT_FOUND'
            USING ERRCODE = 'no_data_found',
                  HINT    = format('No match with id %s.', p_match_id);
    END IF;

    -- 3. Lock check.
    -- BR-LOCK-002+003: editable only when remaining > 60 minutes (strict).
    -- Also reject if the match has already started / finished / been cancelled.
    IF v_kickoff_utc IS NULL OR (v_kickoff_utc - now()) <= interval '60 minutes' THEN
        RAISE EXCEPTION 'PREDICTION_LOCKED'
            USING ERRCODE = 'check_violation',
                  HINT    = 'Lock window closed (kickoff_utc - now() <= 60 minutes).';
    END IF;

    IF v_match_status NOT IN ('scheduled', 'scheduled-tbd') THEN
        -- Defensive: if status is anything other than upcoming, predictions are locked.
        -- This includes 'live', 'finished', 'cancelled'.
        RAISE EXCEPTION 'PREDICTION_LOCKED'
            USING ERRCODE = 'check_violation',
                  HINT    = format('Match is not upcoming (status=%s).', v_match_status);
    END IF;

    -- 4. UPSERT — xmax=0 trick distinguishes insert from update.
    INSERT INTO predictions (
        participant_id, match_id,
        predicted_home_score, predicted_away_score
    )
    VALUES (v_participant_id, p_match_id, p_home, p_away)
    ON CONFLICT (participant_id, match_id) DO UPDATE
        SET predicted_home_score = EXCLUDED.predicted_home_score,
            predicted_away_score = EXCLUDED.predicted_away_score,
            updated_at           = now()
    RETURNING id, (xmax = 0) INTO v_prediction_id, v_inserted;

    -- 5. Audit emit. Schema (per feature 001 migration 0005):
    --    entity_type / entity_id (UUID) / new_value (jsonb).
    INSERT INTO audit_log (
        action,
        actor_oid,
        actor_email,
        participant_id,
        entity_type,
        entity_id,
        new_value
    )
    SELECT
        CASE WHEN v_inserted
             THEN 'prediction.created'
             ELSE 'prediction.updated'
        END,
        p.oid,
        p.email,
        v_participant_id,
        'predictions',
        v_prediction_id,
        jsonb_build_object(
            'match_id',             p_match_id,
            'predicted_home_score', p_home,
            'predicted_away_score', p_away
        )
    FROM participants p WHERE p.id = v_participant_id;

    -- 6. Return success envelope.
    v_locks_at := v_kickoff_utc - interval '60 minutes';

    RETURN jsonb_build_object(
        'outcome',              'success',
        'prediction_id',        v_prediction_id,
        'action',               CASE WHEN v_inserted THEN 'created' ELSE 'updated' END,
        'predicted_home_score', p_home,
        'predicted_away_score', p_away,
        'locks_at',             v_locks_at
    );
END;
$$;

REVOKE ALL ON FUNCTION submit_prediction(UUID, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_prediction(UUID, INTEGER, INTEGER) TO authenticated;

COMMENT ON FUNCTION submit_prediction(UUID, INTEGER, INTEGER) IS
    'feature 003 US-PA: insert or update a participant''s match prediction. Server-side lock at kickoff_utc - 60 min (strict, per BR-LOCK-002+003). Returns {outcome, prediction_id, action, predicted_home_score, predicted_away_score, locks_at}.';

-- ============================================================================
-- submit_final_prediction — feature 003 US-PB (T037)
-- ============================================================================
-- Per contracts/rpc-submit-final-prediction.md. Upsert one row in
-- final_predictions (UNIQUE on participant_id, one row per participant).
-- All four picks nullable so partial submissions are allowed.
--
-- Lock semantic (BR-LOCK-005): editable only BEFORE the first non-cancelled
-- kickoff. Once any non-cancelled match starts (now() >= min(kickoff_utc
-- WHERE status != 'cancelled')), all four picks are immutable.
--
-- The CHECK constraint on final_predictions enforces champion ≠ runner_up
-- (when both non-null); we don't re-check here.
CREATE OR REPLACE FUNCTION submit_final_prediction(
    p_champion       UUID DEFAULT NULL,
    p_runner_up      UUID DEFAULT NULL,
    p_top_scorer     UUID DEFAULT NULL,
    p_best_player    UUID DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id          UUID := auth.uid();
    v_participant_id   UUID;
    v_first_kickoff    TIMESTAMPTZ;
    v_final_prediction_id UUID;
    v_inserted         BOOLEAN;
BEGIN
    -- 1. Resolve participant.
    SELECT id INTO v_participant_id
    FROM participants
    WHERE auth_user_id = v_user_id AND status = 'active';

    IF v_participant_id IS NULL THEN
        RAISE EXCEPTION 'PARTICIPANT_NOT_FOUND'
            USING ERRCODE = 'no_data_found',
                  HINT    = 'No active participant row for the current auth.uid().';
    END IF;

    -- 2. Lock check: the first non-cancelled match must NOT yet have kicked off.
    -- BR-LOCK-005: editable only BEFORE the first official match kickoff.
    SELECT min(kickoff_utc) INTO v_first_kickoff
    FROM matches
    WHERE status != 'cancelled';

    IF v_first_kickoff IS NOT NULL AND now() >= v_first_kickoff THEN
        RAISE EXCEPTION 'FINAL_PREDICTIONS_LOCKED'
            USING ERRCODE = 'check_violation',
                  HINT    = format('First match already kicked off at %s.', v_first_kickoff);
    END IF;

    -- 3. UPSERT — xmax = 0 distinguishes insert from update.
    INSERT INTO final_predictions (
        participant_id,
        champion_team_id,
        runner_up_team_id,
        top_scorer_player_id,
        best_player_player_id
    )
    VALUES (
        v_participant_id,
        p_champion,
        p_runner_up,
        p_top_scorer,
        p_best_player
    )
    ON CONFLICT (participant_id) DO UPDATE
        SET champion_team_id      = EXCLUDED.champion_team_id,
            runner_up_team_id     = EXCLUDED.runner_up_team_id,
            top_scorer_player_id  = EXCLUDED.top_scorer_player_id,
            best_player_player_id = EXCLUDED.best_player_player_id,
            updated_at            = now()
    RETURNING id, (xmax = 0) INTO v_final_prediction_id, v_inserted;

    -- 4. Audit emit.
    INSERT INTO audit_log (
        action,
        actor_oid,
        actor_email,
        participant_id,
        entity_type,
        entity_id,
        new_value
    )
    SELECT
        CASE WHEN v_inserted
             THEN 'final_prediction.created'
             ELSE 'final_prediction.updated'
        END,
        p.oid,
        p.email,
        v_participant_id,
        'final_predictions',
        v_final_prediction_id,
        jsonb_build_object(
            'champion_team_id',      p_champion,
            'runner_up_team_id',     p_runner_up,
            'top_scorer_player_id',  p_top_scorer,
            'best_player_player_id', p_best_player
        )
    FROM participants p WHERE p.id = v_participant_id;

    RETURN jsonb_build_object(
        'outcome',              'success',
        'final_prediction_id',  v_final_prediction_id,
        'action',               CASE WHEN v_inserted THEN 'created' ELSE 'updated' END,
        'picks', jsonb_build_object(
            'champion_team_id',      p_champion,
            'runner_up_team_id',     p_runner_up,
            'top_scorer_player_id',  p_top_scorer,
            'best_player_player_id', p_best_player
        ),
        'locks_at',             v_first_kickoff
    );
END;
$$;

REVOKE ALL ON FUNCTION submit_final_prediction(UUID, UUID, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_final_prediction(UUID, UUID, UUID, UUID) TO authenticated;

COMMENT ON FUNCTION submit_final_prediction(UUID, UUID, UUID, UUID) IS
    'feature 003 US-PB: insert or update a participant''s tournament-wide predictions (champion/runner-up/top-scorer/best-player). All 4 nullable for partial submits. Lock: BEFORE first non-cancelled kickoff (BR-LOCK-005).';

-- ============================================================================
-- set_tournament_winner — feature 003 US-PC (T052)
-- ============================================================================
-- Per contracts/rpc-set-tournament-winner.md. Admin-only. Updates one of the
-- four winner columns on tournament_config; the AFTER UPDATE trigger
-- (migration 0031) re-fires calculate_final_points(NULL) → full sweep.
CREATE OR REPLACE FUNCTION set_tournament_winner(p_item TEXT, p_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_changed BOOLEAN;
BEGIN
    IF NOT is_admin_user() THEN
        RAISE EXCEPTION 'FORBIDDEN'
            USING ERRCODE = 'insufficient_privilege',
                  HINT = 'set_tournament_winner requires an admin participant.';
    END IF;

    IF p_item NOT IN ('champion', 'runner-up', 'top-scorer', 'best-player') THEN
        RAISE EXCEPTION 'INVALID_WINNER_ITEM'
            USING ERRCODE = 'invalid_parameter_value',
                  HINT = 'p_item must be champion | runner-up | top-scorer | best-player.';
    END IF;

    -- Dispatch the UPDATE. The trigger's WHEN (IS DISTINCT FROM) clause
    -- decides whether scoring actually re-fires. `WHERE id = 1` targets the
    -- singleton config row AND satisfies Supabase's safe-update guard
    -- (supautils blocks unqualified UPDATE/DELETE with SQLSTATE 21000).
    CASE p_item
        WHEN 'champion' THEN
            UPDATE tournament_config SET champion_team_id = p_id WHERE id = 1;
        WHEN 'runner-up' THEN
            UPDATE tournament_config SET runner_up_team_id = p_id WHERE id = 1;
        WHEN 'top-scorer' THEN
            UPDATE tournament_config SET top_scorer_player_id = p_id WHERE id = 1;
        WHEN 'best-player' THEN
            UPDATE tournament_config SET best_player_player_id = p_id WHERE id = 1;
    END CASE;
    GET DIAGNOSTICS v_changed = ROW_COUNT;

    INSERT INTO audit_log (action, actor_oid, entity_type, entity_id, new_value)
        VALUES (
            'admin.tournament-winner-set',
            (SELECT oid FROM participants WHERE auth_user_id = auth.uid()),
            'tournament_config',
            p_id,
            jsonb_build_object('item', p_item, 'id', p_id)
        );

    RETURN jsonb_build_object(
        'outcome', 'success',
        'item', p_item,
        'id', p_id,
        'scoring_triggered', v_changed
    );
END;
$$;

REVOKE ALL ON FUNCTION set_tournament_winner(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_tournament_winner(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION set_tournament_winner(TEXT, UUID) IS
    'feature 003 US-PC: admin sets one tournament_config winner column; trigger re-fires calculate_final_points(NULL). Admin-gated via is_admin_user().';

-- ============================================================================
-- recalculate_all_scores — feature 003 US-PC (T052)
-- ============================================================================
-- Per contracts/rpc-recalculate-all-scores.md. Admin-only. Mutex via
-- scoring_runs partial unique index (at most one in-flight admin-recalc-all).
-- Per-match loop calls calculate_match_points() for every finished/cancelled
-- match. SCHEMA NOTE: iterates `matches` (feature 002 stores results there;
-- no match_results table exists).
CREATE OR REPLACE FUNCTION recalculate_all_scores()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_run_id           UUID;
    v_match            RECORD;
    v_matches_processed INTEGER := 0;
    v_active_count     INTEGER;
    v_started_at       TIMESTAMPTZ := now();
    v_in_flight_started TIMESTAMPTZ;
BEGIN
    IF NOT is_admin_user() THEN
        RAISE EXCEPTION 'FORBIDDEN'
            USING ERRCODE = 'insufficient_privilege',
                  HINT = 'recalculate_all_scores requires an admin participant.';
    END IF;

    -- Claim the mutex by inserting an in-flight scoring_runs row. The partial
    -- unique index scoring_runs_at_most_one_in_flight_per_action rejects with
    -- 23505 if another admin-recalc-all is in flight.
    BEGIN
        INSERT INTO scoring_runs (action, started_at, status)
            VALUES ('admin-recalc-all', v_started_at, 'success')
            RETURNING id INTO v_run_id;
    EXCEPTION WHEN unique_violation THEN
        SELECT started_at INTO v_in_flight_started
            FROM scoring_runs
            WHERE action = 'admin-recalc-all' AND finished_at IS NULL
            ORDER BY started_at DESC LIMIT 1;
        RETURN jsonb_build_object(
            'outcome', 'skipped',
            'in_flight_started_at', v_in_flight_started
        );
    END;

    INSERT INTO audit_log (action, actor_oid, entity_type, entity_id, new_value)
        VALUES (
            'admin.recalc-all',
            (SELECT oid FROM participants WHERE auth_user_id = auth.uid()),
            'scoring_runs',
            v_run_id,
            jsonb_build_object('started_at', v_started_at)
        );

    -- Per-match loop. Each calculate_match_points() is its own DELETE+INSERT;
    -- they share this RPC's transaction (a single big transaction is fine for
    -- the recalc-all admin action — it's infrequent and the mutex serialises it).
    FOR v_match IN
        SELECT id FROM matches
        WHERE status IN ('finished', 'cancelled')
        ORDER BY kickoff_utc NULLS LAST
    LOOP
        PERFORM calculate_match_points(v_match.id);
        v_matches_processed := v_matches_processed + 1;
    END LOOP;

    SELECT count(*) INTO v_active_count FROM participants WHERE status = 'active';

    UPDATE scoring_runs
        SET finished_at = now(),
            affected_participants_count = v_matches_processed * v_active_count
        WHERE id = v_run_id;

    RETURN jsonb_build_object(
        'outcome', 'success',
        'scoring_run_id', v_run_id,
        'matches_processed', v_matches_processed,
        'duration_ms', (EXTRACT(EPOCH FROM (now() - v_started_at)) * 1000)::int
    );
END;
$$;

REVOKE ALL ON FUNCTION recalculate_all_scores() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recalculate_all_scores() TO authenticated;

COMMENT ON FUNCTION recalculate_all_scores() IS
    'feature 003 US-PC: admin full recalc across all finished/cancelled matches. Mutex via scoring_runs partial unique index. Admin-gated.';
