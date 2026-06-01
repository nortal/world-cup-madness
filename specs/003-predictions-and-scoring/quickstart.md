# Quickstart: Predictions and Scoring (feature 003)

**Feature**: `003-predictions-and-scoring` | **Date**: 2026-05-22

Local-dev walkthrough for feature 003. Assumes you have features 001 + 002 already running locally (Supabase stack up, dev server on 3000, Edge Function served on 54321).

## 1. Prerequisites

| | Check |
|---|---|
| Node.js 20+ | `node --version` |
| Supabase CLI | `npx supabase --version` |
| Local stack running | `npx supabase status` → all green |
| Edge Function served | `SYNC_FIXTURE_MODE=1 npx supabase functions serve sync-matches --env-file .env.local` (extended in this feature for squads) |
| `.env.local` populated | Per `.env.example`. No new vars in feature 003. |

## 2. Apply migrations

```bash
# Brings in features 001 + 002 (0001-0018) plus this feature's new ones (0019-0028).
npx supabase db reset

# Regenerate TypeScript types after migrations land.
npx supabase gen types typescript --local | sed '/^<claude-code-hint/,$d' > lib/supabase/database.types.ts
```

Verify the new tables + view exist:

```bash
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
  AND table_name IN ('predictions', 'final_predictions', 'players', 'score_events', 'scoring_runs')
  ORDER BY table_name;
"
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT table_name FROM information_schema.views
  WHERE table_schema = 'public' AND table_name = 'all_runs';
"
```

Expected: 5 tables + 1 view.

## 3. Bootstrap match catalog (from feature 002) + extended squad sync

```bash
SROLE=$(npx supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '"')
curl -sS -X POST http://127.0.0.1:54321/functions/v1/sync-matches \
  -H "Authorization: Bearer $SROLE" \
  -H "Content-Type: application/json" \
  -d '{"action":"bootstrap"}'
```

Expected output (idempotent — re-running should report records_unchanged=15+830):

```json
{"outcome":"success","integration_run_id":1,"records_processed":845,"records_unchanged":0,"duration_ms":<small>}
```

Verify counts:

```bash
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT 'matches' AS what, count(*) FROM matches
  UNION ALL SELECT 'players', count(*) FROM players
  UNION ALL SELECT 'teams', count(*) FROM teams;
"
```

Expected: matches=15 (fixture), players=~160 (5 per team × 32), teams=32.

## 4. Submit a prediction (RPC walkthrough)

Sign in to the dev server at http://127.0.0.1:3000 (use the dev `/dev/signin` route to bypass Microsoft OAuth locally).

Navigate to `/matches` and click an upcoming match (kickoff > now + 60 min). The detail page will show the prediction form.

Submit `home=2, away=1`. Expected:
- UI confirms "Prediction saved — editable until [timestamp]".
- Server-side: row in `predictions`; audit row tagged `prediction.created`.

Verify via psql:

```sql
SELECT pr.predicted_home_score, pr.predicted_away_score, m.id AS match_id
  FROM predictions pr JOIN matches m ON m.id = pr.match_id
  WHERE pr.participant_id = (SELECT id FROM participants WHERE email = 'dev@nortal.com');

SELECT action, payload FROM audit_log WHERE action = 'prediction.created' ORDER BY created_at DESC LIMIT 1;
```

## 5. Test the lock boundary via psql

The authoritative comparator is `kickoff_utc - now() > interval '60 minutes'`. Test all three boundary cases.

```sql
-- Step 1: seed a match exactly 60 minutes from now.
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status)
  VALUES (
    gen_random_uuid(),
    99000,
    (SELECT id FROM teams WHERE tla='ENG'),
    (SELECT id FROM teams WHERE tla='FRA'),
    'group',
    now() + interval '60 minutes',
    'scheduled'
  )
  RETURNING id;
-- Note the returned id as $MATCH_60

-- Step 2: at exactly 60 min, the lock IS engaged. Expect PREDICTION_LOCKED.
SELECT submit_prediction('$MATCH_60'::uuid, 2, 1);  -- expects ERROR: PREDICTION_LOCKED

-- Step 3: seed a match at 61 minutes. Lock NOT engaged.
INSERT INTO matches (...) VALUES (..., now() + interval '61 minutes', 'scheduled');
SELECT submit_prediction('$MATCH_61'::uuid, 2, 1);  -- expects SUCCESS

-- Step 4: seed a match at 59 minutes. Lock IS engaged.
INSERT INTO matches (...) VALUES (..., now() + interval '59 minutes', 'scheduled');
SELECT submit_prediction('$MATCH_59'::uuid, 2, 1);  -- expects ERROR: PREDICTION_LOCKED
```

Run by `supabase db psql -- -U postgres`. Replace `$MATCH_60`/`$MATCH_61`/`$MATCH_59` with the actual UUIDs from each INSERT.

## 6. Exercise scoring trigger end-to-end

