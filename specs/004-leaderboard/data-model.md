# Data Model: Leaderboard

**Feature**: `004-leaderboard` | **Date**: 2026-06-01 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

This document specifies every new materialised view, RPC, function, audit event variant, and cron schedule introduced by feature 004. Migrations 0032-0035 implement what's described here.

---

## 1. Migration overview

| Migration | Scope |
|---|---|
| **0032** | Create `leaderboard_snapshots` materialised view (R-8 UNION ALL shape), unique + secondary indexes, enable RLS, define policies + grants (R-3), create `leaderboard_self` view |
| **0033** | Add `leaderboard.refresh` + `leaderboard.refresh_failed` to `audit_log.event_type` enum; create `should_refresh_leaderboard()` predicate (R-5); create `refresh_leaderboard()` RPC (R-1 + R-2) |
| **0034** | Extend feature 003's `calculate_match_points()`, `calculate_final_points()`, `recalculate_all_scores()` by appending one exception-trapped `PERFORM refresh_leaderboard();` block |
| **0035** | Schedule the `leaderboard-refresh-tick` cron job (R-5) |

---

## 2. `leaderboard_snapshots` materialised view

### 2.1 Definition (R-8)

```sql
CREATE MATERIALIZED VIEW leaderboard_snapshots AS
WITH all_stage AS (
    SELECT
        p.id AS participant_id, 'all'::TEXT AS stage, p.display_name,
        COALESCE(SUM(se.points), 0)::INTEGER AS total_points,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact' THEN 1 ELSE 0 END), 0)::INTEGER AS exact_hits,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome' THEN 1 ELSE 0 END), 0)::INTEGER AS outcome_hits,
        COALESCE(SUM(CASE WHEN se.source LIKE 'final-%' THEN se.points ELSE 0 END), 0)::INTEGER AS final_points
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    WHERE p.status = 'active'
    GROUP BY p.id, p.display_name
),
group_stage AS (
    SELECT
        p.id, 'group'::TEXT, p.display_name,
        COALESCE(SUM(se.points), 0)::INTEGER,
        COALESCE(SUM(CASE WHEN se.source = 'match-exact' THEN 1 ELSE 0 END), 0)::INTEGER,
        COALESCE(SUM(CASE WHEN se.source = 'match-outcome' THEN 1 ELSE 0 END), 0)::INTEGER,
        0::INTEGER  -- FC-L4: finals excluded from stage-specific rows
    FROM participants p
    LEFT JOIN score_events se ON se.participant_id = p.id
    LEFT JOIN matches m ON se.match_id = m.id
    WHERE p.status = 'active'
      AND (se.source IS NULL OR (se.source LIKE 'match-%' AND m.stage = 'group'))
    GROUP BY p.id, p.display_name
),
-- r16_stage, quarter_stage, semi_stage, final_stage: identical shape, different m.stage filter
combined AS (
    SELECT * FROM all_stage
    UNION ALL SELECT * FROM group_stage
    UNION ALL SELECT * FROM r16_stage
    UNION ALL SELECT * FROM quarter_stage
    UNION ALL SELECT * FROM semi_stage
    UNION ALL SELECT * FROM final_stage
)
SELECT
    participant_id, stage, display_name,
    total_points, exact_hits, outcome_hits, final_points,
    RANK() OVER (
        PARTITION BY stage
        ORDER BY total_points DESC, exact_hits DESC, outcome_hits DESC, final_points DESC
    ) AS rank,
    (COUNT(*) OVER (
        PARTITION BY stage, total_points, exact_hits, outcome_hits, final_points
    ) > 1) AS rank_is_shared
FROM combined;
```

### 2.2 Column types

