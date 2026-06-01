-- Migration: create players table (feature 003, T005)
--
-- Per data-model.md §1.3. Populated by the squad-sync extension to the
-- sync-matches Edge Function (US-PB, migration not required — runtime UPSERT).
--
-- `provider_player_id` UNIQUE matches feature 002's idempotency pattern for
-- teams + matches. `position` constrained to football-data.org v4's four
-- values (Goalkeeper / Defender / Midfielder / Attacker); NULL allowed for
-- players whose position the provider hasn't recorded.
--
-- ON DELETE CASCADE on team_id: if a team is purged (very unlikely
-- post-draw), all its players go too. Final predictions referencing the
-- player cascade to NULL via the SET NULL FK in 0022.

CREATE TABLE players (
    id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_player_id     INTEGER      NOT NULL,
    name                   TEXT         NOT NULL,
    position               TEXT,
    team_id                UUID         NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT players_provider_id_unique
        UNIQUE (provider_player_id),
    CONSTRAINT players_name_not_empty
        CHECK (length(trim(name)) > 0),
    CONSTRAINT players_position_valid
        CHECK (position IS NULL OR position IN ('Goalkeeper', 'Defender', 'Midfielder', 'Attacker'))
);

CREATE INDEX players_team_id_idx ON players(team_id);
CREATE INDEX players_name_idx ON players(name);

COMMENT ON TABLE players IS
    'feature 003: football-data.org v4 squad players. Populated by sync-matches Edge Function squad-sync step.';