```sql
-- (Continue from step 4 — there's at least one prediction in the DB.)

-- Find the participant's match.
SELECT p.match_id, p.predicted_home_score, p.predicted_away_score, m.kickoff_utc
  FROM predictions p JOIN matches m ON m.id = p.match_id
  LIMIT 1;
-- Note $MATCH_ID and $PRED_HOME, $PRED_AWAY.

-- Insert a match_result that matches the prediction exactly.
INSERT INTO match_results (match_id, status, score_home, score_away, source)
  VALUES ('$MATCH_ID', 'finished', $PRED_HOME, $PRED_AWAY, 'provider')
  ON CONFLICT (match_id) DO UPDATE SET
    status = 'finished',
    score_home = EXCLUDED.score_home,
    score_away = EXCLUDED.score_away;
-- Trigger fires automatically.

-- Verify scoring.
SELECT participant_id, source, points
  FROM score_events
  WHERE match_id = '$MATCH_ID';
-- Expected: one row per active participant. The predicting participant has source='match-exact' and points=10.

-- Audit log should have one 'scoring.match' row.
SELECT action, target_id, payload FROM audit_log WHERE action='scoring.match' ORDER BY created_at DESC LIMIT 1;
```

## 7. Exercise admin recalculate-all RPC

```sql
-- Sign in as an admin via the dev shortcut, then run:
SELECT recalculate_all_scores();
-- Expected: {"outcome":"success", "scoring_run_id":"...", "matches_processed":N, "duration_ms":<small>}

-- Verify scoring_runs row.
SELECT id, action, status, affected_participants_count, started_at, finished_at, error_message
  FROM scoring_runs ORDER BY started_at DESC LIMIT 1;
-- Expected: action='admin-recalc-all', status='success', finished_at IS NOT NULL.

-- The all_runs view should show both sync + scoring rows interleaved.
SELECT run_kind, action, started_at, status, affected_count FROM all_runs ORDER BY started_at DESC LIMIT 5;
```

## 8. Verify concurrent recalc-all mutex

```bash
# Two simultaneous calls. One should succeed, the other should return outcome='skipped'.
for i in 1 2; do
  curl -sS -X POST http://127.0.0.1:54321/rest/v1/rpc/recalculate_all_scores \
    -H "Authorization: Bearer $ADMIN_JWT" \
    -H "Content-Type: application/json" \
    -d '{}' &
done
wait
```

Expected: one response `{"outcome":"success",...}`, one `{"outcome":"skipped","in_flight_run_id":...,"in_flight_started_at":...}`.

(Generate `$ADMIN_JWT` by signing in as admin via `/dev/signin?role=admin` and copying the token from cookies.)

## 9. Run the full pgTAP suite for feature 003

```bash
# Run only the new files (010-018).
for f in test/pgtap/01[0-8]_*.sql; do
  echo ">>> $f"
  docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -X -q -P pager=off -f - < "$f" \
    | grep -E "^ ok|^ not ok|ERROR" | head -50
done
```

Every file should report all asserts passing (no "not ok" or "ERROR" lines).

## 10. Run the new Playwright specs

```bash
npx playwright test \
  e2e/tests/predictions-submit.spec.ts \
  e2e/tests/predictions-lock-boundary.spec.ts \
  e2e/tests/predictions-final-submit.spec.ts \
  e2e/tests/predictions-final-player-picker.spec.ts \
  e2e/tests/scoring-match-points.spec.ts \
  e2e/tests/scoring-idempotency.spec.ts \
  e2e/tests/scoring-admin-correction.spec.ts \
  e2e/tests/scoring-final-points.spec.ts \
  e2e/tests/predictions-rls.spec.ts
```

Expected: every spec green; pristine sweep.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `function submit_prediction(...) does not exist` | Migration 0027 didn't apply | `npx supabase db reset` and verify with `\df submit_prediction` in psql |
| Trigger doesn't fire on `match_results` UPDATE | WHEN clause is more restrictive than the test thought | Verify `status IN ('finished', 'cancelled')` AND scores are non-NULL (or status='cancelled' without scores) |
| `PREDICTION_LOCKED` returned for a match clearly > 60 min away | Server clock skew (rare on local) | Check `SELECT now()` in psql; the function uses server `now()`, not browser time |
| `recalculate_all_scores()` returns `outcome='skipped'` immediately | A prior run is stuck (finished_at IS NULL) | `DELETE FROM scoring_runs WHERE action='admin-recalc-all' AND finished_at IS NULL` (admin-runbook step) |
| `players` is empty after sync | Squad fixture file missing or `SYNC_FIXTURE_MODE` unset | Verify `__fixtures__/v4-squads-sample.json` exists and `.env.local` has `SYNC_FIXTURE_MODE=1` |
| `all_runs` view returns empty for admin user | View created without `security_invoker=true` | `\d+ all_runs` in psql; recreate via migration if the option is missing |
| Final-prediction trigger fires twice on partial submit | UPDATE touched columns where new=old; WHEN clause uses `IS DISTINCT FROM` which is NULL-safe but verify | Check `SELECT * FROM audit_log WHERE action='scoring.final' ORDER BY created_at DESC LIMIT 5` — should be one row per genuine column change |

## 12. Cross-references

- Spec: `specs/003-predictions-and-scoring/spec.md`
- Plan: `specs/003-predictions-and-scoring/plan.md`
- Research decisions: `specs/003-predictions-and-scoring/research.md` (R-1 through R-8)
- Data model: `specs/003-predictions-and-scoring/data-model.md`
- RPC contracts: `specs/003-predictions-and-scoring/contracts/*.md`
- Trigger contracts: `specs/003-predictions-and-scoring/contracts/trigger-*.md`
