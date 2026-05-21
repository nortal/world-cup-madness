# Match Catalog (Read Path) Specification

**Feature Branch**: `002-match-catalog-read`
**Created**: 2026-05-20
**Status**: Draft
**Priority**: High
**Input**: User description: "Match catalog read path: import 104 FIFA World Cup 2026 fixtures from football-data.org, let participants browse by group/stage/date/team with locale-aware kickoff display, render lock-countdown badge per match; predictions write path deferred to feature 003"
**Jira Ticket**: *(none — internal pool, no external tracker)*

---

## 1. Primary User Story

**As a** Nortal collaborator participating in the World Cup Madness pool,
**I want to** browse every match of the tournament with kickoff times shown in my local timezone, see at a glance which matches I can still predict and which are already locked, and know what the final score was for matches that have been played,
**so that** I can plan when to submit predictions, decide which matches to prioritize, and follow tournament progress without leaving the pool app.

A secondary story for tournament administrators:

**As a** tournament administrator,
**I want to** trigger a refresh of the match catalog from the upstream provider when the fixture list changes (draw results, kickoff time corrections, post-match score updates),
**so that** participants always see accurate, current match data without me hand-editing the database.

---

## 2. Details

**Problem:** Feature 001 delivered authenticated participants with empty dashboards. The pool's whole point is predicting matches, but no matches yet exist in the system. Before the prediction write path (feature 003) can be built, participants need to be able to *see* the tournament: every fixture, when it kicks off in their local time, whether the prediction window is still open, and what happened in matches already played. The match catalog also has its own ingestion and admin needs (importing 104 fixtures from an external provider, handling draw-time changes, recovering from provider outages) that earn it a slice of its own.

**Requirement Conflicts:** Requirement conflict check completed — no conflicts found (checked against feature 001 spec on 2026-05-20). The new `participants.timezone` column extends — does not contradict — the participants schema established in feature 001.

**Clarifications:**

### Round 1 (2026-05-20)
- Q: Default view + IA of `/matches` (grouped by stage, chronological by day, flat with filters, tabs)? → A: Chronological by day with secondary filters for stage / group / team via URL searchParams.
- Q: Match detail surface (separate route, inline expansion, modal)? → A: Separate route `/matches/[id]`.
- Q: Provider integration timing (one-shot import, scheduled sync, both)? → A: Both — bootstrap import lands in feature 002; scheduled cron is enabled in Phase 5 (operational readiness). Edge Function code lives in this feature.
- Q: Are match results / scores in scope? → A: Yes — fixtures + final results. Live in-progress score display is out of scope (architecture spec excludes live commentary).
- Q: Dashboard "upcoming matches" widget scope? → A: Next 3 upcoming matches (closest kickoff first) with lock state visible, replacing the current empty-state placeholder.

### Round 2 (2026-05-20)
- Q: Timezone source for kickoff display (browser auto-detect, stored on participants row, tournament-fixed)? → A: Stored on `participants` row (Q6-B). A new `timezone` column.
- Q: Lock countdown granularity (server render only, ticking client component)? → A: Server-rendered on the list / dashboard widget (less visual noise); ticking client component on the match detail page.
- Q: Admin match-data correction UI (in scope, deferred)? → A: Deferred to a dedicated admin-console feature. Feature 002 stops at the read-path UI + ingestion + sync; admin writes go through Supabase Studio / SQL until the admin UI lands.

### Round 3 (2026-05-20)
- Q: How is `participants.timezone` initially populated? → A: Auto-detect on first sign-in via a Client Component that reads `Intl.DateTimeFormat().resolvedOptions().timeZone` and calls a `set_timezone` RPC. The column is NOT NULL with default `'UTC'`; the auto-detect fires once on first dashboard mount when the participant's stored TZ is still the default.
- Q: Timezone UI on `/profile`? → A: Add a full IANA timezone selector to `/profile` with an `update_timezone` RPC mirroring the `update_display_name` pattern from feature 001.
- Q: Day grouping ("Today", "Tomorrow") — whose timezone? → A: The participant's stored timezone. A user in Brasília and a user in Tallinn looking at the same match may see it under different day headers.

---

## 3. Workflow

**Business Workflow:**

