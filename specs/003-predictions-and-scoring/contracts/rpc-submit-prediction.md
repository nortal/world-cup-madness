# RPC: `submit_prediction(p_match_id, p_home, p_away)`

**Purpose**: Submit (insert) or update a participant's predicted score for a match. Server-enforced 60-minute lock per BR-LOCK-002/003. Lock-check + range-check + upsert + audit emission all in one transactional RPC.

**FR coverage**: FR-P01, FR-P02, FR-P03, FR-P04, FR-P05, FR-P06.

## Signature

```sql
submit_prediction(
    p_match_id    UUID,
    p_home        INTEGER,
    p_away        INTEGER
) RETURNS jsonb
```

## Authorisation

- Role: `authenticated`
- RLS: participant identity derived from `auth.uid()`; the RPC writes to `predictions.participant_id = (SELECT id FROM participants WHERE auth_user_id = auth.uid())`.
- `SECURITY DEFINER` + explicit `SET search_path = public, auth`.

## Request

| Param | Type | Constraints |
|---|---|---|
| `p_match_id` | UUID | Must exist in `matches`; raises `MATCH_NOT_FOUND` otherwise. |
| `p_home` | INTEGER | 0..20; raises `OUT_OF_RANGE` (via CHECK constraint) otherwise. |
| `p_away` | INTEGER | 0..20; raises `OUT_OF_RANGE` otherwise. |

## Response

### Success (HTTP 200)

```json
{
  "outcome": "success",
  "prediction_id": "01HXXXXXXXXX",
  "action": "created" | "updated",
  "predicted_home_score": 2,
  "predicted_away_score": 1,
  "locks_at": "2026-06-15T17:00:00+00:00"
}
```

`locks_at` is `kickoff_utc - interval '60 minutes'` — the UI uses it to render the countdown.

### Error envelopes (HTTP 4xx via PostgREST)

| Condition | HTTP | code | message |
|---|---|---|---|
| Match doesn't exist | 404 | `no_data_found` | `MATCH_NOT_FOUND` |
| Participant not active | 404 | `no_data_found` | `PARTICIPANT_NOT_FOUND` |
| Lock window closed (≤ 60 min) | 400 | `check_violation` | `PREDICTION_LOCKED` |
| Score out of range | 400 | `check_violation` | (Postgres CHECK message) |

## Behaviour

1. **Resolve participant**: `SELECT id FROM participants WHERE auth_user_id = auth.uid() AND status = 'active'`. Not found → `PARTICIPANT_NOT_FOUND`.
2. **Load match**: `SELECT kickoff_utc, status FROM matches WHERE id = p_match_id`. Not found → `MATCH_NOT_FOUND`.
3. **Lock check**: `IF (v_kickoff - now() <= interval '60 minutes') OR (v_status != 'scheduled' AND v_status != 'scheduled-tbd') THEN RAISE EXCEPTION 'PREDICTION_LOCKED' USING ERRCODE = 'check_violation';`
4. **Upsert**: `INSERT INTO predictions (participant_id, match_id, predicted_home_score, predicted_away_score) VALUES (...) ON CONFLICT (participant_id, match_id) DO UPDATE SET predicted_home_score = EXCLUDED.predicted_home_score, predicted_away_score = EXCLUDED.predicted_away_score, updated_at = now() RETURNING id, (xmax = 0) AS inserted;` (the `xmax = 0` trick distinguishes insert from update for the audit action tag.)
5. **Audit emit**: `INSERT INTO audit_log (action, target_table, target_id, payload) VALUES (CASE WHEN v_inserted THEN 'prediction.created' ELSE 'prediction.updated' END, 'predictions', v_prediction_id::TEXT, jsonb_build_object('match_id', p_match_id, 'predicted_home', p_home, 'predicted_away', p_away));`
6. **Return** the success envelope.

## Idempotency

A second call with identical args is a successful UPDATE (no row change, but `updated_at` refreshes and an audit row records the no-op edit). Client may treat it as a successful save. The audit-row-per-edit semantic is the spec contract (FR-P04, TC-P21).

## Side effects

- Writes one row to `predictions` (or updates one).
- Writes one row to `audit_log` per call (created or updated).
- Does NOT fire the scoring trigger (predictions are a pre-result data input; scoring fires from `match_results` writes).

## Tests

- pgTAP `017_prediction_rpcs.sql`: lock-boundary triplet (−60/−61/−59 min), range violation, MATCH_NOT_FOUND, PARTICIPANT_NOT_FOUND, audit log emission.
- Playwright `e2e/tests/predictions-submit.spec.ts`: TC-P1, TC-P2, TC-P6, TC-P21.
- Playwright `e2e/tests/predictions-lock-boundary.spec.ts`: TC-P3, TC-P4, TC-P5 (mandatory triplet).
