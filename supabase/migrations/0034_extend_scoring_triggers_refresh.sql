-- Migration: extend feature-003 scoring functions with MV refresh tail
--             (feature 004 US-LC, T024)
--
-- Per data-model.md §5 + spec.md FR-L06, FR-L12, FR-L16, FR-L17, FR-L18,
-- FR-L19, FR-L20 + FC-L2 + NFR-L2.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Re-declares (CREATE OR REPLACE) three feature-003 SECURITY DEFINER
-- functions with their bodies EXACTLY as defined in migrations 0028, 0030,
-- 0031 — plus a small tail block that PERFORMs refresh_leaderboard() so the
-- leaderboard MV catches up after every authoritative scoring write:
--   * calculate_match_points(UUID)         (was migration 0030)
--   * calculate_final_points(UUID)         (was migration 0031)
--   * recalculate_all_scores()             (was migration 0028)
--
-- FC-L2 DECOUPLING — the tail block is wrapped in BEGIN ... EXCEPTION WHEN
-- OTHERS THEN NULL; END so that any exception leaking out of
-- refresh_leaderboard() cannot abort the scoring transaction. In production
-- refresh_leaderboard() itself catches REFRESH failures and audits them as
-- 'leaderboard.refresh_failed' before returning a non-error jsonb (migration
-- 0033), so the outer wrapper is belt-and-braces — it protects against the
-- rare case where Postgres raises before our inner handler can install (e.g.
-- a permission denied or function-not-found error at PERFORM time). This
-- preserves NFR-L2's "scoring transaction independence" guarantee.
--
-- CALLER-KIND PROPAGATION — refresh_leaderboard() detects "called from a
-- scoring trigger" via the GUC `app.scoring_run_id`. The two per-match /
-- per-final functions don't carry an in-flight scoring_runs.id directly
-- (those rows are created only by recalculate_all_scores()), so we mint a
-- synthetic per-call UUID via gen_random_uuid() and stash it in the GUC. The
-- RPC records caller_kind='trigger' + the synthetic id; FR-L20 traceability
-- is preserved (the id lets an operator correlate the refresh row with the
-- scoring transaction it accompanied, even if no scoring_runs row exists).
-- For recalculate_all_scores() we use the real v_run_id so the refresh row
-- correlates with the admin-recalc-all scoring_runs row.
--
-- set_config(name, value, is_local := true) is the SECURITY-DEFINER-safe way
-- to set a GUC; is_local=true means it reverts at transaction end.
--
-- RECALC ONCE, NOT PER MATCH — recalculate_all_scores() loops over
-- calculate_match_points() once per finished/cancelled match. The per-match
-- trigger tail would otherwise emit one refresh attempt per match (100+
-- attempts for a full tournament). To avoid that storm, we refresh ONCE at
-- the end of the recalc-all RPC and rely on the in-loop calculate_match_points
-- calls firing their own tail refresh — which would be wasteful — so we
-- temporarily suppress the inner refresh by setting a sentinel GUC the
-- match function consults. Implementation: the match function's tail block
-- checks `app.suppress_leaderboard_refresh = 'true'` and skips if set.
-- This keeps a single end-of-RPC refresh for the admin sweep while leaving
-- the per-match trigger path untouched in normal operation.

-- ============================================================================
-- 1. calculate_match_points(UUID) — body verbatim from 0030 + tail refresh
-- ============================================================================
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
    v_suppress    TEXT;
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

    -- 5. Feature 004 tail: refresh leaderboard MV. The outer BEGIN/EXCEPTION
    -- wrapper enforces FC-L2 even for errors raised before refresh_leaderboard()
    -- installs its own handler. Suppressed when invoked from inside
    -- recalculate_all_scores() (which performs a single end-of-RPC refresh).
    --
    -- GUC HYGIENE — set_config(..., is_local := true) is transaction-scoped,
    -- NOT statement-scoped: the value survives until the outer transaction
    -- commits/rolls back. If we leave `app.scoring_run_id` set on return, any
    -- LATER call to refresh_leaderboard() in the same connection (e.g. an
    -- admin RPC call from a sibling psql command) would be misrouted to
    -- caller_kind='trigger'. We reset to '' on exit (which refresh_leaderboard
    -- treats as NULL) so the GUC tracks the in-trigger scope only.
    v_suppress := current_setting('app.suppress_leaderboard_refresh', true);
    IF v_suppress IS DISTINCT FROM 'true' THEN
        BEGIN
            PERFORM set_config('app.scoring_run_id', gen_random_uuid()::text, true);
            PERFORM refresh_leaderboard();
            PERFORM set_config('app.scoring_run_id', '', true);
        EXCEPTION WHEN OTHERS THEN
            PERFORM set_config('app.scoring_run_id', '', true);
        END;
    END IF;
