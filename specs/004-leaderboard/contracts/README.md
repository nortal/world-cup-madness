# Contracts: Leaderboard

**Feature**: `004-leaderboard`

Each contract documents the request shape, response shape, error envelope, RLS / authorisation gate, and the side effects (audit emission, MV refresh, audit-log write).

| File | Surface | Caller |
|---|---|---|
| [mv-leaderboard-snapshots.md](./mv-leaderboard-snapshots.md) | Materialised view `leaderboard_snapshots` + `leaderboard_self` companion view | Authenticated participant (RLS-bound) + admin (same surface per FC-L6) |
| [rpc-refresh-leaderboard.md](./rpc-refresh-leaderboard.md) | `refresh_leaderboard()` RPC | Admin (direct) + scoring triggers (feature 003 functions) + pg_cron job |
| [cron-leaderboard-refresh-tick.md](./cron-leaderboard-refresh-tick.md) | `pg_cron` schedule `leaderboard-refresh-tick` | Postgres scheduler |
| [audit-event-leaderboard-refresh.md](./audit-event-leaderboard-refresh.md) | `audit_log.event_type IN ('leaderboard.refresh', 'leaderboard.refresh_failed')` rows | Written by `refresh_leaderboard()`; read by ops dashboards + Realtime subscribers |
| [realtime-channel-leaderboard-snapshots.md](./realtime-channel-leaderboard-snapshots.md) | Supabase Realtime subscription via `audit_log` event proxy (R-2) | Browser (`/leaderboard` page + `<RankWidget/>`) |

All contracts follow the feature 001-003 patterns:
- `SECURITY DEFINER` + explicit `SET search_path = public, pg_temp` to avoid search_path hijacking.
- `REVOKE ALL FROM PUBLIC, authenticated` + targeted `GRANT EXECUTE` to the right role.
- Validate inputs at the entry; `RAISE EXCEPTION` with `ERRCODE` so PostgREST surfaces them as structured HTTP 4xx errors.
- Return `jsonb` shaped `{outcome: 'success' | 'error' | 'skipped', ...}` so the client can branch on `outcome` deterministically.

Error vocabulary (new in feature 004):

| Code | Meaning |
|---|---|
| `FORBIDDEN` | Non-admin caller tried `refresh_leaderboard()` directly. Returned as `errcode 'insufficient_privilege'`. |
| `(outcome=skipped)` | Cron-invoked refresh gated by `should_refresh_leaderboard()` returning false. NOT an error; returns 200 with payload `{outcome: 'skipped', reason: 'gated'}`. |
| `(outcome=error)` | `REFRESH MATERIALIZED VIEW` threw inside the exception block. Returns the SQLSTATE + SQLERRM; scoring still commits (FC-L2). |
