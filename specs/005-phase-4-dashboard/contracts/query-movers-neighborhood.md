# Contract — Neighborhood movers (24-hour rank delta, within ±5 window) — NEW

**Type**: PostgREST read query (no new RPC)
**Source target**: `score_events` table (RLS-narrowed to caller) + `leaderboard_snapshots` slice from `query-neighborhood.md`
**Status**: NEW — works under existing RLS without new schema

## Purpose

Compute the "Top 3 movers near you" sub-section of `MoversWidget` — the three participants within the user's ±5 neighborhood whose ranks have improved most in the trailing 24 hours (FR-D11). Restricted scope means this query CAN run under existing `score_events_select_own` RLS combined with the neighborhood slice — no SECURITY DEFINER RPC required.

## Approach

The neighborhood already gives us the 11 (or fewer) `participant_id` values to consider. We then ask the existing global-movers result (`query-movers-global.md` Option A) filtered to those IDs:

```ts
const neighborhoodIds = neighborhoodRows.map((r) => r.participant_id);
const neighborhoodMovers = globalMovers.filter((m) => neighborhoodIds.includes(m.participantId)).slice(0, 3);
```

**If Option A is rejected** (no SECURITY DEFINER RPC for global movers): the neighborhood-movers section CAN still ship by querying `score_events` filtered to the neighborhood participant IDs directly. But the RLS policy only returns the caller's own events — meaning this fallback path effectively shows "you yourself moved" if you're in the top 3, and nothing else. **This fallback path is degraded and recommended only if Option B (neighborhood-only) is chosen and the user accepts the further degradation.**

## Signature (assuming Option A ratification — preferred)

```ts
// After the global movers have been computed (query-movers-global.md):
const neighborhoodIdSet = new Set(neighborhoodRows.map((r) => r.participant_id));
const neighborhoodMovers = globalMovers.filter((m) => neighborhoodIdSet.has(m.participantId)).slice(0, 3);
```

No additional PostgREST round-trip required — derived in JS from the global-movers output + the neighborhood window output.

## Signature (Option B fallback — degraded path)

```ts
// Without the SECURITY DEFINER RPC, we can only see the caller's own events.
// The "neighborhood movers" section degrades to "you, if you moved up."
const { data: ownDeltas } = await supabase
  .from('score_events')
  .select('participant_id, points.sum()')
  .gte('awarded_at', new Date(Date.now() - 86_400_000).toISOString())
  .single();

const neighborhoodMovers = ownDeltas
  ? [{ ... computeMover(selfRow, ownDeltas) }]
  : [];
```

## Invariants

| Invariant | Check |
|---|---|
| Row count | `≤ 3` always |
| Scope | All `participantId` values present in the result MUST be in the current neighborhood window |
| Order | By `delta.magnitude DESC`, secondary stable-sort by `currentRank ASC` |
| RLS | Under Option A, the `get_movers_24h_aggregate()` RPC handles the cross-participant aggregation. Under Option B, the caller sees only their own data |

## Failure modes

| Scenario | Behaviour |
|---|---|
| No movers in neighborhood (everyone stable or descending) | Section shows "No movers near you" message |
| Caller is themselves in the top 3 | Caller's own row is included (self-row visual highlight applies) |
| Neighborhood window collapses to small-pool mode (< 11 participants) | Section still renders; may have < 3 movers |

## Test coverage

- `e2e/tests/dashboard-movers.spec.ts` — TC-D9 second sub-section assertion ("Top 3 near you" matches expected participant IDs given a seeded scoring burst)
- `lib/dashboard/__tests__/movers-24h.test.ts` — coverage of the neighborhood-filter derivation
