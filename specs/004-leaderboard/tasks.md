# Tasks: Leaderboard

**Feature**: 004-leaderboard
**Input**: `specs/004-leaderboard/` — plan.md (required), spec.md, research.md, data-model.md, contracts/, quickstart.md
**Generated**: 2026-06-01 via `/ai1st-dev-tasks`

## Overview

Tasks are organised into 8 phases:

- **Phase 1** — Setup (dirs + env review)
- **Phase 2** — Foundational (migrations 0032 + 0033 for the MV + RPC + predicate; pgTAP for MV/RLS/RPC; type regen. Blocks every user story.)
- **Phase 3** — US-LA: Core ranking page (FR-L01-L03, L09-L11; `/leaderboard` page + table + auth gate + tie-breaker rendering + pagination + "Show my rank" anchor)
- **Phase 4** — US-LB: Stage filter (FR-L04-L05; stage tab strip + URL state + Playwright)
- **Phase 5** — US-LC: Live updates (FR-L06, L12, L16-L20; Realtime subscription via audit event proxy; scoring trigger extension via migration 0034; admin `refresh_leaderboard()` RPC + audit event variants)
- **Phase 6** — US-LD: Dashboard widget (FR-L08; `<RankWidget/>` on `/dashboard` + delta computation)
- **Phase 7** — US-LE: Pre-tournament + cron self-healing (FR-L07, L21-L22; empty state + countdown + pg_cron schedule via migration 0035)
- **Final Phase** — Polish (privacy spec, a11y sweep, i18n keys, pristine sweep, DoD verification, README, constitution review)

User stories are independent at the implementation layer (each can be developed + tested + demoed without the others) but share the foundational MV + RPC. **Recommended MVP scope is Phase 1 + Phase 2 + US-LA + US-LC** — gives participants the live-updating ranking page (the core engagement loop) minus the stage filter, dashboard widget, and pre-tournament polish. US-LB / US-LD / US-LE can ship in follow-up commits.

Tests are integrated per phase per the AI-Kit convention (each user story produces both implementation and the TC-LX Playwright spec that validates it).

**Total tasks**: 42.

---

## Phase 1 — Setup

- [x] T001 Create the new feature directory tree: `mkdir -p project-repos/world-cup-madness/{components/leaderboard,components/dashboard,lib/leaderboard,lib/leaderboard/__tests__,app/(participant)/leaderboard}`
- [x] T002 Verify `project-repos/world-cup-madness/.env.example` requires no new env vars for feature 004 (Realtime subscription reuses `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`; pg_cron requires no env var); add a section header `# feature 004 — leaderboard (no new env vars)` for clarity

---

## Phase 2 — Foundational (BLOCKS every user story)

### Schema migrations

- [x] T003 Migration `project-repos/world-cup-madness/supabase/migrations/0032_create_leaderboard_snapshots.sql` per `data-model.md` §2 — `CREATE MATERIALIZED VIEW leaderboard_snapshots AS WITH all_stage AS (...), group_stage AS (...), r16_stage AS (...), quarter_stage AS (...), semi_stage AS (...), final_stage AS (...), combined AS (UNION ALL ...) SELECT participant_id, stage, display_name, total_points, exact_hits, outcome_hits, final_points, RANK() OVER (PARTITION BY stage ORDER BY total_points DESC, exact_hits DESC, outcome_hits DESC, final_points DESC) AS rank, (COUNT(*) OVER (PARTITION BY stage, total_points, exact_hits, outcome_hits, final_points) > 1) AS rank_is_shared FROM combined;` + `CREATE UNIQUE INDEX leaderboard_snapshots_pk ON leaderboard_snapshots (participant_id, stage);` + `CREATE INDEX leaderboard_snapshots_stage_rank ON leaderboard_snapshots (stage, rank);` + `ALTER MATERIALIZED VIEW leaderboard_snapshots ENABLE ROW LEVEL SECURITY;` + the two policies (`leaderboard_snapshots_select_public`) + the column-level `GRANT SELECT (public-projection cols) ON leaderboard_snapshots TO authenticated` + `REVOKE ALL ON leaderboard_snapshots FROM authenticated` (so private cols are not selectable). Plus `CREATE VIEW leaderboard_self AS SELECT * FROM leaderboard_snapshots WHERE participant_id = (SELECT id FROM participants WHERE auth_user_id = auth.uid()); GRANT SELECT ON leaderboard_self TO authenticated;`
- [x] T004 Migration `project-repos/world-cup-madness/supabase/migrations/0033_refresh_leaderboard_rpc.sql` per `data-model.md` §3 + §4 + §6 — `ALTER TABLE audit_log DROP CONSTRAINT audit_log_event_type_check; ADD CONSTRAINT ... CHECK (event_type IN (...existing..., 'leaderboard.refresh', 'leaderboard.refresh_failed'));` + `CREATE OR REPLACE FUNCTION should_refresh_leaderboard() RETURNS BOOLEAN LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$ ... $$;` (pre-tournament short-circuit + match-window check + quiet-period check per R-5) + `CREATE OR REPLACE FUNCTION refresh_leaderboard() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ ... $$;` (caller kind detection via GUCs + admin gate + cron gating short-circuit + REFRESH MV CONCURRENTLY + audit emission + EXCEPTION block for FC-L2 decoupling) + `REVOKE ALL ON FUNCTION refresh_leaderboard() FROM PUBLIC, authenticated; GRANT EXECUTE ON FUNCTION refresh_leaderboard() TO postgres;` (same for `should_refresh_leaderboard()`)

