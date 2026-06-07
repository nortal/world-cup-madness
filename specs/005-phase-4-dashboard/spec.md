# Phase 4 Dashboard Polish + Mobile UX Specification

**Feature Branch**: `005-phase-4-dashboard`
**Created**: 2026-06-06
**Status**: Draft
**Priority**: High
**Input**: User description: "Phase 4 dashboard polish + mobile UX — Tighten /dashboard layout for mobile-first usage. In-scope: redesigned compact widget arrangement, responsive grid 360px → desktop, sticky lock-countdown on the upcoming-match widget, quick-edit shortcut from dashboard to active prediction form, leaderboard 'neighborhood' view, weekly digest summary, biggest movers section. Out of scope: notifications/email reminders, admin console changes, scoring rule changes, new match-data integration."

---

## 1. Primary User Story

As an **active Nortal participant** in the World Cup Madness prediction pool, **on my phone during a busy work day or commute**, I want to **see at a glance where I stand, what I should predict next, and how the pool is moving — all without scrolling through long pages or hunting for the right link** — so that **engaging with the tournament is a 10-second tap on the dashboard, not a multi-page navigation chore**.

The current `/dashboard` is functional but desktop-first: the rank widget (feature 004) and the upcoming-match widget (feature 002) sit stacked in a single column with no awareness of viewport size. Lock countdowns aren't visible without scrolling, the only path to a prediction is via the matches list, and there's nothing on the dashboard that surfaces *pool dynamics* (who's climbing, where I rank relative to colleagues near me, what I scored this week). This feature reshapes the dashboard into a mobile-first, engagement-oriented home screen that keeps every common participant action one tap away.

## 2. Details

**Problem:** Participants on mobile devices have to scroll, tap through multiple pages, and pinch-zoom to perform routine actions (check rank, lock-aware "predict the next match," see how they're doing relative to colleagues). The /dashboard surfaces minimal information and no engagement hooks, so daily-use friction is high and "pool stickiness" is low. We expect engagement (return visits, time-to-prediction-edit, scroll depth) to lift materially once dashboard density and mobile-first layout land.

**Clarifications:**

### Round 1 (2026-06-06)
- Q: Of the 7 in-scope items, what's the MVP cut for v1? → A: All 7 items are MVP (compact layout, sticky lock-countdown, quick-edit, neighborhood ±5, weekly digest, biggest movers, mobile-first grid). No staged rollout.
- Q: "Biggest movers" delta time window? → A: Last 24 hours rolling.
- Q: Weekly digest period? → A: Calendar week, Monday-Sunday UTC.
- Q: Neighborhood ±5 edge case (user near top/bottom)? → A: Hybrid — clamp at top (always show ranks 1-11 if user is in top 5), shrink at bottom (centred ±5 elsewhere, fewer rows if there aren't enough participants below).

### Round 2 (2026-06-06)
- Q: How is "24 hours ago" defined for movers? → A: On-demand from `score_events` (no new schema). Sum points awarded in last 24 h, recompute ranks against a baseline derived from the same materialised view.
- Q: Quick-edit shortcut behaviour? → A: Inline expandable card (no modal). Clicking the upcoming-match widget reveals score inputs in place, reusing the existing prediction-form fields.
- Q: My-prediction-snapshot widget content? → A: Split widget with two cards — last finished match (with points awarded) AND next upcoming match (with current prediction or "no pick yet").
- Q: Biggest-movers widget scope? → A: BOTH global top 3 movers AND top 3 movers within user's ±5 neighborhood, presented as two sub-sections of the same widget.

### Round 3 (2026-06-06)
- Q: Mobile (360px) widget stack order — top to bottom? → A: Tabbed mobile dashboard with two tabs: "Today" (Upcoming match + Rank + Snapshot) and "Pool" (Neighborhood + Movers + Digest).
- Q: Pre-tournament rendering (score_events globally empty)? → A: Movers, digest, and neighborhood widgets each show an "awaiting first match" placeholder card. Other widgets render normally.
- Q: Dashboard Realtime subscription? → A: Subscribe to the same `leaderboard-refresh` audit-event channel that `/leaderboard` uses, with a 300 ms debounce so a scoring burst causes one batched re-fetch.
- Q: Initial dashboard server-render performance target at 360 px? → A: Server-render p95 ≤ 1 s, LCP ≤ 2.5 s on a simulated 4G connection.

### Round 4 (2026-06-06)
- Q: Tab pattern — mobile only, or all viewports? → A: Mobile-only tabs (≤ 768 px). Desktop (> 768 px) shows all six widgets in a responsive grid without a tab strip.

### Session 2026-06-06 (via /ai1st-po-clarify)
- Q: Visual state during a Realtime re-fetch? → A: Stale-while-revalidate (keep widget content visible — zero layout shift) PLUS a subtle "refreshing…" chip surfaced in the page header during the in-flight re-fetch window. Chip clears as soon as the new data is applied.
- Q: Inline quick-edit save — error handling on non-lock failures? → A: Full parity with the standalone prediction form. The inline card surfaces every error message the full form does (`errorOutOfRange`, `errorMatchNotFound`, `errorParticipantNotFound`, `errorGeneric`, `errorLocked`) using the same i18n keys and the same error-rendering component.
- Q: Tab persistence across cross-route navigation? → A: Default to "Today" on every fresh `/dashboard` arrival without a `?tab=` query param. No localStorage / sessionStorage persistence. The `?tab=pool` URL is the only way the page lands on Pool by default.
- Q: Observability / telemetry scope for the new dashboard surfaces? → A: Minimal — structured logging (per Constitution §1.3) on inline-save success and inline-save error only. No client-side analytics SDK is introduced; tab-switch, expand-card, and widget-impression telemetry are deferred to a future ops-readiness feature.
- Q: Realtime extended-outage behaviour (channel disconnected 60 s+)? → A: Stale data + persistent reconnecting chip until reconnect. No polling fallback, no forced reload. Rely on Supabase Realtime's exponential-backoff reconnect; the existing `ReconnectingIndicator` chip stays visible the whole time so participants understand live updates are paused. Manual page reload remains available as the user-side recovery path.

### Ratification (2026-06-07, post-plan)
- Q: Global-movers sub-section needs cross-participant aggregation that `score_events_select_own` RLS narrows away. Option A (add one read-only SECURITY DEFINER aggregator RPC, migration 0038) or Option B (drop global sub-section, ship neighborhood-only)? → A: **Option A ratified.** Migration `0038_movers_24h_rpc.sql` introduces `get_movers_24h_aggregate()` (SECURITY DEFINER, STABLE, granted to `authenticated`; ~15 lines including REVOKE/GRANT). FC-D1 ("no new persistent schema") is amended below to carve out this single read-only aggregator.

---

## 3. Workflow

**Business Workflow:**

**A. Mobile participant (360-768 px)**
- Step 1: Participant opens `/dashboard` on their phone.
- Step 2: The dashboard renders with a two-tab strip pinned below the page header: "Today" (default) and "Pool".
- Step 3: The Today tab shows three stacked widgets: **Upcoming match** (collapsed), **Your rank** (compact, with the existing 24 h delta arrow), and **Your prediction snapshot** (split: latest finished + next upcoming).
- Step 4: The participant taps the upcoming-match widget. It expands in place to reveal two score inputs + a Save button (the existing prediction-form fields, rendered inline). Above the inputs, a sticky lock-countdown badge shows time-until-lock (BR-LOCK-001 from feature 003) in a high-contrast pill.
- Step 5: The participant enters a prediction and taps Save. The widget collapses back, the snapshot widget refreshes to show the new pick, a toast confirms the save.
- Step 6: The participant taps "Pool" tab. The dashboard swaps to show three widgets: **Your neighborhood** (their row plus a clamped/centred ±5 window of leaderboard rows), **Biggest movers** (24 h rank-delta — global top 3 and neighborhood top 3 stacked), and **This week's digest** (Mon-Sun UTC, total points + count of matches scored + best/worst single-match score this week).
- Step 7: Any scoring event fired by a trigger (a match finishes) propagates via the Realtime channel; widgets refresh within 5 s without a page reload.

**B. Desktop participant (> 768 px)**
- Step 1: Participant opens `/dashboard` on a desktop browser.
- Step 2: All six widgets render in a responsive 2-column grid below the page header. No tab strip is shown. Order: Upcoming match (expandable), Your rank, Your prediction snapshot, Your neighborhood, Biggest movers, This week's digest.
- Step 3 onwards: Same interactions as mobile (expand for quick-edit, sticky lock-countdown on upcoming-match, Realtime re-fetch on scoring events).

**Test Cases / Acceptance Scenarios:**

- **TC-D1: Mobile tab navigation** — Given a participant on a 360 px viewport, when they load `/dashboard`, then the Today tab is visible by default with three widgets stacked vertically and the Pool tab is reachable via a `role="tab"` button; when they tap Pool, then the URL updates with `?tab=pool` and three different widgets render.
- **TC-D2: Desktop responsive grid** — Given a participant on a > 768 px viewport, when they load `/dashboard`, then all six widgets are visible without a tab strip; rotating/resizing below 768 px swaps to the tabbed layout without a full reload.
- **TC-D3: Inline quick-edit expand** — Given an active participant with the upcoming-match widget collapsed, when they tap the widget, then it expands in place to show home/away score inputs and a Save button; the existing match-list page is not navigated to.
- **TC-D4: Sticky lock-countdown** — Given a user expands the upcoming-match widget, when the lock window is open (> 60 min to kickoff), then a sticky countdown badge is visible above the score inputs and stays pinned even if the widget content scrolls; the badge text updates every second.
- **TC-D5: Lock-boundary in widget** — Given the upcoming match is exactly 60 min from kickoff (BR-LOCK-003), when the participant tries to Save, then the save fails with the `errorLocked` message and the widget badge transitions to a "Locked" state.
- **TC-D6: Neighborhood top-clamp** — Given a participant at rank 2 of N ≥ 11, when the Pool tab loads, then the neighborhood widget shows ranks 1 through 11 (clamped at the top) with the participant's row highlighted.
- **TC-D7: Neighborhood mid-shrink** — Given a participant at rank 50 of N ≥ 100, when the Pool tab loads, then the neighborhood widget shows ranks 45 through 55 (5 above + 5 below) with the participant's row highlighted.
- **TC-D8: Neighborhood bottom-shrink** — Given a participant at the last rank N, when the Pool tab loads, then the neighborhood widget shows ranks N-5 through N (centred but with fewer rows below).
- **TC-D9: Biggest movers — both sections** — Given seeded score_events such that some participants gain ranks in the last 24 h, when the movers widget loads, then it shows two sub-sections: "Top 3 in pool" (global) and "Top 3 near you" (within the user's ±5 neighborhood); each row displays display name, current rank, and delta arrow with magnitude.
- **TC-D10: Weekly digest** — Given the current calendar week (Monday 00:00 UTC through now), when the digest widget loads, then it shows total points earned this week, count of finished matches the user predicted, and the best and worst single-match scores from the same window.
- **TC-D11: Pre-tournament placeholders** — Given `score_events` is globally empty, when the dashboard loads, then the Movers, Digest, and Neighborhood widgets each render an "Awaiting the first match" placeholder card; the Upcoming, Rank, and Snapshot widgets render normally (countdown / "Leaderboard opens at…" / prediction-or-not).
- **TC-D12: Realtime debounced re-fetch** — Given the dashboard is open and 5 scoring events fire in a rapid burst (within 300 ms), when the Realtime channel delivers them, then the widgets re-fetch exactly once (300 ms debounce) — not five times.
- **TC-D13: Server-render performance budget** — Given a representative production-shape DB (200 participants, 20 finished matches, populated MV), when an authenticated participant requests `/dashboard`, then the server-render p95 measurement at 360 px viewport is ≤ 1 s and LCP measured on Lighthouse mobile (simulated 4G) is ≤ 2.5 s.
- **TC-D14: a11y — tab strip and expandable card** — Given the mobile tab strip and the expandable upcoming-match card, when the WCAG 2.1 AA axe-core sweep runs, then zero violations are reported (`role="tablist"` + `aria-selected`, `aria-expanded` on the upcoming-match toggle, accessible labels on all action buttons).
- **TC-D15: i18n** — Given the locale switches among `en`, `es`, `pt-BR`, when each dashboard tab renders, then all visible labels (tab names, widget titles, badge text, digest summary, placeholders) come from the next-intl message catalogue with no hardcoded English.
- **TC-D16: Refreshing chip during Realtime re-fetch** — Given the dashboard is open and a `leaderboard.refresh` event fires, when the page begins its debounced re-fetch, then a "refreshing…" status chip with `role="status"` appears in the page header; previously-rendered widget content remains visible throughout (no skeleton, no blanking); the chip disappears once the new data is applied to the widgets. Cumulative Layout Shift during this transition MUST remain ≤ 0.1 (NFR-D05).
- **TC-D17: Inline edit out-of-range error** — Given the inline quick-edit card is expanded, when the participant enters an out-of-range score (e.g. 99) and taps Save, then the same `errorOutOfRange` message used by the standalone form is shown inside the card; the card stays expanded so the participant can correct the value and retry without re-opening it.

**Edge Cases:**

- What if the participant has NO upcoming match (tournament over or no matches in next 30 days)? → The Upcoming widget shows a "No upcoming matches" empty state and the expandable-card behaviour is disabled.
- What if the participant's neighborhood ±5 has fewer than 11 distinct participants (e.g. small pool)? → Show the whole pool; do not pad with empty rows.
- What if a scoring event fires DURING the inline quick-edit (participant typing)? → The save attempt may collide with a lock boundary. The save MUST surface the same `errorLocked` message as the standalone form; we do not auto-collapse or destroy unsaved input.
- What if the participant changes the URL `?tab=pool` directly without going through the tab strip? → The Pool tab renders on first load.
- What if the participant taps Pool, then navigates to `/leaderboard` and back to `/dashboard` (via the existing nav, without a `?tab=` param)? → The dashboard defaults back to Today. No cross-route persistence is intended; the `?tab=pool` URL is the only mechanism that lands on Pool by default.
- What if the participant is on tablet (≥ 768 px and ≤ 1024 px)? → Desktop responsive grid applies (no tabs). The grid auto-fits to one column on narrow tablets.
- What if the Realtime channel disconnects mid-session? → The same `ReconnectingIndicator` from feature 004 surfaces; widgets continue to show stale data until reconnection. There is no polling fallback even during extended outages (60 s+); the chip stays visible the entire time so the participant understands live updates are paused. On reconnect, one catch-up re-fetch fires (matching feature 004's LeaderboardRealtime recovery pattern). Manual reload remains available as the user-side recovery path.
- What if the weekly digest week spans a calendar-week boundary mid-tournament (e.g. tournament starts Tuesday)? → First week's digest covers only the days from tournament start through the following Sunday, then weekly cadence resumes.

---

## 4. Requirements

**Functional Requirements:**

- **FR-D01**: System MUST render `/dashboard` with a responsive layout that switches between a tabbed mobile view (≤ 768 px) and a grid-based desktop view (> 768 px) based on viewport width. {Source: AI/Specify}
- **FR-D02**: On mobile, the dashboard MUST present a two-tab strip ("Today" and "Pool") that controls which widget set is visible. The active tab MUST be reflected in the URL as `?tab=today` (default) or `?tab=pool` so it survives reload. The dashboard MUST default to "Today" on every fresh navigation to `/dashboard` that lacks a `?tab=` query parameter; no localStorage or sessionStorage persistence is used to remember the prior tab choice across route navigation. {Source: AI/Specify}
- **FR-D03**: The "Today" tab MUST contain three widgets in this order: Upcoming match (expandable), Your rank (existing RankWidget), and Your prediction snapshot. {Source: AI/Specify}
- **FR-D04**: The "Pool" tab MUST contain three widgets in this order: Your neighborhood, Biggest movers, and This week's digest. {Source: AI/Specify}
- **FR-D05**: On desktop (> 768 px), all six widgets MUST be visible simultaneously in a responsive 2-column grid (single column on narrow tablets, two columns otherwise) with no tab strip. {Source: AI/Specify}
- **FR-D06**: The Upcoming match widget MUST be tappable; tapping it MUST expand the card in place to reveal score input fields and a Save button, reusing the same input model and validation as `/predictions/[matchId]`. {Source: AI/Specify}
- **FR-D07**: When the Upcoming match widget is expanded AND the match is still in the editable window (> 60 min to kickoff per BR-LOCK-001), a sticky lock-countdown badge MUST be visible at the top of the expanded card and remain pinned even if the card's content scrolls. The badge MUST update at least once per second. {Source: AI/Specify}
- **FR-D08**: Saving a prediction from the inline quick-edit MUST go through the same server-side lock validation as the full prediction page; if the lock has closed mid-edit, the response MUST surface the existing `errorLocked` message and the badge MUST transition to a "Locked" state. {Source: BR-LOCK-001 + AI/Specify}
- **FR-D20**: The inline quick-edit save MUST surface the FULL error-message set used by the standalone `/predictions/[matchId]` form — at minimum `errorOutOfRange`, `errorMatchNotFound`, `errorParticipantNotFound`, `errorGeneric`, `errorLocked` — using the same i18n keys and the same error-rendering component as the full form. The card MUST remain in expanded edit state when an error is shown so the participant can correct and retry without re-opening the card. {Source: AI/Specify}
- **FR-D09**: The Your prediction snapshot widget MUST display two cards side-by-side (desktop) or stacked (mobile): (a) the participant's prediction for the most recent finished match plus the points awarded; (b) the participant's prediction for the next upcoming match, or a "No pick yet" prompt if absent. {Source: AI/Specify}
- **FR-D10**: The Your neighborhood widget MUST render leaderboard rows centred on the active participant per the hybrid rule: if the participant's rank ≤ 6, show ranks 1 through 11 (top-clamp); otherwise, show 5 ranks above and 5 below (or fewer below if the participant is within 5 of the last rank). The participant's own row MUST carry the existing `data-self="true"` attribute. {Source: AI/Specify}
- **FR-D11**: The Biggest movers widget MUST present two sub-sections: "Top 3 in pool" (the three participants whose ranks have improved most in the last 24 hours, across all participants) and "Top 3 near you" (the three participants within the user's ±5 neighborhood whose ranks have improved most in the last 24 hours). Each row MUST show display name, current rank, and a delta arrow with magnitude. {Source: AI/Specify}
- **FR-D12**: The 24-hour rank delta MUST be computed from `score_events` on demand: sum points awarded per participant where `awarded_at >= now() - interval '24 hours'`, derive a "rank 24 h ago" by subtracting that delta from the current `total_points` and re-ranking, then compare ranks. No new persistent snapshot table is added. {Source: AI/Specify}
- **FR-D13**: The This week's digest widget MUST cover the current calendar week (Monday 00:00 UTC through `now()`) and display: total points earned this week, count of finished matches the user predicted in the window, the best single-match score in the window, and the worst single-match score (zero or otherwise) in the window. {Source: AI/Specify}
- **FR-D14**: When `score_events` is globally empty (pre-tournament), the Movers, Digest, and Neighborhood widgets MUST each render an "Awaiting the first match" placeholder card. The Upcoming, Rank, and Snapshot widgets MUST continue to render their existing pre-tournament states. {Source: AI/Specify}
- **FR-D15**: The dashboard MUST subscribe to the existing `leaderboard-refresh` Supabase Realtime channel and refresh all visible widgets when a `leaderboard.refresh` audit event is broadcast. Multiple events arriving within 300 ms MUST be coalesced into a single batched re-fetch. {Source: AI/Specify, extends feature 004}
- **FR-D19**: During a Realtime re-fetch, the dashboard MUST keep the current widget content visible (stale-while-revalidate — no skeletons, no blanking, no layout shift). A subtle "refreshing…" status chip MUST appear in the page header for the duration of the in-flight fetch and disappear as soon as the new data is applied to the widgets. The chip MUST use `role="status"` so screen readers announce it politely. {Source: AI/Specify}
- **FR-D21**: During an extended Realtime outage (channel disconnected for 60 s or more), the dashboard MUST continue to display the most-recently-fetched widget data unchanged AND keep the existing `ReconnectingIndicator` chip visible the entire time. No polling fallback is initiated. No forced page reload is initiated. The participant retains manual reload as their recovery path. When the channel reconnects, the dashboard MUST trigger one catch-up re-fetch (matching the recovery behaviour already established in feature 004's LeaderboardRealtime component). {Source: AI/Specify}
- **FR-D16**: All visible text (widget titles, tab labels, badge text, placeholders, button labels, accessibility labels) MUST be sourced from the next-intl message catalogue for `en`, `es`, and `pt-BR` locales. {Source: ADR-008}
- **FR-D17**: All interactive controls (tab strip, expandable widget, score inputs, neighborhood rows) MUST be operable by keyboard alone (Tab, Arrow keys for the tab strip per WAI-ARIA, Enter/Space for the expand toggle). The tab strip MUST follow the same manual-activation pattern used by feature 004's StageTabStrip. {Source: AI/Specify}
- **FR-D18**: The dashboard MUST preserve all existing widgets and routes from features 002-004 (the existing UpcomingMatchesWidget, RankWidget, admin nav link, predictions nav, TimezoneAutoDetect, welcome flow). New widgets are additive and do not displace existing surfaces. {Source: AI/Specify}

**Feature-Specific Non-Functional Requirements (NFRs):**

- **NFR-D01**: Server-side render of `/dashboard` (full HTML emitted by the Server Component) MUST complete with p95 ≤ 1 s on a representative production-shape dataset (200 active participants, 20 finished matches, populated MV).
- **NFR-D02**: Largest Contentful Paint (LCP) measured via Lighthouse mobile (simulated 4G) MUST be ≤ 2.5 s.
- **NFR-D03**: The dashboard at the 360 px viewport MUST have zero horizontal scroll (`document.documentElement.scrollWidth ≤ 360`).
- **NFR-D04**: All interactive surfaces (tab strip, expandable card, neighborhood rows, lock countdown) MUST meet WCAG 2.1 AA — zero axe-core violations.
- **NFR-D05**: Cumulative Layout Shift (CLS) on dashboard load MUST be ≤ 0.1 (no shifts after first paint when Realtime data arrives).
- **NFR-D06**: The Realtime debounce window MUST be 300 ms ± 50 ms tolerance, verifiable via a test that fires 5 events in a 200 ms window and asserts exactly one re-fetch.
- **NFR-D07**: The 24-hour-movers query MUST complete in ≤ 250 ms p95 with the representative dataset above (200 participants).
- **NFR-D08**: The inline quick-edit Save handler MUST emit a structured log line (per Constitution §1.3 — JSON shape with `event`, `participant_id`, `match_id`, `outcome`, `error_code` where applicable, `occurred_at`) on every success AND every failure. No client-side analytics SDK or third-party telemetry pipeline is introduced by this feature. Tab-switch, expand-card, and widget-impression instrumentation are explicitly deferred (see Deferred Decisions §4).

**Out of Scope:**

- **Notifications / email reminders** — Separate Phase 4 feature; not part of this spec.
- **Admin console changes** — Admin dashboard polish, recalculate workflows, integration_runs telemetry surface are unchanged by this feature.
- **Scoring rule changes** — Tie-breaker chain, points-per-source, lock-window constants remain as defined by features 003 and 004.
- **New match-data integration** — No changes to football-data.org provider abstraction or sync schedule.
- **Persistent rank-history table** — Deliberately deferred (see Deferred Decisions). 24-hour movers are computed on demand from `score_events` via the small read-only SECURITY DEFINER aggregator added in migration `0038_movers_24h_rpc.sql`.
- **Multi-week historical digest** — Only the current week is shown; "last week" or "weekly trend" surfaces are out of scope for v1.
- **Push notifications, badges, sounds** — Not in scope.
- **Admin role dashboard variant** — Admins use the same dashboard widgets as participants; this feature does not branch behaviour by role.

---

## 5. Deferred Decisions

- **Item:** Persistent rank-history table for higher-fidelity movers calculations.
  - **Rationale:** v1 ships on-demand 24 h movers from `score_events` (FR-D12) to avoid new schema and migration cost. If NFR-D07 (≤ 250 ms p95) is violated at production scale or if the product team wants finer time windows (e.g. "last 1 hour"), a `leaderboard_history` append-only table is the natural next step.
  - **Resolution phase:** Performance review during Phase 1/2 rollout; revisit only if NFR-D07 breaches in production telemetry.

- **Item:** Tablet layout polish (768 px - 1024 px range).
  - **Rationale:** v1 treats tablets as "desktop" (responsive grid, no tabs). Some tablet form factors at 768 px in portrait may benefit from a tab strip. Decision deferred to UX testing post-launch.
  - **Resolution phase:** Implementation tweaking based on real-device feedback.

- **Item:** Multi-week historical digest ("Last week," "Trend over weeks").
  - **Rationale:** v1 ships only the current week. Multi-week views add UI complexity and a need to define week-numbering across the tournament boundary. Best left for a follow-up engagement feature post-tournament-start.
  - **Resolution phase:** Future feature.

- **Item:** Full client-side telemetry / analytics SDK adoption (tab-switch, expand-card, widget-impression events).
  - **Rationale:** v1 ships minimal structured logging on Save success/failure only (NFR-D08) so we get an audit trail for the lock-collision class. Broader engagement analytics need a tooling decision (which SDK, what privacy posture, what retention) that exceeds this feature's scope.
  - **Resolution phase:** Future Phase 5 operational-readiness feature.

---

## 6. Definition of Done

- All functional requirements (FR-D01 through FR-D18) implemented and verified by Playwright + Jest tests.
- All test cases (TC-D1 through TC-D15) pass against the production-shape dataset.
- All edge cases listed in Section 3 handled (no upcoming match, small pool, mid-edit lock collision, direct URL `?tab=`, tablet viewports, Realtime disconnect, calendar-week boundary).
- All non-functional requirements (NFR-D01 through NFR-D07) verified by performance instrumentation and axe-core sweeps.
- The existing dashboard widgets (UpcomingMatchesWidget, RankWidget, admin nav, predictions nav, TimezoneAutoDetect, welcome flow) continue to work unchanged.
- WCAG 2.1 AA compliance verified across both mobile tabbed and desktop grid layouts.
- i18n keys present and reviewed (English authoritative; es + pt-BR queued for native-speaker review).
- DoD verification document (`dod-verification.md`) ships in the feature spec directory mirroring the format from features 002, 003, 004.
- README updated with a "Feature 005 — Dashboard polish" section covering local commands and troubleshooting.

---

## 8. Key Entities

**Data Model Reference:**
- System-wide model: `.ai_project_memory/architecture.md` §Data Architecture
- This feature introduces **no new persistent entities**. All widget data is computed on demand from existing tables.

**Read-only data sources used:**

- **participants** (existing): Each row supplies `id`, `display_name`, `auth_user_id`, `status`, `timezone` for widget rendering and the auth gate.
- **leaderboard_snapshots** (existing MV from feature 004): Source of current rank + display name + public projection for the Neighborhood and Movers widgets.
- **leaderboard_self** (existing view from feature 004): Source of the active participant's own rank + private tie-breaker columns for the Rank widget.
- **matches** (existing): Source of the next upcoming match (Upcoming widget), the most recent finished match (Snapshot widget), and stage/group filtering.
- **predictions** (existing): Source of the participant's prediction for the upcoming match (Upcoming widget + Snapshot widget "next" card) and for the most recent finished match (Snapshot widget "last" card).
- **score_events** (existing): Source of the 24-hour movers calculation (FR-D12) and the weekly digest aggregation (FR-D13). Filtered by `awarded_at >= now() - interval '24 hours'` for movers; `awarded_at >= date_trunc('week', now() at time zone 'UTC')` for digest.
- **audit_log** (existing): Realtime channel source — broadcasts `leaderboard.refresh` events to drive the 300 ms debounced re-fetch.

---

## 9. UX Considerations

**User Interface Context:**
- **Primary user actions:** check current rank + 24 h delta; predict the next match without leaving the dashboard; flip to the Pool tab to see neighborhood + movers + weekly digest; review last/next prediction at a glance.
- **User journey touchpoints:** `/dashboard` is the post-sign-in landing page (feature 001). It is also the most-visited page in the participant flow per the architecture roadmap. Every other route (predictions, leaderboard, profile) is reachable from the dashboard's existing nav.
- **Accessibility needs:** WCAG 2.1 AA. Tab strip uses WAI-ARIA tabs pattern (manual activation, Arrow Left/Right navigation, Home/End, Enter/Space to activate) matching feature 004's StageTabStrip. Expandable upcoming-match card uses `aria-expanded` + accessible button. Sticky countdown uses `role="status"` so screen readers announce lock transitions. All countdown / movers / digest numerics use the existing `<time dateTime="…">` semantic markup where appropriate.
- **Usability considerations:** Mobile-first design starts at 360 px. Tap targets ≥ 44 px (WCAG 2.5.5 minimum). Tab strip and expandable card use the same visual idiom as feature 004's leaderboard surfaces (consistency). All copy in `en` / `es` / `pt-BR` via next-intl.

**Design References:**

- This feature does not have captured design context from `/ai1st-po-capture-ui`. Implementation should follow the existing visual idiom established by features 002-004 (Tailwind utility classes, rounded-md cards, blue-600 active state, gray-100 inactive). UI decisions follow the Constitution and existing component patterns.

---

## 10. Integration Context

**External Systems:**

- **Supabase Realtime** (existing): The dashboard subscribes to the `leaderboard-refresh` channel established by feature 004. No new external system integration.
  - **Business purpose:** Live updates so participants see scoring impact without page reloads.
  - **Data exchange:** Inbound only — receives `leaderboard.refresh` audit events; responds by re-fetching local widget data.
  - **Timing:** On every MV refresh that the scoring trigger, cron tick, or admin RPC produces. Debounced to 300 ms at the page.

- **football-data.org** (existing, indirect): No change. Match data continues to flow through the feature 002 sync pipeline; this dashboard reads downstream tables.

**Integration Constraints:**

- The Realtime channel must support both anon and authenticated subscribers (per the migration 0037 fix from feature 004). No new auth model is introduced.
- The dashboard MUST NOT bypass RLS or the column-level GRANT scheme established by feature 004. All leaderboard data comes via `leaderboard_snapshots` (public projection) and `leaderboard_self` (own row).

---

## 11. Feature-Specific Constraints

**FC-D1:** No new persistent schema, with one read-only carve-out.
- **Description:** v1 deliberately avoids a rank-history snapshot table or any state-changing migration. The single exception, ratified 2026-06-07, is migration `0038_movers_24h_rpc.sql` — a read-only `get_movers_24h_aggregate()` SECURITY DEFINER function that aggregates `score_events.points` across participants for the FR-D11 global-movers sub-section. The function stores no state, exposes no PII (returns `(participant_id, delta_24h)` only), and follows feature 004's `is_pre_tournament()` precedent (migration 0036).
- **Impact:** NFR-D07 (≤ 250 ms p95) must hold at production scale. If it doesn't, the persistent-snapshot path (Deferred Decisions §1) is the escape hatch.

**FC-D2:** Lock-edit collision parity.
- **Description:** Inline quick-edit MUST share validation paths with the full prediction page. There is one server-side lock check (`lock_prediction()` from feature 003), not two implementations.
- **Impact:** No new RPC; the Save handler calls the same RPC the full page calls. Lock-boundary tests must cover both surfaces.

**FC-D3:** Existing dashboard surface preservation.
- **Description:** Existing widgets and nav (UpcomingMatchesWidget, RankWidget, admin nav, predictions nav, TimezoneAutoDetect, welcome flow) MUST continue to render without behaviour change.
- **Impact:** This feature is additive. No widget is removed or restructured beyond layout reshuffling for the tabbed mobile view.

**FC-D4:** Realtime broadcast parity with `/leaderboard`.
- **Description:** Dashboard and `/leaderboard` listen on the same channel + filter so they re-render in lock-step.
- **Impact:** Channel name `leaderboard-refresh`, filter `action=eq.leaderboard.refresh`, RLS policy `audit_log_leaderboard_refresh_select`. No new Realtime topology introduced.

### Feature-Specific Assumptions

**FA-D1:** Production-shape data fits the perf budgets.
- The NFR-D01 / NFR-D02 / NFR-D07 numbers assume ~200 active participants and ~20 finished matches at any time during the tournament. If either grows substantially beyond that, perf budgets must be re-validated.

**FA-D2:** Mobile users use the dashboard more than `/leaderboard`.
- This feature optimises the dashboard for mobile-first daily-use. If post-launch analytics show participants use `/leaderboard` directly more than the dashboard, the engagement-widget set (Movers, Neighborhood, Digest) may want to move into the leaderboard route as a follow-up.

**FA-D3:** Movers computed on demand are accurate enough for engagement.
- A 24-hour window with "rank 24 h ago" derived by subtracting last-24-h points from current totals is a reasonable approximation. It can produce small inaccuracies near rank boundaries because tie-breaker columns (`exact_hits`, `outcome_hits`, `final_points`) are also affected by the last 24 h. This is acceptable for an engagement widget; if precision becomes a complaint, persistent snapshots are the escape hatch.

---

## 12. References

**Project Context:**
- Project Context: `.ai_project_memory/general-overview.md`
- Domain Model: `.ai_project_memory/architecture.md` §Data Architecture
- **Constitution:** `.ai_project_memory/constitution.md` — Universal principles
- Frontend Constitution: `.ai_project_memory/constitution-frontend.md` — Next.js, Tailwind, next-intl, mobile-first idioms
- Backend Constitution: `.ai_project_memory/constitution-backend.md` — Supabase, Postgres, Realtime patterns

**Related Specifications:**
- Feature 001 — Authentication & participant — supplies the auth gate and the participant row that this dashboard reads.
- Feature 002 — Match catalog read — supplies the `matches` table, the upcoming-match widget, and the lock-countdown helpers reused by the sticky badge.
- Feature 003 — Predictions and scoring — supplies the `predictions` and `score_events` tables, the `lock_prediction()` RPC reused by the inline quick-edit, and the scoring triggers that drive the Realtime broadcast cascade.
- Feature 004 — Leaderboard — supplies the `leaderboard_snapshots` MV, the `leaderboard_self` view, the `leaderboard-refresh` Realtime channel, and the RankWidget that the Today tab embeds.

**External References:**

- WCAG 2.1 AA: Used as the accessibility baseline.
- WAI-ARIA Authoring Practices: Tabs pattern (manual activation) for the mobile tab strip.

---

## Review & Acceptance Checklist

### Content Quality
- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

### Requirement Completeness
- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

### Traceability & Context
- [ ] BRD requirements linked (no BRD in this project)
- [ ] Jira/Confluence references included (not applicable — internal Nortal project)
- [ ] Figma designs referenced (no captured design context — visual idiom inherits from features 002-004)
- [x] All clarifications documented with timestamps
- [x] Deferred decisions documented (3 items in Section 5)

---

## Execution Status

- [x] User description parsed
- [x] Key concepts extracted
- [x] Ambiguities marked
- [x] User scenarios defined
- [x] Requirements generated
- [x] Entities identified
- [x] Review checklist passed
