# Phase 0 Research — Feature 005 Dashboard Polish + Mobile UX

**Branch**: `005-phase-4-dashboard`
**Date**: 2026-06-06
**Status**: Complete

This document resolves six design unknowns before Phase 1 contracts + data model. Each entry follows: Decision → Rationale → Alternatives considered → Source.

---

## R-1: Inline expand pattern on the upcoming-match widget

**Decision**: React state (`useState<boolean>`) gating the inline form's render, with `<button aria-expanded>` toggle on the visible card header. No HTML `<details>` element. Tailwind transitions (`transition-all duration-200 ease-in-out`) handle the collapse/expand animation; `max-h-0` / `max-h-screen` swap drives the visual reveal.

**Rationale**: `<details>` carries default browser styling (the disclosure triangle) that conflicts with the visual idiom of the existing match cards and would require shadow-DOM workarounds to override. React state + `aria-expanded` is the WAI-ARIA Authoring Practices "Disclosure" pattern — already familiar to anyone who reviewed feature 004's `ShowMyRankButton`. The Tailwind max-height approach avoids JS-measured height calculations (which can trigger layout shift, breaking NFR-D05 CLS ≤ 0.1) by using CSS transitions with bounded values.

**Alternatives considered**:
- `<details>`/`<summary>` HTML: fails on visual control + default UI clash.
- Headless UI `Disclosure` component: adds a new dependency for a pattern we can express inline.
- `display: none` toggle: causes the entire card to jump on first interaction (CLS spike).

**Source**: Manual decision based on WAI-ARIA Authoring Practices (Disclosure pattern) + the constitution-frontend.md anti-pattern guidance against introducing new dependencies for trivial UI.

---

## R-2: Stale-while-revalidate refresh pattern

**Decision**: Extend feature 004's `LeaderboardRealtime` pattern. The new `DashboardRealtime` Client wrapper holds the widget-data state in `useState`, subscribes to `leaderboard-refresh`, and on each debounced event triggers `refetch()`. During the in-flight fetch (Promise pending), the wrapper sets `isRefetching=true`; React renders the existing widgets unchanged and mounts `<RefreshingChip visible={true}/>`. On Promise resolution, state is swapped atomically (no intermediate empty state) and `isRefetching=false`.

**Rationale**: This is the SWR (stale-while-revalidate) HTTP-cache idea applied at the React-state level. Zero layout shift because the widget subtree never unmounts. The chip carries `role="status"` so screen readers get a polite announcement without yanking focus. Familiar implementation — `LeaderboardRealtime` already manages a `reconnecting` flag via a `setTimeout` ref, so this is one additional flag.

**Alternatives considered**:
- `useTransition` from React 18: not designed for arbitrary-async state updates; built for concurrent rendering of UI changes.
- SWR library or React Query: adds a dependency and orchestration layer for what amounts to one debounced timer + two state values. Overkill.
- Optimistic UI (assume the refresh succeeded before the network round-trips): inappropriate here because we don't know what changed until the refetch arrives.

**Source**: Manual extension of feature 004's existing `components/leaderboard/LeaderboardRealtime.tsx` design. See feature 004 spec §FR-L18 + the related contract `contracts/realtime-channel-leaderboard-snapshots.md`.

---

## R-3: Mobile-only tab strip via Tailwind responsive utilities

**Decision**: Render the tab strip with `className="block md:hidden …"`. Render the desktop grid with `className="hidden md:grid md:grid-cols-2 …"`. Use Next.js `searchParams.tab` for the active-tab read; both layouts use the same parsed value (no separate state).

**Rationale**: Tailwind's `md:` breakpoint (768 px) maps directly to the spec's mobile/desktop split (FR-D01, FR-D05). The `block md:hidden` + `hidden md:grid` pattern is the canonical mobile-only/desktop-only render in Tailwind 4. No JavaScript media-query listener needed; CSS does the work. Layout is server-rendered with both versions present in the DOM (one always hidden), so there's no flicker during hydration when switching viewport size mid-session.

**Alternatives considered**:
- `useMediaQuery` hook (`@react-hook/media-query`): server-rendering can't run the hook; first paint would be wrong on the wrong viewport.
- Single rendered widget grid that adapts via CSS Grid: blurs the "Today" vs "Pool" tab boundary spec asks for at mobile. Less clear UX.
- CSS container queries: not yet a polish requirement; viewport-level `md:` is fine.

**Source**: Tailwind 4 docs + constitution-frontend.md §IV (UI patterns) "Server Components by default."

---

## R-4: 24-hour movers query design

**Decision**: A single PostgREST round-trip combining two queries via `Promise.all`:

```ts
// Query A — current rankings (already cached via leaderboard_snapshots)
const current = await supabase
  .from('leaderboard_snapshots')
  .select('participant_id, display_name, total_points, rank, rank_is_shared')
  .eq('stage', 'all')
  .order('rank');

// Query B — sum of points awarded in the last 24h, per participant
const recentDeltas = await supabase
  .from('score_events')
  .select('participant_id, points.sum()')
  .gte('awarded_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
  .order('participant_id'); // server-side; client doesn't need ordering
```

Then derive `previous_total = current.total_points - recent_delta.sum` per participant and re-rank in JS (the `computeMovers` pure helper). Sort the synthetic "24h ago" ranks and compute deltas via `compute-delta.ts` from feature 004.

