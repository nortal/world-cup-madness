# RPC: `set_tournament_winner(p_item, p_id)`

**Purpose**: Admin sets one of the four official tournament winners. Updates `tournament_config`; the AFTER UPDATE trigger fires `calculate_final_points(NULL)` (full sweep) which rebuilds every active participant's four `final-*` score_events rows.

**FR coverage**: FR-P23, FR-P26.

## Signature

```sql
set_tournament_winner(
    p_item    TEXT,   -- one of 'champion' | 'runner-up' | 'top-scorer' | 'best-player'
    p_id      UUID    -- team_id (champion/runner-up) or player_id (top-scorer/best-player); NULL allowed to clear
) RETURNS jsonb
```

## Authorisation

- Role: `authenticated`, gated on `is_admin_user()` (carry-over from feature 001 migration 0010).
- `SECURITY DEFINER` + explicit `SET search_path = public, auth`.

## Request

| Param | Type | Constraints |
|---|---|---|
| `p_item` | TEXT | Must be one of `'champion'`, `'runner-up'`, `'top-scorer'`, `'best-player'`. Raises `INVALID_WINNER_ITEM` otherwise. |
| `p_id` | UUID? | For `champion`/`runner-up`: must reference `teams`. For `top-scorer`/`best-player`: must reference `players`. NULL is allowed (clears the winner). |

## Response

### Success (HTTP 200)

```json
{
  "outcome": "success",
  "item": "champion",
  "id": "01HXXXXXXXXX",
  "scoring_triggered": true
}
```

`scoring_triggered: true` when the column actually changed (the trigger's WHEN clause uses `IS DISTINCT FROM`); `false` if the call set the same value already in place.

### Error envelopes

| Condition | HTTP | code | message |
|---|---|---|---|
| Non-admin caller | 403 | `insufficient_privilege` | `FORBIDDEN` |
| Invalid `p_item` | 400 | `invalid_parameter_value` | `INVALID_WINNER_ITEM` |
| Team / player FK violation | 400 | `foreign_key_violation` | (Postgres message) |
| Champion == runner-up (CHECK on tournament_config) | 400 | `check_violation` | (Postgres message) |

## Behaviour

1. **Admin gate**: `IF NOT is_admin_user() THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE = 'insufficient_privilege';`
2. **Validate item**: `IF p_item NOT IN ('champion', 'runner-up', 'top-scorer', 'best-player') THEN RAISE EXCEPTION 'INVALID_WINNER_ITEM' USING ERRCODE = 'invalid_parameter_value';`
3. **Dispatch update** via CASE on `p_item`:
   ```sql
   CASE p_item
       WHEN 'champion'    THEN UPDATE tournament_config SET champion_team_id = p_id
       WHEN 'runner-up'   THEN UPDATE tournament_config SET runner_up_team_id = p_id
       WHEN 'top-scorer'  THEN UPDATE tournament_config SET top_scorer_player_id = p_id
       WHEN 'best-player' THEN UPDATE tournament_config SET best_player_player_id = p_id
   END;
   ```
4. **Trigger side effect**: the `tournament_config` AFTER UPDATE trigger fires `calculate_final_points(NULL)` IF the column actually changed. That function deletes + re-inserts every active participant's `final-*` rows in `score_events` and emits a `scoring.final` audit row.
5. **Audit emit** (this RPC's own audit row): `INSERT INTO audit_log (action, target_table, target_id, payload) VALUES ('admin.tournament-winner-set', 'tournament_config', '<singleton>', jsonb_build_object('item', p_item, 'id', p_id));`
6. **Return** success envelope.

## Idempotency

A second call with the same `(p_item, p_id)` is a no-op UPDATE (column unchanged); the trigger's WHEN clause prevents `calculate_final_points()` from re-running. Audit log records both calls (admin intent is captured even if no state change).

## Side effects

- Updates one column on the singleton `tournament_config` row.
- Triggers `calculate_final_points(NULL)` → writes up to N×4 rows to `score_events` (N = active participant count).
- Writes one row to `audit_log` for the admin action + one row for the scoring run (emitted by the trigger function).

## Tests

- pgTAP `017_prediction_rpcs.sql`: admin gate, INVALID_WINNER_ITEM, FK violations, idempotency (no trigger re-fire on unchanged).
- Playwright `e2e/tests/scoring-final-points.spec.ts`: TC-P19 (correct champion → 20 points awarded to matching participants).