END;
$$;

COMMENT ON FUNCTION calculate_match_points(UUID) IS
    'feature 003 US-PC + feature 004 US-LC: rebuild match-scoring score_events for one match (DELETE-then-INSERT). 10/5/0 per scoring-model.md §7.2; no-prediction + cancelled paths. SECURITY DEFINER. After scoring, refreshes leaderboard MV via refresh_leaderboard() in an FC-L2-decoupled tail block.';

-- ============================================================================
-- 2. calculate_final_points(UUID) — body verbatim from 0031 + tail refresh
-- ============================================================================
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
    v_suppress   TEXT;
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

    -- Feature 004 tail: refresh leaderboard MV. FC-L2 decoupling via outer
    -- BEGIN/EXCEPTION. Suppressed when invoked from recalculate_all_scores().
    -- See calculate_match_points() for the GUC-hygiene rationale.
    v_suppress := current_setting('app.suppress_leaderboard_refresh', true);
    IF v_suppress IS DISTINCT FROM 'true' THEN
        BEGIN
            PERFORM set_config('app.scoring_run_id', gen_random_uuid()::text, true);
            PERFORM refresh_leaderboard();
            PERFORM set_config('app.scoring_run_id', '', true);
        EXCEPTION WHEN OTHERS THEN
            PERFORM set_config('app.scoring_run_id', '', true);
        END;
    END IF;
END;
$$;

COMMENT ON FUNCTION calculate_final_points(UUID) IS
    'feature 003 US-PC + feature 004 US-LC: rebuild the 4 final-* score_events rows per participant (DELETE-then-INSERT). NULL arg = full sweep; participant id = single rebuild. 20 pts per correct pick. SECURITY DEFINER. After scoring, refreshes leaderboard MV via refresh_leaderboard() in an FC-L2-decoupled tail block.';

-- ============================================================================
-- 3. recalculate_all_scores() — body verbatim from 0028 + ONE end-of-run refresh
-- ============================================================================
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

    -- Suppress the per-match tail refresh so we emit ONE refresh at the end
    -- of the RPC instead of one per match (feature 004 data-model §5).
    PERFORM set_config('app.suppress_leaderboard_refresh', 'true', true);

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

    -- Feature 004 tail: ONE refresh at end-of-RPC. Re-enable the per-match
    -- tail (RESET via set_config to empty string) before invoking so the
    -- single refresh actually runs. caller_kind='trigger' is correct here —
    -- the refresh is part of an admin scoring transaction. We pass the real
    -- scoring_runs.id (v_run_id) so the audit row correlates with the
    -- admin-recalc-all run for FR-L20 traceability.
    PERFORM set_config('app.suppress_leaderboard_refresh', '', true);
    BEGIN
        PERFORM set_config('app.scoring_run_id', v_run_id::text, true);
        PERFORM refresh_leaderboard();
        PERFORM set_config('app.scoring_run_id', '', true);
    EXCEPTION WHEN OTHERS THEN
        PERFORM set_config('app.scoring_run_id', '', true);
    END;

    RETURN jsonb_build_object(
        'outcome', 'success',
        'scoring_run_id', v_run_id,
        'matches_processed', v_matches_processed,
        'duration_ms', (EXTRACT(EPOCH FROM (now() - v_started_at)) * 1000)::int
    );
END;
$$;

COMMENT ON FUNCTION recalculate_all_scores() IS
    'feature 003 US-PC + feature 004 US-LC: admin full recalc across all finished/cancelled matches. Mutex via scoring_runs partial unique index. Admin-gated. Suppresses per-match tail refresh and emits ONE end-of-RPC refresh_leaderboard() so an N-match recalc produces a single leaderboard.refresh audit row, not N.';
