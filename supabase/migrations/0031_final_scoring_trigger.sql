-- Migration: final-prediction scoring trigger (feature 003 US-PC, T051)
--
-- Per contracts/trigger-calculate-final-points.md + data-model.md §5.2.
--
-- calculate_final_points(p_participant_id DEFAULT NULL) rebuilds the four
-- final-* score_events rows. When p_participant_id IS NULL it sweeps every
-- active participant (used by the tournament_config trigger); when a
-- participant id is supplied it rebuilds just that participant's rows (used
-- by the final_predictions trigger, including FK-cascade SET NULL from a
-- players delete — per R-6).
--
-- Scoring (scoring-model.md §7.3, FR-P12/FR-P17): 20 points per correct pick,
-- 0 for incorrect, 0 + final-not-picked-<item> for a NULL pick.
--
-- DELETE-then-INSERT inside the function keeps each (participant, final-source)
-- row unique (Clarify Q1). SECURITY DEFINER so it can write score_events.

CREATE OR REPLACE FUNCTION calculate_final_points(p_participant_id UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_champion   UUID;
    v_runner_up  UUID;
    v_top_scorer UUID;
    v_best_player UUID;
    v_count      INTEGER;
BEGIN
    SELECT champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id
        INTO v_champion, v_runner_up, v_top_scorer, v_best_player
        FROM tournament_config
        LIMIT 1;

    -- DELETE existing final-* rows, scoped to the participant if provided.
    DELETE FROM score_events
        WHERE source IN (
            'final-champion', 'final-runner-up', 'final-top-scorer', 'final-best-player',
            'final-not-picked-champion', 'final-not-picked-runner-up',
            'final-not-picked-top-scorer', 'final-not-picked-best-player'
        )
        AND (p_participant_id IS NULL OR participant_id = p_participant_id);

    -- Champion
    INSERT INTO score_events (participant_id, source, points)
        SELECT
            p.id,
            CASE WHEN fp.champion_team_id IS NULL THEN 'final-not-picked-champion'
                 ELSE 'final-champion' END::score_event_source,
            CASE WHEN fp.champion_team_id IS NOT NULL
                      AND v_champion IS NOT NULL
                      AND fp.champion_team_id = v_champion THEN 20 ELSE 0 END
        FROM participants p
        LEFT JOIN final_predictions fp ON fp.participant_id = p.id
        WHERE p.status = 'active' AND (p_participant_id IS NULL OR p.id = p_participant_id);

    -- Runner-up
    INSERT INTO score_events (participant_id, source, points)
        SELECT
            p.id,
            CASE WHEN fp.runner_up_team_id IS NULL THEN 'final-not-picked-runner-up'
                 ELSE 'final-runner-up' END::score_event_source,
            CASE WHEN fp.runner_up_team_id IS NOT NULL
                      AND v_runner_up IS NOT NULL
                      AND fp.runner_up_team_id = v_runner_up THEN 20 ELSE 0 END
        FROM participants p
        LEFT JOIN final_predictions fp ON fp.participant_id = p.id
        WHERE p.status = 'active' AND (p_participant_id IS NULL OR p.id = p_participant_id);

    -- Top scorer
    INSERT INTO score_events (participant_id, source, points)
        SELECT
            p.id,
            CASE WHEN fp.top_scorer_player_id IS NULL THEN 'final-not-picked-top-scorer'
                 ELSE 'final-top-scorer' END::score_event_source,
            CASE WHEN fp.top_scorer_player_id IS NOT NULL
                      AND v_top_scorer IS NOT NULL
                      AND fp.top_scorer_player_id = v_top_scorer THEN 20 ELSE 0 END
        FROM participants p
        LEFT JOIN final_predictions fp ON fp.participant_id = p.id
        WHERE p.status = 'active' AND (p_participant_id IS NULL OR p.id = p_participant_id);

    -- Best player
    INSERT INTO score_events (participant_id, source, points)
        SELECT
            p.id,
            CASE WHEN fp.best_player_player_id IS NULL THEN 'final-not-picked-best-player'
                 ELSE 'final-best-player' END::score_event_source,
            CASE WHEN fp.best_player_player_id IS NOT NULL
                      AND v_best_player IS NOT NULL
                      AND fp.best_player_player_id = v_best_player THEN 20 ELSE 0 END
        FROM participants p
        LEFT JOIN final_predictions fp ON fp.participant_id = p.id
        WHERE p.status = 'active' AND (p_participant_id IS NULL OR p.id = p_participant_id);

    GET DIAGNOSTICS v_count = ROW_COUNT;

    INSERT INTO audit_log (action, entity_type, entity_id, new_value)
        VALUES (
            'scoring.final',
            'tournament_config',
            NULL,
            jsonb_build_object(
                'scope', CASE WHEN p_participant_id IS NULL THEN 'full-sweep' ELSE 'single-participant' END,
                'participant_id', p_participant_id,
                'champion_set', v_champion IS NOT NULL,
                'runner_up_set', v_runner_up IS NOT NULL,
                'top_scorer_set', v_top_scorer IS NOT NULL,
                'best_player_set', v_best_player IS NOT NULL,
                'last_insert_rows', v_count
            )
        );
END;
$$;

REVOKE ALL ON FUNCTION calculate_final_points(UUID) FROM PUBLIC;

COMMENT ON FUNCTION calculate_final_points(UUID) IS
    'feature 003 US-PC: rebuild the 4 final-* score_events rows per participant (DELETE-then-INSERT). NULL arg = full sweep; participant id = single rebuild. 20 pts per correct pick. SECURITY DEFINER.';

-- ---------------------------------------------------------------------------
-- Trigger (a): tournament_config UPDATE → full sweep
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calculate_final_points_full_sweep_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM calculate_final_points(NULL);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tournament_config_trigger_final_scoring ON tournament_config;
CREATE TRIGGER tournament_config_trigger_final_scoring
    AFTER UPDATE ON tournament_config
    FOR EACH ROW
    WHEN (
        NEW.champion_team_id IS DISTINCT FROM OLD.champion_team_id
        OR NEW.runner_up_team_id IS DISTINCT FROM OLD.runner_up_team_id
        OR NEW.top_scorer_player_id IS DISTINCT FROM OLD.top_scorer_player_id
        OR NEW.best_player_player_id IS DISTINCT FROM OLD.best_player_player_id
    )
    EXECUTE FUNCTION calculate_final_points_full_sweep_trigger();

-- ---------------------------------------------------------------------------
-- Trigger (b): final_predictions UPDATE (incl. FK cascade) → single participant
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION calculate_final_points_single_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM calculate_final_points(NEW.participant_id);
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS final_predictions_trigger_scoring ON final_predictions;
CREATE TRIGGER final_predictions_trigger_scoring
    AFTER UPDATE ON final_predictions
    FOR EACH ROW
    WHEN (
        NEW.champion_team_id IS DISTINCT FROM OLD.champion_team_id
        OR NEW.runner_up_team_id IS DISTINCT FROM OLD.runner_up_team_id
        OR NEW.top_scorer_player_id IS DISTINCT FROM OLD.top_scorer_player_id
        OR NEW.best_player_player_id IS DISTINCT FROM OLD.best_player_player_id
    )
    EXECUTE FUNCTION calculate_final_points_single_trigger();
