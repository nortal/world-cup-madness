# Leaderboard Specification

**Feature Branch**: `004-leaderboard`
**Created**: 2026-06-01
**Status**: Draft
**Priority**: High
**Input**: User description: "leaderboard"
**Jira Ticket**: *(none — internal pool, no external tracker)*

---

## 1. Primary User Story

**As a** Nortal collaborator competing in the World Cup Madness pool,
**I want to** see a live ranking of every active participant by total points (with deterministic tie-breakers and a stage filter), plus a compact "where do I sit" indicator on my dashboard,
**so that** I can track my standing during the tournament, compare with colleagues, and feel the rank changes as matches finish — without having to refresh the page.

A secondary story for tournament administrators:

**As a** tournament administrator,
**I want to** see the same leaderboard the participants see (reading from the same canonical aggregation),
**so that** there is exactly one ranking source of truth, and any anomalies surface to me before they surface to participants.

---

## 2. Details

**Problem:** Feature 003 closed the predict → score loop — `score_events` now carries one canonical row per `(participant_id, match_id)` for finished matches plus final-prediction rows once admin sets the official winners. But points without a ranking are invisible: participants can see *their* breakdown (`/predictions/breakdown`) but they cannot see *where they stand* against the other ~200 collaborators. That is the engagement loop the project was built for. FR-013 ("Leaderboard with tie-breaking") and `architecture.md`'s named `leaderboard_snapshots` materialised view are both still un-shipped. Feature 004 ships the ranking surface: a `/leaderboard` page with realtime rank updates during match-day flurries, a tournament-stage filter, deterministic tie-breakers per `scoring-model.md` §7.4, a pre-tournament countdown state, and a compact "your rank + delta" widget on `/dashboard`.

**Requirement Conflicts:** Requirement conflict check completed — no conflicts found (checked against features 001 + 002 + 003 specs on 2026-06-01). This feature *adds* one materialised view (`leaderboard_snapshots`), one Realtime channel, one new route (`/leaderboard`), one new dashboard widget, and a minimal set of i18n keys. It does not modify any existing column semantics, RLS policy, or scoring rule. The tie-breaker order is read verbatim from `scoring-model.md` §7.4 items #1–#4 + shared-rank fallback; item #5 (earliest submission time) is explicitly NOT adopted at launch.

**Clarifications:**

### Round 1 (2026-06-01)

- Q: Functional scope — single global ranking only, global + group-stage filter, or global + "around me" view? → A: Global + stage filter. One ranking page at `/leaderboard` with a Group / R16 / QF / SF / Final / All-stages tab; the active tab re-aggregates the ranking against `matches.stage`. Personal "around me" surface is handled by the dashboard widget (Round 2).
- Q: How live should rankings be — Supabase Realtime subscription, ISR-style 30-60s revalidation, or on-demand refresh button? → A: Supabase Realtime subscription on the `leaderboard_snapshots` materialised view. Rank changes during match-day flurries appear without a page refresh, matching `architecture.md`'s plan and FR-013's "live" intent.
- Q: What does a leaderboard row reveal about OTHER participants — rank + name + total only, +exact/outcome counts, or +per-stage subtotals? → A: Rank + display name + total points only. Other participants' per-match predictions and per-source breakdowns stay private. Aligns with FR-018 data-minimisation and §2 of feature 003's spec (predictions are private).
- Q: What does the leaderboard show before the first match has finished — hide rankings with countdown, show everyone at 0 alphabetically, or show "final predictions submitted" badges? → A: Hide rankings; show a countdown to the first kickoff. Avoids the noisy "everyone tied at 0" display before the tournament starts and gives the page a clear "season opens at" moment.

### Round 2 (2026-06-01)

- Q: When the stage filter is active, what do the rankings count — only that stage's match points, total with stage display only, or cumulative through that stage? → A: Only that stage's match points. Stage='Group' ranks by `SUM(score_events.points) WHERE match.stage='group'`; final-prediction points appear ONLY when "All stages" is selected. Each stage becomes its own mini-leaderboard; cleanest semantic, easiest to explain.
- Q: Should "your rank" surface on `/dashboard` as well, or live only on `/leaderboard`? → A: Compact widget on `/dashboard` AND the full ranking on `/leaderboard`. The widget shows "You are rank N (▲/▼ since last finished match)" alongside the upcoming-matches widget. Engagement on the page participants land on daily; the deeper view stays on `/leaderboard`.
- Q: Adopt tie-breaker #5 (earliest valid prediction submission time) at launch, or stop at #4 + shared rank? → A: Stop at #4 + shared rank. Tie-breakers #1–#4 from `scoring-model.md` §7.4 (total → exact hits → outcome hits → final-prediction points) plus shared rank as the fallback. Item #5 is explicitly flagged in the architecture doc as "only if approved"; it penalises late joiners and feels arbitrary. If a real tie persists past #4 at tournament end, we render `1=`, `1=`, `3` and let the participants celebrate together.