**Rationale**: Both queries hit existing indexes — Query A on `leaderboard_snapshots.stage_rank` index, Query B on `score_events_awarded_at_idx` (DESC index already in place). With 200 participants × ~10 events each over 24h, Query B returns ~2000 rows at most. The aggregation `points.sum()` is PostgREST's `count` syntax extended for sum; if PostgREST emits a `400` because of an unfamiliar aggregator, fall back to a single PostgREST `select('participant_id, points')` and aggregate in JS (still well under 2000-row scan).

**Performance estimate**: Query A ≈ 30 ms (already verified by feature 004's pgTAP 020 — 50 participants in 11 ms; linear extrapolation → ~45 ms for 200). Query B ≈ 50 ms with the indexed range scan. Combined p95 ≈ 100-150 ms, well under NFR-D07's 250 ms.

**Alternatives considered**:
- A SECURITY DEFINER RPC encapsulating both queries server-side: adds migration cost (new function, new pgTAP tests) for a single-page-read shape. Reserve as the escape hatch per the deferred-decisions §1 in spec.md.
- Persistent `leaderboard_history` snapshot table: explicitly deferred per FC-D1 + Deferred Decisions §1.
- Materialised view for 24h windowing: introduces fresh-refresh-staleness concerns identical to the leaderboard MV. Not warranted at this scope.

**Source**: PostgREST aggregation docs + feature 004 pgTAP 020 timing baselines + manual EXPLAIN-style estimate using existing indexes.

---

## R-5: Weekly digest query design

**Decision**: One PostgREST query:

```ts
const events = await supabase
  .from('score_events')
  .select('points, awarded_at, match_id')
  .eq('participant_id', selfParticipantId)
  .gte('awarded_at', startOfCurrentWeekUTC().toISOString())
  .order('points', { ascending: false });
```

The cutoff `startOfCurrentWeekUTC()` is computed in JS as:
```ts
function startOfCurrentWeekUTC(now = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // 0 if Monday, 1 if Tuesday, …, 6 if Sunday
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}
```

The `computeDigestSummary` pure helper then aggregates the returned events into `{total, count, best, worst}`. Filtering happens server-side (avoid pulling unrelated events); aggregation happens client-side (single small array, < 50 events per participant per week).

**Rationale**: Server-side aggregation via PostgREST would require either a SECURITY DEFINER RPC or PostgREST's experimental aggregate-in-select syntax. The dataset per participant per week is small (~7-20 events at most — one tournament match per day during group stage), so client-side aggregation is trivial. The week cutoff in JS uses the standard "days-since-Monday" idiom and avoids timezone bugs by working purely in UTC (the spec mandates Mon-Sun UTC per Round 1 clarification).

**Alternatives considered**:
- Postgres `date_trunc('week', now() at time zone 'UTC')`: would require an RPC since `awarded_at >= …` filter via PostgREST needs a static value. The JS-computed cutoff is equally precise.
- A `SECURITY DEFINER` aggregator function: same RPC-cost-vs-read concern as movers (R-4). Defer.

**Source**: Standard JS Date arithmetic + feature 004 pgTAP 023 patterns for week-boundary timing.

---

## R-6: Refreshing chip surface

**Decision**: Mount `<RefreshingChip>` inside the page header rendered by the Server Component composer (`DashboardPage.tsx`), with the chip's `visible` prop driven by the `DashboardRealtime` Client wrapper that wraps the entire widget grid. Use React Context — `<DashboardRefreshContext.Provider value={{isRefetching}}>` — so the `RefreshingChip` and `DashboardRealtime` don't need to be siblings in the DOM tree (header is above the grid; provider lives at the page root).

**Rationale**: The chip's position (page header, top right) is constant across mobile and desktop layouts. Lifting `isRefetching` into a Context keeps the chip co-located with the header markup (where it visually belongs) without requiring it to be rendered inside `DashboardRealtime`. The provider is a one-line Client Component that takes the `[isRefetching, setRefetching]` tuple from `DashboardRealtime` and exposes it to the chip.

**Alternatives considered**:
- Render the chip inside `DashboardRealtime` and absolutely-position it: causes z-index headaches with the page header + adds positioning concerns to a state-management component.
- Use a global store (Zustand, Jotai): heavy for one boolean.
- Render the chip as a portal: works but introduces the React portal lifecycle into a component that's already managing channel subscriptions.

**Source**: React Context patterns + the constitution-frontend.md §V (state management) preference for "React hooks + Supabase Realtime" over external state stores.

---

## Summary

| Research item | Decision | Status |
|---|---|---|
| R-1 Inline expand | React state + `aria-expanded` + Tailwind `max-h` transitions | Resolved |
| R-2 Stale-while-revalidate | Extend feature 004's `LeaderboardRealtime` pattern with `isRefetching` flag | Resolved |
| R-3 Tab strip | Tailwind `md:hidden` + `hidden md:grid` mobile/desktop split | Resolved |
| R-4 Movers query | Two PostgREST round-trips + JS rank derivation; ~150 ms p95 estimate | Resolved |
| R-5 Digest query | One PostgREST query + JS aggregation; UTC week cutoff in JS | Resolved |
| R-6 Refreshing chip | Page-header mount + React Context bridging to `DashboardRealtime` | Resolved |

All Phase 0 unknowns resolved. Proceed to Phase 1 (data-model + contracts).
