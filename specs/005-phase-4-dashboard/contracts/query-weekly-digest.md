# Contract — Weekly digest query (NEW)

**Type**: PostgREST read query (caller-scoped)
**Source target**: `score_events` table
**Status**: NEW — works under existing `score_events_select_own` RLS without schema change

## Purpose

Aggregate the caller's points earned this calendar week (Mon-Sun UTC) for the `DigestWidget` (Pool tab). Returns total points, match count, best single-match score, worst single-match score (FR-D13).

## Signature

```ts
function startOfCurrentWeekUTC(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, …
  const daysSinceMonday = (dayOfWeek + 6) % 7; // 0 if Monday, 6 if Sunday
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}

const { data: events } = await supabase
  .from('score_events')
  .select('points, awarded_at, match_id')
  .eq('participant_id', selfParticipantId) // redundant with RLS, kept for clarity
  .gte('awarded_at', startOfCurrentWeekUTC().toISOString())
  .order('points', { ascending: false });

const summary = computeDigestSummary(events ?? []);
```

## `computeDigestSummary` pure helper

```ts
function computeDigestSummary(events: Array<{ points: number; match_id: string | null }>): DigestSummary {
  const matchEvents = events.filter((e) => e.match_id !== null);
  if (matchEvents.length === 0) {
    return { totalPoints: 0, matchCount: 0, bestSingleScore: null, worstSingleScore: null };
  }
  const totalPoints = matchEvents.reduce((sum, e) => sum + e.points, 0);
  const scores = matchEvents.map((e) => e.points);
  return {
    totalPoints,
    matchCount: matchEvents.length,
    bestSingleScore: Math.max(...scores),
    worstSingleScore: Math.min(...scores),
  };
}
```

`match_id IS NULL` filter excludes final-prediction events (FR-D13 covers match scores only per the spec's intent — finals are scored in one batch at tournament end).

## Invariants

| Invariant | Check |
|---|---|
| Time window | `awarded_at >= startOfCurrentWeekUTC()` AND `awarded_at < startOfCurrentWeekUTC() + 7 days` (implicit upper bound = now()) |
| Row count | 0-20 typical (~1-2 matches per day × 7 days) |
| RLS | Caller's own events only; `participant_id = selfParticipantId` filter is defensive |
| First-of-week edge | If `now()` is Monday 00:01 UTC, window starts at today 00:00 UTC |
| Tournament-start edge | If the tournament begins mid-week (e.g. Tuesday), this week's digest covers Tuesday through Sunday only — there's no synthesised "would-have-been-Monday" zero — first week's digest is naturally short |

## Failure modes

| Scenario | Behaviour |
|---|---|
| No events this week | `summary = { totalPoints: 0, matchCount: 0, bestSingleScore: null, worstSingleScore: null }`; widget shows "No matches scored yet this week" message |
| All events have `match_id IS NULL` (only final-prediction events) | Same as above — match-only filter excludes them |
| Pre-tournament (FR-D14) | `DigestWidget` short-circuits to `<PreTournamentPlaceholder/>` before issuing the query |

## Test coverage

- `e2e/tests/dashboard-digest.spec.ts` — TC-D10 (seed events across the week, verify total/count/best/worst)
- `lib/dashboard/__tests__/weekly-digest.test.ts` — `startOfCurrentWeekUTC` (boundary days Sunday/Monday) + `computeDigestSummary` (zero events, one event, mixed final-prediction events, ties on best/worst)
