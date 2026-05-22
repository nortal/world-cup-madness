-- Migration: is_eligible_nortal_user() predicate, RLS policies, participants_public view

CREATE OR REPLACE FUNCTION is_eligible_nortal_user()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, auth
AS $$
    SELECT (auth.jwt() ->> 'tid')::UUID
        = (SELECT nortal_tenant_id FROM tournament_config WHERE id = 1)
$$;

ALTER TABLE participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY participants_select_own ON participants
    FOR SELECT TO authenticated
    USING (is_eligible_nortal_user() AND auth_user_id = auth.uid());

CREATE POLICY participants_select_active_for_leaderboard ON participants
    FOR SELECT TO authenticated
    USING (is_eligible_nortal_user() AND status = 'active');

CREATE POLICY participants_admin_select_all ON participants
    FOR SELECT TO authenticated
    USING (
        is_eligible_nortal_user() AND EXISTS (
            SELECT 1 FROM participants p
            WHERE p.auth_user_id = auth.uid()
                  AND p.role = 'admin'
                  AND p.status = 'active'
        )
    );

ALTER TABLE tournament_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY tournament_config_select ON tournament_config
    FOR SELECT TO authenticated
    USING (true);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_admin_select ON audit_log
    FOR SELECT TO authenticated
    USING (
        is_eligible_nortal_user() AND EXISTS (
            SELECT 1 FROM participants p
            WHERE p.auth_user_id = auth.uid()
                  AND p.role = 'admin'
                  AND p.status = 'active'
        )
    );

CREATE VIEW participants_public AS
SELECT id, oid, display_name, role, status, created_at, last_login_at
FROM participants;

GRANT SELECT ON participants_public TO authenticated;
