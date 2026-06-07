# Contract — Global movers (24-hour rank delta, all participants) — NEW

**Type**: PostgREST read query + potential SECURITY DEFINER aggregator RPC
**Source target**: `score_events` table + `leaderboard_snapshots` MV
**Status**: NEW — **OPEN RATIFICATION** required (see Open Question below)

## Purpose

Compute the global "Top 3 movers in pool" sub-section of `MoversWidget` — the three participants whose ranks have improved most in the trailing 24 hours, across all active participants (FR-D11 + FR-D12).

## Open question (BLOCKS implementation)

The naive PostgREST aggregation against `score_events` is filtered by `score_events_select_own` RLS, which narrows results to the caller's own rows. This makes a **global** movers calculation impossible without one of:

**Option A (recommended)** — Add migration `0038_movers_24h_rpc.sql` introducing a `get_movers_24h_aggregate()` SECURITY DEFINER function that returns `(participant_id, delta_24h)` rows. The function does no scoring logic, exposes no PII (just participant_id + sum), and is gated to the `authenticated` role.

**Option B** — Drop the global sub-section of FR-D11. Ship only the neighborhood-movers sub-section (computable from the caller's own RLS-filtered events combined with the public `leaderboard_snapshots` projection).

The recommendation is Option A: it's a minimal, well-contained departure from FC-D1 ("zero new schema") that unblocks a high-value engagement widget. The function is read-only, ~15 lines including REVOKE/GRANT, and follows the same pattern as feature 004's `is_pre_tournament()` helper (migration 0036).

If Option A is ratified, this contract documents the resulting RPC and query shape. If Option B is ratified, this contract is deleted and only `query-movers-neighborhood.md` survives.

## Signature (assuming Option A ratification)

### Migration `0038_movers_24h_rpc.sql`

```sql
CREATE OR REPLACE FUNCTION get_movers_24h_aggregate()
RETURNS TABLE (participant_id uuid, delta_24h smallint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT participant_id, COALESCE(SUM(points), 0)::smallint AS delta_24h
  FROM score_events
  WHERE awarded_at >= NOW() - INTERVAL '24 hours'
  GROUP BY participant_id
$$;

REVOKE ALL ON FUNCTION get_movers_24h_aggregate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_movers_24h_aggregate() TO authenticated;

COMMENT ON FUNCTION get_movers_24h_aggregate() IS
  'FR-D11 / FR-D12 helper — global 24-h points delta per participant. SECURITY DEFINER so the dashboard movers widget can aggregate across participants without each one being narrowed by score_events_select_own RLS. Returns no PII (just participant_id + sum).';
```

### Query (Server Component)

```ts
const [{ data: currentRankings }, { data: deltas }] = await Promise.all([
  supabase
    .from('leaderboard_snapshots')
    .select('participant_id, display_name, total_points, rank')
    .eq('stage', 'all')
    .order('rank'),
  supabase.rpc('get_movers_24h_aggregate'),
]);

const movers = computeMovers(currentRankings, deltas).slice(0, 3);
```

### `computeMovers` pure helper

```ts
function computeMovers(
  currentRankings: Array<{ participant_id: string; display_name: string; total_points: number; rank: number }>,
  deltas: Array<{ participant_id: string; delta_24h: number }>,
): MoverRow[] {
  const deltaMap = new Map(deltas.map((d) => [d.participant_id, d.delta_24h]));
  const synthetic = currentRankings.map((r) => ({
    ...r,
    previous_total: r.total_points - (deltaMap.get(r.participant_id) ?? 0),
  }));
  const previousRanks = computeRanks(synthetic, 'previous_total');
  return currentRankings
    .map((r) => ({
      participantId: r.participant_id,
      displayName: r.display_name,
      currentRank: r.rank,
      previousRank: previousRanks.get(r.participant_id)!,
      delta: computeDelta(previousRanks.get(r.participant_id)!, r.rank),
    }))
    .filter((row) => row.delta.direction === 'up')
    .sort((a, b) => b.delta.magnitude - a.delta.magnitude);
}
```

(The `computeDelta` helper is reused from feature 004's `lib/leaderboard/compute-delta.ts`. The `computeRanks` helper is new to `lib/dashboard/`.)

## Invariants

| Invariant | Check |
|---|---|
| Row count from RPC | One row per participant who scored in the last 24 h (≤ 200) |
| Order from `slice(0, 3)` | Top 3 by `delta.magnitude` (climbers only — `direction === 'up'`) |
| Privacy | RPC returns `participant_id` (UUID) + numeric delta — no PII; widget displays `display_name` joined via the `leaderboard_snapshots` data |
| Performance (NFR-D07) | RPC indexed on `score_events_awarded_at_idx`; p95 ≤ 250 ms with 200 participants × ~10 events each |

## Failure modes

| Scenario | Behaviour |
|---|---|
| `deltas` empty (no scoring in last 24 h) | Movers list is empty; widget shows "No movers in the last 24 hours" message |
| Tie between two participants on `delta.magnitude` | Stable sort by `currentRank ASC` (lower rank wins display priority) |
| RPC error | Log + fall back to neighborhood-movers only; render a partial widget |

## Test coverage

- `e2e/tests/dashboard-movers.spec.ts` — TC-D9 (both sections render; deltas correct on a seeded scoring burst)
- `lib/dashboard/__tests__/movers-24h.test.ts` — `computeMovers` pure-helper coverage of all-up, all-down, ties, empty deltas
- `test/pgtap/025_movers_aggregate_rpc.sql` (NEW IF OPTION A RATIFIED) — assert RPC is STABLE, SECURITY DEFINER, returns expected shape, executes in ≤ 250 ms with a 200-participant fixture

## Decision needed

User MUST ratify Option A or Option B before `/ai1st-dev-tasks` generates the implementation tasks. Without ratification, the implementation cannot proceed for the global-movers sub-section.
