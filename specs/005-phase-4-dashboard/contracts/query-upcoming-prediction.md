# Contract — Upcoming match + prediction query (NEW)

**Type**: PostgREST read query (caller-scoped + joins)
**Source target**: `matches` LEFT JOIN `predictions` LEFT JOIN `teams`
**Status**: NEW — works under existing RLS

## Purpose

Surface the next upcoming match metadata + the caller's current prediction (or null) for:
1. The "next" card of `SnapshotWidget` (Today tab, FR-D09)
2. The pre-fill values for `ExpandableMatchCard`'s inline `InlinePredictionForm` (Today tab, FR-D06)

Single source of truth — both surfaces use this query result.

## Signature

```ts
const { data: upcoming } = await supabase
  .from('matches')
  .select(`
    id,
    kickoff_utc,
    status,
    home_team:home_team_id ( name ),
    away_team:away_team_id ( name ),
    predictions ( predicted_home_score, predicted_away_score )
  `)
  .neq('status', 'cancelled')
  .gt('kickoff_utc', new Date().toISOString())
  .eq('predictions.participant_id', selfParticipantId)
  .order('kickoff_utc', { ascending: true })
  .limit(1)
  .maybeSingle();
```

Result shape:
```ts
{
  id: 'uuid',
  kickoff_utc: '2026-06-18T15:00:00Z',
  status: 'scheduled',
  home_team: { name: 'Brazil' },
  away_team: { name: 'Germany' },
  predictions: [{ predicted_home_score: 2, predicted_away_score: 1 }] // empty array if no pick yet
}
```

The `predictions` embed is filtered to the caller via the `eq('predictions.participant_id', selfParticipantId)` PostgREST filter — embedded resources support filter pushdown.

## Invariants

| Invariant | Check |
|---|---|
| Row count | 0 or 1 |
| Status filter | `status != 'cancelled'` AND `status != 'finished'` (the `kickoff_utc > now()` gate excludes finished matches implicitly since live/finished kickoffs are in the past) |
| Lock status | Computed by the consumer: `kickoff_utc - now() > 60 min` → editable; otherwise locked |
| Caller scope | Predictions embed is filtered to the caller; the match itself is visible to all eligible participants (existing `matches_select_eligible` RLS) |

## Failure modes

| Scenario | Behaviour |
|---|---|
| No upcoming match (tournament over or no matches in the future) | Result is `null`; `SnapshotWidget` "next" card shows "No upcoming matches" message; `ExpandableMatchCard` is disabled (no expand affordance) |
| Upcoming match exists but caller has no prediction (`predictions: []`) | Widget shows "No pick yet" prompt; inline form opens empty |
| Match transitions to locked (kickoff < 60 min away) between page render and click | Server already includes the lock status; if the user expands and tries to save, the existing `lock_prediction()` RPC returns `outcome='locked'` and the inline form surfaces `errorLocked` |
| Multiple upcoming matches | The single nearest one (lowest `kickoff_utc`) is returned; widget shows only this match. (Future Phase 4 extension may add a "Next 5 matches" carousel — out of scope here.) |

## Test coverage

- `e2e/tests/dashboard-mobile-tabs.spec.ts` (TC-D1) — Today tab Snapshot "next" card renders with team names + prediction OR "No pick yet"
- `e2e/tests/dashboard-inline-edit.spec.ts` (TC-D3) — Inline-edit opens with the prediction values pre-filled from this query result
- `e2e/tests/dashboard-pre-tournament.spec.ts` (TC-D11) — No upcoming match → widget shows the no-upcoming-matches message
