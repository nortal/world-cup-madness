-- Migration: match scoring trigger (feature 003 US-PC, T050)
--
-- Per contracts/trigger-calculate-match-points.md + data-model.md §5.1.
--
-- calculate_match_points(p_match_id) rebuilds the match-scoring score_events
-- rows for one match: DELETE all existing match-* + no-prediction +
-- match-cancelled rows for the match, then INSERT one fresh row per active
-- participant. DELETE-then-INSERT inside the function is atomic under READ
-- COMMITTED (no reader sees the intermediate empty state) — per Clarify Q1 +
-- research.md §R-3.
--
-- The function is SECURITY DEFINER so it can write score_events (which has NO
-- authenticated write policies — FR-P24). It's invoked by:
--   (a) the matches AFTER INSERT/UPDATE trigger (per-match path)
--   (b) recalculate_all_scores() RPC (full recalc loop, migration 0028)
--
-- SCHEMA NOTE: the feature-003 spec/contracts/data-model assumed a separate
-- `match_results` table (an artifact carried over from docs/architecture/).
-- Feature 002 actually stores scores + status DIRECTLY on `matches`
-- (score_home / score_away / status columns). So the scoring trigger fires
-- on `matches`, and admin score corrections (FR-P22) are UPDATEs to
-- `matches`, not to a separate results table. Everywhere the spec says
-- "UPDATE match_results", read "UPDATE matches".
--
-- Scoring formula (scoring-model.md §7.2, FR-P12):
--   10 pts — exact score (predicted == official, both home + away)
--    5 pts — correct outcome only (sign(predicted diff) == sign(official diff))
--    0 pts — wrong outcome
--    0 pts — no prediction submitted (source='no-prediction')
--    0 pts — cancelled match (source='match-cancelled', everyone)

CREATE OR REPLACE FUNCTION calculate_match_points(p_match_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_status      TEXT;
    v_score_home  INTEGER;
    v_score_away  INTEGER;
    v_count       INTEGER;
BEGIN
    -- 1. Load the match. FOR SHARE blocks a concurrent UPDATE on this match
    -- row while we score, but allows other reads.
    SELECT status, score_home, score_away
        INTO v_status, v_score_home, v_score_away
        FROM matches
        WHERE id = p_match_id
        FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'match % not found in calculate_match_points', p_match_id;
    END IF;

    -- 2. DELETE all prior match-scoring rows for this match (every source in
    -- the match family). This is the "rebuild" half of DELETE-then-INSERT.
    DELETE FROM score_events
        WHERE match_id = p_match_id
        AND source IN (
            'match-exact', 'match-outcome', 'match-wrong',
            'no-prediction', 'match-cancelled'
        );

    -- 3. Branch on status.
    IF v_status = 'cancelled' THEN
        -- Cancelled: 0 points to every active participant.
        INSERT INTO score_events (participant_id, match_id, source, points)
            SELECT p.id, p_match_id, 'match-cancelled'::score_event_source, 0
            FROM participants p
            WHERE p.status = 'active';

    ELSIF v_status = 'finished'
          AND v_score_home IS NOT NULL
          AND v_score_away IS NOT NULL THEN
        -- Finished: compute 10/5/0 per prediction; 0 + 'no-prediction' for
        -- participants who never submitted.
        INSERT INTO score_events (participant_id, match_id, source, points)
            SELECT
                p.id,
                p_match_id,
                CASE
                    WHEN pr.id IS NULL
                        THEN 'no-prediction'
                    WHEN pr.predicted_home_score = v_score_home
                         AND pr.predicted_away_score = v_score_away
                        THEN 'match-exact'
                    WHEN sign(pr.predicted_home_score - pr.predicted_away_score)
                         = sign(v_score_home - v_score_away)
                        THEN 'match-outcome'
                    ELSE 'match-wrong'
                END::score_event_source,
                CASE
                    WHEN pr.id IS NULL
                        THEN 0
                    WHEN pr.predicted_home_score = v_score_home
                         AND pr.predicted_away_score = v_score_away
                        THEN 10
                    WHEN sign(pr.predicted_home_score - pr.predicted_away_score)
                         = sign(v_score_home - v_score_away)
                        THEN 5
                    ELSE 0
                END
            FROM participants p
            LEFT JOIN predictions pr
                ON pr.participant_id = p.id AND pr.match_id = p_match_id
            WHERE p.status = 'active';

    ELSE
        -- Not finished + not cancelled: the trigger's WHEN clause should have
        -- prevented this. Defensive no-op (we already DELETEd, so the match
        -- ends up with zero score rows — correct for an in-progress match).
        RETURN;
    END IF;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- 4. Audit row for the scoring run.
    INSERT INTO audit_log (action, entity_type, entity_id, new_value)
        VALUES (
            'scoring.match',
            'matches',
            p_match_id,
            jsonb_build_object(
                'match_status', v_status,
                'score_home', v_score_home,
                'score_away', v_score_away,
                'affected_participants', v_count
            )
        );
END;
$$;

REVOKE ALL ON FUNCTION calculate_match_points(UUID) FROM PUBLIC;
-- No GRANT to authenticated — only the trigger (runs as owner via SECURITY
-- DEFINER) and recalculate_all_scores() (also SECURITY DEFINER) call this.

COMMENT ON FUNCTION calculate_match_points(UUID) IS
    'feature 003 US-PC: rebuild match-scoring score_events for one match (DELETE-then-INSERT). 10/5/0 per scoring-model.md §7.2; no-prediction + cancelled paths. SECURITY DEFINER — only writer of score_events match rows.';

-- ---------------------------------------------------------------------------
-- Trigger wrapper + trigger on matches
-- ---------------------------------------------------------------------------
-- The wrapper exists so calculate_match_points() can be called directly by
-- recalculate_all_scores() with a plain match id (no forged NEW row needed).
-- matches PK is `id` (not `match_id`).
CREATE OR REPLACE FUNCTION calculate_match_points_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    PERFORM calculate_match_points(NEW.id);
    RETURN NEW;
END;
$$;

-- Fire AFTER INSERT OR UPDATE when the row reaches a scoreable terminal state:
--   - status='finished' with both scores present, OR
--   - status='cancelled' (scores irrelevant)
-- The WHEN clause keeps the trigger quiet during in-progress score updates
-- (status='live' or scheduled).
DROP TRIGGER IF EXISTS matches_trigger_scoring ON matches;
CREATE TRIGGER matches_trigger_scoring
    AFTER INSERT OR UPDATE ON matches
    FOR EACH ROW
    WHEN (
        NEW.status = 'cancelled'
        OR (NEW.status = 'finished' AND NEW.score_home IS NOT NULL AND NEW.score_away IS NOT NULL)
    )
    EXECUTE FUNCTION calculate_match_points_trigger();