### Session 2026-06-01 (Clarify)

- Q: Does the admin view of `/leaderboard` get any extra columns or filters that participants don't (e.g., per-row exact-hit counts, "view as participant X" impersonation)? → A: No. Admins see the exact same `/leaderboard` page, the same `leaderboard_snapshots` view, and the same row contents (rank + display name + active-tab points) as participants. Single MV / single page / single privacy boundary keeps RLS simple and avoids a "shadow" admin leaderboard. Admin-only operational visibility for scoring health already lives in the `all_runs` view + `audit_log` from feature 003.
- Q: If `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` fails (lock contention, disk pressure, concurrent autovacuum), should the scoring transaction roll back or commit? → A: Decouple. Scoring is the canonical writer to `score_events` — a transient view-refresh failure must not lose a correctly-scored match. The scoring transaction commits; the MV refresh failure writes an `audit_log` row (`event_type='leaderboard.refresh_failed'`) carrying the SQLSTATE + error message + triggering `scoring_runs.id`. The NEXT scoring run will refresh the MV (it picks up the latest `score_events` regardless), and admins can force a refresh on demand via a dedicated `refresh_leaderboard()` RPC.
- Q: Ship a periodic MV refresh job to cover long quiet periods (e.g., overnight refresh failure with no scoring runs until morning), or rely only on next-scoring-run + admin RPC? → A: Ship a `pg_cron` job at a 5-minute cadence that calls `refresh_leaderboard()` with internal gating: if any non-cancelled match has `kickoff_utc` within `now() ± 90 min` (i.e. inside a match window), refresh unconditionally; otherwise only refresh if the last `leaderboard.refresh` audit row is more than 60 minutes old. One schedule, two effective cadences (5 min in match windows / ~60 min in quiet periods). Self-healing without admin paging, and cheap (refresh < 500 ms × ~300 attempts/day).
- Q: When a brand-new active participant signs in mid-tournament (e.g., day 3), how soon must they appear on `/leaderboard`, and how is the MV shaped to include 0-point participants? → A: The MV is `participants LEFT JOIN score_events` filtered by `status='active'` — so every active participant appears in every refresh, including those with no scored matches yet (rank=last, 0 points). No participants-INSERT trigger; the cron cadence (≤ 60 min outside match windows, ≤ 5 min inside) handles new joiners. Simplest mutation surface; extra trigger would add complexity for marginal UX benefit and risk cascading refreshes on bulk admin operations.

---

## 3. Workflow

**Business Workflow:**

*Standard ranking view:*

- **Step 1** — Authenticated active participant opens `/leaderboard`.
- **Step 2** — Page header renders the title, a stage tab strip (`All` / `Group` / `R16` / `QF` / `SF` / `Final`, default `All`), a "Show my rank" anchor button, and the current snapshot time.
- **Step 3** — Below the header, the rank table renders one row per active participant, sorted by the tie-breaker chain. Columns: `Rank` (with `=` suffix for shared rank), `Display name`, `Total points` (or stage points when a stage tab is active).
- **Step 4** — On mount, the page opens a Supabase Realtime channel on `leaderboard_snapshots`. When the materialised view refreshes (triggered by any scoring run, see §3 "Scoring path" below), the subscriber receives the new rows and the visible table re-renders in place. The "snapshot time" updates accordingly.
- **Step 5** — User clicks a stage tab. The URL `?stage=group` updates; the page server-rerenders against the same materialised view filtered by stage. The Realtime channel re-subscribes to the stage-scoped view (see FR-L11).
- **Step 6** — User clicks "Show my rank". The page scrolls to the row matching the authenticated participant; if pagination is active, navigates to the page containing that row first.

*Dashboard widget:*

