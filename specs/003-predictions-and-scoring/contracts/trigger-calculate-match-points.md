# Trigger function: `calculate_match_points(p_match_id UUID)`

**Purpose**: Compute and persist the match-scoring `score_events` rows for one match. Called by the `match_results` AFTER INSERT/UPDATE trigger (per-match path) and by `recalculate_all_scores()` (full-recalc path). DELETE-then-INSERT inside one transaction implements the at-most-one-row-per-(participant, match) contract from Clarify Q1.

**FR coverage**: FR-P12, FR-P13, FR-P14, FR-P15, FR-P16, FR-P24.

## Signature

```sql
calculate_match_points(p_match_id UUID) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
```

## Callers

- **Trigger wrapper** `calculate_match_points_trigger()` invoked by `match_results` AFTER INSERT OR UPDATE FOR EACH ROW WHEN status IN ('finished', 'cancelled') AND (status='cancelled' OR (score_home IS NOT NULL AND score_away IS NOT NULL))`.
- **Admin RPC** `recalculate_all_scores()` invokes `PERFORM calculate_match_points(v_match.id)` per match in a loop.

## Authorisation

- No GRANT to `authenticated`. Only the function owner (typically `postgres` or a dedicated `scoring_role`) can call. SECURITY DEFINER lets the trigger run as the owner regardless of who fired the source UPDATE.
- The wrapping trigger fires under the privileges of the user who updated `match_results` — that user does NOT need INSERT on `score_events` because the SECURITY DEFINER function elevates.

## Behaviour

### Step 1 — Load match

```sql
SELECT id, status, score_home, score_away
    INTO v_match
    FROM matches
    WHERE id = p_match_id
    FOR SHARE;
```

`FOR SHARE` blocks concurrent UPDATE on this match row but allows other reads. Prevents two trigger invocations from racing on the same match.

If `NOT FOUND`: `RAISE EXCEPTION 'match % not found in calculate_match_points', p_match_id;` — surface a clear error in `scoring_runs.error_message` (the admin RPC will catch this and write the row).

### Step 2 — DELETE existing rows

```sql
DELETE FROM score_events
    WHERE match_id = p_match_id
    AND source IN ('match-exact', 'match-outcome', 'match-wrong', 'no-prediction', 'match-cancelled');
```

Removes every prior match-scoring row for this match across all participants. Final-source rows (`final-*`) are out of scope here.

### Step 3 — INSERT fresh rows (branched on status)

**Cancelled match path:**

```sql
IF v_match.status = 'cancelled' THEN
    INSERT INTO score_events (participant_id, match_id, source, points)
        SELECT id, p_match_id, 'match-cancelled', 0
        FROM participants
        WHERE status = 'active';
END IF;
```

Every active participant gets one row with `points=0, source='match-cancelled'`.

**Finished match path:**

```sql
ELSIF v_match.status = 'finished'
      AND v_match.score_home IS NOT NULL
      AND v_match.score_away IS NOT NULL THEN
    INSERT INTO score_events (participant_id, match_id, source, points)
        SELECT
            p.id,
            p_match_id,
            <CASE expression for source enum>,
            <CASE expression for points>
        FROM participants p
        LEFT JOIN predictions pr ON pr.participant_id = p.id AND pr.match_id = p_match_id
        WHERE p.status = 'active';
END IF;
```

The CASE expressions:

```sql
-- source
CASE
    WHEN pr.id IS NULL                                         THEN 'no-prediction'
    WHEN pr.predicted_home_score = v_match.score_home
         AND pr.predicted_away_score = v_match.score_away      THEN 'match-exact'
    WHEN sign(pr.predicted_home_score - pr.predicted_away_score)
         = sign(v_match.score_home - v_match.score_away)       THEN 'match-outcome'
    ELSE                                                            'match-wrong'
END :: score_event_source

-- points
CASE
    WHEN pr.id IS NULL                                         THEN 0
    WHEN pr.predicted_home_score = v_match.score_home
         AND pr.predicted_away_score = v_match.score_away      THEN 10
    WHEN sign(pr.predicted_home_score - pr.predicted_away_score)
         = sign(v_match.score_home - v_match.score_away)       THEN 5
    ELSE                                                            0
END
```

`sign(int)` returns -1, 0, or 1 — equal signs ↔ same outcome (home win / away win / draw).

### Step 4 — Audit emit

```sql
GET DIAGNOSTICS v_count = ROW_COUNT;

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
```

The audit row captures the result of the scoring run for this match. The `payload` JSON is small and bounded.

### Step 5 — Return

`RETURN;` (void return; trigger continues with NEW row).

## Idempotency

Running the function twice with unchanged inputs produces the same final state:
- First run: DELETE 0 rows + INSERT N rows.
- Second run: DELETE N rows + INSERT N rows. Total row count after second run is identical; `points` values identical; only `awarded_at` timestamp and PK refresh.

The functional state (sum of points per participant, source per row) is identical. This is the contract TC-P17 verifies.

## Atomicity

Inside the function, DELETE + INSERT are in one implicit transaction (the function call is one statement; PL/pgSQL wraps it). From any other reader's perspective (READ COMMITTED isolation default), the changes appear atomically at the outer transaction's commit time. No reader can observe the intermediate "0 rows for this match" state. (R-3 in research.md.)

## Performance

- ~200 participant rows max per match. Single sequential scan over `participants` (small table, fits in shared_buffers) + nested loop on `predictions` (indexed by `(participant_id, match_id)`). Expected ~30-50 ms per match.
- NFR-P2 budget: ≤ 5 seconds per match. Well clear.

## Tests

- pgTAP `015_match_scoring_trigger.sql`:
  - Seeds 1 match + 200 participants + mixed predictions. Asserts trigger fires once on `match_results` UPDATE; asserts each source / points combination correct.
  - Asserts no-prediction case writes `points=0, source='no-prediction'`.
  - Asserts cancelled match path writes `points=0, source='match-cancelled'` for everyone.
  - Asserts DELETE-then-INSERT atomicity from a parallel session (introduces a controlled delay between DELETE and INSERT via a CTE; confirms reader sees pre-state until commit).
  - Asserts trigger does NOT fire when status='live' (intermediate score updates shouldn't cause scoring).
  - Capacity test: 200 participants, asserts trigger completes < 5 seconds.

## Side effects

- Writes 0 or N rows to `score_events` (N = active participant count).
- Writes 1 row to `audit_log`.
- Does NOT write to `scoring_runs` directly. The per-match trigger path's observability is the audit_log row + the source UPDATE's audit row. Scoring_runs is reserved for the `admin-recalc-all` path which writes one row per RPC invocation (the loop's per-match runs are children).
