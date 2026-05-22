# Quickstart: Match Catalog (Read Path) — Feature 002

**Audience**: Developer running feature 002 locally for the first time.
**Assumes**: Feature 001's quickstart has been completed at least once on this machine (you have a working local Supabase stack with citext, auth schema, and feature-001 migrations applied; you can sign in to `/dashboard` via `/dev/signin`).

If you're starting cold, follow [specs/001-authentication-and-participant/quickstart.md](../001-authentication-and-participant/quickstart.md) first, then come back here.

---

## 1. Switch to the feature branch

```bash
cd project-repos/world-cup-madness
git checkout 002-match-catalog-read
```

(If the branch doesn't exist locally yet:)

```bash
git fetch origin
git checkout -b 002-match-catalog-read origin/002-match-catalog-read
```

## 2. Apply the new migrations

```bash
npx supabase db reset
```

Runs every migration from `0001_*` through `0017_seed_teams.sql`. You should see seven new migrations in the output (`0011_create_teams`, `0012_create_matches`, `0013_create_integration_runs`, `0014_add_participants_timezone`, `0015_match_rpcs`, `0016_match_rls`, `0017_seed_teams`).

Verify the schema:

```bash
npx supabase db psql -c "\d teams \d matches \d integration_runs"
```

Expect three tables. `teams` should have 48 rows from the seed (or whatever WC 2026 has confirmed at seed time — see seed file). `matches` and `integration_runs` should be empty.

## 3. Regenerate TypeScript types

```bash
npx supabase gen types typescript --local > lib/supabase/database.types.ts
```

The diff should add `teams`, `matches`, `integration_runs` table types plus a new `timezone` column on `participants`. Commit this change in the same PR as the migrations so feature-002 code compiles against the new shape.

## 4. Choose your local-dev provider mode

You have two options for getting match data into your local catalog:

### Option A — Fixture mode (recommended for daily dev)

No API key needed. Uses the frozen `__fixtures__/v4-sample.json` shipped with the Edge Function. Always reproducible; CI uses this mode too.

```bash
# Start the Edge Function locally with fixture mode on
SYNC_FIXTURE_MODE=1 npx supabase functions serve sync-matches --env-file .env.local

# In another terminal: invoke the bootstrap import
curl -X POST http://127.0.0.1:54321/functions/v1/sync-matches \
  -H "Authorization: Bearer $(npx supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '"')" \
  -H "Content-Type: application/json" \
  -d '{"action":"bootstrap"}'
```

Expected response:

```json
{ "outcome": "success", "integration_run_id": 1, "records_processed": 104, "records_unchanged": 0, "duration_ms": <small> }
```

Verify: `npx supabase db psql -c "SELECT count(*) FROM matches;"` should return 104.

### Option B — Real provider mode (verifies the live API path)

Get an API key from https://www.football-data.org (free tier — sign up takes a minute). Add to `.env.local`:

```env
FOOTBALL_DATA_API_KEY=your_key_here
```

Then invoke the function the same way as Option A but without `SYNC_FIXTURE_MODE`:

```bash
npx supabase functions serve sync-matches --env-file .env.local

curl -X POST http://127.0.0.1:54321/functions/v1/sync-matches \
  -H "Authorization: Bearer $(npx supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '"')" \
  -H "Content-Type: application/json" \
  -d '{"action":"bootstrap"}'
```

If the provider rate-limits you, the response will include `outcome:'error', error_category:'provider.rate-limit'` — switch to Option A or wait a minute.

## 5. Sign in and browse

Start the Next dev server (in another terminal):

```bash
npm run dev
```

Visit http://localhost:3000/dev/signin?email=you@nortal.com — you'll land on `/dashboard`. The "Upcoming matches" widget should now show the next 3 fixtures by kickoff time (replaces the empty-state placeholder from feature 001).

Click "View all matches" (or navigate manually to `/matches`) — you should see all 104 matches grouped by day, in `UTC` (the default timezone, since you haven't set yours yet).

## 6. Set your timezone

The first time you load `/dashboard`, a Client Component auto-detects your browser timezone and writes it via the `set_timezone` RPC. Refresh the page — kickoffs should now render in your local time, and the day-bucket headers ("Today", "Tomorrow") reflect your timezone.

To override manually, go to `/profile` and pick a different timezone from the IANA selector.

## 7. Trigger the advisory-lock concurrency path

Open two terminals. In each, run the same curl invocation at roughly the same time:

```bash
# Both terminals, simultaneously:
curl -X POST http://127.0.0.1:54321/functions/v1/sync-matches \
  -H "Authorization: Bearer $(npx supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '"')" \
  -H "Content-Type: application/json" \
  -d '{"action":"manual-resync"}'
```

One should return `outcome:'success'`. The other should return `outcome:'skipped'` with `in_flight_run_started_at` populated. Verify:

```bash
npx supabase db psql -c "SELECT action, status, error_message FROM integration_runs ORDER BY started_at DESC LIMIT 3;"
```

You should see one `(manual-resync, success, NULL)` row and one `(manual-resync, skipped, <ISO timestamp>)` row.

## 8. Run the tests

```bash
# pgTAP — RLS on the new tables + sync idempotency + advisory lock
npx supabase db test test/pgtap/*.sql

# Jest unit — pure helpers (lock-badge, day-bucket, format-kickoff)
npm test

# Playwright chromium — all 14 TC-M specs + the existing 22 from feature 001
npx playwright test --project=chromium

# Playwright accessibility — covers the 3 new surfaces
npx playwright test --project=accessibility

# Static checks
npx tsc --noEmit
npm run lint
```

All should pass pristine. If you hit `Error: Timed out waiting 120000ms from config.webServer` — kill any stray `next dev` processes and retry:

```bash
pkill -9 -f next 2>/dev/null
```

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `function net.http_post does not exist` | `pg_net` extension not enabled in local Supabase | Either skip the `trigger_match_sync` RPC tests (the function still works via direct Edge Function curl) or enable pg_net via `CREATE EXTENSION pg_net;` in a migration (Pro tier only — local stack may not support it) |
| `matches` table empty after running the sync | Check `integration_runs` for an `error` row | Most likely a missing API key (Option B) — switch to fixture mode (Option A) |
| Kickoffs render in UTC even though your browser is on a different TZ | Auto-detect Client Component hasn't fired yet, or `participants.timezone` is still 'UTC' | Visit `/dashboard` (the auto-detect runs on first mount); alternatively visit `/profile` and set your TZ manually |
| Day-bucket headers show "Today" twice | Two participants signed in with different timezones in different browser tabs | Expected — day grouping is per-participant TZ. Use the same participant in both tabs or sign each in via `/dev/signin?email=...` with the same email |
| Filter chip on `/matches` not narrowing the list | Check URL has the query param (`/matches?stage=round-of-16`); not all combinations are valid (e.g. `?group=A` only narrows group-stage matches) | Filters compose with AND; conflicting filters produce empty results — expected per FR-M05 |
| Advisory lock never releases | Edge Function crashed mid-flight | Wait ~10 seconds (connection close fail-safe per R-4), then retry. If it persists, restart `supabase functions serve` |

---

## Useful commands reference

```bash
# Tail the function logs while testing locally
npx supabase functions serve sync-matches --env-file .env.local --debug

# Inspect a specific integration_runs row
npx supabase db psql -c "SELECT * FROM integration_runs WHERE id = <N>;"

# See which match is currently held in cache (NFR-M6 revalidate window)
# (Next.js dev mode doesn't expose this directly — check via repeated curl
#  and observe Server-Timing headers or response-time variance)
curl -w "\n%{time_total}s\n" -o /dev/null -s http://localhost:3000/matches

# Inspect the seeded teams (verify FIFA code coverage)
npx supabase db psql -c "SELECT tla, name FROM teams ORDER BY tla;"
```

---

## Next steps

After this feature lands, the next slice is **feature 003 — prediction write path** (the participant's prediction-entry form, the authoritative `lock_prediction()` RPC, the lock-boundary pgTAP tests at exactly −60 / −61 / −59 minutes). The match catalog from feature 002 is the read-side foundation that 003 writes against.

See [specs/](..) for the project's full spec list.
