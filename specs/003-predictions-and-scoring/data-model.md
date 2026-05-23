# Data Model: Predictions and Scoring

**Feature**: `003-predictions-and-scoring` | **Date**: 2026-05-22 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

This document specifies every new table, view, column, constraint, index, RLS policy, function, and trigger introduced by feature 003. Migrations 0019-0028 implement what's described here.

---

## 1. New tables

### 1.1 `predictions` — match-score predictions

```sql
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
```

**Why these choices:**
- `SMALLINT` (16-bit) is more than enough for 0..20; saves 2 bytes per row vs INT. Across 20k predictions, negligible — but consistent with feature 002's `score_home/score_away` columns.
- `ON DELETE CASCADE` on both FKs: if a participant is deleted (account purge) or a match is removed (admin un-imports a fixture), their predictions go with them. Audit trail of deletions captured by the trigger from feature 001 migration 0005.
- `predictions_one_per_participant_match` enforces FR-P02 (single active prediction per participant per match). Edit history lives in `audit_log`, not in this table.
- No `version` column or optimistic locking — last-write-wins per Edge Case in spec.md §3 (concurrent tab race).

### 1.2 `final_predictions` — tournament-wide predictions

```sql
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

CREATE INDEX final_predictions_champion_idx ON final_predictions(champion_team_id) WHERE champion_team_id IS NOT NULL;
CREATE INDEX final_predictions_runner_up_idx ON final_predictions(runner_up_team_id) WHERE runner_up_team_id IS NOT NULL;
CREATE INDEX final_predictions_top_scorer_idx ON final_predictions(top_scorer_player_id) WHERE top_scorer_player_id IS NOT NULL;
CREATE INDEX final_predictions_best_player_idx ON final_predictions(best_player_player_id) WHERE best_player_player_id IS NOT NULL;
```

**Why these choices:**
- All four picks nullable — supports partial submissions (FR-P08). The CHECK accepts NULL for either champion or runner-up so a participant can submit champion first and runner-up later.
- `ON DELETE SET NULL` on the player FKs — when squad-sync removes a player (transfer/withdrawal), the participant's pick is cleared. The FK cascade fires `AFTER UPDATE` on this table, which triggers `calculate_final_points()` for the affected participant (per R-6).
- `ON DELETE SET NULL` on the team FKs — symmetric with players; if a team is later removed (very unlikely; teams seed is frozen post-draw), final-predictions cascade to NULL.
- Partial indexes (`WHERE col IS NOT NULL`) on the four pick columns — used by `calculate_final_points()` when iterating affected participants after a tournament_config winner change.

### 1.3 `players` — football players (squad sync target)

```sql
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
CREATE INDEX players_name_idx ON players(name);  -- supports the combobox filter-by-name
```

**Why these choices:**
- `provider_player_id` UNIQUE — same idempotency pattern as `teams.provider_team_id` and `matches.provider_id` from feature 002.
- `ON DELETE CASCADE` on `team_id` — if a team is purged (won't happen mid-tournament), all squad members go too.
- `position` enum bounded to football-data.org's four values (their v4 API returns these strings). NULL allowed for players whose position isn't yet recorded.
- Name index supports the player picker's combobox filter (~830 rows, but `ILIKE '%foo%'` queries benefit from a btree on lowercased name — applied via a functional index if R-7 reveals it's needed at scale; defer to implementation).

### 1.4 `score_events` — points ledger

```sql
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

-- At most one match-scoring row per (participant, match) — enforces Clarify Q1.
CREATE UNIQUE INDEX score_events_one_per_participant_match
    ON score_events (participant_id, match_id)
    WHERE match_id IS NOT NULL;

-- At most one row per (participant, final-source) — enforces single-row-per-final-pick semantic.
CREATE UNIQUE INDEX score_events_one_per_participant_final_source
    ON score_events (participant_id, source)
    WHERE match_id IS NULL;

CREATE INDEX score_events_participant_id_idx ON score_events(participant_id);
CREATE INDEX score_events_match_id_idx ON score_events(match_id) WHERE match_id IS NOT NULL;
CREATE INDEX score_events_awarded_at_idx ON score_events(awarded_at DESC);
```

