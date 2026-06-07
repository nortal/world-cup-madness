# Contract — Last finished prediction query (NEW)

**Type**: PostgREST read query (caller-scoped + joins)
**Source target**: `predictions` JOIN `matches` JOIN `teams` LEFT JOIN `score_events`
**Status**: NEW — works under existing RLS

## Purpose

Surface the participant's most-recent prediction on a finished match (with the team names + actual score + points awarded) for the "last" card of `SnapshotWidget` (Today tab, FR-D09).

## Signature

PostgREST supports embedded resource selection — single round-trip:

```ts
const { data: last } = await supabase
  .from('predictions')
  .select(`
    predicted_home_score,
    predicted_away_score,
    matches!inner(
      id,
      kickoff_utc,
      status,
      score_home,
      score_away,
      home_team:home_team_id ( name ),
      away_team:away_team_id ( name )
    ),
    score_events ( points )
  `)
  .eq('participant_id', selfParticipantId)
  .eq('matches.status', 'finished')
  .order('matches.kickoff_utc', { ascending: false })
  .limit(1)
  .maybeSingle();
```

Result shape (after the embedded resolution):
```ts
{
  predicted_home_score: 1,
  predicted_away_score: 0,
  matches: {
    id: 'uuid',
    kickoff_utc: '2026-06-15T14:00:00Z',
    status: 'finished',
    score_home: 1,
    score_away: 1,
    home_team: { name: 'England' },
    away_team: { name: 'France' },
  },
  score_events: [{ points: 5 }] // empty array if no scoring event for this participant on this match
}
```

The `score_events` embed is filtered implicitly by RLS to the caller's own row (or empty if no score yet).

## Invariants

| Invariant | Check |
|---|---|
| Row count | 0 or 1 (`limit(1)` + `maybeSingle()`) |
| Caller scope | `participant_id = selfParticipantId` + RLS — caller only |
| Most-recent definition | `matches.status = 'finished'` AND order by `kickoff_utc DESC` |
| Points fallback | If `score_events` embed is empty, points awarded = 0 (defensive) |

## Failure modes

| Scenario | Behaviour |
|---|---|
| No finished match predicted by caller | Result is `null`; widget shows "No predictions on finished matches yet" message in the "last" card |
| Match finished but no scoring event yet (admin hasn't approved or trigger hasn't fired) | `score_events: []` → points awarded = 0 — widget shows "Awaiting scoring" pill below the prediction |
| Pre-tournament (no finished matches at all) | Result is `null`; widget shows the pre-tournament placeholder |

## Test coverage

- `e2e/tests/dashboard-mobile-tabs.spec.ts` (TC-D1) — Today tab Snapshot widget renders the "last" card
- `e2e/tests/dashboard-pre-tournament.spec.ts` (TC-D11) — pre-tournament state hides the "last" card content + shows placeholder
