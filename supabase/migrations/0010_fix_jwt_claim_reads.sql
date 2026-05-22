-- Migration: read custom claims from app_metadata / user_metadata
--
-- Background: the original RPC + RLS predicate read `tid` and `name` from the
-- top-level JWT, which assumed the `before-issue-token` hook (T023) was
-- deployed AND registered to copy those fields out of the Microsoft Entra ID
-- token. Without that wiring (the hook block in `supabase/config.toml` is
-- commented out and we have no Edge Function deployment for it yet), the
-- top-level claims are always NULL on local sign-ins and the RPC rejects
-- every user as tenant-mismatched.
--
-- Fix: align with Supabase's storage convention — custom claims live in
-- `app_metadata` (set via the admin API and/or by the future hook), and user
-- profile metadata lives in `user_metadata`. The RPC and RLS predicate now
-- read from those nested objects so they work consistently with:
--   - Production OAuth flow (hook writes app_metadata.tid)
--   - Local Playwright fixtures (admin.createUser writes raw_app_meta_data)
--   - pgTAP test helpers (build claims object directly)
--
-- The hook in `supabase/auth-hooks/before-issue-token.ts` already writes to
-- `app_metadata` (it ALSO mirrors `tid` top-level, but that mirror is now
-- redundant and will be removed in a follow-up).

CREATE OR REPLACE FUNCTION is_eligible_nortal_user()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, auth
AS $$
    SELECT (auth.jwt() -> 'app_metadata' ->> 'tid')::UUID
        = (SELECT nortal_tenant_id FROM tournament_config WHERE id = 1)
$$;

-- ---------------------------------------------------------------------------
-- is_admin_user(): SECURITY DEFINER admin-check
-- ---------------------------------------------------------------------------
-- Migration 0008 wrote two RLS policies that contained inline
-- `EXISTS (SELECT 1 FROM participants WHERE ...)` admin checks. Those subqueries
-- recurse through `participants`' own RLS, which Postgres detects as
-- "infinite recursion detected in policy for relation 'participants'". The
-- bug was latent until this migration restored a working
-- `is_eligible_nortal_user()` — previously the predicate returned NULL/false
-- for every user, so the `AND EXISTS` short-circuited and the recursion never
-- triggered.
--
-- Standard fix: wrap the admin lookup in a SECURITY DEFINER function so it
-- bypasses RLS on `participants` and cannot recurse. `STABLE` lets the planner
-- cache the result within a single statement.
CREATE OR REPLACE FUNCTION is_admin_user()
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM participants
        WHERE auth_user_id = auth.uid()
              AND role = 'admin'
              AND status = 'active'
    )
$$;

REVOKE ALL ON FUNCTION is_admin_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_admin_user() TO authenticated;

-- Rewrite the two admin-gated RLS policies to use the SECURITY DEFINER helper
-- instead of the recursing inline EXISTS clause.
DROP POLICY IF EXISTS participants_admin_select_all ON participants;
CREATE POLICY participants_admin_select_all ON participants
    FOR SELECT TO authenticated
    USING (is_eligible_nortal_user() AND is_admin_user());

DROP POLICY IF EXISTS audit_log_admin_select ON audit_log;
CREATE POLICY audit_log_admin_select ON audit_log
    FOR SELECT TO authenticated
    USING (is_eligible_nortal_user() AND is_admin_user());

CREATE OR REPLACE FUNCTION provision_participant_from_jwt()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_tid           UUID;
    v_oid           UUID;
    v_email         CITEXT;
    v_display_name  TEXT;
    v_user_id       UUID := auth.uid();
    v_config        tournament_config%ROWTYPE;
    v_existing      participants%ROWTYPE;
    v_new_role      TEXT;
BEGIN
    v_tid := (auth.jwt() -> 'app_metadata' ->> 'tid')::UUID;
    v_oid := (auth.jwt() -> 'app_metadata' ->> 'oid')::UUID;
    v_email := (auth.jwt() ->> 'email')::CITEXT;
    v_display_name := COALESCE(
        NULLIF(trim(auth.jwt() -> 'user_metadata' ->> 'name'), ''),
        NULLIF(trim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
        split_part(auth.jwt() ->> 'email', '@', 1)
    );

    SELECT * INTO v_config FROM tournament_config WHERE id = 1;
    IF NOT FOUND OR v_config.nortal_tenant_id IS NULL THEN
        PERFORM record_auth_failure('auth.provider-error', v_oid, v_email, v_tid, 'config.missing');
        RETURN jsonb_build_object('outcome', 'error', 'reason', 'config.missing');
    END IF;

    IF v_tid IS DISTINCT FROM v_config.nortal_tenant_id THEN
        SELECT * INTO v_existing FROM participants WHERE oid = v_oid;
        IF FOUND AND v_existing.status = 'active' THEN
            UPDATE participants SET status = 'inactive' WHERE id = v_existing.id;
        END IF;
        PERFORM record_auth_failure('auth.rejected', v_oid, v_email, v_tid, 'tenant.mismatch');
        RETURN jsonb_build_object('outcome', 'rejected', 'reason', 'tenant.mismatch');
    END IF;

    v_new_role := CASE WHEN v_oid = ANY(v_config.admin_oids) THEN 'admin' ELSE 'participant' END;

    SELECT * INTO v_existing FROM participants WHERE oid = v_oid;
    IF NOT FOUND THEN
        INSERT INTO participants (auth_user_id, oid, email, display_name,
                                  role, status, last_login_at)
        VALUES (v_user_id, v_oid, v_email, v_display_name, v_new_role, 'active', now())
        RETURNING * INTO v_existing;
    ELSE
        UPDATE participants
        SET last_login_at = now(),
            role = v_new_role,
            status = 'active',
            email = v_email
        WHERE id = v_existing.id;
    END IF;

    RETURN jsonb_build_object(
        'outcome', 'success',
        'participant_id', v_existing.id,
        'role', v_new_role,
        'is_first_login', v_existing.welcome_dismissed_at IS NULL
    );
END $$;

REVOKE ALL ON FUNCTION provision_participant_from_jwt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_participant_from_jwt() TO authenticated;
