-- Migration: create predictions table (feature 003, T003)
--
-- Per data-model.md §1.1. One active row per (participant, match); edit
-- history captured in audit_log via the submit_prediction RPC (created in
-- migration 0028).
--
-- SMALLINT for score columns matches feature 002's matches.score_home /
-- score_away types. Range 0..20 caps fat-finger errors well above the
-- football record (9-0).
--
-- ON DELETE CASCADE on both FKs: purging a participant or removing a
-- fixture cleans up the participant's predictions. Audit trail of the
-- deletion is captured by the participants AFTER DELETE trigger from
-- feature 001 migration 0005 (for the participant cascade); match removals
-- are admin-only and rare.

CREATE TABLE predictions (
    id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id           UUID         NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    match_id                 UUID         NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    predicted_home_score     SMALLINT     NOT NULL,
    predicted_away_score     SMALLINT     NOT NULL,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT predictions_home_range
        CHECK (predicted_home_score BETWEEN 0 AND 20),
    CONSTRAINT predictions_away_range
        CHECK (predicted_away_score BETWEEN 0 AND 20),
    CONSTRAINT predictions_one_per_participant_match
        UNIQUE (participant_id, match_id)
);

CREATE INDEX predictions_match_id_idx ON predictions(match_id);
CREATE INDEX predictions_participant_id_idx ON predictions(participant_id);

COMMENT ON TABLE predictions IS
    'feature 003: one active match-score prediction per participant per match. Edit history in audit_log via submit_prediction RPC.';
