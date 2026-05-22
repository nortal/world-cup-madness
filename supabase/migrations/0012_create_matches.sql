-- Migration: matches table — 104-row tournament catalog (feature 002, T004)
--
-- Purpose: persist the FIFA WC 2026 fixture list synced from football-data.org v4.
-- Each row is a single match keyed internally by UUID and externally by
-- `provider_id` (the merge key for the idempotent sync UPSERT per FR-M20).
--
-- Satisfies FR-M01 (catalog of all tournament matches) and underpins FR-M02–FR-M13
-- (list + filter + detail queries). RLS for this table is added in migration 0016
-- (`is_eligible_nortal_user()` SELECT policy); writes happen only via service-role
-- from the `sync-matches` Edge Function, so no authenticated-role write policies
-- are ever defined.
--
-- The compound `matches_status_kickoff_consistency` CHECK encodes the spec §3
-- edge case ("a match with no kickoff yet → status='scheduled-tbd'") at the
-- schema layer, preventing hand-written rows from violating the invariant.
--
-- Depends on: 0011_create_teams.sql (teams.id FK target).

CREATE TABLE IF NOT EXISTS matches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- football-data.org v4 match id; UNIQUE makes the sync UPSERT idempotent (FR-M20).
    provider_id     INTEGER NOT NULL UNIQUE,
    -- ON DELETE RESTRICT (not CASCADE): a team referenced by any match must be
    -- explicitly detached before deletion — prevents accidental cascading loss
    -- of fixture history when team-catalog corrections are made.
    home_team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    away_team_id    UUID NOT NULL REFERENCES teams(id) ON DELETE RESTRICT,
    -- TEXT + CHECK rather than a Postgres ENUM: ENUMs are hard to evolve and the
    -- stage list could shift between tournament editions.
    stage           TEXT NOT NULL
                        CHECK (stage IN ('group','round-of-16','quarter-final','semi-final','third-place','final')),
    -- NULL for knockout matches; A..L for the 12 groups in the WC 2026 expansion.
    group_label     TEXT
                        CHECK (group_label IS NULL OR group_label ~ '^[A-L]$'),
    -- NULL only when status='scheduled-tbd' (enforced by the compound CHECK below).
    kickoff_utc     TIMESTAMPTZ,
    venue           TEXT,
    -- 5 statuses per spec §2 Session 2026-05-20 Q1. `locked` is NOT stored — it
    -- is derived in TS from (status, kickoff_utc, now()) via lib/matches/lock-badge.ts.
    status          TEXT NOT NULL
                        CHECK (status IN ('scheduled','scheduled-tbd','live','finished','cancelled')),
    score_home      INTEGER
                        CHECK (score_home IS NULL OR score_home >= 0),
    score_away      INTEGER
                        CHECK (score_away IS NULL OR score_away >= 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Refreshed on every successful sync UPSERT (even no-op field-identical rows)
    -- so operators can answer "when did we last hear about this match?".
    last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Compound invariant: kickoff_utc is required for every status EXCEPT
    -- 'scheduled-tbd', and 'scheduled-tbd' rows MUST have a NULL kickoff_utc.
    CONSTRAINT matches_status_kickoff_consistency CHECK (
        (status = 'scheduled-tbd' AND kickoff_utc IS NULL)
        OR (status <> 'scheduled-tbd' AND kickoff_utc IS NOT NULL)
    )
);

-- Chronological list query (default /matches sort) + dashboard "next 3" widget.
-- ASC NULLS LAST keeps scheduled-tbd rows out of the way of the chronological
-- timeline rather than using Postgres' default (NULLS FIRST for ASC).
CREATE INDEX matches_kickoff_utc_idx ON matches (kickoff_utc ASC NULLS LAST);

-- ?stage=... filter combined with chronological sort within the stage.
CREATE INDEX matches_stage_kickoff_idx ON matches (stage, kickoff_utc);

-- ?team=BRA filter (resolved to a team UUID by the route handler, then matched
-- against either side). Two separate indexes — Postgres can OR them — rather
-- than a single composite, since the filter checks home OR away independently.
-- No FK to a future predictions table (feature 003): predictions will reference
-- matches.id, not the other way around.
CREATE INDEX matches_home_team_id_idx ON matches (home_team_id);
CREATE INDEX matches_away_team_id_idx ON matches (away_team_id);