- Step 1 (one-time, admin): An administrator triggers the initial catalog import. The system fetches all 104 fixtures from the external football-data provider, normalises them into internal team + match records, and persists them. The catalog becomes available to participants on next page load.
- Step 2 (participant, browse): An authenticated participant navigates to `/matches`. The system displays all matches grouped by day in the participant's local timezone, with the most imminent day at the top. Secondary filters allow narrowing by stage, group, or team via URL query parameters (shareable links).
- Step 3 (participant, drill in): The participant clicks a match card and lands on `/matches/[id]`. The detail page shows both teams, stage, group, kickoff time (in the participant's TZ), a live ticking countdown to the lock boundary, and the current match status (or final score if the match has finished).
- Step 4 (participant, dashboard glance): On the dashboard (`/dashboard`), the participant sees an "Upcoming matches" widget listing the next 3 upcoming matches with their lock state, replacing the empty-state placeholder from feature 001.
- Step 5 (participant, first-time TZ): A brand-new participant signs in. On first dashboard mount, the system auto-detects their browser timezone and persists it to the participant row. From this point on, kickoff times display in their TZ consistently across devices.
- Step 6 (participant, TZ override): The participant can navigate to `/profile`, see their currently-stored timezone, and pick a different IANA timezone from a searchable selector. The change persists and takes effect on next page load.
- Step 7 (admin, re-sync): When the upstream provider updates fixtures (e.g. after the FIFA draw, after a kickoff-time correction, after a match completes), an administrator invokes the re-sync action. The system pulls fresh provider data, upserts changed matches, and records an integration-run audit row.

**Test Cases / Acceptance Scenarios:**

- **TC-M1:** Catalog browse, authenticated participant — Given a participant has signed in and the catalog has been bootstrapped, when they navigate to `/matches`, then they see all 104 matches grouped by day in their stored timezone with the closest day at the top. {Source: AI/Specify}
- **TC-M2:** Filter by stage — Given the participant is on `/matches`, when they apply the "Round of 16" stage filter (URL `?stage=round-of-16`), then only Round of 16 matches are displayed and the URL is shareable. {Source: AI/Specify}
- **TC-M3:** Match detail page — Given the participant clicks a match card, when the detail page renders, then they see both teams' names + flags, stage + group, kickoff time in their TZ, current status, and a ticking countdown to the lock boundary that updates without page refresh. {Source: AI/Specify}
- **TC-M4:** Lock-state badge — boundary above — Given a match's kickoff is more than 60 minutes in the future, when the participant views its card, then the lock badge reads `UPCOMING` and the countdown shows the remaining time. {Source: AI/Specify}
- **TC-M5:** Lock-state badge — boundary at-or-after — Given a match's kickoff is exactly 60 minutes in the future or sooner, when the participant views its card, then the lock badge reads `LOCKED` and no countdown is shown. {Source: AI/Specify, derived from BR-LOCK-003}
- **TC-M6:** Final score on completed match — Given a match has `status='finished'`, when the participant views its card, then the home and away final scores are displayed and the lock badge reads `FINISHED`. {Source: AI/Specify}
- **TC-M7:** First-sign-in TZ auto-detect — Given a participant who has just been provisioned (timezone column still at the default `'UTC'`), when their dashboard mounts for the first time, then a Client Component detects the browser timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` and calls the `set_timezone` RPC; the participant row's `timezone` column reflects the detected value. {Source: AI/Specify}
- **TC-M8:** TZ override via profile — Given a participant on `/profile`, when they select a different IANA timezone from the picker and save, then their `participants.timezone` column updates, an audit row is written with `action='participant.updated'` containing the old + new value, and the next dashboard load displays kickoff times in the new TZ. {Source: AI/Specify}
- **TC-M9:** Day grouping in participant TZ — Given two participants with stored timezones `Europe/Tallinn` and `America/Sao_Paulo` viewing the same match (kickoff 23:00 UTC on a Saturday), when each opens `/matches`, then the Tallinn participant sees the match under "Sunday" and the São Paulo participant sees it under "Saturday". {Source: AI/Specify}
- **TC-M10:** Dashboard widget — Given the catalog has 104 matches loaded, when an authenticated participant lands on `/dashboard`, then the "Upcoming matches" widget shows exactly the next 3 matches ordered by `kickoff_utc` ascending, each with its lock-state badge, replacing the previous empty-state placeholder. {Source: AI/Specify}
- **TC-M11:** Admin re-sync — Given an authenticated admin participant, when they invoke the re-sync action, then the system fetches fresh data from the provider, upserts any matches whose fields changed, and writes a row to `integration_runs` with provider name, start/end timestamps, status, and records processed. {Source: AI/Specify}
- **TC-M12:** Trilingual UI — Given the catalog is loaded, when the participant signs in with `Accept-Language: es-ES` (or `pt-BR`), then `/matches`, `/matches/[id]`, and the dashboard widget render all UI strings (page headings, day labels, stage names, status badges) in the requested locale; kickoff dates use the locale's date-format conventions in addition to the participant's stored timezone. {Source: AI/Specify}
- **TC-M13:** Idempotent re-import — Given the catalog has been imported once, when the re-sync action runs again with unchanged upstream data, then no row count changes, no duplicate rows are inserted (matched on `provider_id`), and the `integration_runs` row records "0 changes". {Source: AI/Specify}

**Edge Cases:**

- *What happens when no matches have been imported yet?* → `/matches` displays a localised empty-state message ("The match schedule has not been loaded yet. An administrator will publish it shortly.") and the dashboard widget shows its empty-state placeholder unchanged. The browse surfaces remain reachable; admins can sign in and trigger the import without any error state.
- *What happens when a match has no kickoff time yet (group draw not complete)?* → The match is stored with `kickoff_utc=NULL` and `status='scheduled-tbd'`; it is excluded from the default chronological view but reachable via the `?stage=...` filter so admins can verify the import. After the draw, the next re-sync populates `kickoff_utc` and the match appears in its day bucket.
- *What happens when the provider returns 5xx during a re-sync?* → No rows in `matches` change; an `integration_runs` row is written with `status='error'` and the error message; the admin triggering the re-sync sees an error response. Catalog browse continues to work against the existing data.
- *What happens when a participant's stored timezone string is invalid (e.g. corrupted, or removed from the IANA database)?* → The renderer falls back to `'UTC'` display and emits a structured log line. Next time the participant updates their TZ via `/profile`, the value is normalised.
- *What happens at participant TZ DST transitions?* → Day-grouping and kickoff display use the participant's TZ + `Intl.DateTimeFormat`, which handles DST correctly. A match whose kickoff_utc straddles a DST boundary still renders with the correct local clock time on each side.
- *What happens when a participant signs in from a device with a different TZ than stored?* → Display still uses the **stored** TZ (per Q11-A — consistent cross-device). The user can override via `/profile` if they want the device's TZ.
- *What happens at the lock boundary while the user is on the detail page?* → The client-side ticker on `/matches/[id]` counts down each second; when it reaches zero it flips the badge to `LOCKED` and stops the timer. No page refresh is required. The displayed lock state remains *advisory* — authoritative lock enforcement is server-side in feature 003.

---

## 4. Requirements

**Requirement Documents:**

- **Architecture (BRD-equivalent):** `docs/architecture/high-level-architecture.md` (Approved 2026-05-15) — FR-004 (Match catalog), FR-017 (Data synchronization), BR-LOCK-001 / 002 / 003 / 006
- **Scoring model:** `docs/architecture/scoring-model.md`
- **Stack decision:** `docs/architecture/stack-decision.md` (Approved 2026-05-15)
- **Open decisions:** `docs/architecture/open-decisions.md` — OD-005 (football-data.org provider commitment)
- **Predecessor spec:** `specs/001-authentication-and-participant/spec.md` — establishes the participant identity + profile surfaces that this feature extends

**Functional Requirements:**

- **FR-M01:** System MUST maintain a catalog of matches with the following per-match attributes: provider match id, home team, away team, stage (`group`, `round-of-16`, `quarter-final`, `semi-final`, `third-place`, `final`), group label (e.g. `A`, `B` — null for knockout), kickoff time stored UTC, venue (optional), match status, and home/away score fields. {Source: high-level-architecture.md, ID: FR-004}
- **FR-M02:** System MUST maintain a catalog of teams with the team's display name, FIFA 3-letter code, and provider team id. {Source: AI/Specify}
- **FR-M03:** System MUST provide a publicly-defined integration with the football-data.org REST API (via a provider-agnostic abstraction at the Edge Function layer) for importing fixtures and synchronising scores + statuses. {Source: high-level-architecture.md, ID: FR-017}
- **FR-M04:** System MUST allow an authenticated participant to browse the full match catalog at `/matches`. The default view groups matches by day in the participant's stored timezone, with the closest upcoming day at the top of the page and past days reverse-chronological below. {Source: AI/Specify}
- **FR-M05:** System MUST support filtering the `/matches` view by stage, group, and team via URL query parameters (`?stage=round-of-16&group=A&team=BRA`) so filtered views are shareable links. Multiple filters compose with AND semantics. {Source: AI/Specify}
- **FR-M06:** System MUST provide a per-match detail page at `/matches/[id]` (accessible to authenticated participants) showing both teams, stage, group, kickoff time, current status, venue if present, final score if `status='finished'`, and the lock-state badge. {Source: AI/Specify}
- **FR-M07:** System MUST display kickoff times to participants in their stored timezone using locale-appropriate date and time formatting (en / es / pt-BR per FR-A8). {Source: AI/Specify, derived from BR-LOCK-006}
- **FR-M08:** System MUST compute and display a lock-state badge for each match using server-side trusted time. The badge has three states: `UPCOMING` (more than 60 minutes until kickoff), `LOCKED` (60 minutes or less until kickoff, or match in progress), `FINISHED` (match completed). {Source: AI/Specify, derived from BR-LOCK-001 / 002 / 003}
- **FR-M09:** System MUST show a server-rendered countdown ("Locks in 2 hours 14 minutes") next to the UPCOMING badge on match cards on `/matches` and the dashboard widget. {Source: AI/Specify}
- **FR-M10:** System MUST show a client-side ticking countdown on the match detail page (`/matches/[id]`) that updates per second and flips the badge to `LOCKED` at the boundary without requiring a page refresh. The initial countdown value MUST be server-computed; the client-side ticker is presentational only and never determines the authoritative lock state. {Source: AI/Specify, constrained by BR-LOCK-001}
- **FR-M11:** System MUST display the home + away final score on match cards and detail pages when `status='finished'`. The score uses locale-appropriate digit grouping (none required for 0–99 scores but the formatting pipeline MUST honor locale). {Source: AI/Specify}
- **FR-M12:** System MUST update the participant dashboard (`/dashboard`) to render an "Upcoming matches" widget showing the next 3 upcoming matches (ordered ascending by `kickoff_utc`) with their lock-state badges, replacing the existing empty-state placeholder from feature 001. {Source: AI/Specify}
- **FR-M13:** System MUST add a `timezone` column to the `participants` table (NOT NULL with default `'UTC'`, storing IANA timezone strings such as `Europe/Tallinn`). {Source: AI/Specify, supports Q6-B}
- **FR-M14:** System MUST auto-detect the participant's browser timezone on first sign-in and persist it. The detection runs in a Client Component on first dashboard mount (or first `/matches` visit, whichever comes first) when the participant's stored TZ is still the default `'UTC'`. The mechanism is a `set_timezone(text)` RPC invoked once from the client. {Source: AI/Specify}
- **FR-M15:** System MUST extend the `/profile` page (introduced in feature 001) with a timezone selector — a searchable IANA timezone dropdown — that calls an `update_timezone(text)` RPC mirroring the `update_display_name` pattern. The selector defaults to the participant's currently-stored timezone. {Source: AI/Specify}
- **FR-M16:** System MUST audit timezone changes by writing a `participant.updated` audit row whenever `participants.timezone` changes (same trigger that handles `display_name` changes from feature 001). {Source: AI/Specify}
- **FR-M17:** System MUST group matches by day on `/matches` using the participant's stored timezone for day-boundary computation. Day-bucket labels MUST be localised: "Today" / "Tomorrow" / "Yesterday" for the three days adjacent to the current date in the participant's TZ; explicit localised weekday + date for other days (e.g. "Saturday, June 13" in en). {Source: AI/Specify}
- **FR-M18:** System MUST provide an authenticated-admin-only re-sync action that triggers the provider sync Edge Function on demand. The action is invokable from a route gated on `participant.role = 'admin'` (path TBD by planning; an admin-console feature will likely surface it). The action MUST be invokable via service-role RPC from the local dev environment without an admin user, for ops use. {Source: AI/Specify, derived from FR-017}
- **FR-M19:** System MUST record each catalog sync attempt to an `integration_runs` table with provider name, start + finish timestamps, outcome (`success` / `error`), records processed count, and error message on failure. {Source: AI/Specify}
- **FR-M20:** System MUST treat provider syncs as idempotent: re-running an import against unchanged upstream data MUST NOT insert duplicate rows. Matches are matched by `provider_id`; updates are applied only when a field differs. {Source: AI/Specify}
- **FR-M21:** System MUST translate all match-page UI strings (page headings, day labels, stage names, group labels, status badges, lock badges, countdown text, empty-state messages, profile timezone-selector label and validation messages) into `en`, `es`, and `pt-BR`. {Source: high-level-architecture.md, ID: FR-A8, extended}

**Feature-Specific Non-Functional Requirements (NFRs):**

- **NFR-M1:** Initial page render of `/matches` MUST complete in under 1 second for an authenticated user on a warm server (catalog is small — 104 rows — and bounded; no pagination needed).
- **NFR-M2:** Lock-state computation MUST use server-side trusted time exclusively. The client-side ticker on `/matches/[id]` is presentational; if the client's clock is wrong, the next server render corrects the displayed state. {Source: BR-LOCK-001}
- **NFR-M3:** All match-page surfaces (`/matches`, `/matches/[id]`, dashboard widget, `/profile` timezone selector) MUST meet WCAG 2.1 AA accessibility (axe-core scan with zero violations), matching the bar set by NFR-A4 from feature 001.
- **NFR-M4:** Match data MUST be stored in UTC in the database; locale-aware rendering happens at presentation time using the participant's stored TZ. {Source: BR-LOCK-006}
- **NFR-M5:** Provider sync MUST stay within football-data.org's free-tier rate limit of 10 requests per minute. The Edge Function MUST back off and retry on transient 4xx/5xx responses with exponential backoff; the bootstrap import MUST batch + chunk requests if the provider's pagination requires more than 6 calls.

**Out of Scope:**

- **Prediction write path** — Submitting / editing predictions, the `lock_prediction()` RPC, prediction edit history, and the participant-facing score-input form all live in feature 003.
- **Lock-boundary tests at exactly −60 / −61 / −59 minutes** — These are mandatory per Constitution §4 but they test the prediction lock RPC, which is feature 003's surface. The lock-badge UI in feature 002 displays the boundary; the *enforcement* tests land with the RPC.
- **Admin match-data correction UI (FR-015)** — Per Q8-B, deferred to a dedicated admin-console feature. Feature 002 builds the schema + sync + browse; admin field-edit UI ships separately. (Service-role RPCs are still callable from Supabase Studio / local SQL for ops use.)
- **Live in-progress score display** — Architecture spec excludes live commentary. Match status transitions to `finished` once the provider reports the final result; "in-progress" status renders as `LOCKED` without a score until the match completes.
- **Final-prediction browse surfaces** — Champion, runner-up, top scorer, best player display surfaces are out of scope; they belong to the final-predictions feature.
- **Leaderboard** — Display of rankings + points belongs to feature 005 (likely).
- **Notifications** — `FR-019` is out of MVP scope per architecture spec.
- **Scheduled cron** — The Edge Function code lands here; the cron schedule (hourly during the tournament) is enabled in Phase 5 (operational readiness).
- **Per-team detail pages or team rosters** — `/teams/[code]` route, player listings, etc.

---

## 5. Deferred Decisions

- **Item:** Exact path for the admin re-sync trigger UI (likely under `/admin/...`). **Rationale:** Admin console isn't built yet; the re-sync action's service-role RPC needs to exist (this feature) before its UI does (later feature). **Resolution phase:** Architecture (when the admin-console feature is planned).
- **Item:** Whether to surface match venue when present. The provider data may or may not include venue. **Rationale:** Cosmetic; doesn't affect the data model. **Resolution phase:** Implementation (drop into the detail page if present, omit gracefully if absent).
- **Item:** Cron schedule frequency for the operational-readiness phase (hourly / 15-min / per-day-of-match). **Rationale:** Depends on observed provider freshness vs rate-limit budget. **Resolution phase:** Phase 5 operational readiness, not feature 002.
- **Item:** Whether `/matches` should support secondary sort orders (by stage instead of by day, by group). **Rationale:** Default chronological-by-day is the primary IA per Q1-B; alternative sorts add UI complexity without obvious user need. Can be added later if usage logs show demand. **Resolution phase:** Post-launch, based on participant feedback.

---

## 6. Definition of Done

- All functional requirements (FR-M01 through FR-M21) implemented and verified
- All test cases (TC-M1 through TC-M13) pass in automated tests
- Edge cases enumerated in Section 3 are handled and tested
- `participants.timezone` column added via a new migration; participants from feature 001 retain their data (existing rows get `'UTC'` default; subsequent first-sign-in flow auto-detects)
- `integration_runs` table records every catalog sync attempt with full telemetry
- `/matches`, `/matches/[id]`, `/profile` timezone selector, and the dashboard "Upcoming matches" widget all render in en / es / pt-BR with native-quality translations
- Lock-state badge accurate at the boundary: a match at exactly kickoff − 60 minutes reads `LOCKED` (BR-LOCK-003 strict-inequality semantics applied to the display)
- The match-detail client-side ticker flips to `LOCKED` at the boundary without a page refresh
- Provider integration is idempotent and survives provider 5xx (`integration_runs` row written, catalog unchanged, admin sees error response)
- Accessibility audit passes for every new surface (axe-core WCAG 2.1 AA, zero violations) — adds entries to `e2e/tests/all-pages-a11y.spec.ts`
- Bootstrap import script / migration includes the full 104-fixture catalog for local-dev (sourced from football-data.org or a frozen snapshot)
- Updated test plan in CI runs: pgTAP + Playwright (chromium + accessibility) + Jest unit + tsc + lint, all green

---

## 8. Key Entities

**Data Model Reference:**

- Feature 001 data model: `specs/001-authentication-and-participant/data-model.md` (extended below)
- Feature-specific entities below

**teams:** Catalog of national teams participating in FIFA WC 2026.
- **Purpose:** Reference data for match home/away sides; renders on cards and detail pages with name + flag (flag is presentational only, derived from the FIFA code).
- **Key attributes:** display name, FIFA 3-letter code (e.g. `BRA`, `EST`, `USA`), provider team id (for sync).
- **Relationships:** Referenced by `matches.home_team_id` and `matches.away_team_id`.

**matches:** Catalog of all 104 tournament matches.
- **Purpose:** Authoritative source of fixture data for participants to browse and (in feature 003) predict against.
- **Key attributes:** provider match id, home team, away team, stage enum, group label (nullable for knockouts), kickoff UTC timestamp (nullable for pre-draw TBD), venue (optional), status enum (`scheduled`, `scheduled-tbd`, `locked`, `live`, `finished`, `cancelled`), home score (nullable), away score (nullable), created_at, last_synced_at.
- **Relationships:** Each row references two `teams` rows; future predictions table (feature 003) will reference `matches.id`.

**participants:** *(extended from feature 001)*
- **New attribute:** `timezone` (IANA timezone string, NOT NULL default `'UTC'`).
- **Audit:** changes to `timezone` trigger the existing `participant.updated` audit-log entry from feature 001.

**integration_runs:** Telemetry for every catalog sync attempt.
- **Purpose:** Audit trail and operational visibility for provider integrations (FR-017 §10.2).
- **Key attributes:** provider name (e.g. `football-data.org`), action (`bootstrap` / `incremental-sync` / `manual-resync`), started_at, finished_at, status (`success` / `error`), records_processed (count of upserts), records_unchanged, error_message (nullable).
- **Relationships:** Standalone telemetry table; not referenced by user-facing entities.

---

## 9. UX Considerations

**Note:** Business-level user experience needs, not technical UI specifications (those land in planning).

**User Interface Context:**

- **Primary user actions:**
  - Browse the full match list at `/matches`; filter by stage / group / team via URL.
  - Open a match detail page to see context + countdown.
  - Set or update their timezone via `/profile`.
  - Glance at the dashboard widget for "what's coming up".
  - (Admin only) Trigger a re-sync of the catalog from the provider.

- **User journey touchpoints:**
  - Landing → Sign-in → Dashboard (now with the upcoming-matches widget instead of the empty-state placeholder).
  - Dashboard → `/matches` (full browse).
  - Dashboard widget → individual match detail page.
  - `/profile` → timezone selector.

- **Accessibility needs:** WCAG 2.1 AA across every new surface. Keyboard-navigable filter chips, screen-reader-friendly match cards (each card announces team names + kickoff + status), `aria-live` polite region on the countdown ticker to avoid screen-reader interruptions. The IANA timezone picker on `/profile` MUST be searchable (~400 options is too many for a plain native `<select>`).

- **Usability considerations:**
  - Team names use full localised names where the provider supplies them (e.g. "Brazil" / "Brasil" / "Brasil") in addition to 3-letter codes; flag glyphs are decorative.
  - Day grouping uses the participant's TZ so the experience feels personal regardless of where they sit.
  - Lock-state colours pass WCAG AA contrast on the chosen background and never rely on colour alone (the badge text is the source of truth — `UPCOMING` / `LOCKED` / `FINISHED`).
  - Countdown ticker uses "Locks in 2h 14m" style (no seconds in the list view to reduce visual flicker; seconds shown only on the detail page).

**Design References:** *(none — design ships with implementation; visual reference is the feature-001 component palette)*

---

## 10. Integration Context

**Note:** WHAT systems to integrate with and WHY; HOW lives in planning.

**External Systems:**

- **football-data.org REST API:** Source of fixture data, match statuses, and post-match scores.
  - **Business purpose:** Provides authoritative tournament data without us hand-maintaining 104 fixtures. Provider-agnostic abstraction means we can swap to a different provider (sport-specific service, paid tier) if quality is insufficient.
  - **Data exchange:** Outbound — provider API key in request header; nothing else outbound. Inbound — fixture list (teams, kickoffs, venues, statuses, scores) in JSON, normalised into our `teams` + `matches` tables.
  - **Timing:** Bootstrap import: once, at deploy time or via admin trigger. Incremental sync: scheduled hourly during the tournament (cron lands in Phase 5). Admin manual re-sync: on-demand.

**Integration Constraints:**

- football-data.org free-tier rate limit: 10 requests per minute. The Edge Function MUST stay within this limit (NFR-M5).
- Provider may return inconsistent data near draw time and during live matches; sync MUST tolerate partial / stale data without corrupting the local catalog.
- Provider responses MUST be normalised before storage — raw provider payloads are NOT stored in user-facing tables (architecture spec §10.2). Optionally retained in `integration_runs` for debugging.

---

## 11. Feature-Specific Constraints

**Note:** General project constraints / NFRs live in `.ai_project_memory/constitution.md` + `.ai/0_core_memory/`. This section is feature-specific.

**FC-M1: UTC storage, participant-TZ display**
- **Description:** All match times stored in `kickoff_utc TIMESTAMPTZ`. Display always reflects the participant's stored timezone via locale-aware formatting at render time. {Source: BR-LOCK-006}
- **Impact:** Renderer (Server Components) MUST read `participants.timezone` on every request that displays kickoff times. Day grouping happens server-side after applying the TZ shift.

**FC-M2: Server-side time only for lock decisions**
- **Description:** Lock-state display is computed from server time, not client time. The client-side ticker on the detail page is presentational and reconciles with the server on the next render. {Source: BR-LOCK-001}
- **Impact:** The badge state is part of the Server Component output; client-side updates are decorative. Any user with a wrong system clock sees the correct badge after a page navigation.

**FC-M3: Catalog size is bounded**
- **Description:** 104 matches max for FIFA WC 2026. No pagination needed; all matches can be loaded in a single query and rendered in one page.
- **Impact:** Simplifies query patterns (no offset / cursor pagination); enables aggressive caching of the full catalog server-side.

**FC-M4: Provider integration must be idempotent + fail-soft**
- **Description:** Re-running an import with unchanged data must produce zero side effects. Provider 5xx must leave the catalog intact and record telemetry.
- **Impact:** Sync logic uses `INSERT ... ON CONFLICT (provider_id) DO UPDATE` rather than truncate-and-reload; field-level diffing reduces UPDATE noise + audit-log churn.

### Feature-Specific Assumptions

**FA-M1:** football-data.org will publish the World Cup 2026 fixture list with stable `provider_id` per match by the time the bootstrap import runs.
- **Validation plan:** Confirm during the integration spike before the bootstrap migration is written. If `provider_id` is unstable (e.g. changes after the draw), the sync logic adds a secondary match key (stage + home + away + kickoff_utc within ±24h).

**FA-M2:** Nortal will obtain a football-data.org API key (free tier sufficient for MVP) before feature 002 deploys to staging.
- **Validation plan:** Tracked as an external item alongside the OD-007 items from feature 001. Local dev can use a fixture-only seed file until the key is available.

**FA-M3:** The IANA timezone database available in the Postgres + Node.js runtime is fresh enough to cover all participant locations.
- **Validation plan:** Both runtimes ship reasonably current tz data. If a participant location uses a newly-introduced TZ identifier, the renderer falls back to UTC + logs a warning (already covered by the edge case in §3).

**FA-M4:** Group composition and seedings finalise by the FIFA draw (date TBD by FIFA). After the draw, an admin re-sync populates kickoffs that were `NULL` until then.
- **Validation plan:** Re-sync workflow + idempotency tests cover this; no separate code path needed.

---

## 12. References

**Project Context:**

- Project context: `.ai_project_memory/general-overview.md`
- Architecture: `.ai_project_memory/architecture.md`
- Backend constitution: `.ai_project_memory/constitution-backend.md` (Supabase, Postgres, Edge Functions patterns)
- Frontend constitution: `.ai_project_memory/constitution-frontend.md` (Next.js, Tailwind, i18n patterns including the hand-rolled Accept-Language detection from ADR-013)
- Universal constitution: `.ai_project_memory/constitution.md`
- Decisions log: `.ai/knowledge/decisions.md` (ADR-001 through ADR-013 — relevant: ADR-001 stack, ADR-003 knockout scoring basis, ADR-013 i18n)

**Related Specifications:**

- `specs/001-authentication-and-participant/spec.md` — establishes participant identity, `/profile` surface, audit-log infrastructure, i18n machinery, and the `participants` table this feature extends.

**External References:**

- football-data.org API docs (https://www.football-data.org/documentation/quickstart) — provider for fixture / score data
- IANA Time Zone Database — source of valid `timezone` column values
- FIFA World Cup 2026 official schedule — eventual ground truth for the 104 fixtures
- WCAG 2.1 AA accessibility guidelines — bar for all new UI surfaces (NFR-M3)

---

## Review & Acceptance Checklist

### Content Quality

- [x] No implementation details (languages, frameworks, APIs) — beyond unavoidable references to existing schema column names from feature 001
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

### Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable (concrete badge states, exact counts, exact route paths, specific lock boundary at 60 min)
- [x] Scope is clearly bounded (Out of Scope section enumerates everything deferred)
- [x] Dependencies and assumptions identified (Section 11, FA-M1 through FA-M4)

### Traceability & Context

- [x] Architecture document referenced (BRD-equivalent for this internal project)
- [x] Predecessor spec (001) referenced
- [x] No Figma yet (designs ship with implementation)
- [x] All clarifications documented with rounds + dates
- [x] Deferred decisions documented (Section 5)

---

## Execution Status

- [x] User description parsed
- [x] Key concepts extracted (actors: participant + admin; data: matches + teams + integration_runs; constraints: lock window + UTC storage + provider rate limit)
- [x] No ambiguities remain (3 rounds of Socratic dialogue completed; deferred decisions explicitly noted)
- [x] User scenarios defined (TC-M1 through TC-M13)
- [x] Requirements generated (FR-M01 through FR-M21, NFR-M1 through NFR-M5)
- [x] Entities identified (teams, matches, participants extension, integration_runs)
- [x] Review checklist passed
