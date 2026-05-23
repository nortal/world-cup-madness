-- Migration: extend tournament_config with 4 winner FK columns (feature 003, T006)
--
-- Per data-model.md §2. Singleton row; admin sets each column via the
-- set_tournament_winner RPC (migration 0028) as official winners are
-- announced. AFTER UPDATE trigger (migration 0031) re-fires
-- calculate_final_points(NULL) → full sweep across every active
-- participant's final-* score_events rows.
--
-- All FKs ON DELETE SET NULL: if a team or player is later purged, the
-- pick clears. The trigger re-fires with NULL winner → every participant's
-- corresponding final-* row rebuilds as a 0-point row.
--
-- Champion ≠ runner-up enforced via CHECK constraint (mirrors the
-- final_predictions CHECK in migration 0022).

ALTER TABLE tournament_config
    ADD COLUMN champion_team_id        UUID REFERENCES teams(id)   ON DELETE SET NULL,
    ADD COLUMN runner_up_team_id       UUID REFERENCES teams(id)   ON DELETE SET NULL,
    ADD COLUMN top_scorer_player_id    UUID REFERENCES players(id) ON DELETE SET NULL,
    ADD COLUMN best_player_player_id   UUID REFERENCES players(id) ON DELETE SET NULL;

ALTER TABLE tournament_config
    ADD CONSTRAINT tournament_config_winners_champion_distinct_runner_up
        CHECK (champion_team_id IS NULL
               OR runner_up_team_id IS NULL
               OR champion_team_id <> runner_up_team_id);