### Generated types

- [x] T005 Regenerate `project-repos/world-cup-madness/lib/supabase/database.types.ts` via `npx supabase gen types typescript --local 2>/dev/null | sed -E '/^Connecting to db /d; /^<claude-code-hint/,$d' > lib/supabase/database.types.ts` after running `npx supabase db reset` + `docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c 'CREATE EXTENSION IF NOT EXISTS pgtap;'`; commit the regenerated file alongside the migrations. Confirm `leaderboard_snapshots` + `leaderboard_self` appear in the `Database['public']['Views']` and `Database['public']['Functions']` includes `refresh_leaderboard` + `should_refresh_leaderboard`.

### pgTAP tests (DB invariants)

- [x] T006 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/020_mv_leaderboard_snapshots.sql` per `contracts/mv-leaderboard-snapshots.md` — assert MV row count = active participants × 6 stages; `RANK()` produces shared ranks on tied participants (seed 3 tied + 1 distinct; expect ranks `1=`, `1=`, `1=`, `4`); `final_points = 0` for all non-`'all'` rows (FC-L4 / FR-L05); stage-specific `total_points` excludes `final-*` source rows; refresh with empty `score_events` leaves MV empty (FR-L07 + FR-L22 prerequisite); two consecutive refreshes produce identical state (NFR-L3 deterministic); refresh duration < 500 ms with 50-participant fixture (extrapolates to 200 per NFR-L3 budget). 18-22 asserts.
- [x] T007 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/021_rls_leaderboard_snapshots.sql` per `contracts/mv-leaderboard-snapshots.md` — set `auth.uid()` to participant A; assert SELECT on `participant_id, stage, display_name, total_points, rank, rank_is_shared` succeeds for ANY row (public projection); assert SELECT on `exact_hits` for a non-self row returns `permission denied for column exact_hits` (FR-L02 / NFR-L6); assert SELECT * via `leaderboard_self` returns A's own row with all columns (R-3); assert admin SELECT * via `leaderboard_snapshots` ALSO denied on private cols (FC-L6 — admin sees same surface; the column-level GRANT applies to admin's `authenticated` role too). 10-12 asserts.
- [x] T008 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/022_refresh_leaderboard_rpc.sql` per `contracts/rpc-refresh-leaderboard.md` — admin direct call → success + `leaderboard.refresh` audit row with `caller_kind='admin'`; non-admin direct call → `FORBIDDEN` (insufficient_privilege); cron-context call with `app.cron_caller='true'` + predicate=false → `{outcome:'skipped'}` + no audit row; cron-context call with predicate=true → success audit row with `caller_kind='cron'`; trigger-context call with `app.scoring_run_id` set → success audit row with `caller_kind='trigger'` + populated `scoring_run_id` FK; forced REFRESH failure (DROP UNIQUE index trick) → exception caught + `leaderboard.refresh_failed` row + scoring still commits (FC-L2). 14-16 asserts.
- [x] T009 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/023_leaderboard_cron_gating.sql` per `contracts/cron-leaderboard-refresh-tick.md` — verify `should_refresh_leaderboard()` returns false when `score_events` is empty (FR-L22); returns true when at least one non-cancelled match has `kickoff_utc` within `now() ± 90 min`; returns true when no `leaderboard.refresh` audit row exists yet (first-time); returns true when last refresh is > 60 min ago; returns false when last refresh ≤ 60 min ago AND no match in window; verify function classified as `STABLE` via `pg_proc.provolatile`. 10-12 asserts.

---

## Phase 3 — US-LA: Core ranking page

**Story goal**: An authenticated active participant can navigate to `/leaderboard` and see a paginated, tie-broken ranking of every active participant (rank, display name, total points). Auth gate redirects unauthed users. "Show my rank" anchor jumps to the participant's row.

**Independent test criteria**: With seeded `score_events` covering 5 participants at different scores (including a 2-way tie), navigating to `/leaderboard` as participant A renders all 5 rows in correct rank order with the tied pair both showing `=` suffix; unauthed navigation redirects to `/`; clicking "Show my rank" scrolls A's row into view.

**Maps to TCs**: TC-L1, TC-L2, TC-L5, TC-L6, TC-L9, TC-L13 (URL persistence partial — page-level), TC-L14 (mobile).

