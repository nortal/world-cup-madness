# Contracts: Predictions and Scoring

**Feature**: `003-predictions-and-scoring`

Each contract documents the request shape, response shape, error envelope, RLS / authorisation gate, and the side effects (table writes, trigger fires, audit emission).

| File | Surface | Caller |
|---|---|---|
| [rpc-submit-prediction.md](./rpc-submit-prediction.md) | `submit_prediction(p_match_id UUID, p_home INT, p_away INT)` | Authenticated participant |
| [rpc-submit-final-prediction.md](./rpc-submit-final-prediction.md) | `submit_final_prediction(p_champion UUID?, p_runner_up UUID?, p_top_scorer UUID?, p_best_player UUID?)` | Authenticated participant |
| [rpc-set-tournament-winner.md](./rpc-set-tournament-winner.md) | `set_tournament_winner(p_item TEXT, p_id UUID)` | Authenticated admin |
| [rpc-recalculate-all-scores.md](./rpc-recalculate-all-scores.md) | `recalculate_all_scores()` | Authenticated admin |
| [trigger-calculate-match-points.md](./trigger-calculate-match-points.md) | Trigger function `calculate_match_points(p_match_id UUID)` | Trigger on `match_results` + `recalculate_all_scores()` |
| [trigger-calculate-final-points.md](./trigger-calculate-final-points.md) | Trigger function `calculate_final_points(p_participant_id UUID?)` | Triggers on `tournament_config` + `final_predictions` |

All RPCs follow the feature 001 + 002 patterns:
- `SECURITY DEFINER` + explicit `SET search_path = public, auth` to avoid search_path hijacking.
- `REVOKE ALL FROM PUBLIC` + targeted `GRANT EXECUTE` to the right role.
- Validate inputs at the entry; `RAISE EXCEPTION` with `ERRCODE` so PostgREST surfaces them as structured HTTP 4xx errors.
- Return `jsonb` shaped `{outcome: 'success' | 'error', ...}` so the client can branch on `outcome` deterministically.

Error vocabulary (used across RPCs):

| Code | Meaning |
|---|---|
| `PREDICTION_LOCKED` | Lock window closed (≤ 60 min to kickoff). Returned as `errcode 'check_violation'`. |
| `FINAL_PREDICTIONS_LOCKED` | First non-cancelled match has kicked off. Returned as `errcode 'check_violation'`. |
| `MATCH_NOT_FOUND` | match_id doesn't exist. Returned as `errcode 'no_data_found'`. |
| `PARTICIPANT_NOT_FOUND` | No active participant row for `auth.uid()`. Returned as `errcode 'no_data_found'`. |
| `FORBIDDEN` | Non-admin caller tried an admin RPC. Returned as `errcode 'insufficient_privilege'`. |
| `SCORING_RUN_IN_PROGRESS` | Recalc-all mutex held. Returned as `errcode 'lock_not_available'`. |
| `INVALID_WINNER_ITEM` | `p_item` not in {champion, runner-up, top-scorer, best-player}. Returned as `errcode 'invalid_parameter_value'`. |
| `OUT_OF_RANGE` | Score outside 0..20. Returned as native `errcode 'check_violation'` from the table constraint. |
