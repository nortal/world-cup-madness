# Quickstart: Leaderboard (feature 004)

**Feature**: `004-leaderboard` | **Date**: 2026-06-01

Local-dev walkthrough for feature 004. Assumes you have features 001 + 002 + 003 already running locally (Supabase stack up, dev server on 3000, Edge Function served on 54321, pgtap extension installed).

## 1. Prerequisites

| | Check |
|---|---|
| Node.js 20+ | `node --version` |
| Supabase CLI | `npx supabase --version` |
| Local stack running | `npx supabase status` → all green |
| Edge Function served | `SYNC_FIXTURE_MODE=1 npx supabase functions serve sync-matches --env-file .env.local` (from feature 002/003) |
| `.env.local` populated | Per `.env.example`. No new vars in feature 004. |
| `pg_cron` enabled | Already enabled by feature 003; verify with `SELECT extname FROM pg_extension WHERE extname='pg_cron';` |

## 2. Apply migrations

```bash
# Brings in features 001 + 002 + 003 (0001-0031) plus this feature's new ones (0032-0035).
npx supabase db reset

# pgtap is wiped on reset — re-install:
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "CREATE EXTENSION IF NOT EXISTS pgtap;"

# Regenerate TypeScript types after migrations land.
npx supabase gen types typescript --local 2>/dev/null \
  | sed -E '/^Connecting to db /d; /^<claude-code-hint/,$d' \
  > lib/supabase/database.types.ts
```

Verify the MV + RPC + cron schedule exist:

```bash
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT matviewname FROM pg_matviews WHERE matviewname = 'leaderboard_snapshots';
"
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT proname FROM pg_proc WHERE proname IN ('refresh_leaderboard', 'should_refresh_leaderboard');
"
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'leaderboard-refresh-tick';
"
```

Expected: 1 MV, 2 functions, 1 active cron job.

## 3. Bootstrap match catalog + squads + seed predictions

```bash
SROLE=$(npx supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '"')

# Step A: bootstrap matches + squads (from feature 002/003):
curl -sS -X POST http://127.0.0.1:54321/functions/v1/sync-matches \
  -H "Authorization: Bearer $SROLE" \
  -H "Content-Type: application/json" \
  -d '{"action":"bootstrap"}'

# Step B: seed a few participants + predictions + a finished match to trigger scoring.
# (See feature 003 quickstart §4 for the participant + prediction seed flow.)

# After scoring trigger runs, leaderboard_snapshots should have rows:
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT stage, count(*) FROM leaderboard_snapshots GROUP BY stage ORDER BY stage;
"
```

Expected: 6 stages (`all`, `group`, `r16`, `quarter`, `semi`, `final`), each with one row per active participant.

## 4. Trigger a refresh manually

```bash
# Admin-direct invocation (requires an admin participant — set via tournament_config.admin_oids).
# From psql as the postgres role:
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT refresh_leaderboard();
"
```

Expected output: `{"outcome":"success","duration_ms":<small>,"participant_count":<n>}`.

Verify audit row landed:

```bash
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "
  SELECT event_type, created_at, new_value->>'caller_kind' AS caller, (new_value->>'duration_ms')::INT AS ms
  FROM audit_log
  WHERE event_type IN ('leaderboard.refresh', 'leaderboard.refresh_failed')
  ORDER BY created_at DESC
  LIMIT 5;
"
```

## 5. Verify Realtime emission

In one terminal, tail the Realtime channel (using `wsdump` or any WebSocket client):

```bash
# Channel URL pattern (anon JWT can be anything that auth recognises):
WS_URL="ws://127.0.0.1:54321/realtime/v1/websocket?apikey=<anon-jwt>"
# Subscribe to event_type=leaderboard.refresh in audit_log...
```

In another terminal, trigger a scoring event (e.g. UPDATE matches SET status='finished' ...). Observe a single Realtime frame within ~100 ms carrying the audit row.

## 6. Verify cron tick gating

Inspect the gating predicate at various clock states:

```sql
-- Pre-tournament (truncate score_events temporarily):
BEGIN;
DELETE FROM score_events;
SELECT should_refresh_leaderboard();  -- Expected: false
ROLLBACK;

-- Match-window (insert a fake match with kickoff close to now()):
INSERT INTO matches (id, provider_id, home_team_id, away_team_id, stage, kickoff_utc, status)
VALUES (gen_random_uuid(), 99999, '<eng-id>', '<fra-id>', 'group', now() + interval '30 minutes', 'scheduled');
SELECT should_refresh_leaderboard();  -- Expected: true
DELETE FROM matches WHERE provider_id = 99999;
```

The pg_cron schedule fires every 5 minutes; tail Supabase logs to observe the ticks:

```bash
docker exec supabase_db_world-cup-madness tail -f /var/log/postgresql/postgresql-15-main.log \
  | grep -i 'leaderboard-refresh-tick'
```

## 7. Smoke-test the page

1. Sign in to the dev server at http://127.0.0.1:3000 (use `/dev/signin` for synthetic sign-in).
2. Navigate to `/leaderboard`. Expected: rankings table renders with the seeded participants.
3. Click each stage tab — observe the URL updating to `?stage=group` etc., and the rankings re-aggregating.
4. Click "Show my rank" — page scrolls to your row with a brief highlight.
5. In another browser tab, sign in as a different participant and trigger a scoring event (admin RPC). Switch back to the first tab — your visible rank updates within ~5 seconds without refresh.

## 8. Smoke-test the dashboard widget

1. Navigate to `/dashboard`.
2. Observe the "Your rank" card above the upcoming-matches widget.
3. Trigger a scoring event that changes your rank. Observe the card updates within ~5 seconds with `↑ N` or `↓ N` delta.

## 9. Run the test suite

```bash
# pgTAP (DB invariants):
for f in test/pgtap/02{0,1,2,3,4}_*.sql; do
  docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -f - < "$f"
done

# Jest (pure helpers):
npx jest lib/leaderboard/__tests__/

# Playwright (E2E):
npx playwright test e2e/tests/leaderboard-*.spec.ts

# A11y subset:
npx playwright test e2e/tests/all-pages-a11y.spec.ts -g "/leaderboard"
```

Expected: pgTAP 0 failures, Jest 0 failures, Playwright all green.

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/leaderboard` shows pre-tournament countdown forever | `score_events` is empty AND `should_refresh_leaderboard()` returns false | Seed a finished match to trigger scoring (feature 003 quickstart §5) |
| `/leaderboard` shows stale ranks despite scoring runs | MV refresh is failing — check `audit_log` for `leaderboard.refresh_failed` rows | Inspect `sqlstate` + `sqlerrm` in the failure row; common cause: lock contention, retry via `SELECT refresh_leaderboard();` |
| `/leaderboard` rejects with `permission denied for column exact_hits` | Client query is requesting private columns from the public MV instead of `leaderboard_self` | Update the query to use `leaderboard_self` for full-row reads |
| Realtime updates don't appear in the browser | Channel disconnected; `<ReconnectingIndicator/>` should be visible if > 10 s offline | Reload the page; check browser DevTools → Network → WS for the realtime/v1/websocket frame |
| Cron job fires but no refresh happens | `should_refresh_leaderboard()` is gating — check `score_events` row count + match window logic | Verify by running `SELECT should_refresh_leaderboard();` directly; if false, that's the cron-gated case |
| `cron.job` table doesn't exist | `pg_cron` extension not enabled in this project | Re-apply feature 003's migration that enables it: `CREATE EXTENSION IF NOT EXISTS pg_cron;` |
