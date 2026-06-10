# Tasks: Phase 4 Dashboard Polish + Mobile UX

**Feature**: 005-phase-4-dashboard
**Input**: `specs/005-phase-4-dashboard/` — plan.md (required), spec.md, research.md, data-model.md, contracts/, quickstart.md
**Generated**: 2026-06-07 via `/ai1st-dev-tasks`

## Overview

Tasks are organised into 8 phases:

- **Phase 1** — Setup (dirs + initial i18n key block)
- **Phase 2** — Foundational (migration 0038 + pgTAP 025 + types regen + tab-url helper + DashboardPage skeleton + DashboardTabStrip; blocks every user story)
- **Phase 3** — US-DA: Mobile tabs + responsive grid (FR-D01-D05; `/dashboard` layout with tab strip ≤ 768 px + 2-col grid > 768 px; TC-D1, TC-D2)
- **Phase 4** — US-DB: Inline quick-edit on upcoming-match widget (FR-D06-D08, FR-D20, NFR-D08; ExpandableMatchCard + InlinePredictionForm reusing lock_prediction RPC + full error parity; TC-D3, TC-D4, TC-D5, TC-D17)
- **Phase 5** — US-DC: Engagement widgets — Snapshot + Neighborhood + Movers + Digest (FR-D09-D13; four new Server Components + 3 pure helpers + Pool-tab Playwrights; TC-D6, TC-D7, TC-D8, TC-D9, TC-D10; NFR-D07)
- **Phase 6** — US-DD: Realtime stale-while-revalidate + refreshing chip (FR-D15, FR-D19, FR-D21, NFR-D05, NFR-D06; DashboardRealtime Client wrapper + RefreshingChip + Context bridge; TC-D12, TC-D16)
- **Phase 7** — US-DE: Pre-tournament + i18n + a11y polish (FR-D14, FR-D16, FR-D17, NFR-D04; PreTournamentPlaceholder wiring + locale fill + axe sweep extension; TC-D11, TC-D14, TC-D15)
- **Final Phase** — Polish (pristine sweep, DoD verification, README, constitution check, tasks-complete marking)

User stories US-DA through US-DE share the Phase 2 foundation (DashboardPage composer skeleton, DashboardTabStrip, migration 0038). After Phase 2, US-DA must complete first (creates the Today/Pool layout slots that other stories fill). US-DB, US-DC, US-DD, US-DE then attach in any order, but US-DD touches `DashboardPage` so it should sequence after the widgets that mount inside the Realtime wrapper.

**Recommended MVP scope is Phase 1 + Phase 2 + US-DA + US-DB**: gives participants the new mobile-first tabbed layout plus the inline quick-edit (the highest-value daily-use upgrade) without the engagement widgets. US-DC / US-DD / US-DE can ship in follow-up commits.

Tests are integrated per phase per the AI-Kit convention — each user story produces both implementation and its TC-D## Playwright spec.

**Total tasks**: 47.

---

## Phase 1 — Setup

- [x] T001 Create the new feature directory tree: `mkdir -p /Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/{components/dashboard,lib/dashboard,lib/dashboard/__tests__}` (note: `components/matches/` already exists from feature 002 — only the dashboard dirs are new)
- [x] T002 Add the initial `dashboard.*` i18n key block to `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/i18n/messages/{en,es,pt-BR}.json`. Required keys for Phase 2-3 foundation: `tabToday`, `tabPool`, `tabsAriaLabel` (= "Dashboard view"), `refreshing` (= "Refreshing…"). English authoritative + reasonable es / pt-BR. Other widget-specific keys land per story phase.

---

## Phase 2 — Foundational (BLOCKS every user story)

### Schema migration + pgTAP

- [x] T003 Migration `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/supabase/migrations/0038_movers_24h_rpc.sql` per `contracts/query-movers-global.md` — `CREATE OR REPLACE FUNCTION get_movers_24h_aggregate() RETURNS TABLE (participant_id uuid, delta_24h smallint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT participant_id, COALESCE(SUM(points), 0)::smallint AS delta_24h FROM score_events WHERE awarded_at >= NOW() - INTERVAL '24 hours' GROUP BY participant_id $$;` + `REVOKE ALL ON FUNCTION get_movers_24h_aggregate() FROM PUBLIC;` + `GRANT EXECUTE ON FUNCTION get_movers_24h_aggregate() TO authenticated;` + COMMENT block citing FR-D11 + the FC-D1 carve-out (spec.md). Verify via `npx supabase db reset` apply.
- [x] T004 [P] pgTAP `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/test/pgtap/025_movers_aggregate_rpc.sql` per `contracts/query-movers-global.md` Test Coverage — assert: function classified STABLE via `pg_proc.provolatile`; function is SECURITY DEFINER via `pg_proc.prosecdef`; anon role denied (`SET ROLE anon` → `SELECT get_movers_24h_aggregate()` → expect insufficient_privilege); authenticated role allowed; returns one row per participant with `score_events.awarded_at >= NOW() - 24h`; returns zero rows when score_events table is empty (pre-tournament short-circuit honoured naturally by the WHERE clause); runs in < 250 ms with a 200-participant fixture (seed 200 participants + ~2000 events). 10-12 asserts. Header cites NFR-D07.

### Generated types

- [x] T005 Regenerate `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/supabase/database.types.ts` via `cd /Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness && npx supabase gen types typescript --local > /tmp/dbtypes.ts && tail -n +2 /tmp/dbtypes.ts | head -n -2 > lib/supabase/database.types.ts` (strip CLI banner + EOF noise; mirror the feature 004 cleanup pattern). Confirm `Database['public']['Functions']['get_movers_24h_aggregate']` is present in the regenerated file.

### Pure helpers (foundational)

