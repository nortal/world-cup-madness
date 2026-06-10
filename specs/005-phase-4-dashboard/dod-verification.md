# Feature 005 (Phase 4 Dashboard) Definition-of-Done Verification

**Date:** 2026-06-10
**Branch:** `005-phase-4-dashboard`
**Scope:** Phase 4 Dashboard polish + mobile UX (FR-D01–FR-D21 / NFR-D01–NFR-D08 / TC-D1–TC-D17 / FC-D1–FC-D4) — verifies `specs/005-phase-4-dashboard/spec.md` Definition of Done.

## Executive Summary

Feature 005 redesigns `/dashboard` as a mobile-first tabbed surface (Today / Pool) with a desktop 2-column grid fallback (FR-D01–D05), adds inline quick-edit on the upcoming-match widget (FR-D06–D08, FR-D20), ships four engagement widgets — split prediction snapshot, ±5 neighborhood slice, 24-hour movers (global + neighborhood), weekly digest (FR-D09–D13) — wires a Realtime stale-while-revalidate path with a polite-live refreshing chip (FR-D15, FR-D19, FR-D21), and adds pre-tournament placeholders for the Pool widgets (FR-D14). All visible text is sourced from the next-intl catalogue across `en` / `es` / `pt-BR` (FR-D16). Schema impact is one read-only SECURITY DEFINER aggregator RPC (migration 0038, FC-D1 carve-out). Pristine sweep: **pgTAP 12 / Jest 195 / tsc 0 / ESLint 0 / Playwright dashboard suite 18 / 18.**

### Pre-existing bug fixed in scope

`RankWidget.tsx` was opening a Supabase Realtime channel under the fixed topic `leaderboard-refresh`. DashboardPage renders the Today widget tree twice (mobile panel + desktop grid), so two RankWidget instances mount and `supabase.channel()` coalesces by topic — the second mount's `.on()` lands on an already-SUBSCRIBED channel and throws `cannot add postgres_changes callbacks for realtime:leaderboard-refresh after subscribe()`. The pre-tournament path early-returned before subscribe, which is why feature 004's tests never tripped this. The fix attaches a per-mount unique suffix via `useId()`. Committed in `7a6363c`.

### Pre-existing test isolation flaws fixed in scope

