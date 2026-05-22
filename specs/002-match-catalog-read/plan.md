# Implementation Plan: Match Catalog (Read Path)

**Branch**: `002-match-catalog-read` | **Date**: 2026-05-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/002-match-catalog-read/spec.md`

## Summary

Build the participant browse path for the 104 FIFA WC 2026 fixtures, the dashboard "Upcoming matches" widget, and the provider-agnostic ingestion + admin re-sync flow. Schema extension adds `teams`, `matches`, and `integration_runs` tables plus a `participants.timezone` column with auto-detection on first sign-in and a `/profile` selector. Reads serve through Server Components with `revalidate: 60` for outage tolerance; lock-state badges are derived (never persisted) and computed server-side from trusted time; provider sync runs through a Supabase Edge Function pinned to football-data.org v4, guarded by a Postgres advisory lock to serialise concurrent invocations.

## Implementation Conflicts

**Status**: No Conflicts Found

**Conflict check completed**: 2026-05-20. Checked against `specs/001-authentication-and-participant/plan.md` (the only other plan in this repo). Feature 002 *extends* the `participants` table (new column, additive) and the existing audit trigger from feature 001 (which already fires `participant.updated` on any column change — picks up timezone changes automatically per FR-M16). Dashboard update (FR-M12) replaces the empty-state placeholder in `app/(participant)/dashboard/page.tsx` — the slot is already commented as an attachment point in the feature-001 file. No conflicting defaults, validation rules, or data formats.

**Conflict Check Date**: 2026-05-20
**Checked Against**: `specs/001-authentication-and-participant/plan.md`, `specs/001-authentication-and-participant/spec.md`, `specs/001-authentication-and-participant/data-model.md`

---

## Technical Context

**Language/Version**: TypeScript 6.x (Next.js App Router); SQL (PostgreSQL 15+); Deno (Supabase Edge Function runtime for the sync job)
**Primary Dependencies**:
- Frontend: Next.js 15.5.x (App Router), React 19.x, next-intl 4.x, Tailwind v4, `@supabase/ssr` 0.10.x
- Backend: Supabase Postgres 15+ (PostgREST auto-API + custom RPCs), `@supabase/supabase-js` 2.x, Deno runtime for Edge Functions
- New for this feature: a small IANA timezone picker UI (TBD library choice — see Phase 0 research item R-2)
**Storage**: PostgreSQL 15+ managed by Supabase Cloud. New tables: `teams`, `matches`, `integration_runs`. Extension: `participants.timezone` (IANA text, NOT NULL, default `'UTC'`).
**Testing**: pgTAP for SQL/RLS, Jest for pure-function units, Playwright (chromium + accessibility projects) for E2E + a11y. Same suite layout as feature 001.
**Target Platform**: Next.js → Vercel (frontend); Supabase Cloud (Postgres + Edge Functions); browsers — modern evergreen Chrome / Firefox / Safari / Edge.
**Project Type**: Web application (Next.js App Router + Supabase Postgres + Supabase Edge Function for provider sync).
**Performance Goals**:
- `/matches` initial render < 1 second on warm cache (NFR-M1)
- Catalog query bounded to 104 rows; no pagination needed (FC-M3)
- Provider sync stays within 10 req/min free-tier ceiling (NFR-M5)
**Constraints**:
- Lock decisions use server-side trusted time only (NFR-M2 / BR-LOCK-001)
- All match times stored UTC; rendered in participant's stored TZ (NFR-M4 / BR-LOCK-006)
- Read path tolerates ≤ 60 second Supabase outage via Next.js `revalidate: 60` (NFR-M6)
- Concurrent sync invocations serialised via Postgres advisory lock (FR-M23)
- WCAG 2.1 AA across every new surface (NFR-M3)
**Scale/Scope**: 104 matches (bounded), hundreds of Nortal participants (per `general-overview.md`), one tournament cycle (June–July 2026 + cleanup).

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Applicable Constitution**: both (frontend + backend; the feature spans Server Components, Client Components, schema migrations, RLS, RPCs, and an Edge Function)

**Source Documents**:
- `../.ai_project_memory/constitution.md` (core principles)
- `../.ai_project_memory/constitution-frontend.md` (Next.js, Tailwind, i18n patterns including ADR-013)
- `../.ai_project_memory/constitution-backend.md` (Supabase, Postgres, Edge Functions patterns)

### Compliance Checklist

**Universal (constitution.md):**

- [x] **§1.1 Code Organization** — Modular monolith with DB-enforced rules: lock-badge logic, RLS, idempotent upsert all live in Postgres / Server Components; UI never owns authoritative lock decisions. ✓
- [x] **§1.1 Root directory discipline** — No new files in repo root; everything under `app/`, `components/`, `lib/`, `supabase/`, `e2e/`, `specs/`. ✓
- [x] **§1.2 Naming conventions** — kebab-case files (`/matches/[id]/page.tsx`), PascalCase components (`MatchCard`, `LockBadge`, `UpcomingMatchesWidget`), snake_case SQL columns (`kickoff_utc`, `provider_id`). ✓
- [x] **§1.3 Error handling — No silent failures** — Provider 5xx writes `integration_runs.status='error'` with message; advisory-lock contention writes `status='skipped'` with diagnostic context; client RPC errors logged via `console.error` (allowed by feature-001 ESLint config). ✓
- [x] **§1.4 Documentation philosophy — Comments for "why" not "what"** — Inline comments only at non-obvious decisions (advisory-lock semantics, revalidate:60 + ticker reconciliation). ✓
- [x] **§2 Security/Compliance — service_role never in client** — Sync Edge Function uses service-role within the Deno runtime only; admin RPC uses service-role helper from `lib/supabase/admin.ts` (already poison-pilled with `import 'server-only'`). ✓
- [x] **§2 Domain eligibility enforced at DB layer** — Match reads gated by `is_eligible_nortal_user()` RLS predicate (FR-M22). ✓
- [x] **§3 Git workflow — Feature branch + conventional commits + never `--no-verify`** — Already on `002-match-catalog-read` branched off `001-authentication-and-participant`. ✓
- [x] **§4 Testing — pgTAP + Jest + Playwright; output pristine** — pgTAP for RLS + idempotency + lock-badge SQL helper; Jest for pure helpers (kickoff-formatting, day-bucketing, IANA validation); Playwright for browse / detail / dashboard widget / TZ profile editing / admin re-sync flow + axe-core sweep. ✓
- [x] **§4 Lock boundary tests are mandatory** — Lock-badge derivation is unit-tested in this feature (pure function over kickoff + now). The authoritative lock RPC + −60/−61/−59 boundary tests live in feature 003 per Out-of-Scope clause. ✓ (deferred per spec, not skipped)

**Frontend (constitution-frontend.md):**

- [x] **§I.1 Stack: Next.js 15.x App Router + TypeScript 6.x + Tailwind v4 + next-intl 4.x + @supabase/ssr 0.10.x + server-only** — All existing; one new client dependency (IANA timezone picker, TBD R-2). ✓
- [x] **§IV.1 Server Components by default; "use client" only for interactivity** — `/matches`, `/matches/[id]`, dashboard widget all Server Components. Client Components: `<LockCountdownTicker/>` (per-second ticker), `<TimezoneAutoDetect/>` (one-shot RPC on first dashboard mount), `<TimezonePicker/>` (`/profile` selector). ✓
- [x] **§IV.1 Lock status as UI truth — server-rendered; never client-computed** — Server Components compute badge state; client ticker is presentational. ✓ (NFR-M2)
- [x] **§V Server-state via supabase server client in RSC** — All match-data reads via `lib/supabase/server.ts`. ✓
- [x] **§VII Accessibility WCAG 2.1 AA** — Added to `all-pages-a11y.spec.ts` covering 3 new surfaces (`/matches`, `/matches/[id]`, `/profile` with TZ picker open). ✓ (NFR-M3)
- [x] **§IX Anti-patterns — no client-side lock calculation; no useEffect for initial data fetch; no service_role in client bundles** — All respected. ✓
- [x] **i18n: hand-rolled Accept-Language detection per ADR-013** — Add new translation keys for match-page UI to existing en/es/pt-BR namespace files; no new locale machinery. ✓

**Backend (constitution-backend.md):**

- [x] **§I.1 Stack: Supabase Postgres + PostgREST + RPCs + Deno Edge Functions + pgTAP** — All existing; this feature adds the first Edge Function (`sync-matches`). ✓
- [x] **§IV API Design — PostgREST + RPC; business rules in DB** — Match reads via PostgREST with RLS; admin re-sync trigger via RPC + Edge Function. Lock-badge derivation is a SQL view helper (no separate API). ✓
- [x] **§V Data Access — no ORM; Supabase client + generated types** — All queries through `@supabase/ssr` + regenerated `database.types.ts` after migrations land. ✓
- [x] **§VI Security — service_role only server-side; RLS on all reads** — Sync Edge Function uses service-role within Deno; matches/teams/integration_runs all have RLS (FR-M22). ✓
- [x] **§VII Error handling — structured logging + integration retry with backoff** — `integration_runs` table is the structured log; Edge Function retries 4xx/5xx with exponential backoff (NFR-M5). ✓
- [x] **§IX Anti-patterns — no provider raw response stored in user-facing tables; no service_role in browser** — Normalised before storage; Edge Function only. ✓

**Violations Found**: None.

**Remediation**: N/A.

---

## Project Structure

### Documentation (this feature)

```
specs/002-match-catalog-read/
├── spec.md              # Feature specification (input)
├── plan.md              # This file (/ai1st-dev-plan output)
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── contracts/           # Phase 1 output (RPC + Edge Function contracts)
├── quickstart.md        # Phase 1 output
├── checklists/
│   └── requirements.md  # Spec quality checklist (from /ai1st-po-specify)
└── tasks.md             # Phase 2 output (/ai1st-dev-tasks — NOT this file)
```

### Source code (within `project-repos/world-cup-madness/`)

```
app/
├── (participant)/
│   ├── dashboard/page.tsx           # MODIFIED — mount UpcomingMatchesWidget (replaces empty state)
│   ├── matches/page.tsx             # NEW — Server Component, default chronological-by-day, filter chips
│   ├── matches/[id]/page.tsx        # NEW — Server Component, match detail with countdown ticker
│   └── profile/page.tsx             # MODIFIED — mount TimezonePicker beside DisplayNameForm
└── ... (existing routes from feature 001)

