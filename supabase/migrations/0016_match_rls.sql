-- Migration: RLS policies for the match-catalog tables (feature 002, T008, FR-M22)
--
-- Three new tables (teams, matches, integration_runs) get their SELECT policies.
-- No INSERT/UPDATE/DELETE policies for the `authenticated` role — writes happen
-- only via service_role from the sync-matches Edge Function. PostgREST returns
-- 401 to any authenticated write attempt, which is the desired behaviour.
--
-- Read-path RLS uses the predicates from feature 001:
--   is_eligible_nortal_user()  (migration 0010)  — Nortal-tenant participants
--   is_admin_user()            (migration 0010)  — admin participants only
--
-- This matches the spec.md §2 Session 2026-05-20 clarification: keep all read
-- paths behind the eligibility predicate for consistency; lock telemetry away
-- from non-admins so support / debugging context stays operator-only.

-- ---------------------------------------------------------------------------
-- teams: eligible-participant read-only
-- ---------------------------------------------------------------------------
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY teams_select_eligible
    ON teams
    FOR SELECT
    TO authenticated
    USING (is_eligible_nortal_user());

-- (No INSERT/UPDATE/DELETE policies — see file header.)

-- ---------------------------------------------------------------------------
-- matches: eligible-participant read-only
-- ---------------------------------------------------------------------------
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY matches_select_eligible
    ON matches
    FOR SELECT
    TO authenticated
    USING (is_eligible_nortal_user());

-- (No INSERT/UPDATE/DELETE policies — see file header.)

-- ---------------------------------------------------------------------------
-- integration_runs: admin-only read
-- ---------------------------------------------------------------------------
-- Non-admin participants see zero rows. Operators rely on this to triage
-- "did the cron run?" / "why did my re-sync skip?" without exposing sync
-- internals to all participants.
ALTER TABLE integration_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY integration_runs_select_admin
    ON integration_runs
    FOR SELECT
    TO authenticated
    USING (is_admin_user());

-- (No INSERT/UPDATE/DELETE policies — see file header.)
