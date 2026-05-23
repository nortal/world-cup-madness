-- Migration: extend audit_log.action CHECK to cover feature 003 tags
--
-- Feature 001 migration 0005 fixed the action enum at 6 values. Feature 003
-- introduces nine new action tags across prediction writes, admin overrides,
-- and scoring runs. Postgres can't ALTER a CHECK in place, so we DROP + ADD.
--
-- New tags added below (preserves all 6 existing values):
--   prediction.created           — submit_prediction RPC inserts new row
--   prediction.updated           — submit_prediction RPC updates existing row
--   final_prediction.created     — submit_final_prediction RPC insert
--   final_prediction.updated     — submit_final_prediction RPC update
--   admin.match-result-override  — admin corrected match_results outside the trigger path
--   admin.tournament-winner-set  — admin set a tournament_config winner via set_tournament_winner RPC
--   admin.recalc-all             — admin invoked recalculate_all_scores RPC
--   scoring.match                — calculate_match_points trigger function emitted a scoring run
--   scoring.final                — calculate_final_points trigger function emitted a scoring run
--
-- All 15 values together preserve audit semantics; the broader vocabulary
-- documents legitimate write paths into audit_log without changing the
-- table's row shape.

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
            'scoring.final'
        ])
    );
