-- Migration: score_events table + source ENUM (feature 003, T007)
--
-- Per data-model.md §1.4. The ledger of points. Sum across participant_id
-- = participant's total. Distinguishes match-derived, final-prediction-
-- derived, no-prediction, and cancelled-match rows for breakdown queries.
--
-- Source ENUM (13 values total):
--   match-exact / match-outcome / match-wrong / no-prediction / match-cancelled
--   final-champion / final-runner-up / final-top-scorer / final-best-player
--   final-not-picked-champion / final-not-picked-runner-up / final-not-picked-top-scorer / final-not-picked-best-player
--
-- Two partial unique indexes implement Clarify Q1's "at most one match-
-- scoring row per (participant, match) + at most one final-source row per
-- (participant, source)" invariant.
--
-- CHECK constraint pairs source with match_id presence — match sources MUST
-- have match_id; final sources MUST have match_id NULL. Defence-in-depth
-- against trigger bugs.
--
-- ON DELETE CASCADE: participant or match deletion cascades. scoring_run_id
-- is ON DELETE SET NULL — purging a scoring_runs row for retention loses
-- the provenance link but the points themselves stay.

CREATE TYPE score_event_source AS ENUM (
    'match-exact',
    'match-outcome',
    'match-wrong',
    'no-prediction',
    'match-cancelled',
    'final-champion',
    'final-runner-up',
    'final-top-scorer',
    'final-best-player',
    'final-not-picked-champion',
    'final-not-picked-runner-up',
    'final-not-picked-top-scorer',
    'final-not-picked-best-player'
);

CREATE TABLE score_events (
    id                  UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id      UUID                NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    match_id            UUID                REFERENCES matches(id) ON DELETE CASCADE,
    source              score_event_source  NOT NULL,
    points              SMALLINT            NOT NULL,
    awarded_at          TIMESTAMPTZ         NOT NULL DEFAULT now(),
    scoring_run_id      UUID                REFERENCES scoring_runs(id) ON DELETE SET NULL,

    CONSTRAINT score_events_points_range
        CHECK (points BETWEEN 0 AND 20),
    CONSTRAINT score_events_match_id_required_for_match_sources
        CHECK (
            (source IN ('match-exact', 'match-outcome', 'match-wrong', 'no-prediction', 'match-cancelled') AND match_id IS NOT NULL)
            OR
            (source NOT IN ('match-exact', 'match-outcome', 'match-wrong', 'no-prediction', 'match-cancelled') AND match_id IS NULL)
        )
);

-- At most one match-scoring row per (participant, match) — Clarify Q1 contract.
CREATE UNIQUE INDEX score_events_one_per_participant_match
    ON score_events (participant_id, match_id)
    WHERE match_id IS NOT NULL;

-- At most one row per (participant, final-source) — single-row-per-final-pick semantic.
CREATE UNIQUE INDEX score_events_one_per_participant_final_source
    ON score_events (participant_id, source)
    WHERE match_id IS NULL;

CREATE INDEX score_events_participant_id_idx ON score_events(participant_id);
CREATE INDEX score_events_match_id_idx       ON score_events(match_id)   WHERE match_id IS NOT NULL;
CREATE INDEX score_events_awarded_at_idx     ON score_events(awarded_at DESC);

COMMENT ON TABLE score_events IS
    'feature 003: points ledger. Rebuilt per match (DELETE-then-INSERT) by calculate_match_points/_final_points triggers. No authenticated write policies — only SECURITY DEFINER trigger functions write.';
