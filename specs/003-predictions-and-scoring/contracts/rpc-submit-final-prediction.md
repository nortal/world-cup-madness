# RPC: `submit_final_prediction(p_champion, p_runner_up, p_top_scorer, p_best_player)`

**Purpose**: Submit or update a participant's tournament-level predictions. All four picks are nullable (partial submissions allowed). Sweep-lock at first non-cancelled match kickoff per BR-LOCK-005.

**FR coverage**: FR-P07, FR-P08, FR-P09, FR-P10.

## Signature

```sql
submit_final_prediction(
    p_champion         UUID DEFAULT NULL,
    p_runner_up        UUID DEFAULT NULL,
    p_top_scorer       UUID DEFAULT NULL,
    p_best_player      UUID DEFAULT NULL
) RETURNS jsonb
```

## Authorisation

- Role: `authenticated`
- RLS: participant identity derived from `auth.uid()`.
- `SECURITY DEFINER` + explicit `SET search_path = public, auth`.

## Request

| Param | Type | Constraints |
|---|---|---|
| `p_champion` | UUID? | Must exist in `teams` if non-null. |
| `p_runner_up` | UUID? | Must exist in `teams` if non-null. Must differ from `p_champion` if both non-null (CHECK constraint). |
| `p_top_scorer` | UUID? | Must exist in `players` if non-null. |
| `p_best_player` | UUID? | Must exist in `players` if non-null. |

All four nullable — supports partial submission (e.g. team picks before squads announced, player picks after).

## Response

### Success (HTTP 200)

```json
{
  "outcome": "success",
  "final_prediction_id": "01HXXXXXXXXX",
  "action": "created" | "updated",
  "picks": {
    "champion_team_id": "...",
    "runner_up_team_id": "...",
    "top_scorer_player_id": null,
    "best_player_player_id": null
  },
  "locks_at": "2026-06-11T16:00:00+00:00"
}
```

`locks_at` is `min(matches.kickoff_utc WHERE status != 'cancelled')`.

### Error envelopes

| Condition | HTTP | code | message |
|---|---|---|---|
| Tournament already started | 400 | `check_violation` | `FINAL_PREDICTIONS_LOCKED` |
| Champion == runner-up | 400 | `check_violation` | (Postgres CHECK message) |
| Team or player FK violation | 400 | `foreign_key_violation` | (Postgres FK message; client maps to user-friendly message) |
| Participant not active | 404 | `no_data_found` | `PARTICIPANT_NOT_FOUND` |

## Behaviour

1. **Resolve participant**: as in `submit_prediction`.
2. **Lock check**: `SELECT min(kickoff_utc) FROM matches WHERE status != 'cancelled' INTO v_first_kickoff; IF v_first_kickoff IS NOT NULL AND now() >= v_first_kickoff THEN RAISE EXCEPTION 'FINAL_PREDICTIONS_LOCKED' USING ERRCODE = 'check_violation';`
3. **Upsert**: `INSERT INTO final_predictions (participant_id, champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id) VALUES (...) ON CONFLICT (participant_id) DO UPDATE SET ... = EXCLUDED.... , updated_at = now() RETURNING id, (xmax = 0) AS inserted;`
4. **Audit emit**: `INSERT INTO audit_log (action, target_table, target_id, payload) VALUES (CASE WHEN v_inserted THEN 'final_prediction.created' ELSE 'final_prediction.updated' END, 'final_predictions', v_id::TEXT, jsonb_build_object('champion', p_champion, 'runner_up', p_runner_up, 'top_scorer', p_top_scorer, 'best_player', p_best_player));`
5. **Trigger side-effect**: the `final_predictions` AFTER UPDATE trigger fires `calculate_final_points(v_participant_id)` IF any of the four columns changed (per WHEN clause in the trigger). Audit-log row for `scoring.final` is emitted by the trigger function.
6. **Return** success envelope.

## Idempotency

Same as `submit_prediction` — a repeat call with unchanged args is a no-op UPDATE (audit-logged, trigger fires but the `WHEN` clause short-circuits if no column actually changed).

## Side effects

- Writes one row to `final_predictions` (or updates one).
- Writes one row to `audit_log` per call (created or updated).
- AFTER UPDATE trigger on `final_predictions` fires `calculate_final_points()` for this participant, which writes four rows to `score_events` (one per final-source) if `tournament_config` winners are set.

## Tests

- pgTAP `017_prediction_rpcs.sql`: lock boundary at exact first kickoff, distinctness check, FK violations, audit emission.
- Playwright `e2e/tests/predictions-final-submit.spec.ts`: TC-P7, TC-P8, TC-P9.
- Playwright `e2e/tests/predictions-final-player-picker.spec.ts`: TC-P10, TC-P11 (cover the player-pickers-disabled UX path that gates this RPC).
