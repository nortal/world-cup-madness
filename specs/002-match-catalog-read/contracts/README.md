# Contracts — Match Catalog (002)

Each file in this directory specifies a callable surface introduced by feature 002 and the test obligations that go with it. Phase 2 (`/ai1st-dev-tasks`) turns each contract into a contract test + implementation task pair.

| Contract | File | Caller | Implementation |
|---|---|---|---|
| `set_timezone(p_timezone)` RPC | [`rpc-set-timezone.md`](./rpc-set-timezone.md) | `<TimezoneAutoDetect/>` Client Component (first-sign-in only) | `supabase/migrations/0015_match_rpcs.sql` |
| `update_timezone(p_timezone)` RPC | [`rpc-update-timezone.md`](./rpc-update-timezone.md) | `<TimezonePicker/>` Client Component (`/profile`) | `supabase/migrations/0015_match_rpcs.sql` |
| `trigger_match_sync()` admin RPC | [`rpc-trigger-match-sync.md`](./rpc-trigger-match-sync.md) | Admin route handler (later admin-console feature surfaces it) | `supabase/migrations/0015_match_rpcs.sql` |
| `POST /functions/v1/sync-matches` Edge Function | [`edge-sync-matches.md`](./edge-sync-matches.md) | `trigger_match_sync` RPC + Phase-5 cron + direct ops invocation | `supabase/functions/sync-matches/index.ts` |

**PostgREST reads** (Server Component → `matches` / `teams` / `integration_runs` SELECTs) are not separately contracted — they're auto-generated REST from the schema in [`../data-model.md`](../data-model.md) and gated by RLS per FR-M22. Sample queries are documented inline in [`edge-sync-matches.md`](./edge-sync-matches.md) for completeness.

**Status semantics** (apply uniformly):
- All RPCs return `jsonb` with at minimum `{ outcome: 'success' | 'no-op' | 'triggered' | 'error', ... }`.
- All RPC errors raise Postgres EXCEPTIONs with the appropriate ERRCODE so PostgREST surfaces them as HTTP 4xx with a structured error body.
- All Edge Function responses are HTTP 200 with `{ outcome: 'success' | 'error' | 'skipped', ... }` JSON body, regardless of underlying provider HTTP status. (Provider-side errors are recorded as `outcome='error'` in the response body and as `status='error'` in `integration_runs` — never bubbled as a 5xx from our function.)
