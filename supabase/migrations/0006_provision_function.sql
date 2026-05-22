-- Migration: provision_participant_from_jwt() and record_auth_failure() SECURITY DEFINER RPCs

CREATE OR REPLACE FUNCTION record_auth_failure(
    p_action          TEXT,
    p_oid             UUID,
    p_email           CITEXT,
    p_attempted_tid   UUID,
    p_reason          TEXT
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_action NOT IN ('auth.rejected', 'auth.provider-error') THEN
        RAISE EXCEPTION 'Invalid action for record_auth_failure: %', p_action
            USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO audit_log (action, actor_oid, actor_email, attempted_tid, reason)
    VALUES (p_action, p_oid, p_email, p_attempted_tid, p_reason);
END $$;

REVOKE ALL ON FUNCTION record_auth_failure(TEXT, UUID, CITEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_auth_failure(TEXT, UUID, CITEXT, UUID, TEXT)
    TO authenticated, service_role;

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
    v_tid := (auth.jwt() ->> 'tid')::UUID;
    v_oid := (auth.jwt() -> 'app_metadata' ->> 'oid')::UUID;
    v_email := (auth.jwt() ->> 'email')::CITEXT;
    v_display_name := COALESCE(
        NULLIF(trim(auth.jwt() ->> 'name'), ''),
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
