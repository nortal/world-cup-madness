# Contracts — Feature 005 Dashboard Polish + Mobile UX

This directory documents the read-query, RPC, and Realtime-channel contracts the dashboard relies on. Every contract is either **reused** (from features 001-004 with no change) or **new query** (this feature) — there are no new RPCs or new Realtime channels.

## Contracts

| File | Type | Notes |
|---|---|---|
| `reused-rpc-lock-prediction.md` | RPC (REUSED) | Inline-edit save handler — calls feature 003's existing `lock_prediction()` |
| `reused-realtime-leaderboard-refresh.md` | Realtime channel (REUSED) | Dashboard subscribes to feature 004's existing channel + filter |
| `query-neighborhood.md` | Read query (NEW) | Pool tab — hybrid-clamped ±5 neighborhood slice |
| `query-movers-global.md` | Read query (NEW) + migration 0038 (NEW — read-only SECURITY DEFINER aggregator, ratified 2026-06-07) | Pool tab — global top 3 movers in trailing 24 h |
| `query-movers-neighborhood.md` | Read query (NEW) | Pool tab — top 3 movers within user's ±5 neighborhood |
| `query-weekly-digest.md` | Read query (NEW) | Pool tab — current-week totals + best + worst |
| `query-last-finished-prediction.md` | Read query (NEW) | Today tab — Snapshot widget "last" card |
| `query-upcoming-prediction.md` | Read query (NEW) | Today tab — Snapshot widget "next" card + inline-edit pre-fill |

## Conventions

All contracts follow this layout:

1. **Purpose** — what the contract delivers + which widget consumes it
2. **Signature** — for queries: SQL shape; for RPCs: function signature; for Realtime: channel name + filter + payload shape
3. **Invariants** — RLS, GRANT, ordering, row-count expectations
4. **Failure modes** — what can go wrong + how widgets should degrade
5. **Test coverage** — which Playwright spec exercises this contract end-to-end

## Ratifications

- **2026-06-07** — Option A ratified for the global-movers global aggregation. Migration `0038_movers_24h_rpc.sql` (read-only SECURITY DEFINER aggregator, `authenticated` GRANT only) is in scope. See [`query-movers-global.md`](./query-movers-global.md) for the SQL definition and `spec.md` FC-D1 for the carve-out language.
