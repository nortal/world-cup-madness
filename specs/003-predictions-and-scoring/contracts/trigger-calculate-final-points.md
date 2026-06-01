# Trigger function: `calculate_final_points(p_participant_id UUID DEFAULT NULL)`

**Purpose**: Compute and persist the final-prediction `score_events` rows. Two trigger paths feed it: (a) `tournament_config` UPDATE → full sweep (`p_participant_id IS NULL`); (b) `final_predictions` UPDATE (including FK cascade `SET NULL` from a player delete) → single participant rebuild.

**FR coverage**: FR-P17, FR-P08, FR-P11 (player picker is gated by data presence, not by this function — but the function correctly handles NULL picks).

## Signature

```sql
calculate_final_points(p_participant_id UUID DEFAULT NULL) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
```

## Callers

- **Trigger** `calculate_final_points_full_sweep_trigger` invoked by `tournament_config` AFTER UPDATE FOR EACH ROW WHEN any of the 4 winner columns changed → calls `calculate_final_points(NULL)` (full sweep).
- **Trigger** `calculate_final_points_single_trigger` invoked by `final_predictions` AFTER UPDATE FOR EACH ROW WHEN any of the 4 pick columns changed (includes FK cascade `SET NULL`) → calls `calculate_final_points(NEW.participant_id)`.
- **Future**: `recalculate_all_scores()` may extend to also call `calculate_final_points(NULL)` at the end of its match loop (deferred decision; not in scope for feature 003).

## Behaviour

### Step 1 — Load winners

```sql
SELECT champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id
    INTO v_config
    FROM tournament_config
    LIMIT 1;
```

### Step 2 — DELETE existing final-source rows

Scoped to a single participant if provided, else all:

```sql
DELETE FROM score_events
    WHERE source IN (
        'final-champion', 'final-runner-up',
        'final-top-scorer', 'final-best-player',
        'final-not-picked-champion', 'final-not-picked-runner-up',
        'final-not-picked-top-scorer', 'final-not-picked-best-player'
    )
    AND (p_participant_id IS NULL OR participant_id = p_participant_id);
```

### Step 3 — INSERT fresh rows (4 sources per participant)

For brevity, the migration spells out four similar `INSERT ... SELECT` blocks (one per item). Pattern for the champion item:

```sql
INSERT INTO score_events (participant_id, source, points)
    SELECT
        p.id,
        CASE
            WHEN fp.champion_team_id IS NULL                         THEN 'final-not-picked-champion'
            ELSE                                                          'final-champion'
        END :: score_event_source,
        CASE
            WHEN fp.champion_team_id IS NULL                         THEN 0
            WHEN fp.champion_team_id = v_config.champion_team_id
                 AND v_config.champion_team_id IS NOT NULL           THEN 20
            ELSE                                                          0  -- incorrect pick
        END
    FROM participants p
    LEFT JOIN final_predictions fp ON fp.participant_id = p.id
    WHERE p.status = 'active'
    AND (p_participant_id IS NULL OR p.id = p_participant_id);
```

Repeat for `runner_up`, `top_scorer`, `best_player`. Total: 4 INSERTs writing N rows each (N = 1 if scoped, else active participant count).

**Why split into 4 INSERTs instead of one UNION ALL:** the source enum value differs per item; cleaner to keep each branch readable. Performance is fine — each INSERT is ~200 rows max, indexed by participant_id.

### Step 4 — Audit emit

```sql
GET DIAGNOSTICS v_count = ROW_COUNT;  -- captures count from the LAST insert; total = v_count * 4

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
            'scope', CASE WHEN p_participant_id IS NULL THEN 'full-sweep' ELSE 'single-participant' END,
            'affected_rows', v_count * 4
        )
    );
```

## Side effects

- Writes 0 or 4×N rows to `score_events` (N = scope: 1 if single participant, count(active) if full sweep).
- Writes 1 row to `audit_log` per invocation.
- Does NOT write to `scoring_runs`. Final-scoring is trigger-driven only; observability lives in audit_log + the source UPDATE's audit row.

## Edge case: FK cascade from `players` delete

When `DELETE FROM players WHERE id = $X` cascades `ON DELETE SET NULL` into `final_predictions.top_scorer_player_id` (or `best_player_player_id`), the cascade fires `AFTER UPDATE ON final_predictions FOR EACH ROW`. Per R-6, the trigger sees `NEW` with the post-cascade NULL value. `calculate_final_points(NEW.participant_id)` then:
- DELETEs the old `final-top-scorer` row (worth 20 if correct, 0 if incorrect).
- INSERTs a new `final-not-picked-top-scorer` row (worth 0).
- Net effect: a participant who picked the deleted player and would have won 20 now drops to 0 for that item.

UI surface (per spec.md §3 Edge Cases): "Your top-scorer pick is no longer in any squad — please pick again before first kickoff."

## Tests

- pgTAP `016_final_scoring_trigger.sql`:
  - Seeds tournament_config with all 4 winners + 3 participants with various pick combinations.
  - Asserts each correct pick → 20 points with the right source; incorrect pick → 0 points; NULL pick → `final-not-picked-<item>` 0 points.
  - Asserts FK cascade: DELETE a player; assert the participant's `final-top-scorer` row is rebuilt as `final-not-picked-top-scorer`.
  - Asserts single-participant scope: UPDATE one participant's final_predictions row; assert ONLY that participant's rows rebuild; other participants' rows untouched.
  - Asserts full-sweep scope: UPDATE tournament_config.champion_team_id; assert ALL active participants' `final-champion` rows rebuild.
  - Asserts idempotency: re-fire with unchanged state → row count + points identical.
