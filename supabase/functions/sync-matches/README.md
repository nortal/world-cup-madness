# sync-matches — match catalog provider sync

Supabase Edge Function (Deno) that fetches FIFA WC 2026 fixtures from football-data.org v4 and UPSERTs them into the `matches` + `teams` tables. Implements FR-M03 / FR-M18 / FR-M19 / FR-M20 / FR-M23 from `specs/002-match-catalog-read/spec.md`; the full HTTP contract lives at `specs/002-match-catalog-read/contracts/edge-sync-matches.md`.

## Purpose

- **Catalog source-of-truth**: the only path that writes to `matches` (and to seed-extension rows on `teams` once the provider returns teams not in the migration seed). Both the admin manual re-sync action (via `trigger_match_sync()` RPC + `pg_net`) and the Phase-5 scheduled cron point at this function.
- **Idempotent** (FR-M20): the UPSERT keys on `provider_id`; re-running against unchanged upstream data leaves the row count alone and reports `records_processed === records_unchanged` in the `integration_runs` telemetry row.
- **Concurrent-safe** (FR-M23): a Postgres advisory lock keyed `hashtext('match-catalog-sync')` serialises invocations. The second caller short-circuits with `outcome:'skipped'` and records the in-flight run's `started_at` for triage.
- **Rate-budget-aware** (NFR-M5): the retry helper at `lib/retry.ts` respects `Retry-After` on 429 / 503 and tops out at 5 retries so a degraded provider can't amplify load.

## Environment variables

