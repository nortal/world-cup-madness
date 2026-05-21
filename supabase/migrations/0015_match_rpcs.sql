-- Migration: match-catalog RPCs (feature 002, T007)
--
-- Four SECURITY DEFINER functions per specs/002-match-catalog-read/contracts/:
--
--   set_timezone(text)              FR-M14 — first-sign-in TZ persist (one-shot)
--   update_timezone(text)           FR-M15 — /profile TZ editor (mirrors update_display_name)
--   trigger_match_sync()            FR-M18 — admin re-sync action (gates on is_admin_user())
--   acquire_match_sync_lock()       FR-M23 — Postgres advisory-lock helper for the Edge Function
--
-- All RPCs follow the feature 001 convention:
--   - SECURITY DEFINER + explicit `SET search_path` to avoid search_path
--     hijacking
--   - REVOKE ALL FROM PUBLIC + targeted GRANT EXECUTE to the right role
--   - Validate inputs at the entry, RAISE EXCEPTION with appropriate ERRCODE
--     so PostgREST surfaces them as structured HTTP 4xx errors
--
-- AUDIT TRAIL — set_timezone and update_timezone do NOT write to audit_log
-- directly; the existing audit_participants_changes() AFTER UPDATE trigger from
-- migration 0005 picks up the timezone change automatically and writes a
-- participant.updated audit row (FR-M16). See migration 0014 for the same note.
--
-- pg_net AVAILABILITY for trigger_match_sync():
-- pg_net is Supabase Pro tier+. On the local stack pg_net may not be available,
-- in which case the function raises a usable error (`undefined_function`) and
-- the admin UI falls back to a Next.js Route Handler that invokes the Edge
-- Function URL directly via service-role. See contracts/rpc-trigger-match-sync.md
-- §"pg_net AVAILABILITY" for the full fallback design.

