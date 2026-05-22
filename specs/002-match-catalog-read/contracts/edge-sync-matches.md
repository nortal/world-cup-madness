# Contract — `POST /functions/v1/sync-matches` Edge Function

**Spec source**: FR-M03, FR-M18, FR-M19, FR-M20, FR-M23, NFR-M5
**Implementation**: `supabase/functions/sync-matches/index.ts`
**Callers**:
1. `trigger_match_sync()` admin RPC (via `pg_net` HTTP POST) — `action='manual-resync'`
2. Phase 5 cron (Supabase pg_cron job) — `action='incremental-sync'`
3. Direct ops invocation (curl, deploy hooks) — `action='bootstrap'` for first-time setup

## Purpose

Fetch the latest match data from football-data.org v4, normalise into our schema, upsert into `matches` + `teams`, and record telemetry to `integration_runs`. Serialise concurrent invocations via Postgres advisory lock (FR-M23).

## Endpoint

```
POST {SUPABASE_URL}/functions/v1/sync-matches
```

## Request

### Headers

| Header | Value | Required |
|---|---|---|
| `Authorization` | `Bearer {SUPABASE_SERVICE_ROLE_KEY}` | Yes — function is service-role-only |
| `Content-Type` | `application/json` | Yes |

### Body

```json
{
  "action": "bootstrap" | "incremental-sync" | "manual-resync"
}
```

`action` defaults to `"incremental-sync"` when omitted. Differences between actions:
- `bootstrap`: Forces re-fetch of all matches regardless of `last_synced_at`. Treats absence as "no prior import" — used once per deploy or when seeding from a clean DB.
- `incremental-sync`: Fetches all matches but only UPDATEs rows whose provider fields differ from our stored values. Used by cron + manual re-sync.
- `manual-resync`: Identical to `incremental-sync` at the data level; the value flows into `integration_runs.action` for operator triage (R-7).

## Response

Always `HTTP 200` (even on provider errors — those are recorded as `outcome='error'` in the body). The function only returns non-2xx for malformed requests or unauthenticated callers.

### Successful run

```json
{
  "outcome": "success",
  "integration_run_id": 142,
  "records_processed": 104,
  "records_unchanged": 100,
  "duration_ms": 1820
}
```

### Skipped (advisory-lock contention per FR-M23)

```json
{
  "outcome": "skipped",
  "integration_run_id": 143,
  "reason": "another sync is already in flight",
  "in_flight_run_started_at": "2026-06-15T13:00:00Z"
}
```

### Provider or normalisation error

```json
{
  "outcome": "error",
  "integration_run_id": 144,
  "error_category": "provider.5xx" | "provider.4xx" | "provider.rate-limit" | "normalisation.invalid-status" | "db.upsert-failed",
  "error_message": "..."
}
```

## Authentication errors (non-2xx)

| Condition | HTTP status |
|---|---|
| Missing or invalid `Authorization` header | 401 |
| Body is not valid JSON | 400 |
| `action` is not one of the three allowed values | 400 |

## Behavior

```
1. Parse + validate request body
2. Acquire advisory lock:
     RPC supabase.rpc('acquire_match_sync_lock') → boolean
   IF false:
     - Look up the in-flight integration_runs row (most recent
       with finished_at IS NULL) to surface its started_at
     - INSERT integration_runs row:
         { provider: 'football-data.org', action,
           started_at: now(), finished_at: now(),
           status: 'skipped', records_processed: 0,
           records_unchanged: 0,
           error_message: 'blocked by run started at <ISO ts>' }
     - Return { outcome: 'skipped', ... }
3. INSERT integration_runs row:
     { provider: 'football-data.org', action,
       started_at: now(), finished_at: NULL, status: 'success' (placeholder),
       records_processed: 0, records_unchanged: 0 }
   Capture id as v_run_id.
4. fetchMatches() from provider/football-data-v4.ts:
     - GET https://api.football-data.org/v4/competitions/WC/matches
     - X-Auth-Token: <FOOTBALL_DATA_API_KEY>
     - Apply lib/retry.ts (exponential backoff + Retry-After respect)
   IF all retries exhausted or non-retryable error:
     - UPDATE integration_runs SET finished_at=now(), status='error',
       error_message=<message>, error_category derived from response
     - pg_advisory_unlock(...)
     - Return { outcome: 'error', error_category, error_message }
5. Normalise provider response → MatchRow[] + TeamRow[]:
     - Map provider statuses per data-model.md R-1 table
     - Validate stage + group consistency
     - On any unrecognised status: log + skip that match (do NOT fail
       the entire sync; record records_unchanged increment)
6. UPSERT teams (ON CONFLICT (provider_team_id) DO UPDATE):
     - Compute records_processed/records_unchanged from upsert results
7. UPSERT matches (ON CONFLICT (provider_id) DO UPDATE):
     - Field-level diff: only UPDATE rows where any of (status, kickoff_utc,
       score_home, score_away, venue) differ. Track unchanged-count
     - Set last_synced_at = now() unconditionally (so operators can see
       freshness even when no fields changed)
8. UPDATE integration_runs SET finished_at=now(), status='success',
     records_processed=<count>, records_unchanged=<count>
9. pg_advisory_unlock(hashtext('match-catalog-sync'))
10. Return { outcome: 'success', integration_run_id: v_run_id, ... }
```

