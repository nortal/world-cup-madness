# Implementation Plan: Phase 4 Dashboard Polish + Mobile UX

**Branch**: `005-phase-4-dashboard` | **Date**: 2026-06-06 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `specs/005-phase-4-dashboard/spec.md`

## Summary

Reshape `/dashboard` into a mobile-first, engagement-oriented home screen by adding six widgets (existing UpcomingMatchesWidget extended with inline-expand quick-edit, existing RankWidget unchanged, new SnapshotWidget, NeighborhoodWidget, MoversWidget, DigestWidget) and a mobile-only tab strip (Today / Pool). All widgets share the existing `leaderboard-refresh` Realtime channel from feature 004 with a 300 ms client-side debounce. A stale-while-revalidate refresh pattern with a header-level "refreshing…" chip preserves CLS ≤ 0.1 (NFR-D05). Zero new persistent schema — the 24-hour movers calculation and the weekly digest aggregate run on demand against existing tables (`leaderboard_snapshots`, `score_events`, `predictions`, `matches`). The inline quick-edit on the upcoming-match widget calls the same `lock_prediction` RPC the standalone form uses, surfacing the full error-message set (FR-D20).

## Implementation Conflicts

**Status**: No Conflicts Found

**Conflict Check Date**: 2026-06-06

**Checked Against**: Plans + specs for features 001 (auth), 002 (match catalog), 003 (predictions + scoring), 004 (leaderboard).

**Findings**:
- Feature 004's `RankWidget` is embedded as-is in the Today tab; no behavioural change.
- Feature 002's `UpcomingMatchesWidget` is extended with an `<button aria-expanded>` toggle and an inline form; the existing render path is preserved when the widget is collapsed (default state).
- Feature 003's `lock_prediction` RPC is reused unchanged; the inline form is an additional client surface that calls the same RPC the full `/predictions/[matchId]` form does. No new validation logic added at the DB layer.
- Feature 004's `leaderboard-refresh` Realtime channel + RLS policies are reused; no migration changes required.

The feature is fully additive to the existing implementation.

---

## Technical Context

