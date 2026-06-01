# Contract — `trigger_match_sync()` admin RPC

**Spec source**: FR-M18
**Implementation**: `supabase/migrations/0015_match_rpcs.sql`
**Caller**: Admin re-sync route — exact path deferred to a future admin-console feature per spec §5 Deferred Decisions. For feature 002, callable via direct PostgREST RPC invocation from a service-role-keyed local-dev tool (e.g. `curl` against `/rest/v1/rpc/trigger_match_sync`).

## Purpose

Allow an authenticated admin participant to invoke the catalog-sync Edge Function from the database layer (rather than the admin browser tab calling the Edge Function URL directly). Centralises authorization (RLS-equivalent gate via `is_admin_user()`) and produces a single audit trail entry per trigger event.

## Signature

```sql
trigger_match_sync() RETURNS jsonb
```

## Authentication + Authorization

`GRANT EXECUTE TO authenticated`, but the function body opens with:

```sql
IF NOT is_admin_user() THEN
  RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege';
END IF;
```

The `is_admin_user()` helper from feature 001 (migration 0010) wraps the admin-check in SECURITY DEFINER to avoid the recursive RLS problem. Non-admin authenticated callers get HTTP 401 from PostgREST.

## Behavior

```
1. Verify caller is an admin (above).
2. Issue HTTP POST to the Edge Function URL via pg_net:
   net.http_post(
     url := <FUNCTION_URL>/sync-matches,
     body := jsonb_build_object('action', 'manual-resync'),
     headers := jsonb_build_object(
       'Authorization', 'Bearer ' || <service_role_jwt>,
       'Content-Type', 'application/json'
     ),
     timeout_milliseconds := 60000
   )
3. RETURN jsonb_build_object(
     'outcome', 'triggered',
     'request_id', <pg_net request id>
   )
```

**`pg_net` extension dependency:** Available on Supabase Pro tier and above. On the free tier and local dev, `pg_net` may not be available — fallback documented in plan.md §"Phase 1 design moves" is to have the admin UI call the Edge Function URL directly from the browser via a service-role-keyed Next.js Route Handler (`app/admin/match-sync/route.ts`). That fallback shifts authorization to the Route Handler (Next.js Server Component reads the participant role from RLS, then uses service-role to invoke the Edge Function). Decision between the two paths happens during implementation based on what's available in the deployed environment.

## Response shape

```json
{ "outcome": "triggered", "request_id": 42 }
```

The `request_id` is `pg_net`'s internal request id; admins can correlate to the eventual `integration_runs` row by `started_at` proximity.

## Important: NOT the source of truth for sync outcome

This RPC fires-and-forgets. The actual sync outcome (success / error / skipped) is reported by the Edge Function into `integration_runs`. The admin UI should poll `SELECT * FROM integration_runs WHERE action='manual-resync' ORDER BY started_at DESC LIMIT 1` to surface the eventual outcome.

## Error responses

| Postgres ERRCODE | HTTP status | When |
|---|---|---|
| `42501` insufficient_privilege | 401 | Caller is not an admin |
| `42704` undefined_function | 500 | pg_net not installed — log + tell operator to use the Route Handler fallback |

## Test obligations

1. **Non-admin caller (pgTAP `003_*` extended)**: Sign in as a participant with `role = 'participant'`, call `trigger_match_sync()`, assert `insufficient_privilege` raised.
2. **Admin caller (Playwright `match-sync-admin.spec.ts` → TC-M11)**: Sign in as admin, invoke RPC, wait for `integration_runs` row to appear with `action='manual-resync'`, assert telemetry shape.
3. **pg_net unavailable**: Stub `net.http_post` to raise `undefined_function`; assert the RPC raises a usable error (or wrap in `BEGIN/EXCEPTION/RAISE NOTICE`-style fallback — TBD during implementation).