| Column | Type | NOT NULL | Notes |
|---|---|---|---|
| `participant_id` | UUID | YES | FK to `participants(id)` (logical; no constraint on MV) |
| `stage` | TEXT | YES | One of `'all'`, `'group'`, `'r16'`, `'quarter'`, `'semi'`, `'final'` |
| `display_name` | TEXT | YES | Carried over from `participants.display_name` |
| `total_points` | INTEGER | YES | Sum of points in scope; 0 for active participants with no `score_events` yet |
| `exact_hits` | INTEGER | YES | Count of `source = 'match-exact'` rows in scope |
| `outcome_hits` | INTEGER | YES | Count of `source = 'match-outcome'` rows in scope |
| `final_points` | INTEGER | YES | Sum of `source LIKE 'final-%'` points (always 0 for non-`'all'` rows per FC-L4) |
| `rank` | INTEGER | YES | `RANK()` window function value (R-4) |
| `rank_is_shared` | BOOLEAN | YES | True when at least one other row shares the same (stage, total, exact, outcome, final) tuple. UI uses this to render the `=` suffix without a self-join. |

### 2.3 Indexes

```sql
-- Required by REFRESH MATERIALIZED VIEW CONCURRENTLY (R-1):
CREATE UNIQUE INDEX leaderboard_snapshots_pk
    ON leaderboard_snapshots (participant_id, stage);

-- Page-load index for `WHERE stage = $1 ORDER BY rank LIMIT 25 OFFSET $2`:
CREATE INDEX leaderboard_snapshots_stage_rank
    ON leaderboard_snapshots (stage, rank);
```

### 2.4 RLS policies (R-3)

```sql
ALTER MATERIALIZED VIEW leaderboard_snapshots ENABLE ROW LEVEL SECURITY;

-- Public-projection read: any authenticated active participant can SELECT
-- the public columns of any row.
CREATE POLICY leaderboard_snapshots_select_public
    ON leaderboard_snapshots
    FOR SELECT
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM participants
            WHERE participants.auth_user_id = auth.uid()
              AND participants.status = 'active'
        )
    );

-- Column-level GRANT: the private columns are NOT selectable by `authenticated`.
-- Postgres returns `permission denied for column ...` if the client requests them.
REVOKE ALL ON leaderboard_snapshots FROM authenticated;
GRANT SELECT (participant_id, stage, display_name, total_points, rank, rank_is_shared)
    ON leaderboard_snapshots TO authenticated;

-- Self-row view: gives the participant full-row access to their own data,
-- including private columns (exact_hits / outcome_hits / final_points).
CREATE VIEW leaderboard_self AS
    SELECT * FROM leaderboard_snapshots
    WHERE participant_id = (
        SELECT id FROM participants WHERE auth_user_id = auth.uid()
    );

GRANT SELECT ON leaderboard_self TO authenticated;
```

**Notes**:
- Admin parity (FC-L6): admins are matched by the same `participants` join; the RLS policy does not branch on role. Admins see exactly the same surface.
- Column-level GRANT is the primary privacy mechanism (NFR-L6). RLS is defence-in-depth. pgTAP `021_*.sql` verifies BOTH: SELECT on private columns from a non-self row → `permission denied`; SELECT via `leaderboard_self` for the self row → success.

---

## 3. `refresh_leaderboard()` RPC

### 3.1 Signature + GRANT

```sql
CREATE OR REPLACE FUNCTION refresh_leaderboard()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ ... $$;

REVOKE ALL ON FUNCTION refresh_leaderboard() FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION refresh_leaderboard() TO postgres;
-- (postgres role covers both the admin RPC caller AND the pg_cron job invocation.)
```

The admin gating happens INSIDE the function body (see §3.2). The function is also invoked directly from scoring triggers (feature 003 functions) and from the pg_cron schedule — both run as the function owner (postgres) and skip the admin gate.

### 3.2 Body (pseudo-code; final form in migration 0033)