- [x] T006 [P] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/tab-url-state.ts` — pure helpers `parseTab(param: string | null | undefined): 'today' | 'pool'` (returns `'today'` for null/undefined/invalid; otherwise validates against the union) and `formatTabHref(tab: 'today' | 'pool'): string` (returns `/dashboard?tab=today` or `/dashboard?tab=pool` — both include the param explicitly so URL is unambiguous). Export `type DashboardTab = 'today' | 'pool'`. Mirror the shape of feature 004's `stage-url-state.ts`.
- [x] T007 [P] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/__tests__/tab-url-state.test.ts` — Jest spec asserting: `parseTab(null) === 'today'`; `parseTab(undefined) === 'today'`; `parseTab('') === 'today'`; `parseTab('today') === 'today'`; `parseTab('pool') === 'pool'`; `parseTab('TODAY') === 'today'` (case-sensitive); `parseTab('garbage') === 'today'`; `formatTabHref('today') === '/dashboard?tab=today'`; `formatTabHref('pool') === '/dashboard?tab=pool'`. 9 cases. Use `@jest/globals` import pattern (matches feature 004 helper tests).

### Foundation components

- [x] T008 Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/DashboardTabStrip.tsx` — Client Component (`'use client'`), WAI-ARIA tabs pattern (`role="tablist"` + `role="tab"` + `aria-selected`). Props `{activeTab: DashboardTab; labels: {today: string; pool: string}; ariaLabel: string}`. Renders 2 buttons in order (Today, Pool). Active tab: `aria-selected="true"` + `tabIndex={0}` + Tailwind highlight (`bg-blue-600 text-white shadow-sm`). Inactive: `aria-selected="false"` + `tabIndex={-1}` + Tailwind muted (`bg-gray-100 text-gray-700 hover:bg-gray-200`). Click navigates via `useRouter().push(formatTabHref(tab))`. Arrow Left/Right keyboard nav + Home/End + Enter/Space — manual-activation pattern matching feature 004's StageTabStrip. Wrap in `block md:hidden` to hide on desktop (research §R-3). Header comment cites FR-D02 + R-3.
- [x] T009 Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/DashboardPage.tsx` — Server Component composer skeleton. Props `{searchParams: Promise<{tab?: string}>}`. Body order: (a) `await searchParams`; (b) Supabase server client + `auth.getUser()` + redirect `/` if unauthed (mirror feature 004's LeaderboardPage auth gate); (c) participant lookup including `timezone` + `role`; (d) `parseTab(params.tab ?? null)`; (e) `useTranslations('dashboard')` via `getTranslations` for server-side metadata. Skeleton returns a placeholder `<main>` with `<DashboardTabStrip activeTab={activeTab} labels={…} ariaLabel={t('tabsAriaLabel')} />` only. Individual widget slots get filled in subsequent phases. Keep the existing `app/(participant)/dashboard/page.tsx` route as the entry that mounts this composer (modified in T012).

---

## Phase 3 — US-DA: Mobile tabs + responsive grid

**Story goal**: An authenticated participant on `/dashboard` sees a tabbed view on mobile (≤ 768 px, "Today" + "Pool" tabs) and a 2-column responsive grid on desktop (> 768 px). The active tab persists in the URL as `?tab=today` (default) or `?tab=pool`. Defaults to Today on fresh navigation without `?tab=`.

**Independent test criteria**: Sign in as a participant; goto `/dashboard` at 360 px → Today tab is `aria-selected="true"`, tab strip visible. Click Pool → URL updates to `?tab=pool` and the corresponding widget slot renders. Resize to 1024 px → tab strip hidden, both widget sets visible in 2-col grid. Reload at `?tab=pool` → page lands on Pool.

**Maps to TCs**: TC-D1, TC-D2. **FRs**: FR-D01..D05.

### Layout wiring

- [x] T010 [US-DA] Modify `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/DashboardPage.tsx` (T009 skeleton) to render two layout containers: `<section className="block md:hidden" aria-labelledby="today-tab">` for the mobile Today tab content + `<section className="block md:hidden" aria-labelledby="pool-tab">` for the mobile Pool tab content (each section's `hidden` attribute toggled by `activeTab !== 'today'` / `activeTab !== 'pool'`), AND `<section className="hidden md:grid md:grid-cols-2 md:gap-4">` for the desktop grid that always renders both tab sets simultaneously. Per research §R-3 the same JSX is server-rendered twice (mobile + desktop variants) with CSS handling the reveal — no JS media-query listener. Widget slots are placeholders for now (filled by US-DB..US-DE).
- [x] T011 [US-DA] Modify `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/app/(participant)/dashboard/page.tsx` — replace the existing direct content render with `<DashboardPage searchParams={searchParams}/>` (the existing widgets — UpcomingMatchesWidget, RankWidget, admin nav link, predictions nav, TimezoneAutoDetect, welcome flow — move INTO DashboardPage Today-tab + desktop-grid slots so they remain visible per FR-D18). Verify the existing `/dashboard` route still renders all prior content after this refactor.

### Playwright

- [x] T012 [US-DA] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/dashboard-mobile-tabs.spec.ts` covering TC-D1 + TC-D2. Test cases: (a) 360 px viewport — Today tab `aria-selected="true"`, Pool tab `aria-selected="false"`; click Pool → URL contains `?tab=pool`, Pool tab now `aria-selected="true"`; (b) 1024 px viewport — no `[role="tablist"]` present (tab strip CSS-hidden); both widget sets visible; (c) fresh nav without `?tab=` always defaults to Today; (d) reload at `?tab=pool` preserves Pool. Use existing `signInAs` fixture + `provisionFromAuthenticatedPage` pattern from feature 004 specs. Wrap describe in `test.setTimeout(90_000)` to mirror feature 004's leaderboard-page suite (handles dev-server compile latency).

---

## Phase 4 — US-DB: Inline quick-edit on upcoming-match widget

**Story goal**: An authenticated participant taps the Upcoming match widget on `/dashboard` and the card expands in place to reveal home/away score inputs, a sticky lock-countdown badge, and a Save button. Save calls the existing `lock_prediction()` RPC; the inline form surfaces the full error-message set (including `errorLocked`, `errorOutOfRange`, etc.).

**Independent test criteria**: Sign in, seed an upcoming match > 60 min from now, open `/dashboard`. Tap the upcoming-match widget — expands inline, sticky countdown visible at top of expanded card, score inputs reachable. Enter `2-1`, Save → toast confirms, widget collapses, prediction persists. Repeat with out-of-range value (99) → `errorOutOfRange` inline message + card stays expanded.

**Maps to TCs**: TC-D3, TC-D4, TC-D5, TC-D17. **FRs**: FR-D06, FR-D07, FR-D08, FR-D20. **NFRs**: NFR-D08.

### Components

- [x] T013 [US-DB] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/matches/InlinePredictionForm.tsx` — Client Component (`'use client'`). Props `{matchId: string; initialHomeScore: number | null; initialAwayScore: number | null; onSaved: () => void; onError?: (code: string) => void}`. State: `homeScore`, `awayScore`, `isSubmitting`, `errorCode`. Renders two `<input type="number" min={0} max={20}>` for home/away + Save button. On Save: call `supabase.rpc('lock_prediction', { p_match_id, p_predicted_home_score, p_predicted_away_score })`; switch on `data.outcome`: `'saved'` → emit structured log line per NFR-D08 (`{event: 'inline_save', participant_id, match_id, outcome: 'saved', occurred_at}`) → invoke `onSaved()` (parent collapses card); any other outcome → set `errorCode` to map to the existing i18n key (`errorLocked`, `errorOutOfRange`, `errorMatchNotFound`, `errorParticipantNotFound`, `errorGeneric`) AND emit failure log line (`{event: 'inline_save', …, outcome: 'failed', error_code}`) → invoke `onError?.(code)`. Render the error message in a `<p role="alert">` inside the form when `errorCode` is set; the form stays mounted (card stays expanded) so the participant can correct + retry per FR-D20. Use the SAME i18n key namespace + error component as `components/predictions/PredictionForm.tsx` from feature 003 (DRY — extract a small `<PredictionFormError code={errorCode}/>` Client Component into `components/predictions/PredictionFormError.tsx` if it doesn't already exist; both the inline and standalone forms consume it).
- [x] T014 [US-DB] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/matches/ExpandableMatchCard.tsx` — Client Component (`'use client'`). Props `{matchId: string; kickoffUtc: string; homeTeamName: string; awayTeamName: string; initialHomeScore: number | null; initialAwayScore: number | null; locked: boolean}` (server-passed lock state — server is authority per Constitution §IV.1 + FR-D08 implication). State: `isExpanded` (boolean). When collapsed: renders the existing match-row markup unchanged (use the existing UpcomingMatchesWidget row internals) + a `<button aria-expanded={isExpanded}>` toggle on the right side. When expanded: renders the collapsed row + a sticky lock-countdown badge (Tailwind `sticky top-0 z-10 bg-amber-100 …` with `role="status"`) showing time-until-lock OR a "Locked" pill if `locked === true` + `<InlinePredictionForm/>` (T013). The expand/collapse uses Tailwind `max-h-0` / `max-h-[40rem]` + `transition-all duration-200 ease-in-out` per research §R-1 (no JS-measured height — prevents CLS spikes). Disable the expand affordance entirely when `locked === true` AND there is no existing prediction (no point opening to a read-only form). Header comment cites FR-D06, FR-D07, R-1.
- [x] T015 [US-DB] Modify `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/matches/UpcomingMatchesWidget.tsx` — wrap the rendered match row in `<ExpandableMatchCard …/>` (T014). The widget continues to render exactly as before when no participant interaction occurs (collapsed state is visually identical to today's rendering); the only visible change is the expand-toggle button on the right. Pass server-derived lock state (`kickoffUtc - now() <= 60 min`) as the `locked` prop. Pass the participant's prediction (if any, fetched server-side per `contracts/query-upcoming-prediction.md`) as `initialHomeScore` / `initialAwayScore`.

### Lock countdown integration

- [x] T016 [US-DB] Inside `ExpandableMatchCard.tsx`, integrate feature 002's existing lock-countdown helper (likely in `lib/matches/countdown.ts` or `components/match/LockCountdown.tsx` — verify exact path) for the badge text. The badge updates every second via a `setInterval` ref (cleared on unmount). When the countdown reaches zero, the badge swaps to a "Locked" state and the form `disabled` flips (`InlinePredictionForm` receives the updated `locked` prop from a parent React state — `ExpandableMatchCard` tracks `clientSideLocked` derived from the countdown). Server's lock state remains the authority for SAVE attempts (the RPC will return `outcome='locked'` anyway); the client-side flip is a UX affordance only, not a security boundary. Header comment notes the boundary distinction.

### i18n keys

- [x] T017 [US-DB] Add the inline-edit i18n keys to `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/i18n/messages/{en,es,pt-BR}.json` under existing `dashboard.*` namespace (T002 added the foundation block). Required keys: `inlineEditExpand` (button label, e.g. "Edit prediction"), `inlineEditCollapse` ("Hide form"), `inlineEditSaveButton`, `inlineEditSavingButton`, `inlineEditSuccessToast`, `lockedBadge` (sticky badge text when locked), `unlockedBadgeCountdown` (sticky badge ARIA prefix, e.g. "Match locks in"). The five error keys (`errorLocked`, `errorOutOfRange`, `errorMatchNotFound`, `errorParticipantNotFound`, `errorGeneric`) already exist under `predictions.*` (feature 003) — reuse those via `useTranslations('predictions')` in the shared `PredictionFormError` component. English authoritative + reasonable es / pt-BR.

### Playwright

- [x] T018 [US-DB] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/dashboard-inline-edit.spec.ts` covering TC-D3 + TC-D4 + TC-D5 + TC-D17. Test cases: (a) TC-D3 expand + save success — seed an upcoming match 3h from now, sign in, goto `/dashboard`, locate the upcoming-match widget, click expand toggle, assert `aria-expanded="true"` and score inputs visible; type `2-1`, click Save, assert toast confirms + card collapses + the saved prediction persists when re-expanded; (b) TC-D4 sticky countdown — same setup, after expand, assert the badge `role="status"` is visible at the top of the expanded card AND remains visible if the card content is scrolled (use `page.evaluate` to scroll inside the card container); assert the badge text updates within 2 s of waiting (poll text content twice 1 s apart); (c) TC-D5 lock-boundary at exactly −60 min — seed a match with `kickoff_utc = NOW() + INTERVAL '60 minutes'` (boundary), expand the widget, attempt to save → assert `errorLocked` message visible inside the card; badge shows "Locked"; card stays expanded; (d) TC-D17 out-of-range — seed any future match, expand, type `99` in home score, click Save → assert `errorOutOfRange` message visible inside the card; card stays expanded. Owned provider_id range: 9701-9710. `test.setTimeout(90_000)` per describe.

---

## Phase 5 — US-DC: Engagement widgets (Snapshot + Neighborhood + Movers + Digest)

**Story goal**: An authenticated participant flipping to the Pool tab on `/dashboard` (or scrolling the desktop grid) sees four engagement widgets: **Your prediction snapshot** (last-finished + next-upcoming cards), **Your neighborhood** (hybrid-clamped ±5 leaderboard slice), **Biggest movers** (global top 3 + neighborhood top 3 in last 24 h), **This week's digest** (Mon-Sun UTC totals).

**Independent test criteria**: Seed a leaderboard fixture (≥ 25 participants, mixed scoring), refresh MV. Open `/dashboard?tab=pool`. Each widget renders with the seeded data. Verify rank-clamp edge cases (top, mid, bottom), movers ordering, digest aggregates.

**Maps to TCs**: TC-D6, TC-D7, TC-D8, TC-D9, TC-D10 (+ TC-D1 Today-tab Snapshot rendering). **FRs**: FR-D09, FR-D10, FR-D11, FR-D12, FR-D13. **NFRs**: NFR-D07.

### Pure helpers

- [x] T019 [P] [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/types.ts` — TypeScript types per data-model.md §4: `NeighborhoodWindow`, `MoverRow`, `DigestSummary`, `SnapshotData`. Derive from `Database['public']['Views']['leaderboard_snapshots']['Row']` where possible (use `Pick<…>`).
- [x] T020 [P] [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/neighborhood-window.ts` — pure helper `computeNeighborhoodWindow(selfRank: number, totalParticipants: number): NeighborhoodWindow` per `contracts/query-neighborhood.md`. Four branches: small-pool (`totalParticipants < 11` → `{startRank: 1, endRank: totalParticipants, clampMode: 'small-pool'}`), top-clamp (`selfRank ≤ 6` → `{1, 11, 'top'}`), bottom-clamp (`selfRank + 5 ≥ totalParticipants` → `{totalParticipants - 10, totalParticipants, 'bottom'}`), centre (default → `{selfRank - 5, selfRank + 5, 'centre'}`). Return `sliceCount` = `endRank - startRank + 1`.
- [x] T021 [P] [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/__tests__/neighborhood-window.test.ts` — Jest spec covering all four clamp modes + boundary cases. Cases: small-pool (5 participants, selfRank=3 → ranks 1-5); top-clamp boundary (selfRank=6, totalParticipants=20 → ranks 1-11); centre boundary (selfRank=7, totalParticipants=20 → ranks 2-12); bottom-clamp boundary (selfRank=15, totalParticipants=20 → ranks 10-20); centre normal (selfRank=10, totalParticipants=30 → ranks 5-15). 10-12 cases.
- [x] T022 [P] [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/movers-24h.ts` — pure helper `computeMovers(currentRankings, deltas): MoverRow[]` per `contracts/query-movers-global.md`. Inputs: `currentRankings` array of `{participant_id, display_name, total_points, rank}` from MV; `deltas` array of `{participant_id, delta_24h}` from the get_movers_24h_aggregate RPC. Body: build `deltaMap`; compute `previousTotal = currentTotal - delta`; produce synthetic 24h-ago rankings by re-sorting on previousTotal DESC; for each participant produce `MoverRow` with `currentRank`, `previousRank`, and `delta` (using feature 004's `computeDelta` from `lib/leaderboard/compute-delta.ts`); filter to climbers (`direction === 'up'`); sort by `delta.magnitude` DESC. Reuses the feature 004 `computeDelta` helper.
- [x] T023 [P] [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/__tests__/movers-24h.test.ts` — Jest spec. Cases: all-up (3 participants each gained ranks), ties on delta.magnitude (lower currentRank wins by secondary sort), empty deltas (no movers), neighborhood-filter derivation (given a global movers array + a set of participant IDs, the neighborhood subset is the right intersection). 8-10 cases.
- [x] T024 [P] [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/weekly-digest.ts` — pure helpers `startOfCurrentWeekUTC(now?: Date): Date` AND `computeDigestSummary(events): DigestSummary` per `contracts/query-weekly-digest.md`. `startOfCurrentWeekUTC` body matches the spec helper verbatim (days-since-Monday rule). `computeDigestSummary` filters out events with `match_id === null` (excludes final-prediction events per FR-D13 intent), then computes total/count/best/worst using `Math.max` / `Math.min`. Returns `{total: 0, count: 0, bestSingleScore: null, worstSingleScore: null}` for empty input.
- [x] T025 [P] [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/dashboard/__tests__/weekly-digest.test.ts` — Jest spec. Cases for `startOfCurrentWeekUTC`: Monday 00:00 UTC → returns the same day; Sunday 23:59 UTC → returns previous Monday; Wednesday → returns the current Monday. Cases for `computeDigestSummary`: zero events → all-zero / nulls; one event → total = count = points, best = worst = points; mixed events with one final-prediction (match_id=null) → filtered out; ties on best/worst — Math.max/min handle naturally. 10 cases.

### Server Components

- [x] T026 [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/SnapshotWidget.tsx` — Server Component (`async function`). Props `{selfParticipantId: string; locale: string; userTz: string}`. Runs two parallel Supabase queries: (a) last finished prediction per `contracts/query-last-finished-prediction.md`; (b) upcoming match + prediction per `contracts/query-upcoming-prediction.md`. Renders split card layout — two `<article>` elements side-by-side on desktop, stacked on mobile (Tailwind `grid grid-cols-1 md:grid-cols-2 gap-3`). Left article = "Last finished match" with team names + prediction + actual score + points awarded. Right article = "Next upcoming match" with team names + prediction (or "No pick yet" prompt). When either query returns null → render that side's empty state (other side still renders).
- [x] T027 [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/NeighborhoodWidget.tsx` — Server Component. Props `{selfParticipantId: string; selfRank: number; locale: string}`. Body: query `leaderboard_snapshots WHERE stage = 'all'` ORDER BY rank ASC LIMIT 1 to get `totalParticipants` (count via PostgREST `head: true, count: 'exact'`). Then `const window = computeNeighborhoodWindow(selfRank, totalParticipants);`. Issue the slice query per `contracts/query-neighborhood.md`. Render an HTML `<table>` with rank / display_name / total_points columns (same shape as feature 004's LeaderboardTable but capped at 11 rows). Self row carries `data-self="true"` + Tailwind highlight ring. Use the formatRank helper from feature 004 for the rank-with-`=` rendering.
- [x] T028 [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/MoversWidget.tsx` — Server Component. Props `{selfParticipantId: string; neighborhoodParticipantIds: string[]; locale: string}`. Body: `Promise.all([fetchCurrentRankings(), supabase.rpc('get_movers_24h_aggregate')])`; pass both to `computeMovers`; `.slice(0, 3)` for global section; filter by `neighborhoodParticipantIds` then `.slice(0, 3)` for neighborhood section. Render two `<section>` sub-cards: "Top 3 in pool" + "Top 3 near you". Each row: display_name + currentRank + delta arrow (`↑ {magnitude}` green) — reuse feature 004's compute-delta arrow rendering pattern. Empty section → "No movers in the last 24 hours" message.
- [x] T029 [US-DC] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/DigestWidget.tsx` — Server Component. Props `{selfParticipantId: string; locale: string}`. Body: query per `contracts/query-weekly-digest.md`; pass result to `computeDigestSummary`. Render 4 stat cards in a 2×2 grid: total points (large number), match count, best single score, worst single score. If `count === 0` → render "No matches scored yet this week" instead.
- [x] T030 [US-DC] Wire all four widgets into `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/DashboardPage.tsx` (T009 + T010 skeleton). Mobile Today section slots: `<UpcomingMatchesWidget/>` (with ExpandableMatchCard from T015) + `<RankWidget/>` (existing feature 004) + `<SnapshotWidget/>`. Mobile Pool section slots: `<NeighborhoodWidget/>` + `<MoversWidget/>` + `<DigestWidget/>`. Desktop grid: all six widgets in a `grid-cols-2` layout. Pre-fetch the participant's self rank + neighborhood participant IDs server-side at the top of DashboardPage (single `Promise.all`) so the widgets receive their props without making redundant queries.

### i18n keys

- [x] T031 [US-DC] Add the engagement-widget i18n keys to `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/i18n/messages/{en,es,pt-BR}.json` under `dashboard.*`. Required keys: `snapshotHeading`, `snapshotLastHeading`, `snapshotNextHeading`, `snapshotNoPickYet`, `snapshotPointsAwarded` (with `{points}` placeholder), `neighborhoodHeading`, `neighborhoodAriaLabel`, `moversHeading`, `moversGlobalSubheading` ("Top 3 in pool"), `moversNeighborhoodSubheading` ("Top 3 near you"), `moversEmptyState`, `digestHeading`, `digestTotalLabel`, `digestCountLabel`, `digestBestLabel`, `digestWorstLabel`, `digestEmptyState`. English authoritative.

### Playwright

- [x] T032 [US-DC] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/dashboard-neighborhood.spec.ts` covering TC-D6 + TC-D7 + TC-D8 + small-pool edge case. Seed 25 participants with distinct ranks via service-role; sign in as the test participant (vary rank between tests). TC-D6: participant at rank 2 → ranks 1-11 visible. TC-D7: participant at rank 12 → ranks 7-17 visible. TC-D8: participant at rank 25 (last) → ranks 15-25 visible. Small pool: 8 participants total, signed-in at rank 5 → all 8 rows rendered, no padding. Self row has `data-self="true"` + highlight ring class. Owned provider_id range: 9711-9715.
- [x] T033 [US-DC] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/dashboard-movers.spec.ts` covering TC-D9. Seed initial stable rankings via service-role (10 participants with distinct scores via `match-exact` events on a single seeded match); refresh MV. Then fire additional score events for some participants over the next minute (5 climbers + 2 stable + 3 stalled); refresh MV. Sign in as a participant in the middle of the leaderboard. Goto `/dashboard?tab=pool`. Assert: "Top 3 in pool" section shows the global top 3 climbers in correct order by magnitude; "Top 3 near you" section shows the neighborhood top 3 climbers (subset of global, scoped to ±5 around the signed-in participant). If neighborhood has fewer than 3 climbers, the section shows what's available. Owned provider_id range: 9716-9720.
- [x] T034 [US-DC] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/dashboard-digest.spec.ts` covering TC-D10. Seed score_events for the signed-in participant spread across the current calendar week: 10 points on Monday, 5 points on Wednesday, 0 points on Friday, 10 points on Saturday (use `awarded_at` overrides to backdate). Sign in, goto `/dashboard?tab=pool`. Assert: total = 25; count = 4; bestSingleScore = 10; worstSingleScore = 0. Edge: include one `match_id=null` event (final-prediction) → assert it is EXCLUDED from the digest counts. Owned provider_id range: 9721-9725.

---

## Phase 6 — US-DD: Realtime stale-while-revalidate + refreshing chip

**Story goal**: When the participant has `/dashboard` open and a scoring event fires, all widgets refresh in lock-step within ~300 ms without a layout shift. During the in-flight fetch, a "refreshing…" chip appears in the page header. Multiple events arriving within 300 ms are coalesced into a single re-fetch.

**Independent test criteria**: Open `/dashboard`, wait for channel SUBSCRIBED. Fire 5 audit_log inserts within 200 ms via service-role. Assert exactly one PostgREST re-fetch fires (not 5). During the re-fetch, the chip is visible; widget content stays visible (zero CLS). After re-fetch completes, chip disappears.

**Maps to TCs**: TC-D12, TC-D16. **FRs**: FR-D15, FR-D19, FR-D21. **NFRs**: NFR-D05, NFR-D06.

### Realtime infra

- [x] T035 [US-DD] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/RefreshingChip.tsx` — Client Component (`'use client'`). Reads `isRefetching` from a React Context (`DashboardRefreshContext` created in T036). When `isRefetching === true` renders `<div role="status" className="fixed top-2 right-2 z-50 rounded-md bg-blue-100 px-3 py-1 text-sm text-blue-800 shadow-md">{t('refreshing')}</div>` — otherwise returns `null`. Per research §R-6 the chip mounts in the page header and bridges to the wrapper via Context.
- [x] T036 [US-DD] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/DashboardRealtime.tsx` — Client Component wrapper. Props `{children: React.ReactNode; activeTab: DashboardTab}`. State: `isRefetching` (boolean, init false), `reconnecting` (boolean, init false — mirrors feature 004 LeaderboardRealtime's pattern). Creates `DashboardRefreshContext` and provides `{isRefetching, setIsRefetching}` to descendants. On mount (`useEffect`): create Supabase browser client; open channel `leaderboard-refresh` filtered by `action=eq.leaderboard.refresh` (same as feature 004); on each event call a debounced `refetch()` helper that uses a `setTimeout` ref with 300 ms delay (cleared on each event); when the debounced fire happens, set `isRefetching=true`, call `router.refresh()` to trigger Server Component re-fetch with new data (Next.js App Router pattern — Server Components re-render with fresh data, widgets receive new props without unmount, achieving stale-while-revalidate per research §R-2); on completion (next render tick) set `isRefetching=false`. Track channel subscribe status for ReconnectingIndicator integration (10 s threshold). On unmount: clear timers + unsubscribe channel.
- [x] T037 [US-DD] Modify `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/DashboardPage.tsx` (T030 widget-wiring) to wrap the `<main>` body in `<DashboardRealtime activeTab={activeTab}>…</DashboardRealtime>` and mount `<RefreshingChip/>` inside the page header (above the tab strip). The Server Component still does all initial fetches; the Client wrapper subscribes to Realtime and triggers `router.refresh()` for subsequent updates. Verify the existing feature 004 `ReconnectingIndicator` from `components/leaderboard/` is reused here (don't recreate) — import + mount inside DashboardRealtime when needed.

### i18n key

- [x] T038 [US-DD] The `refreshing` key was added in T002 — no new keys needed. Verify the key resolves correctly via `useTranslations('dashboard')` in the RefreshingChip component and that the ReconnectingIndicator's existing key (`leaderboard.reconnecting` from feature 004) is reused — DO NOT duplicate.

### Playwright

- [x] T039 [US-DD] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/dashboard-realtime.spec.ts` covering TC-D12 + TC-D16. TC-D12 debounce burst: open `/dashboard`, wait 2 s for channel SUBSCRIBED (matches feature 004's TC-L4 pattern); capture network requests via `page.on('request')`; fire 5 audit_log inserts within 200 ms via service-role; assert exactly ONE PostgREST `/rest/v1/…` re-fetch fires within the next second. TC-D16 refreshing chip + CLS: open `/dashboard`, wait for SUBSCRIBED, capture initial DOM snapshot; fire ONE audit_log insert; assert within 500 ms a chip with `role="status"` is visible in the page header; assert the widget container's bounding box does not change (zero layout shift); assert chip disappears once the new data is applied. Measure CLS via `PerformanceObserver` and assert ≤ 0.1. `test.setTimeout(90_000)` per describe.

---

## Phase 7 — US-DE: Pre-tournament + i18n + a11y polish

**Story goal**: When `score_events` is globally empty, the Movers / Digest / Neighborhood widgets render "Awaiting the first match" placeholder cards while Upcoming / Rank / Snapshot widgets render their existing pre-tournament states. All visible text comes from the next-intl catalogue in en/es/pt-BR; all interactive surfaces meet WCAG 2.1 AA.

**Independent test criteria**: Truncate score_events. Open `/dashboard` → Pool tab shows three placeholder cards. Switch locale via NEXT_LOCALE cookie → no hardcoded English visible. Run axe-core sweep on both mobile and desktop variants → zero violations.

**Maps to TCs**: TC-D11, TC-D14, TC-D15. **FRs**: FR-D14, FR-D16, FR-D17. **NFRs**: NFR-D04.

### Pre-tournament placeholder

- [x] T040 [US-DE] Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/PreTournamentPlaceholder.tsx` — Server Component. Props `{widgetType: 'movers' | 'digest' | 'neighborhood'; locale: string}`. Renders a centred card with a localised "Awaiting the first match" headline (`dashboard.preTournamentHeading`) + a widget-specific body line (`dashboard.preTournamentMoversBody` / `…DigestBody` / `…NeighborhoodBody`) from i18n. Uses the same visual idiom as feature 004's EmptyLeaderboardState (rounded-md card, gray-50 background, centred text).
- [x] T041 [US-DE] Modify `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/components/dashboard/DashboardPage.tsx` to call `supabase.rpc('is_pre_tournament')` (feature 004 helper) and pass the resulting boolean to a `<PreTournamentBranch>` wrapper for the Pool widgets. When `isPreTournament === true`: replace the three widgets in Pool tab + the three corresponding slots in desktop grid with `<PreTournamentPlaceholder widgetType="movers"/>`, `<PreTournamentPlaceholder widgetType="digest"/>`, `<PreTournamentPlaceholder widgetType="neighborhood"/>`. Today tab widgets render unchanged (their existing pre-tournament states kick in independently).
- [x] T042 [US-DE] Add the pre-tournament + a11y i18n keys to `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/i18n/messages/{en,es,pt-BR}.json`. Required keys: `preTournamentHeading` (= "Awaiting the first match"), `preTournamentMoversBody`, `preTournamentDigestBody`, `preTournamentNeighborhoodBody`. English authoritative.

### Playwright pre-tournament

- [x] T043 [US-DE] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/dashboard-pre-tournament.spec.ts` covering TC-D11. Truncate score_events (defensive wholesale-clear pattern from feature 003 fix); seed one future upcoming match. Sign in + goto `/dashboard`. Assert Today tab: Upcoming widget renders normally (with the future match); Rank widget shows pre-tournament countdown; Snapshot widget "next" card shows the upcoming match. Switch to Pool tab. Assert all three widgets render the PreTournamentPlaceholder (look for the localised "Awaiting the first match" heading three times). Owned provider_id range: 9731-9735.

### Accessibility sweep extension

- [x] T044 [US-DE] Modify `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/all-pages-a11y.spec.ts` — add 4 new test cases covering TC-D14 across `/dashboard` states: (a) populated mobile (360 px, tab=today, with seeded fixture); (b) populated mobile pool (tab=pool, with seeded fixture); (c) populated desktop (1024 px, with seeded fixture); (d) pre-tournament (mobile + desktop, score_events empty). Use existing `seedA11yMatches` helper if present + add a `seedA11yLeaderboard` helper inline if needed. All assertions: zero axe-core violations at WCAG 2.0 / 2.1 A + AA. Owned provider_id range: 9736-9740.

### i18n verification

- [x] T045 [US-DE] Verify all `dashboard.*` i18n keys are present in all three locale files (en/es/pt-BR). Required keys (cumulative across T002, T017, T031, T038, T042): `tabToday`, `tabPool`, `tabsAriaLabel`, `refreshing`, `inlineEditExpand`, `inlineEditCollapse`, `inlineEditSaveButton`, `inlineEditSavingButton`, `inlineEditSuccessToast`, `lockedBadge`, `unlockedBadgeCountdown`, `snapshotHeading`, `snapshotLastHeading`, `snapshotNextHeading`, `snapshotNoPickYet`, `snapshotPointsAwarded`, `neighborhoodHeading`, `neighborhoodAriaLabel`, `moversHeading`, `moversGlobalSubheading`, `moversNeighborhoodSubheading`, `moversEmptyState`, `digestHeading`, `digestTotalLabel`, `digestCountLabel`, `digestBestLabel`, `digestWorstLabel`, `digestEmptyState`, `preTournamentHeading`, `preTournamentMoversBody`, `preTournamentDigestBody`, `preTournamentNeighborhoodBody`. Run `jq` audit: `for f in lib/i18n/messages/{en,es,pt-BR}.json; do for k in <list>; do jq -e ".dashboard.$k" "$f" > /dev/null || echo "MISSING $k in $f"; done; done`. Fix any missing keys with reasonable translations.

---

## Final Phase — Polish & cross-cutting concerns

### Pristine sweep + DoD + docs

- [ ] T046 Run the full pristine sweep — pgTAP (`docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -f - < test/pgtap/025_movers_aggregate_rpc.sql 2>&1 | grep -cE '^ ok'`), Jest (`npm test`), Playwright against the production build (`npm run build && npm start &; until curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ | grep -qE '^(2|3)'; do sleep 1; done && npx playwright test e2e/tests/dashboard-*.spec.ts --project=chromium --reporter=list`), tsc (`npx tsc --noEmit`), ESLint (`npm run lint`). All five MUST report zero failures / zero warnings before T047 proceeds.
- [ ] T047 Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/specs/005-phase-4-dashboard/dod-verification.md` mirroring feature 004's format: per-FR (FR-D01..D21) / per-NFR (NFR-D01..D08) / per-TC (TC-D1..D17) coverage table; constraint verification (FC-D1..D4); cite migration 0038 + test files for each FR-D; list outstanding external items (50-concurrent-Realtime load test against Pro tier; native-speaker review of the new `dashboard.*` translation keys; post-deploy verification of mobile LCP via Lighthouse-in-CI; ratification check that `get_movers_24h_aggregate()` actually executes within NFR-D07's 250 ms p95 on the deployed Supabase project).
- [ ] T048 [P] Update `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/README.md` — add a new "Feature 005 — Dashboard polish + mobile UX" section sibling to features 001-004; document new local commands (force a leaderboard refresh + inspect cron schedule are already in feature 004 README — reference back; new commands: how to invoke `get_movers_24h_aggregate()` manually for debugging movers; how to view the refreshing chip in DevTools; how to simulate a 360 px viewport); troubleshooting matrix from `quickstart.md` §4 (always-pre-tournament-state, refresh chip never appears, mobile tabs not visible, inline save returns errorLocked); cross-references to spec / DoD / contracts.
- [ ] T049 [P] Verify `/Users/mikehitchcock/AI/ai-first-wrapper/.ai_project_memory/constitution-frontend.md` has the two new rows added during plan workflow (Mobile-tabbed dashboard + Stale-while-revalidate Realtime refresh). If absent, re-add per `plan.md` Phase 1 Stack constitution update. No backend-constitution changes required (the one new RPC follows the existing SECURITY DEFINER pattern documented for feature 004's `is_pre_tournament()`).

### Wrap-up

- [ ] T050 Mark all phase-2 through final-phase tasks complete in this file using the Python in-place-rewrite pattern from features 002/003/004 (`python3 -c "import re; ..."`). Commit the marked tasks.md alongside the DoD doc in the final commit.

---

## Dependencies & MVP delivery strategy

### Story-level dependency graph

```
Phase 1 (Setup, T001-T002)
        ↓
Phase 2 (Foundational, T003-T009)
        ↓
        ├──→ US-DA (T010-T012)        ←── MVP must-have (creates tab/grid layout slots)
        │       ↓
        │       ├──→ US-DB (T013-T018) ←── MVP must-have (inline quick-edit)
        │       │
        │       ├──→ US-DC (T019-T034) ←── MVP must-have for engagement (4 widgets)
        │       │
        │       └──→ US-DD (T035-T039) ←── Live updates — touches DashboardPage post-widgets
        │
        └──→ US-DE (T040-T045)          ←── Pre-tournament + a11y + i18n polish
                ↓
Final Phase (T046-T050)
```

### MVP scope (recommended)

**Phase 1 + Phase 2 + US-DA + US-DB** — 18 tasks. Gives participants the mobile-first tabbed layout plus the inline quick-edit (highest-value daily-use upgrade) without engagement widgets. Defers:
- US-DC (engagement widgets) — three new widgets adding the bulk of the engagement story; can ship as a follow-up commit.
- US-DD (Realtime + refresh chip) — only matters once new widget content is actually changing live; ship after US-DC.
- US-DE (pre-tournament + a11y + i18n) — final polish; ship just before launch.

If preferred, MVP can include US-DC to cover the full engagement story from day 1 (34 tasks).

### Parallel execution opportunities

Within phases, `[P]` markers identify tasks that can run in parallel (independent files, no within-stream dependencies). Key parallel opportunities:

- **Phase 2 pgTAP + types regen**: T004 + T005 cannot run truly parallel because T005 needs T003 applied; but T004 + T006 + T007 can run in parallel (3-way concurrent: pgTAP + helper + helper test).
- **US-DC pure helpers** (T019-T025): all 7 tasks are independent files — dispatch as a single parallel group of 7 Agent tasks.
- **US-DC widget components** (T026-T029): four independent files — dispatch as 4 parallel Agent tasks.
- **Final Phase docs** (T048 + T049): independent files — parallel pair.

### Risk hotspots

- **T003 + T004 (migration 0038 + pgTAP 025)**: first SECURITY DEFINER RPC for this feature; follow feature 004's `is_pre_tournament()` migration 0036 pattern verbatim. Pre-test by manually `SELECT get_movers_24h_aggregate()` from `psql` as both `authenticated` and `anon` to confirm the gate before pgTAP runs.
- **T013 + T015 (inline form + UpcomingMatchesWidget mod)**: modifies feature 002's production UpcomingMatchesWidget. Test that the existing widget continues to render unchanged in the collapsed state (visual diff acceptable only if intentional).
- **T036 (DashboardRealtime)**: the `router.refresh()` pattern for stale-while-revalidate is correct for Next.js App Router but requires testing. Mirror feature 004's LeaderboardRealtime test pattern (TC-L4) — 2 s warmup + audit_log insert via service-role + assertion within 5 s.
- **T039 (Realtime + CLS measurement)**: Playwright + CLS via `PerformanceObserver` is touchy; mirror feature 004's TC-L4 timing-hardening (page.waitForTimeout(2_000) after goto + 15 s expect timeout).
- **T046 (pristine sweep against prod build)**: feature 004 surfaced that dev-mode Next.js compile times eat per-test budgets; prod build is the verified-stable path. Use `npm run build && npm start` per the quickstart.

---

## Task ID summary

| Phase | Task IDs | Count |
|---|---|---|
| 1 — Setup | T001-T002 | 2 |
| 2 — Foundational | T003-T009 | 7 |
| 3 — US-DA | T010-T012 | 3 |
| 4 — US-DB | T013-T018 | 6 |
| 5 — US-DC | T019-T034 | 16 |
| 6 — US-DD | T035-T039 | 5 |
| 7 — US-DE | T040-T045 | 6 |
| Final | T046-T050 | 5 |
| **Total** | T001-T050 | **50** |

(Plan estimate was 35-45; the final count is 50 because Phase 5 US-DC grew (4 helpers + 4 helper tests + 4 widgets + 3 Playwright specs = 16 tasks once each helper-with-tests was carved into separate parallel jobs for cleaner commits). Still much smaller than feature 004's 47 because this is a frontend-only feature with one read-only migration vs feature 004's full MV + cron + 4 migrations.)
