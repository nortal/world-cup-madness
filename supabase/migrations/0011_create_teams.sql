-- Migration: teams table — national-team catalog for FIFA WC 2026 (feature 002, FR-M02)
--
-- Scope of THIS migration:
--   - CREATE TABLE teams with PK, NOT NULL constraints, UNIQUE on tla + provider_team_id,
--     and a CHECK enforcing the FIFA three-letter abbreviation shape.
--
-- Out of scope (handled by sibling migrations per data-model.md migration-order chart):
--   - RLS enable + SELECT policy gated on is_eligible_nortal_user()  -> 0016_match_rls.sql
--   - Seed rows (48 WC 2026 qualifiers from the frozen provider fixture) -> 0017_seed_teams.sql
--   - FK references from matches.home_team_id / away_team_id          -> 0012_create_matches.sql
--
-- IF NOT EXISTS keeps `npx supabase db reset` idempotent during local dev.

CREATE TABLE IF NOT EXISTS teams (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    -- FIFA three-letter abbreviation (e.g. BRA, EST, USA). Regex pins it to exactly
    -- three uppercase A–Z characters so a stray lowercase or 2/4-letter value from
    -- a provider response is rejected at write time rather than corrupting UI chips.
    tla                 TEXT NOT NULL UNIQUE
                            CHECK (length(tla) = 3 AND tla ~ '^[A-Z]+$'),
    -- football-data.org v4 team id. UNIQUE makes it safe to use as the merge key on
    -- the sync UPSERT (FR-M20 idempotency).
    provider_team_id    INTEGER NOT NULL UNIQUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- No index on `name`: max 48 rows means a seq-scan beats any btree lookup, and
-- the column is display-only (filter chips use `tla`, joins use `id`).