components/
├── auth/                            # (unchanged from feature 001)
├── profile/
│   ├── DisplayNameForm.tsx          # (unchanged from feature 001)
│   └── TimezonePicker.tsx           # NEW — Client Component, IANA picker calling update_timezone RPC
├── matches/
│   ├── MatchCard.tsx                # NEW — Server Component, renders one match in list view
│   ├── MatchDetailCard.tsx          # NEW — Server Component, detail page surface
│   ├── LockBadge.tsx                # NEW — Server Component, derived badge from kickoff+now+status
│   ├── LockCountdownText.tsx        # NEW — Server Component, "Locks in 2h 14m" text
│   ├── LockCountdownTicker.tsx      # NEW — Client Component, per-second ticker on detail page
│   ├── MatchFilters.tsx             # NEW — Server Component, filter chips reading searchParams
│   ├── UpcomingMatchesWidget.tsx    # NEW — Server Component, dashboard widget
│   └── TimezoneAutoDetect.tsx       # NEW — Client Component, one-shot first-sign-in RPC

lib/
├── matches/
│   ├── lock-badge.ts                # NEW — pure helper: (kickoff, now, status) → badge state
│   ├── day-bucket.ts                # NEW — pure helper: (kickoff_utc, participant_tz, locale) → bucket label
│   ├── format-kickoff.ts            # NEW — pure helper: (kickoff_utc, participant_tz, locale) → display string
│   └── iana-timezones.ts            # NEW — static IANA list for the picker (sourced from runtime Intl)
├── supabase/                        # (existing; types.ts will be regenerated)
└── i18n/                            # (existing; matches.* keys added to messages/*.json)