**Why these choices:**
- `score_event_source` as a Postgres ENUM — enforces the spec's source vocabulary at the schema layer. Adding a new source (e.g. a future bonus type) requires `ALTER TYPE ... ADD VALUE`.
- Two partial unique indexes implement the "one row per (participant, match) for match sources; one row per (participant, source) for final sources" invariant from Clarify Q1.
- The CHECK constraint pairs source with match_id presence — match sources must have match_id; final sources must have match_id NULL. Prevents bad data even if the trigger has a bug.
- `scoring_run_id` is a soft reference (ON DELETE SET NULL) — if a scoring_runs row is purged for retention, the score_event rows survive but lose their provenance link. The points themselves remain correct.
- `points` capped at 0..20 — covers match scoring (0/5/10) and final scoring (0/20). If business ever adds a 25-pt or 30-pt scoring tier, this CHECK widens.
- No row-level audit on `score_events` directly — every write happens inside a scoring run, and the scoring_runs table + audit_log together provide the trail (the `audit_log` row tagged `scoring.match` references the scoring_run_id).

### 1.5 `scoring_runs` — operator telemetry for scoring

```sql
CREATE TYPE scoring_action AS ENUM (
    'trigger-result-update',
    'trigger-config-change',
    'trigger-cascade',
    'admin-recalc-all'
);

CREATE TYPE scoring_status AS ENUM (
    'success',
    'error',
    'skipped'
);

CREATE TABLE scoring_runs (
    id                              UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
    action                          scoring_action   NOT NULL,
    match_id                        UUID             REFERENCES matches(id) ON DELETE SET NULL,
    started_at                      TIMESTAMPTZ      NOT NULL DEFAULT now(),
    finished_at                     TIMESTAMPTZ,
    status                          scoring_status   NOT NULL DEFAULT 'success',
    affected_participants_count     INTEGER          NOT NULL DEFAULT 0,
    error_message                   TEXT,

    CONSTRAINT scoring_runs_match_required_for_per_match_actions
        CHECK (
            (action IN ('trigger-result-update', 'trigger-cascade') AND match_id IS NOT NULL)
            OR
            (action IN ('trigger-config-change', 'admin-recalc-all'))
        ),
    CONSTRAINT scoring_runs_finished_at_after_started_at
        CHECK (finished_at IS NULL OR finished_at >= started_at),
    CONSTRAINT scoring_runs_error_message_for_error_status
        CHECK ((status = 'error') = (error_message IS NOT NULL))
);

-- At most one in-flight per action — the mutex (per R-4).
CREATE UNIQUE INDEX scoring_runs_at_most_one_in_flight_per_action
    ON scoring_runs (action)
    WHERE finished_at IS NULL;

CREATE INDEX scoring_runs_started_at_idx ON scoring_runs(started_at DESC);
CREATE INDEX scoring_runs_status_started_at_idx ON scoring_runs(action, status, started_at DESC);
```

**Why these choices:**
- `action` enum — bounded to the four current actions; admin recalc + the three trigger paths. New actions land via `ALTER TYPE`.
- `match_id` nullable but constrained by the CHECK — per-match triggers must reference a match; config-change and admin-recalc-all are tournament-wide.
- The partial unique index `WHERE finished_at IS NULL` is the per-action mutex from R-4. The trigger paths don't write `scoring_runs` rows (they're transactional with the source UPDATE), so the mutex really only governs `admin-recalc-all`. Future scoring actions get free serialisation by virtue of the index.
- `error_message` constrained to be present iff status='error' — keeps the audit story clean.
- Same index family as feature 002's `integration_runs` so operators have consistent query ergonomics.

---

## 2. Extended table: `tournament_config`

Add four nullable FK columns for the official tournament winners:

```sql
ALTER TABLE tournament_config
    ADD COLUMN champion_team_id        UUID REFERENCES teams(id) ON DELETE SET NULL,
    ADD COLUMN runner_up_team_id       UUID REFERENCES teams(id) ON DELETE SET NULL,
    ADD COLUMN top_scorer_player_id    UUID REFERENCES players(id) ON DELETE SET NULL,
    ADD COLUMN best_player_player_id   UUID REFERENCES players(id) ON DELETE SET NULL;

ALTER TABLE tournament_config
    ADD CONSTRAINT tournament_config_winners_champion_distinct_runner_up
        CHECK (champion_team_id IS NULL
               OR runner_up_team_id IS NULL
               OR champion_team_id <> runner_up_team_id);
```

**Why these choices:**
- All nullable — winners are not known until tournament end. Admin sets them via `set_tournament_winner()` RPC as they're officially announced.
- `ON DELETE SET NULL` on every FK — if a team or player is later purged, the config row's pick is cleared. The trigger on this column change re-fires final scoring (everyone who picked the now-deleted player drops to 0).
- Champion ≠ runner-up enforced symmetrically with `final_predictions`.

