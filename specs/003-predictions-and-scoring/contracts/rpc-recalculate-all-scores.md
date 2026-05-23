# RPC: `recalculate_all_scores()`

**Purpose**: Admin-triggered full recalculation across every finished + cancelled match. Iterates per-match (each in its own transaction per R-2); calls `calculate_match_points(match_id)` for each. Mutex-protected via the `scoring_runs` partial-unique-index so two concurrent admin clicks don't interleave.

**FR coverage**: FR-P18, FR-P26, FR-P28.

## Signature

```sql
recalculate_all_scores() RETURNS jsonb
```

## Authorisation

- Role: `authenticated`, gated on `is_admin_user()`.
- `SECURITY DEFINER` + explicit `SET search_path = public, auth`.

## Request

No parameters.

## Response

### Success (HTTP 200) — completed run

```json
{
  "outcome": "success",
  "scoring_run_id": "01HXXXXXXXXX",
  "matches_processed": 48,
  "duration_ms": 4231
}
```

### Skipped (HTTP 200) — another recalc-all is in flight

```json
{
  "outcome": "skipped",
  "in_flight_run_id": "01HYYYYYYYYY",
  "in_flight_started_at": "2026-05-22T14:30:00+00:00"
}
```

### Error envelopes

| Condition | HTTP | code | message |
|---|---|---|---|
| Non-admin caller | 403 | `insufficient_privilege` | `FORBIDDEN` |
| Mutex race lost (rare; race between concurrent admin clicks) | 200 | — | `outcome: 'skipped'` (handled in-band) |
| Per-match scoring fails mid-loop | 200 | — | `outcome: 'error'` + scoring_run row marked `status='error'` with the offending match_id in the message |

## Behaviour

1. **Admin gate**: `IF NOT is_admin_user() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';`
2. **Claim the mutex** (in its own transaction):
   ```sql
   INSERT INTO scoring_runs (action, started_at, status)
       VALUES ('admin-recalc-all', now(), 'success')
       RETURNING id INTO v_run_id;
   ```
   The partial unique index `scoring_runs_at_most_one_in_flight_per_action` rejects with `23505` if another `admin-recalc-all` row exists with `finished_at IS NULL`. The RPC catches that, queries the in-flight row, and returns `outcome: 'skipped'`.
3. **Audit emit**: `INSERT INTO audit_log (action, target_table, target_id, payload) VALUES ('admin.recalc-all', 'scoring_runs', v_run_id::TEXT, jsonb_build_object('started_at', now()));`
4. **Per-match loop**:
   ```sql
   FOR v_match IN
       SELECT id FROM matches WHERE status IN ('finished', 'cancelled') ORDER BY kickoff_utc
   LOOP
       BEGIN
           PERFORM calculate_match_points(v_match.id);
           v_matches_processed := v_matches_processed + 1;
       EXCEPTION WHEN OTHERS THEN
           UPDATE scoring_runs SET status = 'error',
                                    error_message = format('match %s failed: %s', v_match.id, SQLERRM),
                                    finished_at = now()
               WHERE id = v_run_id;
           RAISE;  -- propagate (caller sees outcome:'error')
       END;
   END LOOP;
   ```
   Each `PERFORM calculate_match_points()` runs in its own implicit savepoint via the `BEGIN/EXCEPTION/END` block — a per-match failure rolls back that match's writes and updates the scoring_run row before re-raising. Earlier matches' commits stay.
5. **Finalise**: `UPDATE scoring_runs SET finished_at = now(), affected_participants_count = v_matches_processed * (SELECT count(*) FROM participants WHERE status = 'active') WHERE id = v_run_id;`
6. **Return** success envelope with duration.

## Idempotency

Re-running with no upstream changes is functionally idempotent (per Clarify Q1 + FR-P16 — the trigger paths rebuild every score_events row identically). The only difference between runs is the `scoring_runs` row count (one per invocation).

## Side effects

- One row written to `scoring_runs` per call (status `success`, `error`, or `skipped` based on outcome).
- One row to `audit_log` for the admin action + N rows from per-match `calculate_match_points()` calls (each emits a `scoring.match` audit row).
- Up to ~20,800 row writes to `score_events` (DELETE-then-INSERT for each match × participant cell).

## Performance budget

- NFR-P3: ≤ 2 minutes for 104 matches × 200 participants. Per-match budget ~1.2 seconds (very generous; actual per-match runtime is ~30-50 ms).
- pgTAP `018_scoring_idempotency.sql` seeds the full grid and asserts duration.

## Tests

- pgTAP `018_scoring_idempotency.sql`: full-grid recalc + duration assertion + idempotency check + mutex collision test (run two simultaneously; second returns skipped).
- Playwright `e2e/tests/scoring-admin-correction.spec.ts`: TC-P18 (admin corrects → trigger re-fires); TC-P22 (admin cannot direct-INSERT score_events — verifies the RLS gate, not the recalc-all path itself).