supabase/
├── migrations/
│   ├── 0011_create_teams.sql                NEW
│   ├── 0012_create_matches.sql              NEW
│   ├── 0013_create_integration_runs.sql     NEW
│   ├── 0014_add_participants_timezone.sql   NEW (column + default)
│   ├── 0015_match_rpcs.sql                  NEW (set_timezone, update_timezone, trigger_match_sync admin RPC)
│   ├── 0016_match_rls.sql                   NEW (RLS policies for the 3 new tables)
│   └── 0017_seed_teams.sql                  NEW (32 WC2026 teams as a frozen seed; matches come from provider sync)
├── functions/
│   └── sync-matches/
│       ├── index.ts                 NEW (Deno Edge Function — fetch v4 → normalise → upsert)
│       ├── provider/
│       │   └── football-data-v4.ts  NEW (provider abstraction)
│       └── README.md                NEW (deployment + env var notes)
└── seed.sql                         (unchanged from feature 001)

test/
└── pgtap/
    ├── 006_rls_matches.sql          NEW
    ├── 007_rls_integration_runs.sql NEW
    ├── 008_lock_badge_helper.sql    NEW (SQL-side lock-badge helper if we add one; otherwise omit)
    └── 009_sync_idempotency.sql     NEW (advisory lock + upsert idempotency at DB layer)