---

## 3. New view: `all_runs`

```sql
CREATE VIEW all_runs WITH (security_invoker = true) AS
SELECT
    'integration' :: TEXT  AS run_kind,
    id,
    action :: TEXT         AS action,
    NULL :: UUID           AS match_id,
    started_at,
    finished_at,
    status :: TEXT         AS status,
    records_processed      AS affected_count,
    error_message
FROM integration_runs
UNION ALL
SELECT
    'scoring' :: TEXT      AS run_kind,
    id,
    action :: TEXT         AS action,
    match_id,
    started_at,
    finished_at,
    status :: TEXT         AS status,
    affected_participants_count   AS affected_count,
    error_message
FROM scoring_runs;
```

**Why these choices:**
- `security_invoker = true` — per R-5, applies the caller's RLS to the underlying tables. An admin sees both row sets; a non-admin sees neither.
- Discriminator column `run_kind` lets operators filter ("show me only scoring runs") without joining back to the source tables.
- Cast `action` and `status` to TEXT so the view's column types are stable across the two underlying enum types. Operator queries that filter on `action = 'admin-recalc-all'` work identically whether the underlying row is integration or scoring.
- `affected_count` unifies `records_processed` (integration_runs) and `affected_participants_count` (scoring_runs) into one operator-facing metric.
- `match_id` is NULL for every integration row (integration sync isn't per-match scoped); populated for per-match scoring rows. Lets operators filter scoring runs by match.

---

## 4. RLS policies

### 4.1 `predictions`

```sql
ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;

-- Participants read/write their own row.
CREATE POLICY predictions_select_own ON predictions
    FOR SELECT TO authenticated
    USING (participant_id IN (
        SELECT id FROM participants WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY predictions_insert_own ON predictions
    FOR INSERT TO authenticated
    WITH CHECK (participant_id IN (
        SELECT id FROM participants WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

CREATE POLICY predictions_update_own ON predictions
    FOR UPDATE TO authenticated
    USING (participant_id IN (
        SELECT id FROM participants WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

-- Admin can SELECT all (for support / triage).
CREATE POLICY predictions_select_admin ON predictions
    FOR SELECT TO authenticated
    USING (is_admin_user());
```

### 4.2 `final_predictions`

Same shape as `predictions` — participants read/write their own row; admin can SELECT all. No DELETE policy on either: predictions stay until participant deletion cascades them.

### 4.3 `players`

```sql
ALTER TABLE players ENABLE ROW LEVEL SECURITY;

-- All eligible participants can read (needed for the picker).
CREATE POLICY players_select_eligible ON players
    FOR SELECT TO authenticated
    USING (is_eligible_nortal_user());

-- No INSERT/UPDATE/DELETE policies for authenticated — only service_role (squad-sync Edge Function) can write.
```

### 4.4 `score_events`

```sql
ALTER TABLE score_events ENABLE ROW LEVEL SECURITY;

-- Participants read only their own.
CREATE POLICY score_events_select_own ON score_events
    FOR SELECT TO authenticated
    USING (participant_id IN (
        SELECT id FROM participants WHERE auth_user_id = auth.uid() AND status = 'active'
    ));

-- Admin can SELECT all.
CREATE POLICY score_events_select_admin ON score_events
    FOR SELECT TO authenticated
    USING (is_admin_user());

-- NO INSERT/UPDATE/DELETE policies for ANY authenticated role — enforces FR-P24.
-- Only SECURITY DEFINER trigger functions (running as the function owner) can write.
```

### 4.5 `scoring_runs`

```sql
ALTER TABLE scoring_runs ENABLE ROW LEVEL SECURITY;

-- Admin-only SELECT (mirrors integration_runs from feature 002).
CREATE POLICY scoring_runs_select_admin ON scoring_runs
    FOR SELECT TO authenticated
    USING (is_admin_user());

-- No INSERT/UPDATE/DELETE policies for authenticated — service_role + SECURITY DEFINER functions only.
```

The `all_runs` view inherits RLS via `security_invoker=true` — no separate policy.

---

## 5. Trigger functions

### 5.1 `calculate_match_points(p_match_id UUID)` — match scoring

```sql
CREATE OR REPLACE FUNCTION calculate_match_points(p_match_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_match           RECORD;
    v_scoring_run_id  UUID;
    v_count           INTEGER;
BEGIN
    -- 1. Load the match (status, score, kickoff). Lock the row to prevent concurrent triggers from racing.
    SELECT id, status, score_home, score_away
        INTO v_match
        FROM matches
        WHERE id = p_match_id
        FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'match % not found in calculate_match_points', p_match_id;
    END IF;

    -- 2. DELETE all existing match-scoring rows for this match (DELETE-then-INSERT semantic, per Clarify Q1).
    DELETE FROM score_events
        WHERE match_id = p_match_id
        AND source IN ('match-exact', 'match-outcome', 'match-wrong', 'no-prediction', 'match-cancelled');

    -- 3. Branch on match status.
    IF v_match.status = 'cancelled' THEN
        -- Cancelled match: 0 points to every active participant.
        INSERT INTO score_events (participant_id, match_id, source, points)
            SELECT id, p_match_id, 'match-cancelled', 0
            FROM participants
            WHERE status = 'active';

    ELSIF v_match.status = 'finished'
          AND v_match.score_home IS NOT NULL
          AND v_match.score_away IS NOT NULL THEN
        -- Finished match: compute 10 / 5 / 0 per prediction; 0 with source='no-prediction' for missing.
        INSERT INTO score_events (participant_id, match_id, source, points)
            SELECT
                p.id,
                p_match_id,
                CASE
                    WHEN pr.id IS NULL                          THEN 'no-prediction'
                    WHEN pr.predicted_home_score = v_match.score_home
                         AND pr.predicted_away_score = v_match.score_away
                                                                THEN 'match-exact'
                    WHEN sign(pr.predicted_home_score - pr.predicted_away_score)
                         = sign(v_match.score_home - v_match.score_away)
                                                                THEN 'match-outcome'
                    ELSE                                             'match-wrong'
                END :: score_event_source,
                CASE
                    WHEN pr.id IS NULL                          THEN 0
                    WHEN pr.predicted_home_score = v_match.score_home
                         AND pr.predicted_away_score = v_match.score_away
                                                                THEN 10
                    WHEN sign(pr.predicted_home_score - pr.predicted_away_score)
                         = sign(v_match.score_home - v_match.score_away)
                                                                THEN 5
                    ELSE                                             0
                END
            FROM participants p
            LEFT JOIN predictions pr ON pr.participant_id = p.id AND pr.match_id = p_match_id
            WHERE p.status = 'active';
    ELSE
        -- Not finished + not cancelled: trigger shouldn't have fired. Defensive no-op.
        RETURN;
    END IF;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- 4. Audit log row.
    INSERT INTO audit_log (action, target_table, target_id, payload)
        VALUES (
            'scoring.match',
            'matches',
            p_match_id :: TEXT,
            jsonb_build_object(
                'match_status', v_match.status,
                'score_home', v_match.score_home,
                'score_away', v_match.score_away,
                'affected_participants', v_count
            )
        );
END;
$$;

REVOKE EXECUTE ON FUNCTION calculate_match_points(UUID) FROM PUBLIC;
-- No GRANT to authenticated — only the trigger (running as the function owner) and the recalc-all RPC call this.
```

**Trigger:**

```sql
CREATE TRIGGER match_results_trigger_scoring
    AFTER INSERT OR UPDATE ON match_results
    FOR EACH ROW
    WHEN (
        NEW.status IN ('finished', 'cancelled')
        AND (
            NEW.status = 'cancelled'
            OR (NEW.score_home IS NOT NULL AND NEW.score_away IS NOT NULL)
        )
    )
    EXECUTE FUNCTION calculate_match_points_trigger();

CREATE OR REPLACE FUNCTION calculate_match_points_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM calculate_match_points(NEW.match_id);
    RETURN NEW;
END;
$$;
```

(Two-function shape: the trigger wrapper just passes `NEW.match_id` to the working function. Lets `calculate_match_points()` be called directly by `recalculate_all_scores()` without forging a fake NEW row.)

### 5.2 `calculate_final_points(p_participant_id UUID)` — final scoring

```sql
CREATE OR REPLACE FUNCTION calculate_final_points(p_participant_id UUID DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_config  RECORD;
    v_count   INTEGER;
BEGIN
    SELECT champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id
        INTO v_config
        FROM tournament_config
        LIMIT 1;

    -- DELETE all existing final-source rows (scoped to single participant if provided, else all).
    DELETE FROM score_events
        WHERE source IN (
            'final-champion', 'final-runner-up', 'final-top-scorer', 'final-best-player',
            'final-not-picked-champion', 'final-not-picked-runner-up',
            'final-not-picked-top-scorer', 'final-not-picked-best-player'
        )
        AND (p_participant_id IS NULL OR participant_id = p_participant_id);

    -- INSERT fresh rows for every active participant (or just the one specified).
    INSERT INTO score_events (participant_id, source, points)
        SELECT
            p.id,
            CASE
                WHEN fp.champion_team_id IS NULL                              THEN 'final-not-picked-champion'
                WHEN fp.champion_team_id = v_config.champion_team_id
                     AND v_config.champion_team_id IS NOT NULL               THEN 'final-champion'
                ELSE                                                              'final-champion'  -- award 0 for incorrect pick
            END :: score_event_source,
            CASE
                WHEN fp.champion_team_id IS NULL                              THEN 0
                WHEN fp.champion_team_id = v_config.champion_team_id
                     AND v_config.champion_team_id IS NOT NULL               THEN 20
                ELSE                                                              0
            END
        FROM participants p
        LEFT JOIN final_predictions fp ON fp.participant_id = p.id
        WHERE p.status = 'active'
        AND (p_participant_id IS NULL OR p.id = p_participant_id)
    UNION ALL
        -- ... three more SELECT blocks for runner_up, top_scorer, best_player ...
    ;
    -- (The actual migration will spell out all four items; truncated here for spec readability.)

    GET DIAGNOSTICS v_count = ROW_COUNT;

    INSERT INTO audit_log (action, target_table, target_id, payload)
        VALUES (
            'scoring.final',
            'tournament_config',
            COALESCE(p_participant_id :: TEXT, '<full-sweep>'),
            jsonb_build_object(
                'champion_set', v_config.champion_team_id IS NOT NULL,
                'runner_up_set', v_config.runner_up_team_id IS NOT NULL,
                'top_scorer_set', v_config.top_scorer_player_id IS NOT NULL,
                'best_player_set', v_config.best_player_player_id IS NOT NULL,
                'affected_rows', v_count
            )
        );
END;
$$;

REVOKE EXECUTE ON FUNCTION calculate_final_points(UUID) FROM PUBLIC;
```

**Triggers:**

```sql
-- (a) tournament_config UPDATE → full sweep.
CREATE TRIGGER tournament_config_trigger_final_scoring
    AFTER UPDATE ON tournament_config
    FOR EACH ROW
    WHEN (
        NEW.champion_team_id IS DISTINCT FROM OLD.champion_team_id
        OR NEW.runner_up_team_id IS DISTINCT FROM OLD.runner_up_team_id
        OR NEW.top_scorer_player_id IS DISTINCT FROM OLD.top_scorer_player_id
        OR NEW.best_player_player_id IS DISTINCT FROM OLD.best_player_player_id
    )
    EXECUTE FUNCTION calculate_final_points_full_sweep_trigger();

CREATE OR REPLACE FUNCTION calculate_final_points_full_sweep_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM calculate_final_points(NULL);
    RETURN NEW;
END;
$$;

-- (b) final_predictions UPDATE (or FK cascade NULL-out) → single participant rebuild.
CREATE TRIGGER final_predictions_trigger_scoring
    AFTER UPDATE ON final_predictions
    FOR EACH ROW
    WHEN (
        NEW.champion_team_id IS DISTINCT FROM OLD.champion_team_id
        OR NEW.runner_up_team_id IS DISTINCT FROM OLD.runner_up_team_id
        OR NEW.top_scorer_player_id IS DISTINCT FROM OLD.top_scorer_player_id
        OR NEW.best_player_player_id IS DISTINCT FROM OLD.best_player_player_id
    )
    EXECUTE FUNCTION calculate_final_points_single_trigger();

CREATE OR REPLACE FUNCTION calculate_final_points_single_trigger()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM calculate_final_points(NEW.participant_id);
    RETURN NEW;
END;
$$;
```

(R-6 confirms FK cascade `ON DELETE SET NULL` on `players` fires this trigger correctly with NEW reflecting the post-cascade NULL value.)

---

## 6. RPCs (interface only; contracts in `contracts/`)

| RPC | Caller | Purpose |
|---|---|---|
| `submit_prediction(p_match_id, p_home, p_away)` | authenticated | Lock-check + insert/update one row in `predictions` |
| `submit_final_prediction(p_champion, p_runner_up, p_top_scorer, p_best_player)` | authenticated | Lock-check + upsert one row in `final_predictions` |
| `set_tournament_winner(p_item, p_id)` | authenticated (admin gate) | Update one column in `tournament_config`; trigger cascades final scoring |
| `recalculate_all_scores()` | authenticated (admin gate) | Per-match commit loop calling `calculate_match_points()`; mutex-protected via `scoring_runs` |

Full RPC bodies + error envelopes in `contracts/` (Phase 1).

---

## 7. State transitions (entity lifecycle)

### `predictions` row lifecycle

```
(no row)
    └── INSERT via submit_prediction()
            │ (audit_log: prediction.created)
            ▼
   (active, editable)
            │ UPDATE via submit_prediction() — kickoff_utc - now() > 60 min
            │ (audit_log: prediction.updated)
            ▼
   (active, editable)  ← repeat as needed
            │
            │ kickoff_utc - now() ≤ 60 min  (server-side gate)
            ▼
   (locked, immutable)
            │
            │ match.status → 'finished'  →  trigger fires, score_events written
            │ (audit_log: scoring.match)
            ▼
   (scored, immutable, source-of-truth for the score event)
```

### `final_predictions` row lifecycle

```
(no row)
    └── INSERT via submit_final_prediction() — any subset of 4 picks
            │ (audit_log: final_prediction.created)
            ▼
   (active, editable)
            │ UPDATE via submit_final_prediction()
            │ (audit_log: final_prediction.updated)
            ▼
   (active, editable)  ← repeat until first non-cancelled match kicks off
            │
            │ now() ≥ min(matches.kickoff_utc WHERE status != 'cancelled')
            ▼
   (locked, immutable)
            │
            │ admin sets tournament_config winners  →  trigger fires, score_events written per source
            ▼
   (scored: 4 score_events rows, one per final-source)
```

---

## 8. Migration order summary

| # | File | Purpose | Rollback safety |
|---|---|---|---|
| 0019 | create_predictions.sql | `predictions` table + indexes + CHECK constraints | DROP TABLE clean |
| 0020 | create_final_predictions.sql | `final_predictions` table + indexes + CHECK | DROP TABLE clean |
| 0021 | create_players_and_seed_columns.sql | `players` table + indexes; players seed (post squad-sync rollout) | DROP TABLE clean |
| 0022 | extend_tournament_config_winners.sql | 4 nullable FK columns + champion≠runner_up CHECK | ALTER TABLE DROP COLUMN clean |
| 0023 | create_score_events.sql | `score_event_source` ENUM; `score_events` table + indexes | DROP TABLE + DROP TYPE clean (no dependents until 0025/0026 land) |
| 0024 | create_scoring_runs_and_all_runs.sql | `scoring_action`/`scoring_status` ENUMs; `scoring_runs` table + partial unique index; `all_runs` view | DROP VIEW + DROP TABLE + DROP TYPE clean |
| 0025 | match_scoring_trigger.sql | `calculate_match_points()` function + trigger wrapper + audit emission | DROP TRIGGER + DROP FUNCTION clean |
| 0026 | final_scoring_trigger.sql | `calculate_final_points()` function + 2 triggers + audit emission | DROP TRIGGER + DROP FUNCTION clean |
| 0027 | prediction_rpcs.sql | 4 RPCs (`submit_prediction`, `submit_final_prediction`, `set_tournament_winner`, `recalculate_all_scores`) | DROP FUNCTION clean |
| 0028 | prediction_rls.sql | RLS ENABLE + policies on all 5 new tables; verify `all_runs` view inherits | DROP POLICY + DISABLE RLS clean |

Reverse order for rollback. All migrations idempotent under `npx supabase db reset`.

---

## 9. Open items for Phase 2 (implementation)

- Confirm Postgres `sign(int)` returns -1/0/1 across all rows (it does for `int`/`smallint` per Postgres docs — covered in pgTAP `015_*.sql`).
- The `audit_log` schema from feature 001 must accept the new action tags (`prediction.created`, `prediction.updated`, `final_prediction.created`, `final_prediction.updated`, `admin.match-result-override`, `admin.tournament-winner-set`, `admin.recalc-all`, `scoring.match`, `scoring.final`). Verify feature 001's check constraint allows these or extend it in migration 0027.
- `players_name_idx` may need to become a functional index (`lower(name) gin_trgm_ops`) if the picker's filter is slow at 830 rows. Defer benchmark to implementation; the migration is additive if needed.