- **Step 1** — Participant opens `/dashboard` (existing route).
- **Step 2** — Above the existing upcoming-matches widget, a new "Your rank" card renders: rank number, total points, and an arrow + integer delta versus the previous snapshot (e.g. `↑ 3` means moved up 3 places since the last finished match). On pre-tournament, the card shows "Leaderboard opens at [first kickoff in user TZ]" with no rank number.
- **Step 3** — The widget subscribes to the same Realtime channel; when a scoring run completes, the rank and delta update in place.
- **Step 4** — Clicking the card navigates to `/leaderboard` with the "Show my rank" anchor pre-fired.

*Materialised view refresh:*

- **Step 1** — A scoring run completes (any of: match-scoring trigger, final-scoring trigger, admin recalc-all RPC from feature 003).
- **Step 2** — In the same transaction, `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` is invoked, recomputing every rank from the canonical `score_events` table.
- **Step 3** — Postgres emits the change on the Realtime channel; subscribed clients receive the diff.
- **Step 4** — A row is written to `audit_log` (`event_type='leaderboard.refresh'`) recording the refresh duration and triggering scoring run id, for traceability.

**Test Cases / Acceptance Scenarios:**

- **TC-L1: Authenticated participant sees the ranking** — Given a signed-in active participant and at least one finished match has been scored, when they navigate to `/leaderboard`, then the table renders with rank, display name, and total points for every active participant. {Source: AI, ID: FR-L01}
- **TC-L2: Unauth user redirected** — Given no session, when an HTTP request hits `/leaderboard`, then the server redirects to `/` (matches the participant-route auth gate convention from features 001-003). {Source: AI, ID: FR-L10}
- **TC-L3: Pre-tournament countdown** — Given no `score_events` row exists yet (no finished match), when a participant opens `/leaderboard`, then the rankings table is replaced by a countdown to the earliest non-cancelled match kickoff in the participant's timezone. {Source: AI, ID: FR-L07}
- **TC-L4: Realtime rank update** — Given a participant has `/leaderboard` open in a browser, when an admin (or scheduled trigger) finishes scoring a match, then the visible ranking updates without a page reload within 5 seconds of the scoring run completing. {Source: AI, ID: FR-L06, NFR-L2}
- **TC-L5: Shared rank rendering** — Given two participants who are exactly tied through every tie-breaker, when the leaderboard renders, then both rows show `1=` (or whatever the shared rank is), and the next non-tied participant is `3`. {Source: scoring-model.md §7.4, ID: FR-L03}
- **TC-L6: Tie-breaker chain** — Given two participants tied on total points (e.g. both at 47), where A has more exact-score hits than B, when the leaderboard renders, then A ranks above B regardless of secondary criteria. The chain is exhaustively tested for each pair: total → exact hits → outcome hits → final-prediction points → shared rank. {Source: scoring-model.md §7.4, ID: FR-L03}
- **TC-L7: Stage filter — group-stage only** — Given the stage filter is set to "Group" and final predictions have been scored (e.g. champion = correct → 20 pts to participant X), when the leaderboard renders, then participant X's row does NOT show that 20 pts; only points from `match.stage='group'` are counted. {Source: AI, ID: FR-L04, FR-L05}
- **TC-L8: Stage filter — all stages includes finals** — Given the stage filter is set to "All", when the leaderboard renders, then final-prediction points ARE included in the total. {Source: AI, ID: FR-L05}
- **TC-L9: "Show my rank" anchor** — Given a participant currently on page 4 of a paginated leaderboard, when they click "Show my rank", then they are navigated to the page that contains their row and the row is scrolled into view with a brief visual highlight. {Source: AI, ID: FR-L09}
- **TC-L10: Dashboard widget — rank and delta** — Given a participant has `/dashboard` open and a scoring run completes that moves them from rank 12 to rank 10, when the widget updates, then it displays "10" with an "↑ 2" delta indicator. {Source: AI, ID: FR-L08}
- **TC-L11: Dashboard widget — pre-tournament** — Given no `score_events` row exists yet, when the participant lands on `/dashboard`, then the "Your rank" card shows "Leaderboard opens at [first kickoff time in user TZ]" with no rank number. {Source: AI, ID: FR-L07, FR-L08}
- **TC-L12: Privacy — no other-participant breakdown** — Given a participant on `/leaderboard`, when they inspect any other participant's row, then no per-match prediction, per-source point breakdown, or audit metadata is exposed in the DOM or via the Realtime channel. {Source: AI, ID: FR-L02, NFR-L6}
- **TC-L13: Stage filter persistence via URL** — Given a participant navigates to `/leaderboard?stage=quarter`, when the page renders, then the "Quarter" stage tab is active and the rankings reflect only quarter-final points. Reloading preserves the filter. {Source: AI, ID: FR-L04}
- **TC-L14: Mobile layout** — Given a participant loads `/leaderboard` on a 360 px viewport, when the page renders, then the table layout adapts (compact rank + name + total columns; no horizontal scroll) and the stage tabs remain reachable via a swipe or scroll. {Source: AI, ID: FR-L15}
- **TC-L15: Admin recalc-all propagation** — Given a participant has `/leaderboard` open and an admin invokes `recalculate_all_scores()` (feature 003 FR-P18), when the recalc completes, then the visible ranking reflects the new state within 5 seconds. {Source: AI, ID: FR-L06}
- **TC-L16: A11y sweep** — Given any state of `/leaderboard` (empty / pre-tournament / populated / stage-filtered), when an axe-core scan runs at WCAG 2.1 AA, then there are zero violations. {Source: AI, ID: NFR-L4}
- **TC-L17: i18n keys present in all locales** — Given the locales `en`, `es`, `pt-BR`, when the leaderboard page renders in each, then all visible strings resolve to non-empty translations (no `leaderboard.xxx` raw keys leak through). {Source: AI, ID: FR-L13}
- **TC-L18: Mid-tournament joiner appears at 0/last after next refresh** — Given the tournament is live (at least one match has been scored) and a brand-new active participant is provisioned, when the next cron tick (or scoring run) refreshes `leaderboard_snapshots`, then the new participant is visible on `/leaderboard` with 0 total points and rank = last (shared with any others at 0). {Source: Session 2026-06-01, ID: FR-L01, FR-L21}
- **TC-L19: Inactive participant excluded** — Given a participant whose `status` has been changed from `active` to `inactive`, when the MV next refreshes, then their row no longer appears on `/leaderboard`. Their historical `score_events` rows are preserved (audit) but they drop out of the visible ranking. {Source: AI, ID: FR-L01}

