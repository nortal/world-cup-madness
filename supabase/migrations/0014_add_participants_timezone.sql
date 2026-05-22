-- Migration: add `timezone` column to participants (feature 002, T006, FR-M13/M14/M16)
--
-- Extends the participants table from feature 001 (migration 0003) with a stored
-- IANA timezone string. Default 'UTC' for existing rows; new sign-ins overwrite
-- via FR-M14's set_timezone() RPC (added in migration 0015).
--
-- AUDIT TRAIL — NO NEW SQL NEEDED:
-- The existing `audit_participants_changes()` AFTER UPDATE trigger from migration
-- 0005 already fires on ANY column mutation via its catch-all
-- `ELSIF OLD IS DISTINCT FROM NEW` branch (see 0005_audit_triggers.sql lines 28–33).
-- It will automatically write a `participant.updated` audit row with the old + new
-- timezone embedded in old_value / new_value JSONB whenever this column changes.
-- That fully satisfies FR-M16 with zero new audit infrastructure.
--
-- VALIDATION SCOPE:
-- The CHECK constraint rejects empty strings and values containing whitespace
-- anywhere. It does NOT validate against the live IANA database — Postgres has
-- no native way to do that, and the IANA tz db evolves over time (zones are
-- added, occasionally renamed). The renderer falls back to UTC display + a
-- structured log line if the stored value is not recognised by the runtime's
-- Intl support — see spec.md §3 edge cases ("invalid stored TZ string").
--
-- IF NOT EXISTS keeps `npx supabase db reset` idempotent during local dev.

ALTER TABLE participants
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- Separate ADD CONSTRAINT statement (not embedded in ADD COLUMN) so the check
-- can be inspected, dropped, or evolved independently if the validity rules
-- change. Named for traceability in pg_catalog.
ALTER TABLE participants
    ADD CONSTRAINT participants_timezone_nonempty
        CHECK (length(timezone) > 0 AND timezone NOT LIKE '% %');