-- ---------------------------------------------------------------------------
-- set_timezone(p_timezone TEXT) — first-sign-in helper, one-shot semantics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_timezone(p_timezone TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id   UUID := auth.uid();
    v_trimmed   TEXT := trim(p_timezone);
BEGIN
    IF v_trimmed IS NULL OR length(v_trimmed) = 0 THEN
        RAISE EXCEPTION 'timezone cannot be empty' USING ERRCODE = 'check_violation';
    END IF;
    IF length(v_trimmed) > 64 THEN
        RAISE EXCEPTION 'timezone too long (max 64 chars)' USING ERRCODE = 'check_violation';
    END IF;
    IF v_trimmed LIKE '% %' THEN
        RAISE EXCEPTION 'timezone must not contain whitespace' USING ERRCODE = 'check_violation';
    END IF;

    -- One-shot: only overwrite the default 'UTC'. Subsequent calls (e.g. React
    -- StrictMode double-render, second-tab race) are silent no-ops rather than
    -- errors so the Client Component can be naive about call frequency.
    UPDATE participants
        SET timezone = v_trimmed
        WHERE auth_user_id = v_user_id
            AND status = 'active'
            AND timezone = 'UTC';

    IF FOUND THEN
        RETURN jsonb_build_object('outcome', 'success', 'timezone', v_trimmed);
    ELSE
        RETURN jsonb_build_object(
            'outcome', 'no-op',
            'reason', 'already-set-or-not-eligible'
        );
    END IF;
END $$;

REVOKE ALL ON FUNCTION set_timezone(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_timezone(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- update_timezone(p_timezone TEXT) — /profile editor, mirrors update_display_name
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_timezone(p_timezone TEXT)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
    v_user_id   UUID := auth.uid();
    v_trimmed   TEXT := trim(p_timezone);
BEGIN
    IF v_trimmed IS NULL OR length(v_trimmed) = 0 THEN
        RAISE EXCEPTION 'timezone cannot be empty' USING ERRCODE = 'check_violation';
    END IF;
    IF length(v_trimmed) > 64 THEN
        RAISE EXCEPTION 'timezone too long (max 64 chars)' USING ERRCODE = 'check_violation';
    END IF;
    IF v_trimmed LIKE '% %' THEN
        RAISE EXCEPTION 'timezone must not contain whitespace' USING ERRCODE = 'check_violation';
    END IF;

    UPDATE participants
        SET timezone = v_trimmed
        WHERE auth_user_id = v_user_id AND status = 'active';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'participant not found or inactive'
            USING ERRCODE = 'no_data_found';
    END IF;

    RETURN jsonb_build_object('outcome', 'success', 'timezone', v_trimmed);
END $$;

REVOKE ALL ON FUNCTION update_timezone(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION update_timezone(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- trigger_match_sync() — admin re-sync action (FR-M18)
-- ---------------------------------------------------------------------------
-- Issues an HTTP POST to the sync-matches Edge Function via pg_net. The admin
-- gate is checked via is_admin_user() (from feature 001 migration 0010, which
-- wraps the admin lookup in its own SECURITY DEFINER to avoid the recursive
-- RLS problem on participants).
--
-- pg_net behaviour: net.http_post returns a request_id immediately; the actual
-- HTTP exchange happens asynchronously. The caller (admin UI) polls
-- integration_runs for the eventual outcome. This RPC is fire-and-forget.
--
-- pg_net may not be installed on the local stack; the EXCEPTION clause keeps
-- the error explanatory rather than letting the implicit undefined_function
-- error bubble up cryptically.
CREATE OR REPLACE FUNCTION trigger_match_sync()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, net
AS $$
DECLARE
    v_request_id BIGINT;
    v_function_url TEXT := current_setting('app.sync_function_url', true);
    v_service_role_key TEXT := current_setting('app.service_role_key', true);
BEGIN
    -- Authorization: admin only
    IF NOT is_admin_user() THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF v_function_url IS NULL OR length(v_function_url) = 0 THEN
        RAISE EXCEPTION 'app.sync_function_url not configured'
            USING ERRCODE = 'config_file_error',
                  HINT = 'Set via: ALTER DATABASE postgres SET app.sync_function_url = ''https://.../functions/v1/sync-matches'';';
    END IF;

    -- Issue the HTTP POST. pg_net may be unavailable on the local stack — wrap
    -- in EXCEPTION block for a clearer error path than the raw undefined_function.
    BEGIN
        v_request_id := net.http_post(
            url     := v_function_url,
            body    := jsonb_build_object('action', 'manual-resync'),
            headers := jsonb_build_object(
                'Authorization', 'Bearer ' || coalesce(v_service_role_key, ''),
                'Content-Type', 'application/json'
            ),
            timeout_milliseconds := 60000
        );
    EXCEPTION WHEN undefined_function THEN
        RAISE EXCEPTION 'pg_net extension not installed; use Next.js Route Handler fallback to invoke Edge Function directly'
            USING ERRCODE = 'feature_not_supported',
                  HINT = 'CREATE EXTENSION pg_net; (Supabase Pro tier+) OR call /admin/match-sync from the browser';
    END;

    RETURN jsonb_build_object(
        'outcome', 'triggered',
        'request_id', v_request_id
    );
END $$;

REVOKE ALL ON FUNCTION trigger_match_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION trigger_match_sync() TO authenticated;

-- ---------------------------------------------------------------------------
-- acquire_match_sync_lock() — advisory-lock helper for the Edge Function
-- ---------------------------------------------------------------------------
-- Called by sync-matches/index.ts at start-of-run. Returns true if this caller
-- got the lock; false if another invocation is in flight (the caller then
-- short-circuits with outcome='skipped' per FR-M23).
--
-- Service-role only — non-service callers have no business touching the lock.
CREATE OR REPLACE FUNCTION acquire_match_sync_lock()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT pg_try_advisory_lock(hashtext('match-catalog-sync'))
$$;

REVOKE ALL ON FUNCTION acquire_match_sync_lock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION acquire_match_sync_lock() TO service_role;

-- (There is no release_match_sync_lock RPC — the Edge Function calls
--  pg_advisory_unlock(hashtext('match-catalog-sync')) directly via the SQL
--  client. Connection close auto-releases the lock as a fail-safe per R-4.)