### Pure helpers (parallel)

- [x] T010 [P] [US-LA] Create `project-repos/world-cup-madness/lib/leaderboard/format-rank.ts` — pure helper `formatRank(rank: number, isShared: boolean): string` returning `"3"` for unique or `"3="` for shared (per `data-model.md` §2.2 + spec.md §8 UX). Export named.
- [x] T011 [P] [US-LA] Create `project-repos/world-cup-madness/lib/leaderboard/__tests__/format-rank.test.ts` — Jest spec asserting `formatRank(1, false) === "1"`, `formatRank(1, true) === "1="`, `formatRank(99, true) === "99="`, edge case `formatRank(0, false) === "0"` (defensive). 4-6 cases.

### Server Components

- [x] T012 [US-LA] Create `project-repos/world-cup-madness/components/leaderboard/EmptyLeaderboardState.tsx` — Server Component with placeholder body (renders `<p>{t('emptyMessage')}</p>` for now; the countdown logic ships in US-LE T034). Accepts props `{firstKickoffUtc: Date | null}`. Component shell only — full implementation in US-LE.
- [x] T013 [US-LA] Create `project-repos/world-cup-madness/components/leaderboard/LeaderboardTable.tsx` — Server Component, async. Props `{stage: string; page: number; rows: LeaderboardRow[]; selfParticipantId: string | null; locale: string}`. Renders an HTML `<table>` with `<caption>` (visually hidden), `<thead>` (Rank/Name/Points columns), `<tbody>` mapping rows. Each row is `<tr data-self={row.participant_id === selfParticipantId ? 'true' : null}>` with three `<td>` cells: rank (using `formatRank`), display_name, total_points. Apply Tailwind utility classes for mobile responsiveness (per FR-L15). Hidden screen-reader span on self-row for "Your rank". The data fetch happens in the parent (T015).
- [x] T014 [US-LA] Create `project-repos/world-cup-madness/components/leaderboard/ShowMyRankButton.tsx` — Client Component (`'use client'`). Props `{selfRank: number | null; rowsPerPage: number; activeStage: string; baseHref: string}`. Renders a button labelled `t('showMyRank')` that, on click, computes `targetPage = Math.ceil(selfRank / rowsPerPage)` and navigates via `useRouter().push(${baseHref}?stage=${activeStage}&page=${targetPage}#self-row)`, then `document.querySelector('[data-self="true"]')?.scrollIntoView({behavior: 'smooth', block: 'center'})`. After scroll, adds a 1.5s Tailwind ring highlight (`ring-2 ring-amber-400`) then removes it. Button is hidden when `selfRank === null` (pre-tournament).

### Page composition

- [x] T015 [US-LA] Create `project-repos/world-cup-madness/components/leaderboard/LeaderboardPage.tsx` — Server Component composing the page. Props `{searchParams: {stage?: string; page?: string}}`. Reads `auth.getUser()`, fetches the active participant (else 307 redirect to `/` per FR-L10 + TC-L2), determines `activeStage` (default `'all'`, validated against the enum), `currentPage` (default 1), then queries `leaderboard_snapshots` with `WHERE stage = $1 ORDER BY rank, display_name LIMIT 25 OFFSET (currentPage-1)*25` for the public columns + queries `leaderboard_self WHERE stage = $1` for the self row's `rank`. Composes `<h1>` heading + `<ShowMyRankButton/>` + `<LeaderboardTable/>` + pagination controls (prev/next links updating `?page=`). If no `score_events` row exists at all (pre-tournament), renders `<EmptyLeaderboardState/>` instead of the table.
- [x] T016 [US-LA] Create `project-repos/world-cup-madness/app/(participant)/leaderboard/page.tsx` — thin Server Component that mounts `<LeaderboardPage searchParams={searchParams}/>`. Exports `export const dynamic = 'force-dynamic'` (no ISR; Realtime is the freshness mechanism per plan §Constitution Check). Sets `<title>` via metadata export to `t('pageTitle')`.

### Playwright

- [ ] T017 [US-LA] Playwright spec `project-repos/world-cup-madness/e2e/tests/leaderboard-page.spec.ts` covering TC-L1, TC-L2, TC-L9, TC-L13 (basic), TC-L14. Seeds 5 active participants with deterministic score_events (one tied pair at 30 pts, others at 50/40/20); signs in as participant A; navigates to `/leaderboard`; asserts: 5 rows visible in correct order; tied pair both render `=` suffix; clicking "Show my rank" scrolls A's row into view with the highlight ring class present. Separate test: unauthed `goto('/leaderboard')` returns 307 → `/`. Separate test: 360 px viewport renders without horizontal scroll. Owned provider_id range: matches don't matter for this spec (seeded score_events directly); player range N/A.
- [ ] T018 [US-LA] Playwright spec `project-repos/world-cup-madness/e2e/tests/leaderboard-tie-breakers.spec.ts` covering TC-L5 + TC-L6. Seeds 4 participants designed to exercise each tie-breaker level: P1 (total=100, exact=2), P2 (total=100, exact=1) — tied on total, distinguished by exact; P3 (total=100, exact=1, outcome=3), P4 (total=100, exact=1, outcome=2) — tied on total + exact, distinguished by outcome; verify ranks 1, 2, 3, 4 in that order. Then a tied scenario all the way through final_points → assert shared rank with `=` suffix.

