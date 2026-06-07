# Contract — `lock_prediction()` RPC (REUSED from feature 003)

**Type**: Postgres RPC, SECURITY DEFINER
**Source**: Feature 003, migration `0028_prediction_rpcs.sql`
**Status**: REUSED — no changes for feature 005

## Purpose

The inline quick-edit form (`ExpandableMatchCard` + `InlinePredictionForm`) saves participant predictions via this RPC, identical to the standalone `/predictions/[matchId]` form. The RPC enforces the 60-minute lock window server-side (BR-LOCK-001) before persisting.

## Signature

```sql
lock_prediction(
  p_match_id uuid,
  p_predicted_home_score smallint,
  p_predicted_away_score smallint
) RETURNS jsonb
```

Return shape:
```json
{
  "outcome": "saved" | "locked" | "out_of_range" | "match_not_found" | "participant_not_found" | "error",
  "match_id": "uuid",
  "predicted_home_score": 1,
  "predicted_away_score": 0,
  "locked_at_utc": "2026-06-12T17:00:00Z" | null
}
```

## Invariants

- Caller MUST be authenticated (`authenticated` role + valid JWT).
- The function looks up the participant via `auth.uid()` — does not accept a participant_id argument.
- Server-side lock check uses BR-LOCK-001 boundary: kickoff_utc - 60 minutes (inclusive).
- On `outcome != 'saved'`, the RPC does not modify the `predictions` table.
- Audit trail: every save (success or failure) emits an `audit_log` row (handled by existing feature 003 trigger).

## Failure modes

| outcome | Trigger | Inline-edit UI surface |
|---|---|---|
| `locked` | now() within 60 min of kickoff_utc | `errorLocked` toast inside the expanded card; badge transitions to "Locked" state |
| `out_of_range` | predicted score < 0 or > 20 | `errorOutOfRange` inline message; card stays expanded |
| `match_not_found` | `p_match_id` not in `matches` | `errorMatchNotFound` inline message; card stays expanded |
| `participant_not_found` | `auth.uid()` not in `participants` | `errorParticipantNotFound` inline message; card stays expanded |
| `error` | any other failure | `errorGeneric` inline message; card stays expanded |

## Test coverage

- `e2e/tests/dashboard-inline-edit.spec.ts` — TC-D3 (expand + save success), TC-D4 (sticky countdown), TC-D5 (lock-boundary at exactly -60 min), TC-D17 (out-of-range error)
- Existing feature 003 pgTAP tests (`test/pgtap/014_lock_prediction.sql` and similar) cover the RPC's invariants — no new pgTAP for feature 005.

## NFR observability

- NFR-D08: the inline-save Client handler MUST emit a structured `console.log` JSON line on every RPC invocation, success or failure, with `event`, `participant_id`, `match_id`, `outcome`, `error_code` (if any), `occurred_at`.