e2e/tests/
├── matches-browse.spec.ts                       NEW (TC-M1, TC-M2, TC-M5/6 part)
├── matches-detail-countdown.spec.ts             NEW (TC-M3, TC-M4)
├── matches-final-score.spec.ts                  NEW (TC-M6 full)
├── timezone-auto-detect.spec.ts                 NEW (TC-M7)
├── timezone-profile-override.spec.ts            NEW (TC-M8)
├── day-grouping-cross-tz.spec.ts                NEW (TC-M9)
├── dashboard-upcoming-widget.spec.ts            NEW (TC-M10)
├── match-sync-admin.spec.ts                     NEW (TC-M11)
├── matches-i18n.spec.ts                         NEW (TC-M12)
├── match-sync-idempotent.spec.ts                NEW (TC-M13)
├── match-sync-concurrent-skipped.spec.ts        NEW (TC-M14)
└── all-pages-a11y.spec.ts                       MODIFIED (add 3 new surfaces)

lib/i18n/messages/
├── en.json                          MODIFIED (matches.* namespace added)
├── es.json                          MODIFIED (matches.* namespace added)
└── pt-BR.json                       MODIFIED (matches.* namespace added)

lib/i18n/__tests__/
├── format-kickoff.test.ts           NEW (pure-helper unit tests)
├── day-bucket.test.ts               NEW (cross-TZ day boundary unit tests)
└── lock-badge.test.ts               NEW (boundary + status enum unit tests)
```

**Structure Decision**: Web application — the existing Next.js + Supabase layout from feature 001 carries forward. Feature 002 adds a new top-level concept (`matches`) but reuses every machinery layer (auth, RLS, audit, i18n, testing) established in 001. No new packages, no monorepo refactor.

---

## Phase 0: Outline & Research

Unknowns to resolve before writing the data model and contracts:

1. **R-1 — football-data.org v4 response shape**: What fields does `/v4/competitions/WC/matches` actually return? Are status enum values stable? Are kickoffs always UTC? What pagination model? What rate-limit response headers? Need a frozen sample response to drive the normaliser design.
2. **R-2 — IANA timezone picker library choice**: ~400 IANA zones is too many for a native `<select>`. Options: `react-timezone-select`, `react-aria-components` Combobox, hand-rolled combobox from `<input>` + filtered `<datalist>`. Pick one balancing bundle size, a11y, and Tailwind-friendliness.
3. **R-3 — Edge Function: Deno fetch retry pattern**: What's the canonical exponential-backoff implementation for Deno that respects football-data.org's `Retry-After` header on 429s? Are there battle-tested helpers we should use instead of hand-rolling?
4. **R-4 — Postgres advisory lock pattern for Edge Functions**: Does `pg_try_advisory_lock` work cleanly from a Supabase Edge Function via the service-role HTTP client (PostgREST)? Or do we need a session-bound `pg_advisory_lock` via a raw connection? Confirm before designing FR-M23.
5. **R-5 — Next.js `revalidate: 60` semantics in App Router 15**: How does `revalidate` interact with Server Components reading from supabase (which is dynamic by default)? Do we need `export const revalidate = 60` at the page level, `unstable_cache` wrappers, or both?
6. **R-6 — Day-bucket label formatting in Intl**: How do `Intl.DateTimeFormat` + `Intl.RelativeTimeFormat` interact for "Today" / "Tomorrow" / "Yesterday" / explicit-weekday labels in en/es/pt-BR? Any gotchas around DST boundary days?
7. **R-7 — Concurrent sync from cron + admin click**: Confirm the timing model — pg_cron triggers a database function that calls the Edge Function via http; admin click hits the Edge Function directly. Both compete for the same advisory lock. Plan how telemetry distinguishes them.

Each item gets a `## R-N` block in `research.md` with Decision / Rationale / Alternatives. No NEEDS CLARIFICATION items remain after R-1 through R-7 close.

**Output**: `research.md` (Phase 0)

---

## Phase 1: Design & Contracts

**Prerequisites**: `research.md` complete.

### Artifacts produced

1. **`data-model.md`** — Schema definitions for `teams`, `matches`, `integration_runs`; the `participants.timezone` column extension; status enums + check constraints; RLS policies in human-readable form; the `lock_badge_state(kickoff_utc, status, now())` SQL helper function (if R-1 confirms we want it server-side rather than only in TS).

2. **`contracts/`** — RPC + HTTP contracts:
   - `set_timezone(text)` RPC contract (first-sign-in helper)
   - `update_timezone(text)` RPC contract (profile editing)
   - `trigger_match_sync()` admin RPC contract (gated on `is_admin_user()`)
   - `POST /functions/v1/sync-matches` Edge Function HTTP contract (request shape, response shape, `outcome: success | error | skipped`)
   - Sample PostgREST queries Server Components will issue (for documentation, not enforcement)