---

## Phase 4 — US-LB: Stage filter

**Story goal**: Participant can switch among `All`, `Group`, `R16`, `Quarter`, `Semi`, `Final` tabs; the rankings re-aggregate to show only that stage's match points (with `final-*` sources excluded for stage-specific tabs per FC-L4). Filter state persists in the URL.

**Independent test criteria**: With seeded score_events spanning group-stage + final-prediction sources for the same participants, switching from `All` to `Group` removes the final-prediction points from the totals and re-ranks the participants accordingly; reloading the page with `?stage=group` preserves the filter.

**Maps to TCs**: TC-L7, TC-L8, TC-L13 (URL persistence — stage param).

### Pure helpers

- [x] T019 [P] [US-LB] Create `project-repos/world-cup-madness/lib/leaderboard/stage-url-state.ts` — pure helpers `parseStage(param: string | null): Stage` (returns `'all'` for null/invalid; otherwise validates against the enum) and `formatStageHref(stage: Stage, page?: number): string`. Export `type Stage = 'all' | 'group' | 'r16' | 'quarter' | 'semi' | 'final'`.
- [x] T020 [P] [US-LB] Create `project-repos/world-cup-madness/lib/leaderboard/__tests__/stage-url-state.test.ts` — Jest spec asserting `parseStage(null) === 'all'`, `parseStage('group') === 'group'`, `parseStage('GROUP') === 'all'` (case-sensitive), `parseStage('invalid') === 'all'`, `parseStage('final') === 'final'`; `formatStageHref('group', 2) === '/leaderboard?stage=group&page=2'`. 8-10 cases.

### Component

- [x] T021 [US-LB] Create `project-repos/world-cup-madness/components/leaderboard/StageTabStrip.tsx` — Client Component, WAI-ARIA tabs pattern (`role="tablist"`, `role="tab"`, `aria-selected`). Props `{activeStage: Stage; baseHref: string; labels: {[K in Stage]: string}}`. Renders 6 buttons (one per stage); active stage gets `aria-selected="true"` + Tailwind highlight; click navigates via `router.push(formatStageHref(stage))`. Arrow Left/Right keyboard nav cycles among tabs (focus + activate on Enter/Space per WAI-ARIA). Horizontally scrollable on mobile (overflow-x-auto).
- [x] T022 [US-LB] Modify `project-repos/world-cup-madness/components/leaderboard/LeaderboardPage.tsx` (from T015) to: (a) parse `stage` from `searchParams` via `parseStage`; (b) render `<StageTabStrip activeStage={stage} ... />` above the table; (c) query MV with the parsed stage (note: page already used `activeStage` in T015 — this task wires the tabs into the actual fetch).

### Playwright

- [ ] T023 [US-LB] Playwright spec `project-repos/world-cup-madness/e2e/tests/leaderboard-stage-filter.spec.ts` covering TC-L7 + TC-L8 + TC-L13 (stage URL persistence). Seeds 3 participants: P1 with only group-stage points (15 pts), P2 with group-stage 10 + final-prediction-correct 20 (total 30), P3 with only final-prediction-correct 20. With stage=`all`: ranking is P2 (30), P3 (20), P1 (15). With stage=`group`: ranking is P1 (15), P2 (10), P3 (0) — final-prediction points excluded. Switch tabs by clicking + assert ranking changes accordingly. Reload `?stage=group` + assert the Group tab is active + ranking matches. Owned match range: provider_id 9201-9210 (disjoint).

---

## Phase 5 — US-LC: Live updates via Realtime + scoring trigger integration

**Story goal**: When an admin (or trigger) completes a scoring run, every viewer of `/leaderboard` sees the updated rankings within 5 seconds without refreshing. Admin can manually invoke `refresh_leaderboard()` to force a refresh.