**Edge Cases:**

- **No active participants** — `participants WHERE status='active'` is empty. Page shows "No participants yet" instead of an empty table. (Should never occur in production but defensively rendered.)
- **One active participant** — Ranking renders that single row at rank 1. The "around me" view degenerates gracefully (no above/below rows).
- **All participants tied at 0** — Only possible right after the tournament opens before any prediction has scored. Shared-rank rendering kicks in (`1=`, `1=`, …, `1=`).
- **Participant deactivated mid-tournament** — Inactive participants are excluded from the materialised view. Their historical score_events rows are preserved (audit) but they drop out of the ranking.
- **Stage with no matches yet** — e.g. participant filters to "Quarter" before any quarter-final has finished. Page shows "No matches scored in this stage yet — leaderboard opens at [first quarter-final kickoff]". (Same UI primitive as the pre-tournament empty state.)
- **Realtime channel disconnect** — If the WebSocket drops (e.g. network blip), the client reconnects automatically; the user sees no visible state regression but a small indicator may surface "Reconnecting…" if the disconnect exceeds 10s.

---

## 4. Functional Requirements

| FR | Requirement | Priority |
|---|---|---|
| FR-L01 | The system shall expose a `/leaderboard` route that ranks every active participant by total points across all source types. Participants with no `score_events` rows yet (e.g. brand-new joiners mid-tournament) shall appear at 0 points + last rank, not be hidden. | Must |
| FR-L02 | The leaderboard row for ANY participant shall expose only: rank (with `=` for shared rank), display name, and the active-tab's points total. No per-match, per-source, or audit data shall be exposed for other participants. | Must |
| FR-L03 | The ranking shall apply tie-breakers in this exact order, then shared rank: (1) total points DESC, (2) count of `match-exact` score_events DESC, (3) count of `match-outcome` score_events DESC, (4) sum of `final-*` score_events points DESC, (5) shared rank if all four are equal. {Source: scoring-model.md §7.4 items 1-4 + 6} | Must |
| FR-L04 | The page shall provide a tournament-stage filter as a tab strip: `All`, `Group`, `Round of 16`, `Quarter`, `Semi`, `Final`. The active tab persists via the `?stage=` URL query parameter. | Must |
| FR-L05 | When a specific stage tab is active, the ranking shall count ONLY match-scoring score_events whose `match.stage` matches. Final-prediction score_events (`source LIKE 'final-%'`) shall be INCLUDED only when the `All` tab is active. | Must |
| FR-L06 | The page shall subscribe to a Supabase Realtime channel on `leaderboard_snapshots`. When the underlying materialised view refreshes, the visible table shall re-render within 5 seconds without a page reload. | Must |
| FR-L07 | Before the first `score_events` row exists (i.e. before the first match has been scored), the page shall hide the rankings table and show a countdown to the earliest non-cancelled match's kickoff in the participant's timezone, with the heading "Leaderboard opens at [time]". The same primitive is reused for stage filters where no matches in that stage have finished yet. | Must |
| FR-L08 | The `/dashboard` route shall include a "Your rank" widget showing the authenticated participant's current rank (or pre-tournament message) and an arrow + integer delta versus the previous snapshot. Clicking the widget navigates to `/leaderboard` with the "Show my rank" anchor pre-fired. | Must |
| FR-L09 | When the participant list exceeds 25 rows, the `/leaderboard` page shall paginate at 25 rows per page. A "Show my rank" button shall navigate the user to the page containing their row and scroll the row into view with a brief visual highlight. | Must |
| FR-L10 | The `/leaderboard` route shall require an authenticated active participant session. Unauthenticated or inactive requests shall be redirected to `/` server-side (matches the auth gate convention from features 001-003). | Must |
| FR-L11 | Leaderboard reads (page server-rendering AND Realtime change emissions) shall be served from a Postgres materialised view `leaderboard_snapshots` keyed by `(participant_id, stage)` so the `All` and each stage tab share one canonical aggregation surface. | Must |
| FR-L12 | Every successful refresh of `leaderboard_snapshots` shall write a `leaderboard.refresh` row to `audit_log` recording the triggering `scoring_runs.id` (FK), refresh duration, and participant count. (Failure case: see FR-L20.) | Must |
| FR-L13 | All visible UI strings shall resolve through `next-intl` keys under the new `leaderboard.*` namespace, in `en` / `es` / `pt-BR`. | Must |
| FR-L14 | The page shall meet WCAG 2.1 AA at every state (empty / pre-tournament / populated / stage-filtered / pagination). Verified via axe-core sweep extension to `all-pages-a11y.spec.ts`. | Must |
| FR-L15 | The page shall be usable on a 360 px viewport (smallest common mobile width): no horizontal scroll, stage tabs reachable, table columns adapt to the smaller width. | Must |
| FR-L16 | Realtime subscription scope shall be the materialised view itself (not the underlying `score_events` table) so that subscribers only receive *ranked* aggregates, never raw score events. This is what enforces FR-L02 at the channel layer (no participant can subscribe to another's score_events). | Must |
| FR-L17 | When stage filter changes, only one Realtime subscription shall be active at a time (resubscribe on tab change). The previous subscription shall be cancelled to avoid leaked listeners. | Should |
| FR-L18 | When the Realtime channel drops, the client shall attempt to reconnect with exponential backoff. After 10s offline, a small "Reconnecting…" indicator shall surface in the page header. | Should |
| FR-L19 | The system shall expose an admin-only RPC `refresh_leaderboard()` that runs `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` outside any scoring run, for operator use after a `leaderboard.refresh_failed` audit row. The RPC writes a `leaderboard.refresh` audit row on success and a `leaderboard.refresh_failed` row on failure (same schema as the trigger-driven path). | Must |
| FR-L20 | Each scoring run's MV refresh attempt — regardless of outcome — shall produce exactly one `audit_log` row: `leaderboard.refresh` on success (carrying duration + participant count) OR `leaderboard.refresh_failed` on exception (carrying SQLSTATE + error message). The `scoring_runs.id` FK is set in both cases for traceability. | Must |
| FR-L21 | A `pg_cron` job shall invoke `refresh_leaderboard()` every 5 minutes. The RPC body shall gate the actual `REFRESH` based on: (a) if any non-cancelled match has `kickoff_utc` within `now() ± 90 min`, refresh unconditionally; (b) otherwise refresh only if the most recent `leaderboard.refresh` audit row is more than 60 minutes old. Effective cadence: 5 min during match windows, ~60 min during quiet periods. | Must |
| FR-L22 | The cron job shall not refresh the MV if no `score_events` row exists yet (pre-tournament). The audit log shall not be polluted with `leaderboard.refresh` rows for a no-op pre-tournament state. | Should |

## 5. Non-Functional Requirements

| NFR | Target | Notes |
|---|---|---|
| NFR-L1 | `/leaderboard` first paint ≤ 1 s @ 200 active participants | Server-rendered from the materialised view; no client-side fetch waterfall on cold load. |
| NFR-L2 | Realtime rank update visible within 5 s of scoring trigger commit | End-to-end: scoring trigger → MV refresh → Realtime emit → client re-render. |
| NFR-L3 | `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` ≤ 500 ms @ 200 participants × 104 matches × 6 stages = 124,800 score_events rows | Concurrent refresh keeps reads non-blocking. |
| NFR-L4 | A11y: WCAG 2.1 AA, axe-core 0 violations | Verified in every page state including stage-filtered + empty + pagination. |
| NFR-L5 | Stage tab switch ≤ 200 ms perceived latency | Cached materialised view + URL state means the new tab is rendered from already-loaded snapshot data. |
| NFR-L6 | Privacy: no DOM or Realtime payload shall expose any other-participant data beyond rank + display name + (active-tab) total points | Enforced by FR-L11 (MV is the only read surface) + FR-L16 (subscription scope is the MV, not score_events). |
| NFR-L7 | 50+ concurrent active Realtime subscribers supported without backpressure or dropped events | Verified in load test against the Pro-tier Supabase project. |

## 6. Key Entities

This feature adds ONE materialised view, ONE Realtime channel, ONE audit event type, and a small set of i18n keys. It introduces NO new mutable tables and changes no existing column semantics.

| Entity | Type | Purpose |
|---|---|---|
| `leaderboard_snapshots` | Materialised view | Aggregates `score_events` into `(participant_id, stage, total_points, exact_hits, outcome_hits, final_points, rank)` via `participants LEFT JOIN score_events`, filtered by `participants.status='active'`. Active participants with no `score_events` rows yet still appear (0 points, last rank) — see FR-L01. Keyed by `(participant_id, stage)`. The `stage` dimension takes a literal `'all'` value plus one row per real `matches.stage`. Refreshed in an exception-trapped block invoked by every scoring run; refresh failure does NOT roll back the scoring commit (FC-L2). |
| `audit_log.event_type = 'leaderboard.refresh'` | Audit event variant | Records each successful MV refresh with triggering `scoring_runs.id`, duration, and participant count. |
| `audit_log.event_type = 'leaderboard.refresh_failed'` | Audit event variant | Records each failed MV refresh with triggering `scoring_runs.id`, SQLSTATE, and error message. The MV is left at its prior state; the next scoring run (or `refresh_leaderboard()` RPC) re-attempts. |
| `refresh_leaderboard()` | RPC (admin-only + cron-invoked) | `SECURITY DEFINER` function that runs `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` outside any scoring run. Writes the same `leaderboard.refresh` / `leaderboard.refresh_failed` audit row schema as the trigger-driven path. RLS gates the RPC to admin oids; the `pg_cron` job (FR-L21) calls it with elevated privileges. |
| `pg_cron` schedule `leaderboard-refresh-tick` | Scheduled job | Runs every 5 minutes. Body invokes `refresh_leaderboard()` with internal gating per FR-L21 (5 min in match windows, ~60 min in quiet periods, skip pre-tournament per FR-L22). |
| `leaderboard.*` i18n keys | i18n namespace | `pageHeading`, `pageDescription`, `stageAll`, `stageGroup`, `stageR16`, `stageQuarter`, `stageSemi`, `stageFinal`, `rankColumn`, `nameColumn`, `pointsColumn`, `showMyRank`, `noMatchesYet`, `tournamentOpensAt`, `yourRank`, `delta`, `reconnecting`, `sharedRankSuffix`. (Final list firmed up at plan time.) |

**Read-only references (no schema change):**
- `score_events` (feature 003): source aggregation surface — read-only for this feature.
- `participants` (feature 001): joined for `display_name` + `status='active'` filter.
- `matches` (feature 002): joined for `stage` filter dimension.
- `scoring_runs` (feature 003): FK target for `audit_log.leaderboard.refresh` rows.

---

## 7. Solution Overview

Feature 004 makes the points visible. Today, a participant can submit predictions and view their own breakdown, but cannot see where they stand against the pool. The leaderboard closes that loop: one ranked page, one dashboard widget, one shared aggregation surface, one Realtime channel — all reading from `score_events` (the canonical aggregation table from feature 003).

The design choice that matters: there is exactly ONE materialised view (`leaderboard_snapshots`) that holds the ranked aggregation for `All stages` plus one row per real tournament stage. Every reader — the `/leaderboard` page, the dashboard widget, the Realtime subscriber — reads from this view. The view refreshes in the same database transaction as every scoring run (match-scoring trigger, final-scoring trigger, admin recalc-all), so the ranking is always consistent with the underlying `score_events` (no derived-state drift). Postgres emits change events on the view via Supabase Realtime, and the subscribed pages re-render the visible rows without a refresh.

The page surfaces are deliberately minimal at MVP: rank + display name + active-tab points. This is what FR-013 ("ranked by total points, with deterministic tie-breaking rules") explicitly mandates and what feature 003's FR-P25 (predictions are private) implicitly forbids breaking. Richer "comeback narratives" (per-stage subtotals, exact/outcome hit counts on display, head-to-head views) are deferred to a future engagement-polish feature. The current MVP ships the ranking, the stage filter, the pre-tournament countdown, the dashboard widget, mobile-friendly layout, internationalisation, accessibility, and the Realtime path — which is the minimum needed to fulfil FR-013 with the engagement quality that justifies the project's existence.

---

## 8. UX Considerations

- **Rank rendering**: shared rank is rendered with a trailing `=` (`1=`, `1=`, `3`). Never use `T1` or `1*` — the `=` convention is what the architecture document uses and what most sports apps use.
- **Delta indicator on dashboard widget**: arrow + integer (`↑ 3`, `↓ 1`, `—`). Never an emoji or coloured arrow alone (a11y: colour cannot be the sole carrier of meaning). Tooltip / sr-only span: "Moved up 3 places since last finished match".
- **Stage tab strip**: horizontally scrollable on mobile if the labels exceed viewport; keyboard-navigable (Arrow Left / Right) per WAI-ARIA tabs pattern.
- **"Show my rank" button**: prominent in the page header on mobile (often above-fold). Smooth-scrolls the target row into view; row receives a 1.5s subtle highlight (Tailwind `ring-2 ring-amber-400` or equivalent) so the participant can locate themselves.
- **Snapshot freshness indicator**: small caption near the page title showing "Last updated at [hh:mm]" using the participant's timezone. Reduces "is this stale?" anxiety during quiet hours.
- **Empty / pre-tournament state**: a single primitive `<EmptyLeaderboardState/>` is reused for: (a) no finished matches yet (page-level), (b) no matches in the selected stage yet (stage-level). The component shows a short copy and a countdown to the next opening kickoff.
- **Realtime reconnect indicator**: small unobtrusive chip in the page header when the WebSocket has been offline for ≥ 10 s. Goes away on reconnect.
- **Dashboard widget visual weight**: compact (one line on desktop, two on mobile). It should not dominate `/dashboard` — the participant's primary task there is still "predict the next match". Widget is positioned ABOVE the upcoming-matches list but BELOW the welcome / nav header.

---

## 9. Integration Context

| Surface | Direction | Notes |
|---|---|---|
| `score_events` (feature 003 table) | Read | Sole source of points for the MV. Read inside the MV definition, never directly by the page. |
| `participants` (feature 001 table) | Read | Joined for `display_name`; filtered by `status='active'`. |
| `matches` (feature 002 table) | Read | Joined for `stage` filter dimension when building the per-stage MV rows. |
| `scoring_runs` (feature 003 table) | Read (FK only) | Each `leaderboard.refresh` audit row references the triggering scoring_run id. |
| `audit_log` (feature 001 table) | Write (refresh trail) | One row per MV refresh. |
| Supabase Realtime | Bidirectional | Page subscribes to `leaderboard_snapshots`; Postgres emits via Realtime publication. |
| `pg_cron` (Postgres extension) | Scheduled | New `leaderboard-refresh-tick` job invokes `refresh_leaderboard()` every 5 minutes (see FR-L21 / FR-L22). Already enabled in the Supabase project for other features. |
| `/dashboard` route (feature 001) | Read + extend | Adds the `<RankWidget/>` above the upcoming-matches widget. |
| `next-intl` messages (feature 001 i18n) | Extend | New `leaderboard.*` keys in `en` / `es` / `pt-BR`. |

**No new external integrations.** The materialised view + Realtime channel are entirely internal to Supabase.

---

## 10. Feature-Specific Constraints

- **FC-L1: MV is the only read surface for rankings.** No page / RPC / Realtime subscriber may bypass `leaderboard_snapshots` and read from `score_events` directly for ranking purposes. This is what makes FR-L02 (privacy) and FR-L06 (live updates) compose correctly.
- **FC-L2: MV refresh is invoked from each scoring run, but decoupled from scoring commit.** `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` runs inside an exception-trapped block within each scoring run (match trigger, final trigger, admin recalc). If the scoring transaction rolls back, the MV stays at the prior state — no derived-state drift. If the REFRESH itself throws (lock contention, disk pressure, concurrent autovacuum), the **scoring transaction still commits** — `score_events` is the canonical store; a transient view-refresh failure must not lose a correctly-scored match. The failure is recorded as an `audit_log` row (`event_type='leaderboard.refresh_failed'`) carrying the SQLSTATE + error message + triggering `scoring_runs.id`. The MV will be re-refreshed by the next successful scoring run, or by an admin invocation of the `refresh_leaderboard()` RPC (FR-L19).
- **FC-L3: Realtime subscription scope is the MV.** Participants subscribe to the materialised view's change stream, never to `score_events`. This is what enforces FR-L02 / NFR-L6 at the wire level.
- **FC-L4: Stage filter excludes finals.** The four `final-*` score_events sources contribute ONLY to the `All` stage row of the MV. They do not appear in any specific-stage row regardless of which match they were notionally awarded for. This is the agreed semantic from Round 2 Q1.
- **FC-L5: Tie-breaker stops at #4.** The MV stores `total_points`, `exact_hits`, `outcome_hits`, `final_points` as the four sort keys plus shared-rank fallback. Item #5 (earliest submission time) is NOT computed and NOT stored. If the business approves #5 post-launch, it becomes a follow-up feature.
- **FC-L6: Single leaderboard surface for all roles.** Admins read `/leaderboard` and `leaderboard_snapshots` with exactly the same shape and same row contents as participants. There is no admin-only column, no impersonation view, no "show breakdown" toggle. Admin operational visibility for scoring health is served by the `all_runs` view and `audit_log` (feature 003), not by this page.

---

## 11. Out of Scope / Deferred

| Item | Reason | Resolution path |
|---|---|---|
| Per-stage subtotals visible per row | Privacy + clutter; not what FR-013 asks for. | Possible "rich row" follow-up feature post-tournament. |
| Head-to-head comparison view | Engagement nice-to-have; not in FR-013/014. | Future engagement-polish feature. |
| Historical rank trajectory chart | Not in FR-013; nontrivial UI. | Future engagement-polish feature. |
| Public (no-auth) read-only leaderboard | Conflicts with the "internal Nortal pool" framing (general-overview.md). | None planned. |
| Tie-breaker #5 (earliest submission time) | "Only if approved" per architecture; we stop at #4 + shared rank. | Future feature if the business approves. |
| Notifications on leaderboard milestones (FR-019) | FR-019 spans more than leaderboard (deadlines, missing predictions). Cleaner as its own feature. | Future notifications feature. |

---

## 12. References

**Project context:**
- `.ai_project_memory/architecture.md` — system architecture and integration points
- `.ai_project_memory/general-overview.md` — project identity and stakeholders
- `.ai_project_memory/constitution-frontend.md` — Next.js / Tailwind patterns
- `.ai_project_memory/constitution-backend.md` — Supabase / Postgres patterns (Realtime + materialised views)

**Related specs:**
- `specs/001-authentication-and-participant/spec.md` — auth gate convention, participant entity, audit_log
- `specs/002-match-catalog-read/spec.md` — `/dashboard` and `/matches/*` routes, timezone handling, ISR pattern
- `specs/003-predictions-and-scoring/spec.md` — `score_events` schema + sources, scoring triggers, `scoring_runs` table

**External references:**
- `docs/architecture/high-level-architecture.md` FR-013, FR-014, FR-018, FR-019
- `docs/architecture/scoring-model.md` §7.4 (tie-breaker chain)
- `docs/architecture/open-decisions.md` (no leaderboard-specific ODs open)