```sql
DECLARE
    v_caller_kind   TEXT;                       -- 'admin' | 'trigger' | 'cron'
    v_started_at    TIMESTAMPTZ := now();
    v_duration_ms   INTEGER;
    v_participants  INTEGER;
    v_scoring_run   UUID := current_setting('app.scoring_run_id', true)::UUID;
BEGIN
    -- Identify caller kind via GUCs set by the invoking context:
    IF current_setting('app.cron_caller', true) = 'true' THEN
        v_caller_kind := 'cron';
    ELSIF v_scoring_run IS NOT NULL THEN
        v_caller_kind := 'trigger';
    ELSE
        -- Admin-direct invocation: enforce admin gate
        IF NOT is_admin_user() THEN
            RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
        END IF;
        v_caller_kind := 'admin';
    END IF;

    -- Cron gating short-circuit (FR-L21 + FR-L22):
    IF v_caller_kind = 'cron' AND NOT should_refresh_leaderboard() THEN
        RETURN jsonb_build_object('outcome', 'skipped', 'reason', 'gated');
    END IF;

    -- Heavy lifting:
    REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;

    v_duration_ms := EXTRACT(MILLISECOND FROM (now() - v_started_at))::INTEGER;
    SELECT count(DISTINCT participant_id) INTO v_participants FROM leaderboard_snapshots;

    INSERT INTO audit_log (event_type, entity_type, entity_id, new_value, actor_id)
    VALUES (
        'leaderboard.refresh',
        'leaderboard_snapshots',
        NULL,
        jsonb_build_object(
            'caller_kind', v_caller_kind,
            'duration_ms', v_duration_ms,
            'participant_count', v_participants,
            'scoring_run_id', v_scoring_run
        ),
        NULL  -- system action; not attributable to a user
    );

    RETURN jsonb_build_object(
        'outcome', 'success',
        'duration_ms', v_duration_ms,
        'participant_count', v_participants
    );

EXCEPTION WHEN OTHERS THEN
    -- Decoupled failure handling (FC-L2):
    INSERT INTO audit_log (event_type, entity_type, entity_id, new_value, actor_id)
    VALUES (
        'leaderboard.refresh_failed',
        'leaderboard_snapshots',
        NULL,
        jsonb_build_object(
            'caller_kind', v_caller_kind,
            'sqlstate', SQLSTATE,
            'sqlerrm', SQLERRM,
            'scoring_run_id', v_scoring_run
        ),
        NULL
    );

    RETURN jsonb_build_object(
        'outcome', 'error',
        'sqlstate', SQLSTATE,
        'sqlerrm', SQLERRM
    );
END;
```

### 3.3 Idempotency + concurrency

- Postgres serialises `REFRESH MATERIALIZED VIEW CONCURRENTLY` on the same MV. A second concurrent caller queues until the first completes (typically < 500 ms). No app-level mutex required (R-1, FC-L1).
- The function is idempotent: invoking it N times in succession produces the same MV state at the end and N audit rows (one per call).

---

## 4. `should_refresh_leaderboard()` predicate (R-5)

```sql
CREATE OR REPLACE FUNCTION should_refresh_leaderboard()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    -- FR-L22: pre-tournament short-circuit
    IF NOT EXISTS (SELECT 1 FROM score_events LIMIT 1) THEN
        RETURN false;
    END IF;

    -- Match-window: any non-cancelled match within now() ± 90 min
    IF EXISTS (
        SELECT 1 FROM matches
        WHERE status != 'cancelled'
          AND kickoff_utc BETWEEN now() - interval '90 minutes' AND now() + interval '90 minutes'
    ) THEN
        RETURN true;
    END IF;

    -- Quiet-period: refresh if the last successful refresh is older than 60 min
    -- (or if no successful refresh exists yet).
    RETURN COALESCE(
        (SELECT max(created_at) FROM audit_log WHERE event_type = 'leaderboard.refresh')
            < now() - interval '60 minutes',
        true  -- no prior refresh → do one
    );
END;
$$;

REVOKE ALL ON FUNCTION should_refresh_leaderboard() FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION should_refresh_leaderboard() TO postgres;
```