3. **`quickstart.md`** — Step-by-step local dev setup for feature 002: env vars (`FOOTBALL_DATA_API_KEY`), bootstrap import command, how to hand-seed a few matches without the provider, how to test admin re-sync locally, how to verify the advisory lock with two concurrent `curl` invocations.

4. **Stack constitution update** — Add to `constitution-backend.md` §I.1: Deno Edge Function runtime row + football-data.org v4 client row + pg_cron (Phase-5 scheduling) row. Add to `constitution-frontend.md` §I.1: IANA timezone picker library row (whichever R-2 picks).

### Phase 1 design moves (informing the artifacts above)

- **Lock-badge derivation**: pure function in `lib/matches/lock-badge.ts` taking `(kickoff_utc, status, now_utc)` and returning `'UPCOMING' | 'LOCKED' | 'FINISHED'`. Same logic mirrored as a SQL helper if R-1 reveals we need to filter the dashboard widget query by badge state in SQL.
- **Day-bucket label**: pure function in `lib/matches/day-bucket.ts` taking `(kickoff_utc, participant_tz, locale, now_utc)` and returning `{ bucketKey: string, bucketLabel: string }`. Used for both grouping and label rendering. Unit-tested with cross-TZ pairs from TC-M9.
- **Format kickoff**: pure function `lib/matches/format-kickoff.ts` wrapping `Intl.DateTimeFormat` with the participant's `timeZone` + the request's locale. Tested in `lib/i18n/__tests__/format-kickoff.test.ts`.
- **Server Component caching**: page-level `export const revalidate = 60` on `/matches`, `/matches/[id]`, and the dashboard route (after R-5 confirms semantics for Supabase reads). Per-row badge state is recomputed on render (not cached), so the cache holds the raw match rows while badges stay live.
- **Edge Function lifecycle**: `sync-matches` accepts `POST` with optional `{ action: 'bootstrap' | 'incremental' | 'manual' }` (defaults to `incremental`). Service-role-keyed; not callable from the browser. Admin RPC `trigger_match_sync()` issues an `http` POST to the function URL (uses Supabase's `pg_net` extension or similar — R-4 / R-7 decide).
- **Provider abstraction**: `provider/football-data-v4.ts` exports a `fetchMatches()` function returning a normalised `MatchRow[]`. Future providers slot in by implementing the same interface; the sync core only sees normalised rows.

### Re-evaluate Constitution Check post-design

(Performed after Phase 1 artifacts land — see "Post-design re-check" section below at the bottom of this plan once research.md + data-model.md + contracts/ are written. Expected: all checks still ✓ with no new violations.)

**Output**: `data-model.md`, `contracts/*`, `quickstart.md`, updated stack constitution.

---

## Phase 2: Task Planning Approach

*This section describes what `/ai1st-dev-tasks` will do — DO NOT execute during /plan.*

**Task Generation Strategy**:

- Load `.ai/2_templates/tasks-template.md` as base.
- Generate tasks from Phase 1 design docs (contracts, data-model, plus the source-code tree above).
- Each migration → one task (T-DB-N); migrations 0011→0017 enforce order via the natural ordering.
- Each pgTAP file → one task tagged [DB][TEST].
- Each RPC → one task in `0015_match_rpcs.sql` plus a contract-aligned pgTAP test.
- Each Server Component / Client Component → one task tagged [UI].
- Each pure helper in `lib/matches/` → one task plus its `__tests__` Jest spec (tagged [UI][TEST]).
- Each Playwright spec (TC-M1 through TC-M14) → one task tagged [TEST]; mark [P] where independent.
- Edge Function `sync-matches` → one task tagged [INT] plus its pgTAP idempotency tests.
- i18n keys (matches.* namespace) → one task per locale (3 in parallel) tagged [UI].
- README + dod-verification refresh → final-phase task tagged [INT].

**Ordering Strategy**:

- Migrations first (DB layer is the foundation; types regenerated after).
- pgTAP tests for RLS + idempotency next (lock down DB invariants).
- Pure helpers + their Jest tests (no UI dependency, can run in parallel via [P]).
- Server Components (read path) — depend on regenerated types + helpers.
- Client Components — depend on Server Components for prop shapes.
- Playwright specs last per surface (each depends on the surface existing).
- Edge Function can run in parallel with the UI track once its RPC contract is written.

**Estimated Output**: ~35–45 tasks in `tasks.md`. (Feature 001 was 80; feature 002 is smaller because all the auth + i18n + audit + a11y machinery already exists.)

**IMPORTANT**: This phase is executed by `/ai1st-dev-tasks`, NOT by `/ai1st-dev-plan`.

---

## Dependencies Analysis

### Prerequisites

*What must exist before this feature can be implemented.*

| Dependency | Source | Status | Notes |
|---|---|---|---|
| Authenticated participant + RLS + audit machinery | Feature 001 (PR #2) | Required | Branched off `001-authentication-and-participant`; merges to `main` first or rebases on merge. |
| Supabase local stack with citext + auth schema | Feature 001 migrations 0001–0010 | Required | `npx supabase db reset` brings them in along with feature 002's new ones. |
| Existing `/profile` page + `update_display_name` RPC pattern | Feature 001 | Required | `TimezonePicker` mirrors `DisplayNameForm` structure; `update_timezone` mirrors `update_display_name`. |
| Existing audit trigger | Feature 001 migration 0005 | Required | Already fires `participant.updated` on any column change → covers FR-M16 with zero new SQL. |
| Hand-rolled Accept-Language detection + i18n namespace pattern | Feature 001 ADR-013 + constitution-frontend.md | Required | New `matches.*` namespace added; no new locale machinery. |
| football-data.org API key | Nortal IT | Required for production | Local dev can hand-seed a few matches without the key (see quickstart.md). |
| Vercel deployment + Supabase Cloud Pro tier | Architecture §"Delivery Roadmap" | Required for staging+ | Local dev and CI work with the local Supabase stack alone. |

### Provides (to other features)

*What this feature enables for downstream use cases.*

| Output | Used By | Description |
|---|---|---|
| `matches` table + lock-badge helper | Feature 003 (predictions write path) | Predictions reference `matches.id`; the prediction-form lock decision can reuse `lib/matches/lock-badge.ts` (or its SQL twin) for display, while the *authoritative* `lock_prediction()` RPC checks server time directly. |
| `participants.timezone` column + RPC pair | All future participant-facing features | Any future feature that displays datetimes (notifications, leaderboard refresh times, prediction edit history) gets locale-aware rendering for free. |
| `integration_runs` table | Future provider integrations | Reusable telemetry schema; e.g. when we add a leaderboard-snapshot sync or notification dispatch, telemetry lands in the same table. |
| `sync-matches` Edge Function pattern | Future scheduled integrations | Provides the working template for Deno + advisory-lock + provider-abstracted sync; e.g. final-prediction results sync (top scorer, best player) can clone the structure. |
| Dashboard widget pattern | Future dashboard surfaces | `UpcomingMatchesWidget` slots into the same dashboard container any future widget (e.g. "Your rank: 5") can mount alongside. |

---

## Work Streams

### Stream Definitions

| Stream | Tag | Scope | Typical Executor |
|---|---|---|---|
| Database | [DB] | Migrations 0011–0017, pgTAP tests, RLS policies, RPCs | Direct edits / Agent for migrations |
| Backend integration | [INT] | Edge Function, provider abstraction, advisory lock, integration_runs writes | Agent via subagent dispatch |
| Frontend UI | [UI] | Pages, components, pure helpers, i18n keys, Jest unit tests | Agent dispatched [P] for independent components |
| End-to-end testing | [TEST] | Playwright specs TC-M1..TC-M14, accessibility sweep additions | Agent dispatched [P] for independent specs |
| Integration | [I] | README updates, dod-verification refresh, final pristine sweep | Direct + Agent |

### Active Streams for This Feature

- [x] **[DB]** — 7 new migrations, 4 new pgTAP files, RLS for 3 tables
- [x] **[INT]** — `sync-matches` Edge Function + provider abstraction + advisory lock
- [x] **[UI]** — 2 new pages, 1 modified page, ~8 components, 3 pure helpers, 3 i18n namespace additions
- [x] **[TEST]** — 11 new Playwright specs + 3 new Jest unit specs + a11y sweep extension
- [ ] **[INFRA]** — None (cron schedule lands in Phase 5)
- [x] **[I]** — README + dod-verification.md for feature 002

### Stream Dependencies

- [UI] depends on [DB] for: regenerated `lib/supabase/database.types.ts` after migrations apply
- [TEST] depends on: [UI] and [INT] implementations
- [INT] depends on [DB] for: `integration_runs` schema + advisory-lock pattern; [UI] depends on [INT] for the admin re-sync UX path
- [I] depends on: every other stream completing

---

## Complexity Tracking

*No constitution violations.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(none)* | — | — |

---

## Use Case Specific NFRs

*Extracted from spec.md §4 NFR-M1..NFR-M6 and consolidated for traceability.*

### Performance

| Requirement | Target | Measurement |
|---|---|---|
| Initial `/matches` render | < 1 second on warm cache | Manual Lighthouse check + Playwright timing assertion in `matches-browse.spec.ts` |
| Dashboard widget render | < 1 second on warm cache (same render path) | Implicit (existing dashboard spec assertion still holds) |

### Reliability

| Requirement | Target | Measurement |
|---|---|---|
| Read-path tolerance to Supabase blip | ≤ 60s outage transparent (NFR-M6) | Manual: stop local supabase for 30s while page reloads; visual confirmation |
| Provider sync idempotency | 0 duplicate matches after N re-runs (NFR-M5 + FR-M20) | `match-sync-idempotent.spec.ts` (TC-M13) |
| Concurrent sync handling | 0 double-fetches of provider (FR-M23) | `match-sync-concurrent-skipped.spec.ts` (TC-M14) |

### Accessibility

| Requirement | Target | Measurement |
|---|---|---|
| All new surfaces | WCAG 2.1 AA, zero axe-core violations | `all-pages-a11y.spec.ts` extension covering 3 new surfaces |

### Scalability

| Requirement | Target | Measurement |
|---|---|---|
| Catalog query | All 104 rows in one query, no pagination | Schema constraint + Playwright assertion on `matches-browse.spec.ts` (104 rows expected) |
| Provider rate budget | ≤ 10 req/min (free tier) | Edge Function self-throttles; verified in `match-sync-admin.spec.ts` log assertion |

---

## Acceptance Criteria

### BRD Traceability

*BRD references: FR-004 (Match catalog), FR-017 (Data synchronization), BR-LOCK-001/002/003/006 — all from `docs/architecture/high-level-architecture.md` (Approved 2026-05-15).*
*This project has no design-system.md or Figma references; design ships with implementation.*

### Catalog read path

- [FR-M01] System maintains a 104-row match catalog with provider id, both teams, stage, group, kickoff UTC, status, score fields {Source: FR-004}
- [FR-M02] System maintains the team catalog with display name + FIFA code + provider team id {Source: AI/Specify}
- [FR-M04] Authenticated participants can browse `/matches` grouped by day in their stored TZ {Source: AI/Specify}
- [FR-M05] `/matches` supports stage/group/team filters via URL searchParams, shareable as links {Source: AI/Specify}
- [FR-M06] `/matches/[id]` detail page shows teams, stage, group, kickoff, status, badge, score (if finished) {Source: AI/Specify}
- [FR-M07] Kickoff times rendered in participant's stored TZ with locale-appropriate formatting {Source: AI/Specify, BR-LOCK-006}
- [FR-M11] Final score displayed when `status='finished'` {Source: AI/Specify}
- [FR-M12] Dashboard "Upcoming matches" widget renders next 3 matches by kickoff ASC, replaces empty-state {Source: AI/Specify}
- [FR-M17] Day grouping uses participant TZ; bucket labels localised "Today"/"Tomorrow"/explicit weekday {Source: AI/Specify}

### Lock state + countdown

- [FR-M08] Lock-state badge derived (never stored) — UPCOMING / LOCKED / FINISHED computed from kickoff + now + status {Source: AI/Specify, BR-LOCK-001/002/003}
- [FR-M09] Server-rendered countdown text on list + dashboard match cards {Source: AI/Specify}
- [FR-M10] Client-side ticking countdown on `/matches/[id]` flips badge at boundary without page refresh {Source: AI/Specify, BR-LOCK-001}
- [NFR-M2] All lock decisions use server-side trusted time only {Source: BR-LOCK-001}

### Timezone handling

- [FR-M13] `participants.timezone` column (NOT NULL default 'UTC', IANA string) {Source: AI/Specify}
- [FR-M14] Auto-detect TZ on first sign-in via `set_timezone` RPC from Client Component {Source: AI/Specify}
- [FR-M15] `/profile` TZ selector + `update_timezone` RPC {Source: AI/Specify}
- [FR-M16] TZ changes audited via existing participant.updated trigger {Source: AI/Specify}
- [NFR-M4] All timestamps stored UTC; render-time TZ shift {Source: BR-LOCK-006}

### Provider sync + telemetry

- [FR-M03] Integration with football-data.org v4 via Edge Function (provider-agnostic abstraction) {Source: FR-017}
- [FR-M18] Admin re-sync action callable via RPC (gated on `is_admin_user()`) {Source: FR-017}
- [FR-M19] Sync attempts logged to `integration_runs` (start/finish/status/records/error) {Source: AI/Specify}
- [FR-M20] Sync is idempotent — re-running with unchanged data produces 0 changes {Source: AI/Specify}
- [FR-M23] Concurrent sync invocations serialised via Postgres advisory lock; second caller short-circuits with `skipped` status {Source: AI/Clarify}
- [NFR-M5] Stays within 10 req/min provider rate limit; exponential backoff on transient failures {Source: AI/Specify}

### Security + RLS

- [FR-M22] RLS: matches/teams SELECT gated on `is_eligible_nortal_user()`; integration_runs SELECT gated on `is_admin_user()`; no authenticated-role write policies {Source: AI/Clarify}

### Quality

- [NFR-M1] `/matches` initial render < 1 second on warm cache {Source: AI/Specify}
- [NFR-M3] WCAG 2.1 AA across all new surfaces (zero axe-core violations) {Source: AI/Specify}
- [NFR-M6] Read-path uses Next.js `revalidate: 60` so sub-minute Supabase outage serves stale instead of erroring {Source: AI/Clarify}

### i18n

- [FR-M21] All match-page UI strings (page headings, day labels, stage names, group labels, status badges, lock badges, countdown text, empty states, TZ selector labels, validation messages) translated to en / es / pt-BR {Source: FR-A8 extended}

---

## Post-design Constitution Re-check

*Performed 2026-05-20 after research.md, data-model.md, contracts/, and quickstart.md landed.*

**Status**: **PASS** — no new violations; all Pre-design checks remain ✓.

**Design choices re-validated against the constitutions:**

| Pre-design check | Post-design evidence |
|---|---|
| §1.1 Modular monolith with DB-enforced rules | RLS (FR-M22) + advisory lock (FR-M23) + status check constraints all enforced in Postgres per data-model.md; UI never owns authoritative lock state. |
| §1.3 No silent failures | `integration_runs` is the structured log; Edge Function records every outcome (success/error/skipped); RPC contracts in `contracts/` all raise typed Postgres EXCEPTIONs. |
| §2 service_role never in client | Edge Function (Deno, server-side); admin RPC paths verified in `contracts/rpc-trigger-match-sync.md` + `edge-sync-matches.md` (both require service-role auth). |
| §4 Testing — pgTAP + Jest + Playwright + pristine | Test obligations enumerated in every contract; quickstart.md §8 walks the full suite. |
| Frontend §IV.1 Server Components by default | Server Component / Client Component split documented in plan.md §"Project Structure"; only 3 Client Components (TimezoneAutoDetect, TimezonePicker, LockCountdownTicker), each justified by interactive state or per-second ticking. |
| Frontend §I.1 i18n via hand-rolled Accept-Language (ADR-013) | Confirmed in research.md R-6: 3 new keys (`matches.today`, `matches.tomorrow`, `matches.yesterday`) added to the existing `matches.*` namespace; no new locale machinery. |
| Backend §I.1 Stack | Constitution updated 2026-05-20 with the new `pg_net`, advisory-lock, Deno Edge runtime, and football-data.org v4 rows. |
| Backend §VI Security — RLS on all reads | RLS policies in data-model.md §"RLS policies" cover all three new tables with explicit `is_eligible_nortal_user()` / `is_admin_user()` predicates. |
| Backend §IX Anti-patterns — no provider raw in user tables | Normaliser in `provider/football-data-v4.ts` produces typed `MatchRow[]` / `TeamRow[]`; provider raw JSON never lands in user-facing tables. Raw payloads optionally retained in `integration_runs.error_message` for debugging only. |

**New surface introduced post-design that warranted a constitution add:**
- Deno Edge Function runtime (`supabase/functions/sync-matches/`) — added to constitution-backend.md §I.1 as "Edge runtime" row.
- `pg_net` extension — added to constitution-backend.md §I.1 as "Extensions" row (conditional on Pro tier).
- Postgres advisory locks — added to constitution-backend.md §I.1 as "Concurrency primitive" row.
- football-data.org v4 — added to constitution-backend.md §I.1 as "External provider" row.
- Hand-rolled IANA timezone combobox — added to constitution-frontend.md §I.1 as "Timezone picker UI" row.
- Next.js `revalidate: 60` ISR pattern — added to constitution-frontend.md §I.1 as "Read-path caching" row.

**Violations found**: None.
**Remediation**: N/A.

**Ready for `/ai1st-dev-tasks`**.

---

*Based on Constitution — see `.ai_project_memory/constitution.md`.*