The advisory lock release in step 9 happens whether sync succeeded or errored. Edge Function crash before step 9 → lock auto-releases on connection close (R-4 fail-safe).

## Sample PostgREST queries (for documentation only — driven from Server Components)

```sql
-- /matches page query (per-locale variant; cache key includes participant_tz):
SELECT m.*, ht.name AS home_team_name, ht.tla AS home_team_tla,
              at.name AS away_team_name, at.tla AS away_team_tla
  FROM matches m
  JOIN teams ht ON ht.id = m.home_team_id
  JOIN teams at ON at.id = m.away_team_id
 WHERE (status != 'scheduled-tbd' OR ?stage=<value>)  -- TBD matches included only on stage-filtered views
 ORDER BY kickoff_utc ASC NULLS LAST;

-- Dashboard widget query:
SELECT m.*, ht.name AS home_team_name, ht.tla AS home_team_tla,
              at.name AS away_team_name, at.tla AS away_team_tla
  FROM matches m
  JOIN teams ht ON ht.id = m.home_team_id
  JOIN teams at ON at.id = m.away_team_id
 WHERE m.status = 'scheduled'
   AND m.kickoff_utc > now() + INTERVAL '60 minutes'
 ORDER BY m.kickoff_utc ASC
 LIMIT 3;

-- /matches/[id] detail query:
SELECT m.*, ht.name AS home_team_name, ht.tla AS home_team_tla,
              at.name AS away_team_name, at.tla AS away_team_tla
  FROM matches m
  JOIN teams ht ON ht.id = m.home_team_id
  JOIN teams at ON at.id = m.away_team_id
 WHERE m.id = $1;
```

All three queries run under the participant's session JWT and are gated by the `matches_select_eligible` + `teams_select_eligible` RLS policies (FR-M22).

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `FOOTBALL_DATA_API_KEY` | Yes (deployed envs); No (local dev with fixture mode) | Provider auth header |
| `FUNCTION_URL` | No (auto-detected from Supabase env) | Used only by `trigger_match_sync` RPC |
| `SYNC_FIXTURE_MODE` | No (local dev only) | When set to `"1"`, function reads from `__fixtures__/v4-sample.json` instead of hitting the provider — lets local dev + CI work without an API key |

## Idempotency contract

After N consecutive invocations with unchanged provider data:
- `matches` row count is constant
- `teams` row count is constant
- Each match's `last_synced_at` is updated to the latest invocation's timestamp
- No match field values change
- N `integration_runs` rows exist, each with `records_processed = 104, records_unchanged = 104` (full provider count, all unchanged)
- pgTAP test `009_sync_idempotency.sql` asserts this directly.

## Rate-limit contract (NFR-M5)

- Bootstrap: 1 fetch call to provider
- Incremental sync: 1 fetch call to provider (v4 returns all matches in one envelope)
- Manual re-sync: 1 fetch call to provider
- Worst case: cron + 2 admin clicks within 6 seconds → 1 actual fetch (others get skipped) → 1 / 60s = well within 10 req/min
- Retry on 429 with `Retry-After` respect → never amplifies provider load

## Test obligations

1. **Idempotency (pgTAP `009_*`)**: Run sync via direct DB-side invocation with fixture mode, assert idempotency contract above.
2. **Advisory lock contention (Playwright `match-sync-concurrent-skipped.spec.ts` → TC-M14)**: Trigger two manual-resyncs back-to-back; assert the second returns `outcome='skipped'` and `integration_runs` has a `skipped` row.
3. **Provider error handling (manual test + log assertion in `match-sync-admin.spec.ts`)**: Stub the provider to return 500; assert function returns `{outcome:'error', error_category:'provider.5xx', ...}` and writes corresponding `integration_runs` row; catalog unchanged.
4. **Provider rate limit**: Stub provider to return 429 with `Retry-After: 2`; assert retry helper waits the right amount and eventually succeeds.
5. **Fixture mode**: Set `SYNC_FIXTURE_MODE=1`, assert sync completes without an API key.
6. **Audit row format (pgTAP `009_*` + `match-sync-admin.spec.ts`)**: Assert every `integration_runs` row has all required columns populated per data-model.md spec.