`STABLE`: declares that the function returns the same result within a single SQL statement (acceptable here because the function is consulted at most once per call).

---

## 5. Scoring trigger extensions (migration 0034)

Each of feature 003's scoring functions gains a single exception-trapped tail block. Pseudo-diff:

```sql
-- BEFORE (feature 003):
CREATE OR REPLACE FUNCTION calculate_match_points(p_match_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    -- ... feature 003 body (DELETE-then-INSERT score_events) ...
END;
$$;

-- AFTER (feature 004 extension):
CREATE OR REPLACE FUNCTION calculate_match_points(p_match_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    -- ... feature 003 body unchanged ...

    -- Feature 004: refresh leaderboard MV. Failure is decoupled (FC-L2);
    -- the refresh writes its own audit row on either path, so this outer
    -- EXCEPTION block has nothing to do beyond swallowing the throw.
    BEGIN
        PERFORM refresh_leaderboard();
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
END;
$$;
```

Identical one-line extension applied to:
- `calculate_final_points()` (feature 003 migration 0026 — both `tournament_config` + `final_predictions` trigger paths)
- `recalculate_all_scores()` (feature 003 migration 0027 — after the per-match loop completes)

**Test coverage (pgTAP `024_*.sql`)**:
- After a successful `match_results` UPDATE that triggers `calculate_match_points()` → MV reflects new scores AND `audit_log` has one `leaderboard.refresh` row.
- After a failed refresh (simulated by `DROP INDEX leaderboard_snapshots_pk` to force REFRESH CONCURRENTLY to fail) → scoring transaction commits, `score_events` reflects new state, MV is stale, AND `audit_log` has one `leaderboard.refresh_failed` row.

---

## 6. `audit_log.event_type` additions (migration 0033)

The existing `event_type` field is a TEXT column with a CHECK constraint enumerating allowed values (feature 001 migration 0005). Migration 0033 ALTERs that CHECK to add two values:

```sql
ALTER TABLE audit_log DROP CONSTRAINT audit_log_event_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_event_type_check
    CHECK (event_type IN (
        -- ... existing values from features 001/002/003 ...
        'leaderboard.refresh',
        'leaderboard.refresh_failed'
    ));
```

### 6.1 `leaderboard.refresh` row shape

| Column | Value |
|---|---|
| `event_type` | `'leaderboard.refresh'` |
| `entity_type` | `'leaderboard_snapshots'` |
| `entity_id` | NULL (the MV has no row-level identity) |
| `actor_id` | NULL (system action) |
| `new_value` | JSONB: `{caller_kind: 'admin' | 'trigger' | 'cron', duration_ms: INTEGER, participant_count: INTEGER, scoring_run_id: UUID?}` |
| `created_at` | DEFAULT now() |

### 6.2 `leaderboard.refresh_failed` row shape

| Column | Value |
|---|---|
| `event_type` | `'leaderboard.refresh_failed'` |
| `entity_type` | `'leaderboard_snapshots'` |
| `entity_id` | NULL |
| `actor_id` | NULL |
| `new_value` | JSONB: `{caller_kind: ..., sqlstate: TEXT, sqlerrm: TEXT, scoring_run_id: UUID?}` |
| `created_at` | DEFAULT now() |

`scoring_run_id` is NULL when the refresh was initiated by cron or admin (no scoring run in scope); it's set when the refresh was initiated by a scoring trigger.

---

## 7. `pg_cron` schedule (migration 0035)

```sql
SELECT cron.schedule(
    'leaderboard-refresh-tick',
    '*/5 * * * *',
    $$
        SET LOCAL app.cron_caller = 'true';
        SELECT refresh_leaderboard();
    $$
);
```

The schedule runs every 5 minutes. The `SET LOCAL app.cron_caller = 'true'` GUC informs `refresh_leaderboard()` to consult `should_refresh_leaderboard()` for gating (R-5).

