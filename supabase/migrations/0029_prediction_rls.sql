-- Migration: RLS policies for all feature-003 tables (T009)
--
-- Per data-model.md §4. Enables RLS on the 5 new tables and adds policies
-- matching the participant / admin / service-role split established by
-- features 001 + 002.
--
-- Critical: score_events has NO INSERT/UPDATE/DELETE policies for
-- authenticated. Only SECURITY DEFINER trigger functions (in migrations
-- 0030 + 0031) can write. This enforces FR-P24 / FC-3 at the SQL layer —
-- admins correct match_results and the triggers regenerate scoring.
--
-- The all_runs view inherits RLS via security_invoker=true (migration 0024).

-- ===========================================================================
-- predictions
-- ===========================================================================
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;

CREATE POLICY predictions_select_own ON predictions
    FOR SELECT TO authenticated
    USING (participant_id IN (
        SELECT id FROM participants
        WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY predictions_insert_own ON predictions
    FOR INSERT TO authenticated
    WITH CHECK (participant_id IN (
        SELECT id FROM participants
        WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY predictions_update_own ON predictions
    FOR UPDATE TO authenticated
    USING (participant_id IN (
        SELECT id FROM participants
        WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY predictions_select_admin ON predictions
    FOR SELECT TO authenticated
    USING (is_admin_user());

-- ===========================================================================
-- final_predictions
-- ===========================================================================
ALTER TABLE final_predictions ENABLE ROW LEVEL SECURITY;

CREATE POLICY final_predictions_select_own ON final_predictions
    FOR SELECT TO authenticated
    USING (participant_id IN (
        SELECT id FROM participants
        WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY final_predictions_insert_own ON final_predictions
    FOR INSERT TO authenticated
    WITH CHECK (participant_id IN (
        SELECT id FROM participants
        WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY final_predictions_update_own ON final_predictions
    FOR UPDATE TO authenticated
    USING (participant_id IN (
        SELECT id FROM participants
        WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY final_predictions_select_admin ON final_predictions
    FOR SELECT TO authenticated
    USING (is_admin_user());

-- ===========================================================================
-- players — eligible-tenant SELECT only; no participant writes (service-role)
-- ===========================================================================
ALTER TABLE players ENABLE ROW LEVEL SECURITY;

CREATE POLICY players_select_eligible ON players
    FOR SELECT TO authenticated
    USING (is_eligible_nortal_user());

-- ===========================================================================
-- score_events — read-only for participants (own rows) + admins; no writes via PostgREST
-- ===========================================================================
ALTER TABLE score_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY score_events_select_own ON score_events
    FOR SELECT TO authenticated
    USING (participant_id IN (
        SELECT id FROM participants
        WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY score_events_select_admin ON score_events
    FOR SELECT TO authenticated
    USING (is_admin_user());

-- DELIBERATELY NO INSERT/UPDATE/DELETE POLICIES for authenticated.
-- All writes flow through SECURITY DEFINER trigger functions in 0030/0031.
-- This is the FR-P24 / FC-3 enforcement point.

-- ===========================================================================
-- scoring_runs — admin SELECT only
-- ===========================================================================
ALTER TABLE scoring_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY scoring_runs_select_admin ON scoring_runs
    FOR SELECT TO authenticated
    USING (is_admin_user());

-- No write policies — service-role + SECURITY DEFINER trigger functions only.
