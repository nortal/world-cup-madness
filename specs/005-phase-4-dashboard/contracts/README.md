# Contracts — Feature 005 Dashboard Polish + Mobile UX

This directory documents the read-query, RPC, and Realtime-channel contracts the dashboard relies on. Every contract is either **reused** (from features 001-004 with no change) or **new query** (this feature) — there are no new RPCs or new Realtime channels.

## Contracts

| File | Type | Notes |
|---|---|---|
| `reused-rpc-lock-prediction.md` | RPC (REUSED) | Inline-edit save handler — calls feature 003's existing `lock_prediction()` |
| `reused-realtime-leaderboard-refresh.md` | Realtime channel (REUSED) | Dashboard subscribes to feature 004's existing channel + filter |
| `query-neighborhood.md` | Read query (NEW) | Pool tab — hybrid-clamped ±5 neighborhood slice |
| `query-movers-global.md` | Read query (NEW — needs ratification, see §2.5 of data-model.md) | Pool tab — global top 3 movers in trailing 24 h |
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

## Open ratification

See [`query-movers-global.md`](./query-movers-global.md) — the global-movers section of `MoversWidget` requires either a small SECURITY DEFINER aggregator RPC (one new migration) or scope reduction to neighborhood-movers only. Flagged for user decision before `/ai1st-dev-tasks`.
