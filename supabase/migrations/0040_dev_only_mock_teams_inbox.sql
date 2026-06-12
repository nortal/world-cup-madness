-- Migration 0040: dev-only mock Teams receiver inbox
--
-- Feature 006 (Phase 5 Operational Readiness) — FR-O01..O02 + research R-4.
--
-- Creates the `_test_mock_teams_inbox` table that receives POSTs from the
-- mock Teams receiver Edge Function (T006) during local Playwright tests.
-- The mock receiver writes the incoming JSON body + headers + status here;
-- Playwright specs then assert on row counts, body shape (e.g. that
-- `body->>'error_message'` is the `[REDACTED]` output of
-- scrub_pii_for_teams()), and Content-Type headers.
--
-- This table is DEV-ONLY. The entire CREATE is wrapped in a PL/pgSQL DO
-- block guarded by `current_setting('app.env', true) = 'development'`,
-- so it is a no-op in any environment where `app.env` is not exactly
-- 'development'. Supabase Cloud (production + staging) leaves `app.env`
-- unset or set to 'production', so the table is never created there.
--
-- No RLS, no GRANT — writes only happen from the mock receiver Edge
-- Function, which runs with the service_role key.

DO $$
BEGIN
    IF current_setting('app.env', true) = 'development' THEN
        CREATE TABLE IF NOT EXISTS _test_mock_teams_inbox (
            id           BIGSERIAL PRIMARY KEY,
            body         JSONB NOT NULL,
            headers      JSONB NOT NULL DEFAULT '{}'::jsonb,
            status_sent  INT NOT NULL DEFAULT 200,
            received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        -- No RLS — dev-only, service-role-only writes from the mock receiver.
    END IF;
END;
$$ LANGUAGE plpgsql;