**Verification**: `SELECT jobid, schedule, command, active FROM cron.job WHERE jobname = 'leaderboard-refresh-tick';` should return one active row.

---

## 8. Read-path query shapes

The page + widget compose 3 read patterns. All three are RLS-bound (FR-L02 / NFR-L6).

### 8.1 Page first paint (server component)

```sql
-- Public projection for paginated list at active stage + page:
SELECT participant_id, display_name, rank, rank_is_shared, total_points
FROM leaderboard_snapshots
WHERE stage = $1            -- 'all' | 'group' | ...
ORDER BY rank, display_name
LIMIT 25 OFFSET $2;

-- Plus self row's full projection (for header callout):
SELECT participant_id, stage, total_points, exact_hits, outcome_hits, final_points, rank, rank_is_shared
FROM leaderboard_self
WHERE stage = $1;
```

### 8.2 Realtime re-fetch on `leaderboard.refresh` event

```sql
-- Identical to §8.1 — re-runs and the Client Component diffs.
SELECT participant_id, display_name, rank, rank_is_shared, total_points
FROM leaderboard_snapshots
WHERE stage = $1
ORDER BY rank, display_name
LIMIT 25 OFFSET $2;
```

### 8.3 Dashboard widget (server initial + client re-fetch)

```sql
SELECT rank, total_points, rank_is_shared
FROM leaderboard_self
WHERE stage = 'all';
```

---

## 9. Data lifecycle + edge cases

| Scenario | Behaviour |
|---|---|
| Pre-tournament (no `score_events` row) | `should_refresh_leaderboard()` returns false → cron skips → MV remains empty. Page renders `<EmptyLeaderboardState/>` (FR-L07). |
| New participant activated mid-tournament | Next refresh (cron tick or scoring run) picks them up via the `LEFT JOIN` against `participants WHERE status='active'`. They appear at 0 points + last rank (FR-L01). |
| Participant deactivated | Next refresh drops them from the MV (the WHERE `status='active'` filter excludes them). Their historical `score_events` rows are preserved for audit. |
| Tournament cancellation of a match | Match-cancelled rows in `score_events` (source='match-cancelled') award 0 points to everyone; they don't move ranks. |
| Concurrent admin recalc + scoring trigger | Each call to `refresh_leaderboard()` is serialised at the `REFRESH CONCURRENTLY` level by Postgres. Two callers run sequentially; both produce audit rows. |
| Refresh failure (e.g. disk full) | EXCEPTION block writes `leaderboard.refresh_failed` audit row. The scoring transaction (if any) STILL commits per FC-L2. Cron retries every 5 min in match windows. |
| Realtime subscriber connecting at startup | Server-renders the current state on first paint; client subscription opens immediately and replays the next event whenever it lands. No backfill of missed events needed (the next event always carries the latest authoritative state). |
| Stage with no finished matches yet | The stage's CTE returns one row per active participant with `total_points=0`, ranked alphabetically (the tie-breaker chain collapses to the implicit ORDER BY participant_id from RANK). `<EmptyLeaderboardState/>` is rendered when the stage's only "finished match count" is 0 (UI-side decision). |

---

## 10. Constraints summary (carry-forward into Phase 2 tasks)

- **FC-L1**: One read surface — every query targets `leaderboard_snapshots` or `leaderboard_self`. Never `score_events` directly for ranking.
- **FC-L2**: Refresh failure decoupled from scoring commit — verified by pgTAP `024_*.sql`.
- **FC-L3**: Realtime subscription targets `audit_log` events, never `score_events` or the MV directly.
- **FC-L4**: Stage-specific rows have `final_points = 0` (FC-L4 expressed structurally in the MV definition).
- **FC-L5**: MV stores four tie-breaker columns + `rank` + `rank_is_shared`; no #5 column.
- **FC-L6**: Admin sees the same RLS-applied surface as participants. The RLS policy does not branch on role.