**Independent test criteria**: With `/leaderboard` open in a browser, an external scoring event (e.g. admin UPDATEs a match's score) causes the visible table to re-render within 5 seconds. Forced refresh failure (simulated via DROP INDEX) leaves the page showing the prior state without errors; the scoring transaction still commits.

**Maps to TCs**: TC-L4, TC-L15.

### Schema extension

- [ ] T024 [US-LC] Migration `project-repos/world-cup-madness/supabase/migrations/0034_extend_scoring_triggers_refresh.sql` per `data-model.md` §5 — `CREATE OR REPLACE FUNCTION calculate_match_points(...)` with the SAME body as feature 003 migration 0030 PLUS a trailing `BEGIN PERFORM refresh_leaderboard(); EXCEPTION WHEN OTHERS THEN NULL; END;` block; same for `calculate_final_points()` (feature 003 migration 0031) and `recalculate_all_scores()` (feature 003 migration 0028). The outer EXCEPTION block is a NO-OP because `refresh_leaderboard()` writes its own failure audit row — so this block has nothing to do beyond swallowing the exception. NOTE: this migration must `CREATE OR REPLACE` the entire function bodies (Postgres can't ALTER FUNCTION body); copy from feature 003 migrations + add the tail block.
- [ ] T025 [US-LC] pgTAP test `project-repos/world-cup-madness/test/pgtap/024_scoring_trigger_mv_extension.sql` per `data-model.md` §5 + spec.md NFR-L2 (decoupling). Asserts: (a) UPDATE on `matches` triggers `calculate_match_points()` which then refreshes MV and writes one `leaderboard.refresh` audit row; (b) MV reflects new scores after trigger fires; (c) DROP UNIQUE index `leaderboard_snapshots_pk` then UPDATE matches → trigger still commits + `leaderboard.refresh_failed` audit row written + MV unchanged + `score_events` updated successfully (FC-L2); (d) re-CREATE index then admin invokes `refresh_leaderboard()` directly → MV catches up + new `leaderboard.refresh` row. 12-14 asserts.

### Realtime UI

- [ ] T026 [US-LC] Create `project-repos/world-cup-madness/components/leaderboard/ReconnectingIndicator.tsx` — Client Component, props `{visible: boolean}`. Renders a small `<div role="status">{t('reconnecting')}</div>` chip in the page header (Tailwind `fixed top-2 right-2` or similar) only when `visible === true`. Accessible status announcement per WCAG.
- [ ] T027 [US-LC] Create `project-repos/world-cup-madness/components/leaderboard/LeaderboardRealtime.tsx` — Client Component (`'use client'`) wrapping `<LeaderboardTable/>`. Props `{initialRows: LeaderboardRow[]; activeStage: Stage; currentPage: number}`. On mount, opens a Supabase Realtime channel subscribed to `audit_log` INSERTs filtered by `event_type=eq.leaderboard.refresh` per `contracts/realtime-channel-leaderboard-snapshots.md`. On each event, re-fetches MV rows for the active stage + page via `createBrowserClient` + updates state. Tracks channel status; if non-SUBSCRIBED for > 10 s, shows `<ReconnectingIndicator visible={true}/>`. Initial paint uses `initialRows` (server-rendered); subsequent updates use the re-fetched state. Cancels the channel on unmount.
- [ ] T028 [US-LC] Modify `project-repos/world-cup-madness/components/leaderboard/LeaderboardPage.tsx` (from T015 + T022) to wrap `<LeaderboardTable/>` in `<LeaderboardRealtime initialRows={rows} activeStage={stage} currentPage={page}/>`. The Server Component still does the initial fetch; the Client wrapper takes over for live updates.

### Playwright

- [ ] T029 [US-LC] Playwright spec `project-repos/world-cup-madness/e2e/tests/leaderboard-realtime.spec.ts` covering TC-L4 + TC-L15. Open `/leaderboard` as participant A; capture initial ranks; from a separate context (service-role admin), UPDATE a match's `score_home`/`score_away`/`status` to trigger scoring (which extends to refresh MV); assert the visible page updates within 5 s without manual reload. Separate test: admin invokes `recalculate_all_scores()` RPC → page updates within 5 s. Use `page.waitForFunction` with timeout for the assertion. Owned match range: provider_id 9301-9310.

---

## Phase 6 — US-LD: Dashboard widget

**Story goal**: On `/dashboard`, a participant sees a compact "Your rank: N (↑/↓ delta)" card. Card subscribes to the same Realtime stream as `/leaderboard` and updates in place. Pre-tournament state shows "Leaderboard opens at [first kickoff]".

**Independent test criteria**: With seeded scores, `/dashboard` shows the participant's rank + 0 delta on first visit. After a scoring event that moves the participant from rank 12 to rank 10, the widget shows "10" with "↑ 2" delta indicator.

**Maps to TCs**: TC-L10, TC-L11 (pre-tournament widget state).

### Pure helper

- [ ] T030 [P] [US-LD] Create `project-repos/world-cup-madness/lib/leaderboard/compute-delta.ts` — pure helper `computeDelta(previousRank: number | null, currentRank: number): {direction: 'up' | 'down' | 'flat' | 'first'; magnitude: number}`. `previousRank=null → 'first', 0`; equal → `'flat', 0`; `previous > current → 'up', previous-current`; `previous < current → 'down', current-previous`.
- [ ] T031 [P] [US-LD] Create `project-repos/world-cup-madness/lib/leaderboard/__tests__/compute-delta.test.ts` — Jest spec with cases: first load (null), no change, up, down, large magnitude.

### Widget + dashboard integration

- [ ] T032 [US-LD] Create `project-repos/world-cup-madness/components/dashboard/RankWidget.tsx` — Client Component. Props `{initialRank: number | null; initialFirstKickoffUtc: string | null}`. If `initialRank === null AND initialFirstKickoffUtc !== null` → renders the pre-tournament message `t('widgetPreTournament', {time: formatTimeInUserTz(initialFirstKickoffUtc)})`. Otherwise subscribes to the audit-event channel (mirrors `LeaderboardRealtime` pattern), re-fetches own `leaderboard_self` row on each event, computes delta against previous state via `computeDelta`. Renders compact card: rank number + arrow + delta magnitude (`↑ 3` / `↓ 1` / `—`). Card is a `<Link href="/leaderboard">...</Link>` so click navigates to the full page. Visually compact (one line desktop, two-line mobile).
- [ ] T033 [US-LD] Modify `project-repos/world-cup-madness/app/(participant)/dashboard/page.tsx` to: (a) on render, fetch the participant's `leaderboard_self WHERE stage = 'all'` row (or null if pre-tournament) + the first non-cancelled match's kickoff_utc (for pre-tournament message); (b) mount `<RankWidget initialRank={selfRow?.rank ?? null} initialFirstKickoffUtc={firstKickoff?.toISOString() ?? null}/>` ABOVE the existing upcoming-matches widget; (c) preserve all existing dashboard content otherwise.

### Playwright

- [ ] T034 [US-LD] Playwright spec `project-repos/world-cup-madness/e2e/tests/leaderboard-dashboard-widget.spec.ts` covering TC-L10 + TC-L11. Seeds scores placing participant A at rank 12; navigates to `/dashboard`; asserts the "Your rank: 12" widget visible + delta is `—` (first visit). External scoring event re-ranks A to 10; asserts widget shows "10" + "↑ 2" within 5 s. Separate test: with `score_events` empty + a future match seeded, `/dashboard` shows widget "Leaderboard opens at [time]" message instead of a rank.

---

## Phase 7 — US-LE: Pre-tournament + cron self-healing

**Story goal**: Before the first match is scored, `/leaderboard` shows a countdown to the first kickoff (in user's timezone) instead of an empty ranking. The pg_cron job ticks every 5 minutes and refreshes the MV only when warranted (in match windows or quiet periods past 60 min) — keeping the leaderboard self-healing even when scoring doesn't fire.

**Independent test criteria**: With `score_events` empty, `/leaderboard` renders the countdown to the earliest non-cancelled match's kickoff_utc. Verify `should_refresh_leaderboard()` returns false in this state (cron tick is a no-op). After seeding one finished match, the cron next-tick refreshes the MV and the page transitions to the ranked state.

**Maps to TCs**: TC-L3, TC-L11 (page-side pre-tournament — widget side covered in US-LD).

### Pure helper

- [ ] T035 [P] [US-LE] Create `project-repos/world-cup-madness/lib/leaderboard/countdown-time.ts` — pure helper `formatCountdownTarget(firstKickoffUtc: Date, userTz: string, locale: string): string` returning a locale-formatted "June 12, 2026 at 18:00 GMT-3" style string using `Intl.DateTimeFormat`. Plus `formatRelativeCountdown(firstKickoffUtc: Date, now: Date): string` returning a "in 5 days" or "in 3 hours" style string. Companion Jest test at `lib/leaderboard/__tests__/countdown-time.test.ts` with 6-8 cases covering: 5 days future, 3 hours future, 2 minutes future, past (returns "now"), all 3 locales.

### Component completion + cron migration

- [ ] T036 [US-LE] Modify `project-repos/world-cup-madness/components/leaderboard/EmptyLeaderboardState.tsx` (placeholder from T012) — full implementation. Props `{firstKickoffUtc: Date | null; userTz: string; locale: string}`. If `firstKickoffUtc === null` → "No matches scheduled yet" message. Otherwise renders `<h2>{t('opensAt')}</h2>` + `<time dateTime={...}>{formatCountdownTarget(...)}</time>` + relative `<p>{formatRelativeCountdown(...)}</p>`. Accessible per WCAG (semantic `<time>` element with datetime attribute).
- [ ] T037 [US-LE] Modify `project-repos/world-cup-madness/components/leaderboard/LeaderboardPage.tsx` to: (a) detect pre-tournament state by checking `SELECT 1 FROM score_events LIMIT 1` returning no row; (b) if pre-tournament: fetch the first non-cancelled match's `kickoff_utc` + participant's `timezone` + render `<EmptyLeaderboardState/>` instead of the table; (c) reuse the same empty-state primitive for stage-filtered states where no matches in that stage have finished (per spec.md §3 Edge Cases). The widget pre-tournament case (T032) is independent and already shipped in US-LD.
- [ ] T038 [US-LE] Migration `project-repos/world-cup-madness/supabase/migrations/0035_leaderboard_cron.sql` per `data-model.md` §7 + `contracts/cron-leaderboard-refresh-tick.md` — `SELECT cron.schedule('leaderboard-refresh-tick', '*/5 * * * *', $$ SET LOCAL app.cron_caller = 'true'; SELECT refresh_leaderboard(); $$);`. Plus a small `DO $$` block verifying `pg_cron` extension is present (`CREATE EXTENSION IF NOT EXISTS pg_cron;` is feature 003's responsibility; this migration assumes it).

### Playwright

- [ ] T039 [US-LE] Playwright spec `project-repos/world-cup-madness/e2e/tests/leaderboard-pre-tournament.spec.ts` covering TC-L3 + TC-L11 (page-side). Sets DB state: truncate `score_events`; ensure one future match exists. As participant A, navigate to `/leaderboard`; assert the countdown text is visible (`opensAt` + the formatted time); assert no `<table>` is rendered. Separate test: with `score_events` empty + no matches, the empty state shows the "No matches scheduled yet" fallback. Note: this spec must run with `score_events` empty — own a unique provider_id range (9501-9510) for any test-seeded matches and clean wholesale-clear of `score_events` in beforeEach (mirrors the `predictions-final-*` spec defensive pattern from the May 2026 fix).

---

## Final Phase — Polish & cross-cutting concerns

### Privacy spec

- [ ] T040 Playwright spec `project-repos/world-cup-madness/e2e/tests/leaderboard-privacy.spec.ts` covering TC-L12. As participant A on `/leaderboard`, capture: (a) the DOM — assert no `exact_hits` / `outcome_hits` / `final_points` / per-source data appears in any non-self row's `<tr>` (only rank, name, total); (b) the Realtime WebSocket frame payload — assert the audit-event message carries only `event_type`, `created_at`, `new_value` metadata and NO participant scores. Use `page.on('websocket')` + frame inspection. Then trigger a scoring event for participant B and re-capture the WS frame; assert same (no leak). Repeat in admin role: admin sees the same column set (FC-L6 verification).

### A11y + i18n

- [ ] T041 [P] Modify `project-repos/world-cup-madness/e2e/tests/all-pages-a11y.spec.ts` — add 3 new test cases covering TC-L16 across `/leaderboard` states: (a) populated (seeded 5 participants); (b) pre-tournament (empty score_events + future match); (c) stage-filtered (`?stage=quarter` with seeded quarter matches). Use the `seedA11yMatches` helper. Plus extend the existing `/dashboard` a11y test to scan with `<RankWidget/>` mounted (covered by re-running the test post-T033). All assertions: zero axe-core violations at WCAG 2.1 AA.
- [ ] T042 [P] Add `leaderboard.*` i18n keys to `project-repos/world-cup-madness/lib/i18n/messages/{en,es,pt-BR}.json` per `data-model.md` §6 / contracts. Required keys: `pageTitle`, `pageHeading`, `pageDescription`, `stageAll`, `stageGroup`, `stageR16`, `stageQuarter`, `stageSemi`, `stageFinal`, `rankColumn`, `nameColumn`, `pointsColumn`, `showMyRank`, `noMatchesYet`, `opensAt`, `widgetPreTournament`, `widgetRankLabel`, `reconnecting`. English-first authoritative; es + pt-BR with native-speaker review queued (note in dod-verification.md). One commit per locale or one combined — 3 file edits.

### Pristine sweep + DoD + docs

- [ ] T043 Run the full pristine sweep — pgTAP (`for f in test/pgtap/02{0,1,2,3,4}_*.sql; do docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -f - < $f; done`), Jest (`npm test`), Playwright (`npx playwright test`), tsc (`npx tsc --noEmit`), ESLint (`npm run lint`). All five MUST report zero failures / zero warnings before T044 proceeds.
- [ ] T044 Write `project-repos/world-cup-madness/specs/004-leaderboard/dod-verification.md` mirroring feature 002 + 003 format: per-FR (FR-L01..L22) / per-NFR (NFR-L1..L7) / per-TC (TC-L1..L19) coverage table; constraint verification (FC-L1..L6); cite migration numbers + test files for each FR-L; list outstanding external items (50-concurrent-Realtime-subscribers load test against Pro tier, native-speaker translation review of new `leaderboard.*` keys, post-merge verification that the cron schedule activates on the deployed Supabase project).
- [ ] T045 [P] Update `project-repos/world-cup-madness/README.md` — add a new "Feature 004 — Leaderboard" section sibling to features 001-003; document new local commands (how to manually `SELECT refresh_leaderboard()` to force a refresh; how to inspect `cron.job` for the schedule status; how to read `audit_log` for `leaderboard.refresh` rows); troubleshooting matrix from `quickstart.md` §10 (stale leaderboard, permission denied on private columns, Realtime disconnects, etc.); cross-references to spec / DoD / contracts.
- [ ] T046 [P] Verify `.ai_project_memory/constitution-backend.md` has the three new rows added during plan workflow (Materialised view with RLS, Realtime over audit-event proxy, pg_cron gating predicate pattern). If absent, re-add per `plan.md` §Phase 1 §Stack constitution update. No frontend-constitution changes needed (reuses existing data-table + tab-strip + Realtime patterns).

### Wrap-up

- [ ] T047 Mark all phase-2 through final-phase tasks complete in this file using the Python in-place-rewrite pattern from features 002/003 (`python3 -c "re.sub r'^- \[ \] (T0\d{2}) ', r'- [x] \1 '"`). Commit the marked tasks.md alongside the DoD doc in the final commit.

---

## Dependencies & MVP delivery strategy

### Story-level dependency graph

```
Phase 1 (Setup, T001-T002)
        ↓
Phase 2 (Foundational, T003-T009)
        ↓
        ├──→ US-LA (T010-T018, P1)         ←── MVP must-have
        │       ↓
        │       ├──→ US-LB (T019-T023, P1)  ←── MVP must-have (stage filter)
        │       │
        │       └──→ US-LC (T024-T029, P1)  ←── MVP must-have (live updates)
        │
        ├──→ US-LD (T030-T034, P2)          ←── MVP nice-to-have (widget)
        │
        └──→ US-LE (T035-T039, P2)          ←── MVP nice-to-have (pre-tournament + cron)
                ↓
Final Phase (T040-T047)
```

### MVP scope (recommended)

**Phase 1 + Phase 2 + US-LA + US-LC** — 28 tasks. Gives participants the live-updating ranking page (the core engagement loop). Defers:
- US-LB (stage filter) — useful but not essential at launch; can ship as a single follow-up commit.
- US-LD (dashboard widget) — engagement boost; not on the critical participation path.
- US-LE (pre-tournament + cron) — only matters before the first match; can ship just before kickoff.

If preferred, MVP can include US-LB to cover the full read surface from day 1 (33 tasks).

### Parallel execution opportunities

Within phases, `[P]` markers identify tasks that can run in parallel (independent files, no within-stream dependencies). Key parallel opportunities:

- **Phase 2 pgTAP tests** (T006-T009): all four files are independent — can dispatch as 4 parallel Agent tasks.
- **US-LA pure helpers** (T010-T011): independent of components — run alongside T012-T014.
- **US-LB helpers** (T019-T020): parallel with T021.
- **US-LD helpers** (T030-T031): parallel with T032.
- **Final Phase i18n + a11y + README** (T041, T042, T045): all three can dispatch in parallel.

### Risk hotspots

- **T003 (MV definition with UNION ALL)** — first complex MV in the project. Build incrementally with `psql` REPL: first the `all_stage` CTE alone; verify; then add one stage CTE at a time. Confirm `REFRESH CONCURRENTLY` succeeds before adding more stages.
- **T004 (refresh_leaderboard RPC)** — the EXCEPTION block + GUC-based caller detection is non-obvious. Test all four caller kinds (admin / trigger / cron / unauthenticated) BEFORE wiring into T024.
- **T024 (scoring trigger extension)** — modifies production feature 003 trigger bodies. Test in a clean reset first; verify scoring still works for the existing feature 003 Playwright suite.
- **T025 (decoupling pgTAP test)** — verifying FC-L2 requires deliberately breaking the refresh (e.g. DROP UNIQUE index) and confirming scoring still commits. Use a SAVEPOINT pattern.
- **T029 (Realtime end-to-end)** — Playwright + Realtime + scoring trigger is a 3-system chain; flakes are likely. Pad timeouts (5 s + retry once); use `page.waitForFunction` with deterministic conditions.
- **T039 (pre-tournament spec)** — needs `score_events` empty AT TEST START. Apply the wholesale-clear pattern from the memory `wcm-feature-003-implementation-progress` (now retired) + global-setup pattern from the May 2026 fix.

---

## Task ID summary

| Phase | Task IDs | Count |
|---|---|---|
| 1 — Setup | T001-T002 | 2 |
| 2 — Foundational | T003-T009 | 7 |
| 3 — US-LA | T010-T018 | 9 |
| 4 — US-LB | T019-T023 | 5 |
| 5 — US-LC | T024-T029 | 6 |
| 6 — US-LD | T030-T034 | 5 |
| 7 — US-LE | T035-T039 | 5 |
| Final | T040-T047 | 8 |
| **Total** | T001-T047 | **47** |

(Plan estimate was 35-45; the final count is 47 because the Realtime + dashboard widget tracks each grew an extra component task once the implementation details were worked out, and the Final Phase split README + constitution check + DoD + i18n into separate tasks for clean commit boundaries. Still substantially smaller than feature 003's 74 tasks because: 1 MV vs 5 tables, 1 RPC vs 4, no Edge Function changes, reuse of established UI patterns.)
