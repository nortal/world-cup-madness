-- Migration: update_display_name() and dismiss_welcome() SECURITY DEFINER RPCs

CREATE OR REPLACE FUNCTION update_display_name(new_name TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id   UUID := auth.uid();
    v_trimmed   TEXT := trim(new_name);
BEGIN
    IF v_trimmed IS NULL OR length(v_trimmed) = 0 THEN
        RAISE EXCEPTION 'display_name cannot be empty' USING ERRCODE = 'check_violation';
    END IF;
    IF length(v_trimmed) > 100 THEN
        RAISE EXCEPTION 'display_name too long (max 100 chars)' USING ERRCODE = 'check_violation';
    END IF;

    UPDATE participants
    SET display_name = v_trimmed
    WHERE auth_user_id = v_user_id AND status = 'active';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'participant not found or inactive' USING ERRCODE = 'no_data_found';
    END IF;

    RETURN jsonb_build_object('outcome', 'success', 'display_name', v_trimmed);
END $$;

REVOKE ALL ON FUNCTION update_display_name(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_display_name(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION dismiss_welcome()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    UPDATE participants
    SET welcome_dismissed_at = COALESCE(welcome_dismissed_at, now())
    WHERE auth_user_id = v_user_id AND status = 'active';

    RETURN jsonb_build_object('outcome', 'success');
END $$;

REVOKE ALL ON FUNCTION dismiss_welcome() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dismiss_welcome() TO authenticated;