| Var | Required | Purpose | Where to set |
| --- | --- | --- | --- |
| `FOOTBALL_DATA_API_KEY` | Yes (deployed envs); No when `SYNC_FIXTURE_MODE=1` | Provider auth — sent as `X-Auth-Token` header on every v4 request. | Production / staging: `npx supabase secrets set FOOTBALL_DATA_API_KEY=<key>`. Local dev: `.env.local` (template in `.env.example`). |
| `SYNC_FIXTURE_MODE` | No (default unset) | When `'1'`, the function reads `__fixtures__/v4-sample.json` instead of hitting the provider. Enables local dev + CI to run without a live API key. | `.env.local`. Already in `.env.example` with a value of `1`. |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Yes | The function-internal supabase client uses service-role to call `acquire_match_sync_lock()` and to UPSERT `matches` + `teams` (RLS write policies for `authenticated` deliberately don't exist — service-role only). | Auto-injected by the Supabase Edge runtime; available via `Deno.env.get(...)` inside the function. |

## Local invocation

### Fixture mode (no API key needed)

```bash
# Terminal 1 — serve the function with fixture mode on:
SYNC_FIXTURE_MODE=1 npx supabase functions serve sync-matches --env-file .env.local
```

```bash
# Terminal 2 — invoke the bootstrap import:
curl -X POST http://127.0.0.1:54321/functions/v1/sync-matches \
  -H "Authorization: Bearer $(npx supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '"')" \
  -H "Content-Type: application/json" \
  -d '{"action":"bootstrap"}'
```

Expected response:

```json
{ "outcome": "success", "integration_run_id": 1, "records_processed": 15, "records_unchanged": 0, "duration_ms": <small> }
```

After a successful bootstrap, `npx supabase db psql -c "SELECT count(*) FROM matches;"` should return `15` (the count of rows in the fixture file; see `__fixtures__/v4-sample.json`).

### Live provider mode

Drop `SYNC_FIXTURE_MODE` from `.env.local` (or set to anything other than `'1'`) and ensure `FOOTBALL_DATA_API_KEY` is set. Invocation is identical; the function fetches from `https://api.football-data.org/v4/competitions/WC/matches` instead of the local fixture.

### `action` values

The function accepts three `action` values per `contracts/edge-sync-matches.md`:

- `bootstrap` — first-time / forced reload. Treats absence of prior data as the default case.
- `incremental-sync` — Phase-5 scheduled cron uses this in production. Behaviour-identical to `manual-resync` at the data level; differs only in the `integration_runs.action` field for operator triage.
- `manual-resync` — admin clicks the action. Routes through `trigger_match_sync()` RPC (or a Next.js Route Handler fallback if `pg_net` is not installed in the deployed environment).

## Concurrency model

The function uses a Postgres advisory lock to serialise concurrent invocations (FR-M23, research.md §R-4):

1. At start of every run, the function calls `acquire_match_sync_lock()` RPC (defined in migration 0015). The RPC returns the result of `pg_try_advisory_lock(hashtext('match-catalog-sync'))`.
2. If the lock is held by another in-flight invocation, the RPC returns `false`. The function short-circuits: it writes an `integration_runs` row with `status='skipped'` and the in-flight run's `started_at` in `error_message` for triage, then returns `{outcome:'skipped'}` immediately.
3. If the lock is acquired, the function proceeds with the sync. The lock is released in a `finally` block via `pg_advisory_unlock(hashtext('match-catalog-sync'))`. If the function crashes before the release, the lock auto-releases when its DB connection closes (the session-scoped fail-safe).

Cross-session concurrency is the case that actually matters in production (e.g. cron and an admin clicking re-sync within seconds of each other). The Playwright spec `e2e/tests/match-sync-concurrent-skipped.spec.ts` (T057) exercises that path end-to-end.

## Deployment

```bash
# Deploy to the linked Supabase project:
npx supabase functions deploy sync-matches

# Set the production secret once:
npx supabase secrets set FOOTBALL_DATA_API_KEY=<the-real-key>
```

Scheduled invocation (hourly cron during the tournament) is **Phase-5 operational-readiness work**, not configured by this feature. The Edge Function code is ready for it; the schedule itself lands later.

## Verifying the lock + idempotency locally

Open two terminals, both with the function already served via `supabase functions serve`. Run the same curl invocation simultaneously:

```bash
# Run in both terminals at the same time:
curl -X POST http://127.0.0.1:54321/functions/v1/sync-matches \
  -H "Authorization: Bearer $(npx supabase status -o env | grep SERVICE_ROLE_KEY | cut -d= -f2 | tr -d '"')" \
  -H "Content-Type: application/json" \
  -d '{"action":"manual-resync"}'
```

One terminal should return `{"outcome":"success", ...}`. The other should return `{"outcome":"skipped", ...}` with `in_flight_run_started_at` populated.

Verify the telemetry:

```bash
npx supabase db psql -c "SELECT action, status, error_message FROM integration_runs ORDER BY started_at DESC LIMIT 3;"
```

You should see one `(manual-resync, success, NULL)` row and one `(manual-resync, skipped, <ISO timestamp>)` row.

For idempotency, run the bootstrap import twice in fixture mode. The second `integration_runs` row should report `records_processed = records_unchanged` (no field changed), confirming the UPSERT diff logic and the `last_synced_at`-only-update path.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `function net.http_post does not exist` when the admin re-sync RPC is invoked | `pg_net` extension not installed on the local Supabase stack (Pro tier+) | Either install `pg_net` (`CREATE EXTENSION pg_net;`) OR use the Next.js Route Handler fallback documented in `contracts/rpc-trigger-match-sync.md` (the admin UI POSTs to the Edge Function URL directly from the browser via a server-side handler). |
| HTTP 401 from the Edge Function | Missing or wrong `Authorization: Bearer <service_role>` header | Re-derive the service-role key with `npx supabase status -o env`. |
| `integration_runs.status='error'` with `error_category='provider.rate-limit'` | Free tier (10 req/min) exhausted — likely from rapid re-runs or a misconfigured cron | Back off (the retry helper at `lib/retry.ts` already respects `Retry-After`); or switch to `SYNC_FIXTURE_MODE=1` for development; in production raise the provider tier or stretch the cron schedule. |
| `acquire_match_sync_lock()` always returns `false` after a crash | A leaked session is still holding the advisory lock | Restart the function (`supabase functions serve` ⇒ Ctrl-C ⇒ restart); or terminate the leaked DB session via the Supabase Studio "Database → Connections" view. |
| Catalog is empty after `bootstrap` even though the function returned success | Check `integration_runs.records_processed` — if zero, the fixture file or provider response is empty. Bad provider_team_id values in the fixture also yield a silent FK failure in the UPSERT. | Diff `__fixtures__/v4-sample.json` `homeTeam.id` / `awayTeam.id` against the `provider_team_id` values in `supabase/migrations/0017_seed_teams.sql`. |

## Cross-references

- HTTP contract: `specs/002-match-catalog-read/contracts/edge-sync-matches.md`
- RPC contracts: `specs/002-match-catalog-read/contracts/rpc-trigger-match-sync.md`
- Retry design: `specs/002-match-catalog-read/research.md` §R-3
- Advisory lock design: `specs/002-match-catalog-read/research.md` §R-4
- Local-dev walkthrough: `specs/002-match-catalog-read/quickstart.md`