The T046 pristine sweep surfaced six failing dashboard specs written before the US-DA mobile/desktop dual-render landed: welcome-modal intercept (no `dismiss_welcome` RPC call after provision), accessible-name churn on toggle (button name flips between "Edit prediction" and "Collapse"), `.first()` resolving to hidden mobile copies at the default desktop viewport, and cross-spec match leakage (prior dashboard specs leave matches that the upcoming widget picks up and ranks above the test's own seed). All six fixes captured in `1f0885e`.

## Per-FR Coverage (FR-D01 through FR-D21)

| FR | Requirement (one-line) | Implementation | Test Evidence |
|---|---|---|---|
| FR-D01 | Responsive layout: tabbed mobile / grid desktop at 768 px breakpoint | `components/dashboard/DashboardPage.tsx` (block md:hidden + hidden md:grid) | `e2e/tests/dashboard-mobile-tabs.spec.ts` (TC-D1 + TC-D2) |
| FR-D02 | Tab strip → URL state via `?tab=today`/`?tab=pool`, default today, no client persistence | `lib/dashboard/tab-url-state.ts` + `DashboardTabStrip.tsx` | `lib/dashboard/__tests__/tab-url-state.test.ts` (9 Jest); `dashboard-mobile-tabs.spec.ts` (TC-D1 + URL preservation) |
| FR-D03 | Today tab = Upcoming + Rank + Snapshot in order | `DashboardPage.tsx` `todayWidgets` fragment | `dashboard-upcoming-widget.spec.ts` (TC-M10), `dashboard-inline-edit.spec.ts` (TC-D3) |
| FR-D04 | Pool tab = Neighborhood + Movers + Digest in order | `DashboardPage.tsx` `poolWidgets` fragment | `dashboard-neighborhood.spec.ts` + `dashboard-movers.spec.ts` + `dashboard-digest.spec.ts` |
| FR-D05 | Desktop > 768 px: all six widgets in 2-col grid, no tab strip | `DashboardPage.tsx` `<div className="hidden md:grid md:grid-cols-2 …">` | `dashboard-mobile-tabs.spec.ts` (TC-D2 strip CSS-hidden) |
| FR-D06 | Upcoming widget tappable; expands in place with score inputs + Save | `components/matches/ExpandableMatchCard.tsx` + `InlinePredictionForm.tsx` | `dashboard-inline-edit.spec.ts` (TC-D3) |
| FR-D07 | Sticky lock-countdown badge inside expanded card; updates ≥ 1×/s | `ExpandableMatchCard.tsx` + `components/matches/LockCountdownTicker.tsx` | `dashboard-inline-edit.spec.ts` (TC-D4 — badge text differs across 1.5 s) |
| FR-D08 | Inline save reuses server-side lock validation; locked → errorLocked + badge swap | `InlinePredictionForm.tsx` reuses `submit_prediction` RPC | `dashboard-inline-edit.spec.ts` (TC-D5 boundary at exactly −60 min) |
| FR-D09 | Snapshot widget: last finished + next upcoming side-by-side / stacked | `components/dashboard/SnapshotWidget.tsx` | covered by `dashboard-inline-edit.spec.ts` interactive path; widget renders inline within Today widgets |
| FR-D10 | Neighborhood widget: hybrid-clamped ±5 with self-row highlight | `NeighborhoodWidget.tsx` + `lib/dashboard/neighborhood-window.ts` | `lib/dashboard/__tests__/neighborhood-window.test.ts` (Jest); `dashboard-neighborhood.spec.ts` (TC-D6 top-clamp, TC-D7 centre, TC-D8 bottom-clamp, small-pool) |
| FR-D11 | Movers widget: "Top 3 in pool" + "Top 3 near you" sub-sections | `MoversWidget.tsx` + `lib/dashboard/movers-24h.ts` | `lib/dashboard/__tests__/movers-24h.test.ts` (Jest); `dashboard-movers.spec.ts` (TC-D9) |
| FR-D12 | 24-h delta computed from `score_events.awarded_at`; no new snapshot table | `migrations/0038_movers_24h_rpc.sql` + `computeMovers` helper | `test/pgtap/025_movers_aggregate_rpc.sql` (12 asserts including STABLE/SECURITY DEFINER/anon-denied/authenticated-allowed/perf) |
| FR-D13 | Weekly digest: total + count + best + worst across Mon-Sun UTC | `DigestWidget.tsx` + `lib/dashboard/weekly-digest.ts` | `lib/dashboard/__tests__/weekly-digest.test.ts` (Jest); `dashboard-digest.spec.ts` (TC-D10 incl. final-prediction exclusion) |
| FR-D14 | Pre-tournament placeholder for Movers / Digest / Neighborhood; Today widgets unchanged | `components/dashboard/PreTournamentPlaceholder.tsx` + branch in `DashboardPage.tsx` | `dashboard-pre-tournament.spec.ts` (TC-D11) |
| FR-D15 | Subscribe to `leaderboard-refresh`; debounce 300 ms; single batched re-fetch | `DashboardRealtime.tsx` (300 ms `setTimeout`-debounced router.refresh inside startTransition) | `dashboard-realtime.spec.ts` (TC-D12 — 5 inserts in ≤ 200 ms → exactly 1 RSC re-fetch) |
| FR-D16 | All visible text via next-intl across en/es/pt-BR | `lib/i18n/messages/{en,es,pt-BR}.json` `dashboard.*` block | T045 static used-vs-defined audit (35 keys called via `t(...)` in `components/dashboard/*`, all present in three locales); dashboard a11y sweep at en locale (T044) |
| FR-D17 | Keyboard ops: Tab, Arrows on tab strip, Enter/Space on expand | `DashboardTabStrip.tsx` manual-activation pattern; `ExpandableMatchCard.tsx` button toggle | `all-pages-a11y.spec.ts` 4 new dashboard cases (T044 — zero WCAG 2.1 AA axe violations) |
| FR-D18 | Existing surfaces preserved: UpcomingMatchesWidget, RankWidget, admin nav, predictions nav, TimezoneAutoDetect, welcome flow | composer wraps existing widgets unchanged | `dashboard-upcoming-widget.spec.ts` (TC-M10 widget still renders); existing `/dashboard` a11y test (no welcome modal regression) |
| FR-D19 | Stale-while-revalidate; refreshing chip with `role="status"`; chip dismisses on commit | `RefreshingChip.tsx` reads `DashboardRefreshContext.isRefetching` (= `useTransition().isPending`) | `dashboard-realtime.spec.ts` (TC-D16 — chip visible mid-transition, widget container box unchanged, chip hidden after commit, PerformanceObserver CLS ≤ 0.1) |
| FR-D20 | Inline save surfaces full error set (errorOutOfRange / Locked / MatchNotFound / etc.); card stays expanded on error | `InlinePredictionForm.tsx` reuses `PredictionFormError` from feature 003 | `dashboard-inline-edit.spec.ts` (TC-D17 errorOutOfRange + aria-expanded stays true) |
| FR-D21 | Extended Realtime outage → stale data + ReconnectingIndicator visible; reconnect → catch-up re-fetch | `DashboardRealtime.tsx` reconnect-threshold timer + ReconnectingIndicator mount + catch-up `router.refresh()` on SUBSCRIBED recovery | follow-up — outage simulation deferred to integration-environment soak test (see Outstanding Items) |

## Per-NFR Coverage (NFR-D01 through NFR-D08)

| NFR | Target | Evidence |
|---|---|---|
| NFR-D01 | SSR p95 ≤ 1 s on 200-participant DB | local dev-build cold paint observed ≈ 300–500 ms in `/tmp/wcm-next.log`; load-shape validation against the Pro tier deferred to deploy (see Outstanding Items) |
| NFR-D02 | Mobile LCP ≤ 2.5 s (Lighthouse simulated 4G) | local Lighthouse-in-CI not wired; mobile LCP measurement deferred to deploy + Lighthouse-in-CI configuration (see Outstanding Items) |
| NFR-D03 | Zero horizontal scroll at 360 px | observed during a11y sweep on 4 dashboard surfaces (T044 — populated + pre-tournament at 360 px); no horizontal-scroll violation surfaced by axe |
| NFR-D04 | Dashboard WCAG 2.1 AA — zero axe violations | `all-pages-a11y.spec.ts` 4 dashboard cases (T044) — populated mobile today, populated mobile pool, populated desktop, pre-tournament mobile — all zero violations |
| NFR-D05 | CLS ≤ 0.1 on Realtime transitions | `dashboard-realtime.spec.ts` TC-D16 — PerformanceObserver-measured CLS asserted ≤ 0.1 |
| NFR-D06 | Debounce 300 ms ± 50 ms; 5-events-in-200-ms → 1 re-fetch | `dashboard-realtime.spec.ts` TC-D12 — exactly 1 RSC re-fetch observed |
| NFR-D07 | `get_movers_24h_aggregate()` p95 ≤ 250 ms on 200-participant fixture | `test/pgtap/025_movers_aggregate_rpc.sql` TEST 12 (200-participant timing assert, observed 1.7–2.7 ms locally per earlier session); production p95 verification deferred (see Outstanding Items) |
| NFR-D08 | Inline save emits structured JSON log per Constitution §1.3 | `InlinePredictionForm.tsx` reuses the existing `PredictionForm` log emitter (`event`, `participant_id`, `match_id`, `outcome`, `error_code`); covered by feature 003's existing log-shape tests |

## Per-TC Coverage (TC-D1 through TC-D17)

| TC | Behaviour | Spec |
|---|---|---|
| TC-D1 | Mobile tab navigation + URL state | `dashboard-mobile-tabs.spec.ts` (TC-D1) |
| TC-D2 | Desktop responsive grid + strip hidden | `dashboard-mobile-tabs.spec.ts` (TC-D2 + reload preserves ?tab=pool) |
| TC-D3 | Inline quick-edit expand + save success | `dashboard-inline-edit.spec.ts` (TC-D3) |
| TC-D4 | Sticky lock countdown ticks ≥ 1×/s | `dashboard-inline-edit.spec.ts` (TC-D4) |
| TC-D5 | Lock boundary at exactly −60 min | `dashboard-inline-edit.spec.ts` (TC-D5) |
| TC-D6 | Neighborhood top-clamp | `dashboard-neighborhood.spec.ts` (TC-D6) |
| TC-D7 | Neighborhood mid-shrink (centre) | `dashboard-neighborhood.spec.ts` (TC-D7) |
| TC-D8 | Neighborhood bottom-shrink | `dashboard-neighborhood.spec.ts` (TC-D8) + small-pool edge |
| TC-D9 | Movers global + neighborhood sub-sections | `dashboard-movers.spec.ts` (TC-D9) |
| TC-D10 | Weekly digest aggregate + final-prediction exclusion | `dashboard-digest.spec.ts` (TC-D10) |
| TC-D11 | Pre-tournament placeholders for Pool widgets | `dashboard-pre-tournament.spec.ts` (TC-D11) |
| TC-D12 | Realtime debounced re-fetch (5 events → 1 fetch) | `dashboard-realtime.spec.ts` (TC-D12) |
| TC-D13 | SSR ≤ 1 s + LCP ≤ 2.5 s budget | deferred to deploy + Lighthouse-in-CI (see Outstanding Items) |
| TC-D14 | a11y across 4 dashboard surfaces | `all-pages-a11y.spec.ts` T044 — 4 new cases, zero violations |
| TC-D15 | i18n across en/es/pt-BR for every visible label | T045 static used-vs-defined audit (35 keys present in all 3 locales); native-speaker review deferred (see Outstanding Items) |
| TC-D16 | Refreshing chip visible + zero CLS during transition | `dashboard-realtime.spec.ts` (TC-D16) |
| TC-D17 | Inline edit out-of-range error | `dashboard-inline-edit.spec.ts` (TC-D17) |

## Constraint Verification (FC-D1 through FC-D4)

| FC | Constraint | Verification |
|---|---|---|
| FC-D1 | No new persistent schema; one read-only carve-out for `get_movers_24h_aggregate()` | only schema migration in feature: `supabase/migrations/0038_movers_24h_rpc.sql`. STABLE, SECURITY DEFINER, returns `(participant_id, delta_24h)` — no state. Verified by pgTAP 025 (STABLE classification, SECURITY DEFINER, anon denied, authenticated allowed). |
| FC-D2 | Lock-edit collision parity — one validation path | `InlinePredictionForm.tsx` reuses the same `submit_prediction` RPC and the same `PredictionFormError` rendering component as `/predictions/[matchId]`. No second lock implementation. Verified by TC-D5 (errorLocked surfaces exactly as in standalone form) + TC-D17 (errorOutOfRange surfaces). |
| FC-D3 | Existing dashboard surfaces preserved | composer mounts `UpcomingMatchesWidget`, `RankWidget`, `AdminNavLink`, predictions nav, `TimezoneAutoDetect`, `WelcomeModal` (via `DashboardClient`) unchanged. Verified by TC-M10 (Upcoming widget still renders) and the existing `/dashboard (returning user)` a11y test. |
| FC-D4 | Realtime broadcast parity with `/leaderboard` | `DashboardRealtime.tsx` opens `leaderboard-refresh` channel with `action=eq.leaderboard.refresh` filter — bit-identical with `LeaderboardRealtime.tsx`. Verified by TC-D12 observing the same channel name in the page's WebSocket frames. |

## Outstanding External Items

The feature ships green on every automatable assertion. The remaining items require either external infrastructure or human review and are explicitly tracked here:

1. **Production load shape — NFR-D01 + NFR-D07 + TC-D13.** Local single-row fixtures verify correctness; the 200-participant p95 budget for `/dashboard` SSR and `get_movers_24h_aggregate()` must be re-verified on the deployed Supabase Pro tier with full match catalog + scoring history. Run via post-deploy verification.
2. **Lighthouse-in-CI for LCP — NFR-D02 + TC-D13.** Mobile LCP ≤ 2.5 s on simulated 4G. Needs a CI step that boots the prod build, signs in a synthetic user, and runs Lighthouse against `/dashboard` at 360 px. Not wired in this branch.
3. **Native-speaker review of pt-BR + es translations — TC-D15.** The 4 new `preTournamentHeading/Body` keys + the 18 US-DC widget keys added during this feature are AI-translated. Recommended: route through the same translation review queue as feature 002's match-catalog strings.
4. **50-concurrent-Realtime load test.** FR-D15's debounce + `router.refresh()` was validated against single-user bursts. A 50-concurrent-participant soak (per the spec.md NFR matrix) is deferred to the integration environment.
5. **FR-D21 extended-outage soak.** Local validation captured the SUBSCRIBED → reconnect timer wiring; an end-to-end 60-s outage simulation against the Pro tier WebSocket is deferred to deploy.

## Pristine Sweep — Results (2026-06-10)

| Check | Command | Result |
|---|---|---|
| pgTAP | `docker exec supabase_db_world-cup-madness psql … < test/pgtap/025_movers_aggregate_rpc.sql` | **12 / 12 PASS** |
| Jest | `npm test` | **195 / 195 PASS** (16 suites) |
| TypeScript | `npx tsc --noEmit` | **0 errors** |
| ESLint | `npm run lint` | **0 warnings / 0 errors** |
| Playwright (dashboard suite) | `npx playwright test e2e/tests/dashboard-*.spec.ts --project=chromium` | **18 / 18 PASS** (51.7 s) |
| Playwright (a11y dashboard cases) | `npx playwright test e2e/tests/all-pages-a11y.spec.ts -g "dashboard" --project=chromium` | **5 / 5 PASS** (including the existing returning-user case + 4 new T044 cases) |
