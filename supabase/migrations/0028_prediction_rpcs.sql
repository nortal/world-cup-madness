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
