-- Migration: create final_predictions table (feature 003, T004)
--
-- Per data-model.md §1.2. One row per participant with four nullable picks.
-- All 4 nullable: supports partial submissions (champion + runner_up before
-- squads are published, then top_scorer + best_player after).
--
-- ON DELETE SET NULL on every FK so squad-sync removing a player (transfer /
-- withdrawal) clears the affected pick; the cascade fires
-- final_predictions_trigger_scoring (migration 0031) which rebuilds the
-- participant's final-* score_events rows.
--
-- CHECK constraint: champion <> runner_up, but only when both non-NULL
-- (partial-submit support).

CREATE TABLE final_predictions (
    id                         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    participant_id             UUID         NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    champion_team_id           UUID         REFERENCES teams(id) ON DELETE SET NULL,
    runner_up_team_id          UUID         REFERENCES teams(id) ON DELETE SET NULL,
    top_scorer_player_id       UUID         REFERENCES players(id) ON DELETE SET NULL,
    best_player_player_id      UUID         REFERENCES players(id) ON DELETE SET NULL,
    created_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT final_predictions_one_per_participant
        UNIQUE (participant_id),
    CONSTRAINT final_predictions_champion_distinct_runner_up
        CHECK (champion_team_id IS NULL
               OR runner_up_team_id IS NULL
               OR champion_team_id <> runner_up_team_id)
);

CREATE INDEX final_predictions_champion_idx       ON final_predictions(champion_team_id)       WHERE champion_team_id       IS NOT NULL;
CREATE INDEX final_predictions_runner_up_idx      ON final_predictions(runner_up_team_id)      WHERE runner_up_team_id      IS NOT NULL;
CREATE INDEX final_predictions_top_scorer_idx     ON final_predictions(top_scorer_player_id)   WHERE top_scorer_player_id   IS NOT NULL;
CREATE INDEX final_predictions_best_player_idx    ON final_predictions(best_player_player_id)  WHERE best_player_player_id  IS NOT NULL;

COMMENT ON TABLE final_predictions IS
    'feature 003: one row per participant; the four tournament-wide picks (champion, runner-up, top scorer, best player). Locks at first non-cancelled kickoff (BR-LOCK-005).';