**Language/Version**: TypeScript 6.x (strict mode) + SQL (PostgreSQL 15+ on Supabase)
**Primary Dependencies**:
- Next.js 15.x (App Router, Server Components + selective Client Components)
- Tailwind CSS 4.x (responsive `md:` breakpoint = 768 px controls tab vs grid)
- next-intl 4.x (i18n for en/es/pt-BR)
- @supabase/ssr 0.10.x (Server Component cookie handling)
- @supabase/supabase-js 2.x (browser client + Realtime channel)
**Storage**: PostgreSQL 15 (Supabase) — read-only from existing tables; no new schema
**Testing**: Jest (helpers + components) + Playwright (E2E + axe-core a11y)
**Target Platform**: Vercel-hosted Next.js Server Components; participant browsers (mobile 360 px → desktop)
**Project Type**: Web (Next.js full-stack monolith on Vercel + Supabase)
**Performance Goals**: Server-render p95 ≤ 1 s; LCP ≤ 2.5 s on simulated 4G; 24-hour-movers query p95 ≤ 250 ms; CLS ≤ 0.1 on Realtime re-fetch
**Constraints**: No new persistent tables (FC-D1, with the one ratified read-only carve-out for migration 0038's aggregator RPC); preserves existing dashboard surfaces (FC-D3); shares Realtime topology with `/leaderboard` (FC-D4)
**Scale/Scope**: 200 active participants + 20 finished matches at peak (FA-D1); single page (`/dashboard`) with 6 widgets; one Server Component composer; ~5 new Client Components

## Constitution Check

**Applicable Constitution**: frontend (primary), backend (secondary — query shapes only, no schema)
**Source Documents**:
- `.ai_project_memory/constitution.md` — universal principles
- `.ai_project_memory/constitution-frontend.md` — Next.js, Tailwind, next-intl
- `.ai_project_memory/constitution-backend.md` — Supabase patterns (Realtime + RLS)

### Compliance Checklist

- [x] **constitution §1.1 (Modular Monolith)**: All authoritative state stays in Postgres (existing MV, views, RPCs). Inline edit calls existing `lock_prediction()` RPC — no client-side lock logic.
- [x] **constitution §1.2 (Naming conventions)**: New components PascalCase (`DigestWidget`, `MoversWidget`, etc.); helpers camelCase; i18n keys camelCase under `dashboard.*` namespace.
- [x] **constitution §1.3 (Structured logging)**: NFR-D08 mandates JSON log lines on inline-save success + failure with `event`, `participant_id`, `match_id`, `outcome`, `error_code`, `occurred_at` fields.
- [x] **constitution §2 (Security)**: No new service-role usage in client bundles. All data reads go through participant's authenticated Supabase session + existing RLS policies + column-level GRANTs from feature 004. Inline save reuses the lock-validated RPC.
- [x] **constitution §3 (Git workflow)**: Feature branch `005-phase-4-dashboard` already created; commits follow Conventional Commits.
- [x] **constitution §4 (Testing)**: Lock-boundary tests required (TC-D5 at exactly −60 min); pre-tournament tests required (TC-D11); per-FR test mapping for FR-D01..D21.
- [x] **constitution-frontend §I (Stack)**: Tech stack matches — Next 15, TS 6, Tailwind 4, next-intl 4. No new dependencies introduced.
- [x] **constitution-frontend §IV.1 (UI patterns)**: Server Components by default; Client Components only where interactivity demands (tab strip, inline-expand, debounced Realtime subscription, refreshing chip).
- [x] **constitution-frontend §IV.1 (Lock state authority)**: Server renders lock state; inline countdown formats the server-provided value but never calculates lock state independently.
- [x] **constitution-frontend §V.2 (URL state)**: Active tab reflected in `?tab=` query param per FR-D02 — uses Next.js `searchParams`.
- [x] **constitution-frontend §VII (Accessibility)**: WCAG 2.1 AA across the new surfaces — `role="tablist"` + manual-activation arrow nav (matching feature 004's StageTabStrip), `aria-expanded` on the upcoming-match toggle, `role="status"` on the refreshing chip + ReconnectingIndicator, semantic `<time dateTime="…">` markup throughout.
- [x] **constitution-frontend §VIII (Testing)**: Jest unit tests for new pure helpers; Playwright E2E with axe-core sweep on both mobile tabbed and desktop grid layouts.
- [x] **constitution-frontend §IX (Anti-patterns)**: No `useEffect` for initial data fetching; lock state never computed client-side; predictions never persisted to localStorage.
- [x] **constitution-backend §1.1 (Stack)**: Reuses existing tables, MV, views, RPCs from features 001-004. The 24-hour movers and weekly digest queries are PostgREST reads against tables already exposed.
- [x] **constitution-backend §IV (Auto-API via PostgREST)**: New queries are stock `.from(...).select(...)` calls; no new RPC introduced.
- [x] **constitution-backend §IX (Anti-patterns)**: No lock validation in Next.js; no service-role usage in browser bundles; no provider raw responses persisted directly.

**Violations Found**: None.
**Remediation**: N/A.

---

## Project Structure

### Documentation (this feature)
```
specs/005-phase-4-dashboard/
├── spec.md                                  # Feature specification (input)
├── plan.md                                  # This file
├── research.md                              # Phase 0 output
├── data-model.md                            # Phase 1 output
├── contracts/                               # Phase 1 output
│   ├── README.md
│   ├── reused-rpc-lock-prediction.md
│   ├── reused-realtime-leaderboard-refresh.md
│   ├── query-neighborhood.md
│   ├── query-movers-global.md
│   ├── query-movers-neighborhood.md
│   ├── query-weekly-digest.md
│   ├── query-last-finished-prediction.md
│   └── query-upcoming-prediction.md
├── quickstart.md                            # Phase 1 output
├── checklists/
│   └── requirements.md                      # From /ai1st-po-specify
└── tasks.md                                 # (created by /ai1st-dev-tasks)
```

### Source Code (repository root: `project-repos/world-cup-madness/`)
```
app/
└── (participant)/
    └── dashboard/
        └── page.tsx                         # MODIFY — auth gate + tab parsing + Server Component composer

components/
├── dashboard/
│   ├── DashboardPage.tsx                    # NEW — Server Component composer
│   ├── DashboardTabStrip.tsx                # NEW — Client Component, WAI-ARIA tabs (mobile only)
│   ├── RefreshingChip.tsx                   # NEW — Client Component, role="status"
│   ├── DashboardRealtime.tsx                # NEW — Client Component wrapper, 300 ms debounce
│   ├── SnapshotWidget.tsx                   # NEW — Server Component, split card (last + next)
│   ├── NeighborhoodWidget.tsx               # NEW — Server Component, hybrid-clamp window
│   ├── MoversWidget.tsx                     # NEW — Server Component, global + neighborhood sections
│   ├── DigestWidget.tsx                     # NEW — Server Component, week-to-date totals
│   ├── PreTournamentPlaceholder.tsx         # NEW — Server Component, shared empty state
│   └── RankWidget.tsx                       # EXISTING (feature 004) — unchanged
└── matches/
    ├── UpcomingMatchesWidget.tsx            # MODIFY — wrap row in ExpandableMatchCard
    ├── ExpandableMatchCard.tsx              # NEW — Client Component, aria-expanded + sticky countdown
    └── InlinePredictionForm.tsx             # NEW — Client Component, reuses lock_prediction RPC + error component

lib/
└── dashboard/
    ├── tab-url-state.ts                     # NEW — parseTab/formatTabHref helpers
    ├── neighborhood-window.ts               # NEW — pure helper, computeNeighborhoodWindow
    ├── movers-24h.ts                        # NEW — pure helper, computeMovers
    ├── weekly-digest.ts                     # NEW — pure helper, computeDigestSummary
    └── __tests__/
        ├── tab-url-state.test.ts
        ├── neighborhood-window.test.ts
        ├── movers-24h.test.ts
        └── weekly-digest.test.ts

lib/i18n/messages/
├── en.json                                  # MODIFY — add ~25 dashboard.* keys
├── es.json                                  # MODIFY
└── pt-BR.json                               # MODIFY

e2e/tests/
├── dashboard-mobile-tabs.spec.ts            # NEW — TC-D1, TC-D2
├── dashboard-inline-edit.spec.ts            # NEW — TC-D3, TC-D4, TC-D5, TC-D17
├── dashboard-neighborhood.spec.ts           # NEW — TC-D6, TC-D7, TC-D8
├── dashboard-movers.spec.ts                 # NEW — TC-D9
├── dashboard-digest.spec.ts                 # NEW — TC-D10
├── dashboard-pre-tournament.spec.ts         # NEW — TC-D11
├── dashboard-realtime.spec.ts               # NEW — TC-D12, TC-D16
└── all-pages-a11y.spec.ts                   # MODIFY — add dashboard mobile + desktop variants for TC-D14

test/pgtap/
└── 025_movers_aggregate_rpc.sql             # NEW — pgTAP coverage for the migration 0038 RPC

supabase/migrations/
└── 0038_movers_24h_rpc.sql                  # NEW — read-only SECURITY DEFINER aggregator for FR-D11 global movers (Option A ratified 2026-06-07; see spec.md FC-D1 carve-out)
```

**Structure Decision**: Web application (single Next.js project). New files land under `components/dashboard/`, `components/matches/` (for the expandable card), `lib/dashboard/`, `e2e/tests/`, plus one new migration `supabase/migrations/0038_movers_24h_rpc.sql` and one new pgTAP file `test/pgtap/025_movers_aggregate_rpc.sql`. Modifies the three locale files + `app/(participant)/dashboard/page.tsx`. The migration is a single read-only SECURITY DEFINER aggregator — no persistent schema changes, no RLS changes to existing tables.

---

## Phase 0: Outline & Research

See [research.md](./research.md) for the six research tasks resolving all design unknowns ahead of Phase 1.

**Output**: research.md with all design unknowns resolved.

## Phase 1: Design & Contracts

See [data-model.md](./data-model.md) for the read-query catalogue (seven queries against existing tables/views) and [contracts/](./contracts/) for individual query/RPC contracts.

**Outputs**:
- `data-model.md` — query catalogue (no new entities)
- `contracts/README.md` + 7 individual contract files (two reuse documents + five new query contracts)
- `quickstart.md` — local dev + smoke-test recipes
- `.ai_project_memory/constitution-frontend.md` — stack additions (one new row for the mobile-tabs + responsive-grid idiom)

## Phase 2: Task Planning Approach

*This section describes what the `/ai1st-dev-tasks` command will do — DO NOT execute during /plan.*

**Task Generation Strategy**:
- Load `.ai/2_templates/tasks-template.md` as base.
- One phase per user story.
- Each pure helper → one Jest test task + one impl task (both [P]).
- Each new component → one impl task; tested via Playwright in that story's phase.
- Each Playwright spec → one task in the relevant story phase.
- Final phase: pristine sweep (tsc + lint + Jest + Playwright + axe-core), DoD doc, README update.

**Ordering Strategy**:
- Phase 1 Setup: directory tree + i18n key additions.
- Phase 2 Foundational: tab-url-state helper + DashboardPage composer skeleton + DashboardTabStrip.
- Phase 3-7: one phase per user story; each story is independently demoable.
- Final Phase: a11y sweep + DoD verification + README.
- `[P]` parallel markers identify helpers + Playwright specs that don't share files.

**Estimated Output**: 35-45 numbered, ordered tasks in `tasks.md`.

**IMPORTANT**: This phase is executed by `/ai1st-dev-tasks`, NOT by /plan.

---

## Dependencies Analysis

### Prerequisites

| Dependency | Source | Status | Notes |
|---|---|---|---|
| `leaderboard_snapshots` MV + column GRANT | Feature 004 (migration 0032) | ✅ Implemented | Neighborhood + Movers widgets read this |
| `leaderboard_self` view | Feature 004 (migration 0032) | ✅ Implemented | RankWidget already uses this; Pool tab also reads from it |
| `leaderboard-refresh` Realtime channel + `audit_log` publication + RLS | Feature 004 (migrations 0033 + 0037) | ✅ Implemented | DashboardRealtime subscribes to this channel |
| `lock_prediction()` RPC | Feature 003 (migration 0028) | ✅ Implemented | InlinePredictionForm calls this |
| `score_events` table | Feature 003 (migration 0025) | ✅ Implemented | Movers + Digest widgets aggregate this |
| `predictions` table | Feature 003 (migration 0020) | ✅ Implemented | SnapshotWidget reads this |
| `matches` table | Feature 002 | ✅ Implemented | All match-related widgets read this |
| `participants` table | Feature 001 | ✅ Implemented | Auth gate + display_name + timezone |
| Locale message catalogues + next-intl wiring | Feature 002 (ADR-008) | ✅ Implemented | Add new keys under `dashboard.*` |
| Existing UpcomingMatchesWidget render path | Feature 002 | ✅ Implemented | Extend (not replace) with the expand button |
| Existing RankWidget | Feature 004 | ✅ Implemented | Embedded as-is in the Today tab |

### Provides (to other features)

| Output | Used By | Description |
|---|---|---|
| Mobile-first dashboard pattern (tab strip + responsive grid) | Future Phase 4 features | Establishes the tabbed dashboard + refresh-chip idiom |
| `DashboardRealtime` Client wrapper (300 ms debounce + refreshing chip) | Reusable for any future dashboard widget needing Realtime + refresh-chip | Parametrised by widget render functions |
| Pure helpers: `computeNeighborhoodWindow`, `computeMovers`, `computeDigestSummary` | Future engagement features (leaderboard neighborhood, weekly newsletter, post-match digest) | Stateless utilities reusable from any Server Component |
| Inline expandable card pattern (matches widget) | Future features that may want inline edit elsewhere | `ExpandableMatchCard` + `InlinePredictionForm` decomposition can be lifted |

---

## Work Streams

### Stream Definitions

| Stream | Tag | Scope | Typical Executor |
|---|---|---|---|
| Frontend UI | [UI] | Components, pages, hooks, i18n keys | Frontend dev / UI agent |
| Testing | [TEST] | E2E specs, Jest tests, axe-core extension | QA / Test agent |
| Integration | [INT] | Pristine sweep, DoD doc, README, constitution update | Full-stack dev / Lead |

### Active Streams for This Feature

- [ ] [API] — Backend endpoints and services *(not active — read-only against existing tables; the one new RPC is consumed via PostgREST, not a custom endpoint)*
- [x] [UI] — Frontend components, page composer, helpers, i18n keys
- [x] [DB] — One new read-only migration: `0038_movers_24h_rpc.sql` (SECURITY DEFINER aggregator + pgTAP 025)
- [x] [TEST] — Playwright specs, Jest helper specs, axe-core sweep extension, pgTAP for the new RPC
- [ ] [INFRA] — Infrastructure changes *(not active)*
- [x] [INT] — Pristine sweep + DoD + README + stack-constitution update

### Stream Dependencies

- [TEST] depends on [UI] component skeletons being present (helpers can be tested ahead of components).
- [INT] depends on all of [UI] + [TEST] being green.

---

## Complexity Tracking

No constitutional violations. No entries.

---

## Use Case Specific NFRs

### Performance

| Requirement | Target | Measurement |
|---|---|---|
| [NFR-D01] Server-render `/dashboard` HTML | p95 ≤ 1 s | Server-side timing instrumentation against a 200-participant fixture |
| [NFR-D02] Largest Contentful Paint on mobile | ≤ 2.5 s | Lighthouse mobile simulated 4G in CI |
| [NFR-D07] 24-hour movers query | p95 ≤ 250 ms | Postgres `EXPLAIN ANALYZE` + Playwright timing on 200-participant fixture |
| [NFR-D05] Cumulative Layout Shift on Realtime re-fetch | ≤ 0.1 | Lighthouse mobile + Playwright timing TC-D16 |

### Accessibility

| Requirement | Target | Measurement |
|---|---|---|
| [NFR-D04] WCAG 2.1 AA on both layouts (mobile tabbed + desktop grid) | Zero axe-core violations | `e2e/tests/all-pages-a11y.spec.ts` extended with mobile + desktop dashboard variants |
| [FR-D17] Keyboard nav (Tab + arrow keys for tab strip + Enter/Space for expand) | All interactive surfaces operable by keyboard alone | Playwright keyboard interaction tests in `dashboard-mobile-tabs.spec.ts` + `dashboard-inline-edit.spec.ts` |

### Reliability

| Requirement | Target | Measurement |
|---|---|---|
| [NFR-D06] Realtime debounce window | 300 ms ± 50 ms | Playwright test fires 5 events in 200 ms; asserts exactly one re-fetch |
| [FR-D21] Extended Realtime outage stays stale + chip remains | No polling fallback, no forced reload | Playwright integration with channel-disconnect simulation |

### Internationalisation

| Requirement | Target | Measurement |
|---|---|---|
| [FR-D16] All visible labels via next-intl in en + es + pt-BR | Zero hardcoded English in new components | jq sweep across the three locale files; Playwright text-match tests with locale switches |

### Observability

| Requirement | Target | Measurement |
|---|---|---|
| [NFR-D08] Structured log on inline-save (success + failure) | One JSON line per save attempt with required fields | Capture `console.log` output during Playwright save tests + assert JSON shape |

---

## Acceptance Criteria

### Layout

- [FR-D01] Dashboard renders responsive layout that switches between mobile-tabbed (≤ 768 px) and desktop-grid (> 768 px) views
- [FR-D02] Mobile tab strip with two tabs (Today / Pool); active tab in URL as `?tab=today` (default) or `?tab=pool`; defaults to Today on every fresh navigation without `?tab=` param
- [FR-D03] Today tab contains Upcoming match (expandable) + Your rank + Your prediction snapshot in that order
- [FR-D04] Pool tab contains Your neighborhood + Biggest movers + This week's digest in that order
- [FR-D05] Desktop grid shows all six widgets in a responsive 2-column grid with no tab strip
- [UC-005-IMPL-01] Tab strip styling derives from feature 004's StageTabStrip (rounded-md, blue-600 active, gray-100 inactive)

### Inline Quick-Edit

- [FR-D06] Upcoming match widget tappable; expanding reveals score inputs + Save button reusing the standalone prediction-form logic
- [FR-D07] Sticky lock-countdown badge inside expanded card; ≥ 1 s update cadence
- [FR-D08] Save goes through `lock_prediction()` server validation; lock-collision surfaces `errorLocked`; badge transitions to "Locked"
- [FR-D20] Inline save surfaces the FULL error set (`errorOutOfRange`, `errorMatchNotFound`, `errorParticipantNotFound`, `errorGeneric`, `errorLocked`) with card staying expanded for retry
- [NFR-D08] Structured log line emitted on save success AND failure

### Prediction Snapshot

- [FR-D09] Split widget showing last-finished prediction + points awarded AND next-upcoming prediction or "No pick yet" prompt

### Neighborhood

- [FR-D10] Hybrid clamp: top-clamp ranks 1-11 if user rank ≤ 6; otherwise centred ±5 rows (shrink at bottom if user is within 5 of last rank); self row carries `data-self="true"`
- [UC-005-IMPL-02] Small pool (< 11 participants) renders whole pool; no padding with empty rows

### Movers

- [FR-D11] Two sub-sections: "Top 3 in pool" (global) + "Top 3 near you" (within neighborhood); each row shows name + current rank + delta arrow + magnitude
- [FR-D12] 24-hour rank delta computed on demand from `score_events` (no persistent rank-history table)
- [NFR-D07] Movers query p95 ≤ 250 ms on 200-participant fixture

### Weekly Digest

- [FR-D13] Mon-Sun UTC calendar week; total points + match count + best + worst single-match score

### Realtime + Refresh Chip

- [FR-D15] Subscribe to `leaderboard-refresh` channel; coalesce events within 300 ms into single batched re-fetch
- [FR-D19] Stale-while-revalidate (no skeletons, no blanking); "refreshing…" chip in page header with `role="status"` for in-flight fetch window
- [FR-D21] Extended outage: keep stale data + ReconnectingIndicator visible; no polling fallback, no forced reload; on reconnect, fire one catch-up re-fetch
- [NFR-D06] Debounce window 300 ms ± 50 ms; verifiable via burst test

### Pre-Tournament

- [FR-D14] When `score_events` is globally empty, Movers/Digest/Neighborhood widgets render "Awaiting the first match" placeholder cards; Upcoming/Rank/Snapshot render their existing pre-tournament states

### Cross-Cutting

- [FR-D16] All visible text in next-intl `en` + `es` + `pt-BR`
- [FR-D17] Keyboard navigation parity (Tab, Arrow keys per WAI-ARIA, Enter/Space for expand)
- [FR-D18] All existing dashboard surfaces preserved (UpcomingMatchesWidget, RankWidget, admin nav, predictions nav, TimezoneAutoDetect, welcome flow)
- [NFR-D01] Server-render p95 ≤ 1 s; [NFR-D02] LCP ≤ 2.5 s on mobile 4G; [NFR-D03] zero horizontal scroll at 360 px; [NFR-D04] zero axe-core violations; [NFR-D05] CLS ≤ 0.1

### BRD Traceability

*BRD references*: Not applicable — internal Nortal tool with no formal BRD. Criteria derive from the feature 005 spec (FR-D01..D21, NFR-D01..D08) which itself derives from constitutional principles + the architecture.md roadmap (Phase 4 — UX polish + leaderboard engagement).

*Design System references*: No formal design-system doc — visual idiom inherits from features 002-004 components; `[UC-005-IMPL-##]` IMPL tags denote derivations.

---

*Based on Constitution — See `.ai_project_memory/constitution.md`*
