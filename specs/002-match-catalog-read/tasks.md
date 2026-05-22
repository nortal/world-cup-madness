# Tasks: Match Catalog (Read Path)

**Feature**: 002-match-catalog-read
**Input**: `specs/002-match-catalog-read/` — plan.md (required), spec.md, research.md, data-model.md, contracts/, quickstart.md
**Generated**: 2026-05-20 via `/ai1st-dev-tasks`

## Overview

Tasks are organised into 6 phases:

- **Phase 1** — Setup (env + tooling)
- **Phase 2** — Foundational (schema, RPCs, RLS, pure helpers, i18n; blocks every user story)
- **Phase 3** — US-MA: participant catalog browse path
- **Phase 4** — US-MB: timezone auto-detect + profile selector
- **Phase 5** — US-MC: admin provider sync (Edge Function + telemetry + advisory lock)
- **Final Phase** — Polish (a11y sweep, pristine test sweep, DoD verification, README)

User stories are independent at the implementation layer (each story can be developed + tested + demoed without the others) but share the foundational schema. A reasonable **MVP scope is US-MA + Phase 2** (browse path works against a hand-seeded catalog; admin sync deferred).

Tests are integrated per phase per the AI-Kit convention (each user story produces both implementation and the TC-MX Playwright spec that validates it).

**Total tasks**: 47.

---

## Phase 1 — Setup

- [x] T001 Create the new feature directory tree: `mkdir -p project-repos/world-cup-madness/{components/matches,lib/matches,lib/matches/__tests__,supabase/functions/sync-matches/{provider,lib,__fixtures__}}`
- [x] T002 Add the `FOOTBALL_DATA_API_KEY` placeholder to `project-repos/world-cup-madness/.env.example` with a comment explaining fixture-mode fallback (`SYNC_FIXTURE_MODE=1` for local dev without a key)

---

## Phase 2 — Foundational (BLOCKS every user story)

### Schema migrations

- [x] T003 Migration `project-repos/world-cup-madness/supabase/migrations/0011_create_teams.sql` per `data-model.md` §teams — UUID PK, name, tla (UNIQUE + length=3 check), provider_team_id (UNIQUE), created_at; no RLS yet
- [x] T004 Migration `project-repos/world-cup-madness/supabase/migrations/0012_create_matches.sql` per `data-model.md` §matches — full column set, status check constraint (5 values), kickoff-status compatibility check, all indexes (`provider_id` UNIQUE, `kickoff_utc ASC NULLS LAST`, `(stage, kickoff_utc)`, `home_team_id`, `away_team_id`); no RLS yet
- [x] T005 Migration `project-repos/world-cup-madness/supabase/migrations/0013_create_integration_runs.sql` per `data-model.md` §integration_runs — BIGSERIAL PK, provider/action/status check constraints, records_processed + records_unchanged NOT NULL default 0, indexes on `started_at DESC` and `(action, status, started_at DESC)`; no RLS yet
- [x] T006 Migration `project-repos/world-cup-madness/supabase/migrations/0014_add_participants_timezone.sql` — `ALTER TABLE participants ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'` + `participants_timezone_nonempty` CHECK constraint (length > 0 AND no whitespace)
- [x] T007 Migration `project-repos/world-cup-madness/supabase/migrations/0015_match_rpcs.sql` containing all four RPCs per `contracts/`: `set_timezone(text)`, `update_timezone(text)`, `trigger_match_sync()`, `acquire_match_sync_lock()` — each SECURITY DEFINER with explicit REVOKE FROM PUBLIC + targeted GRANT (`authenticated` for set/update, `authenticated` with internal `is_admin_user()` check for trigger, `service_role` only for acquire-lock)
- [x] T008 Migration `project-repos/world-cup-madness/supabase/migrations/0016_match_rls.sql` — `ENABLE ROW LEVEL SECURITY` on teams/matches/integration_runs; SELECT policies `teams_select_eligible`, `matches_select_eligible` gated on `is_eligible_nortal_user()`; SELECT policy `integration_runs_select_admin` gated on `is_admin_user()`; no INSERT/UPDATE/DELETE policies for `authenticated`
- [x] T009 Migration `project-repos/world-cup-madness/supabase/migrations/0017_seed_teams.sql` — INSERT 48 FIFA WC 2026 confirmed-qualifier teams (or N teams known at seed time) using ON CONFLICT (provider_team_id) DO NOTHING; values sourced from the frozen `__fixtures__/v4-sample.json` so the seed is reproducible without a live API key

### Generated types

- [x] T010 Regenerate `project-repos/world-cup-madness/lib/supabase/database.types.ts` via `npx supabase gen types typescript --local` after running `npx supabase db reset`; commit the regenerated file alongside the migrations

### pgTAP tests (DB invariants)

- [x] T011 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/006_rls_matches.sql` — verify SELECT policies for matches + teams: eligible-tenant participant sees rows; ineligible-tenant returns zero; anon role denied; no INSERT/UPDATE/DELETE policies present for `authenticated`
- [x] T012 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/007_rls_integration_runs.sql` — verify SELECT policy for integration_runs: admin role sees rows; non-admin authenticated sees zero; no write policies
- [x] T013 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/008_match_rpcs.sql` — `set_timezone` happy path + one-shot semantics + validation cases per `contracts/rpc-set-timezone.md` §"Test obligations"; `update_timezone` same per `contracts/rpc-update-timezone.md`; `trigger_match_sync` non-admin rejection per `contracts/rpc-trigger-match-sync.md`
- [x] T014 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/009_sync_idempotency.sql` — direct-DB-side invocation harness using fixture mode: assert idempotency contract (run-twice → 0 changes, `records_processed = records_unchanged`); assert advisory-lock contention path writes a `skipped` integration_runs row

### Pure helpers + Jest unit tests

- [x] T015 [P] Implement `project-repos/world-cup-madness/lib/matches/lock-badge.ts` — pure function `lockBadgeState(kickoffUtc, status, nowUtc): 'UPCOMING' | 'LOCKED' | 'FINISHED'` per FR-M08 derivation rules
- [x] T016 [P] Jest unit test `project-repos/world-cup-madness/lib/matches/__tests__/lock-badge.test.ts` — boundary cases (kickoff = now + 60min exactly, ±1s either side); status mapping for all 5 enum values; null kickoff for `scheduled-tbd`
- [x] T017 [P] Implement `project-repos/world-cup-madness/lib/matches/day-bucket.ts` — pure function `dayBucket(kickoffUtc, participantTz, locale, nowUtc): { bucketKey, bucketLabel, offsetFromToday }` per research.md R-6
- [x] T018 [P] Jest unit test `project-repos/world-cup-madness/lib/matches/__tests__/day-bucket.test.ts` — cross-TZ day-boundary cases (TC-M9 pair: Tallinn vs São Paulo for a 23:00 UTC Saturday kickoff); "Today" / "Tomorrow" / "Yesterday" offset labels in en/es/pt-BR; DST boundary day handling
- [x] T019 [P] Implement `project-repos/world-cup-madness/lib/matches/format-kickoff.ts` — pure function `formatKickoff(kickoffUtc, participantTz, locale): string` wrapping `Intl.DateTimeFormat` with `{ timeZone, hour, minute, weekday, month, day, year }` shape per locale conventions
- [x] T020 [P] Jest unit test `project-repos/world-cup-madness/lib/matches/__tests__/format-kickoff.test.ts` — en/es/pt-BR formatting; null kickoff handling; invalid TZ fallback to UTC + structured warning
- [x] T021 [P] Generate the static IANA timezone list at `project-repos/world-cup-madness/lib/matches/iana-timezones.ts` — exports `IANA_TIMEZONES: readonly string[]` from `Intl.supportedValuesOf('timeZone')`, with a Node script in `scripts/regen-iana-timezones.mjs` to refresh when the runtime tz db updates

### i18n keys

- [x] T022 [P] Add `matches.*` namespace keys (page headings, day labels Today/Tomorrow/Yesterday, stage names, group labels, status badges UPCOMING/LOCKED/FINISHED, countdown text, empty-state messages, filter chip labels, dashboard widget heading, view-all link) to `project-repos/world-cup-madness/lib/i18n/messages/en.json`
- [x] T023 [P] Mirror the same `matches.*` keys with Spanish translations to `project-repos/world-cup-madness/lib/i18n/messages/es.json` (informal tú register, Latin-American football vocabulary: "Por hoy", "Grupo A", "Pronto", "Bloqueado", "Finalizado")
- [x] T024 [P] Mirror the same `matches.*` keys with Brazilian Portuguese translations to `project-repos/world-cup-madness/lib/i18n/messages/pt-BR.json` (informal você register: "Hoje", "Amanhã", "Em breve", "Bloqueado", "Finalizado", "artilheiro")
- [x] T025 [P] Add `profile.timezone*` keys (label, helper text, validation messages, success toast) for the new TimezonePicker on `/profile` to all three locale files
- [x] T026 Run `npm test` (Jest) to confirm helpers + Jest 25+ existing tests still pristine; run `npx supabase db test test/pgtap/*.sql` to confirm pgTAP 63+ existing + 4 new files all pass

---

## Phase 3 — US-MA: Participant browses the match catalog

**Story goal**: An authenticated participant can browse all 104 matches at `/matches` grouped by day in their stored TZ, filter by stage / group / team via URL, drill into `/matches/[id]` for detail + ticking countdown, see final scores on completed matches, and glance at the next 3 upcoming on the dashboard widget.

**Independent test criteria**: TC-M1 through TC-M6, TC-M10, TC-M12, TC-M13. Story passes when all eight Playwright specs are green with the catalog hand-seeded (admin sync still mocked / fixture-loaded).

**Implementation tasks**

- [x] T027 [US-MA] Implement `project-repos/world-cup-madness/components/matches/LockBadge.tsx` (Server Component) — renders the badge text + color per `lockBadgeState()` return; accepts `kickoffUtc`, `status`, `nowUtc` props
- [x] T028 [P] [US-MA] Implement `project-repos/world-cup-madness/components/matches/LockCountdownText.tsx` (Server Component) — renders "Locks in 2h 14m" style text; reads localised strings from `useTranslations('matches')`
- [x] T029 [P] [US-MA] Implement `project-repos/world-cup-madness/components/matches/MatchCard.tsx` (Server Component) — single match row for list view; renders home/away teams (name + tla), kickoff in participant TZ, group label (if any), `<LockBadge/>` + `<LockCountdownText/>`, or final score if `status='finished'`; links to `/matches/[id]`
- [x] T030 [P] [US-MA] Implement `project-repos/world-cup-madness/components/matches/MatchFilters.tsx` (Server Component) — filter chips reading from URL `searchParams` (`stage`, `group`, `team`); renders active chips with clear-affordance; submits filter changes via Next.js Link with merged searchParams
- [x] T031 [US-MA] Implement `project-repos/world-cup-madness/app/(participant)/matches/page.tsx` (Server Component) — page-level `export const revalidate = 60`; reads participant TZ + locale; queries matches with the JOIN-teams query from `contracts/edge-sync-matches.md` §"Sample PostgREST queries"; groups by day via `dayBucket()`; renders `<MatchFilters/>` + day buckets of `<MatchCard/>`; localised page heading + empty-state
- [x] T032 [US-MA] Implement `project-repos/world-cup-madness/components/matches/LockCountdownTicker.tsx` (Client Component) — `'use client'`; accepts `initialKickoffMs`, `initialNowMs`, `initialBadge` props; runs a `setInterval` per second; computes `remaining = initialKickoffMs - (Date.now() - initialNowMs * <implied>)` style hydration math; flips badge to `LOCKED` at 0; cleans up interval on unmount; uses `aria-live='polite'` per UX considerations
- [x] T033 [US-MA] Implement `project-repos/world-cup-madness/components/matches/MatchDetailCard.tsx` (Server Component) — full detail surface for one match: both teams with name + tla, stage, group (if any), venue (if any), kickoff (formatted), status, final score (if finished); embeds `<LockBadge/>` + `<LockCountdownTicker/>` (Client, gets server-computed initial values)
- [x] T034 [US-MA] Implement `project-repos/world-cup-madness/app/(participant)/matches/[id]/page.tsx` (Server Component) — page-level `export const revalidate = 60`; reads participant TZ + locale; fetches single match via PostgREST JOIN query; 404s on missing; renders `<MatchDetailCard/>` plus a "Back to matches" link
- [x] T035 [P] [US-MA] Implement `project-repos/world-cup-madness/components/matches/UpcomingMatchesWidget.tsx` (Server Component) — runs the dashboard widget query from `contracts/edge-sync-matches.md` (LIMIT 3, ordered by `kickoff_utc ASC`, `status='scheduled' AND kickoff > now() + INTERVAL '60min'`); renders 3 `<MatchCard/>` instances + a "View all matches" link; empty-state when fewer than 3 upcoming
- [x] T036 [US-MA] Modify `project-repos/world-cup-madness/app/(participant)/dashboard/page.tsx` — replace the existing empty-state placeholder (the `<section aria-labelledby="upcoming-matches-heading">` block from feature 001) with `<UpcomingMatchesWidget/>`; preserve the `<AdminNavLink/>` and welcome modal mounting from feature 001

**Test tasks**

- [x] T037 [P] [US-MA] Playwright test `project-repos/world-cup-madness/e2e/tests/matches-browse.spec.ts` covering TC-M1 (104 matches grouped by day) and TC-M2 (`?stage=round-of-16` filter applies and is shareable)
- [x] T038 [P] [US-MA] Playwright test `project-repos/world-cup-madness/e2e/tests/matches-detail-countdown.spec.ts` covering TC-M3 (detail page renders all fields including ticker) and TC-M4 (UPCOMING badge with countdown when kickoff > 60min away)
- [x] T039 [P] [US-MA] Playwright test `project-repos/world-cup-madness/e2e/tests/matches-lock-badge-boundary.spec.ts` covering TC-M5 (LOCKED badge at kickoff − 60min and sooner) — uses fixture-mode catalog seeded with three matches at +59min, +60min, +61min from `now`
- [x] T040 [P] [US-MA] Playwright test `project-repos/world-cup-madness/e2e/tests/matches-final-score.spec.ts` covering TC-M6 (FINISHED badge + final score display)
- [x] T041 [P] [US-MA] Playwright test `project-repos/world-cup-madness/e2e/tests/dashboard-upcoming-widget.spec.ts` covering TC-M10 (next 3 upcoming with lock-state badges, replaces empty state)
- [x] T042 [P] [US-MA] Playwright test `project-repos/world-cup-madness/e2e/tests/matches-i18n.spec.ts` covering TC-M12 (`/matches`, `/matches/[id]`, dashboard widget render in en / es / pt-BR per Accept-Language; kickoff formatting follows locale conventions)

---

## Phase 4 — US-MB: Timezone auto-detect + profile selector

**Story goal**: New participants get their browser TZ auto-detected and persisted on first sign-in; existing participants can change their TZ via a searchable selector on `/profile`; day grouping on `/matches` follows the participant's stored TZ.

**Independent test criteria**: TC-M7, TC-M8, TC-M9. Story passes when all three Playwright specs are green and a manually-tested TZ change from `/profile` is visible on the next `/matches` load.

**Implementation tasks**

- [x] T043 [US-MB] Implement `project-repos/world-cup-madness/components/matches/TimezoneAutoDetect.tsx` (Client Component) — `'use client'`; mounts in dashboard page; on first mount only when `participant.timezone === 'UTC'`, reads `Intl.DateTimeFormat().resolvedOptions().timeZone` and calls `supabase.rpc('set_timezone', { p_timezone: detected })`; structured `console.error` on failure (closes without retry; next sign-in will re-attempt); renders no DOM (returns null)
- [x] T044 [US-MB] Modify `project-repos/world-cup-madness/app/(participant)/dashboard/page.tsx` to mount `<TimezoneAutoDetect/>` conditionally — pass the participant's current `timezone` value down so the Client Component can decide whether to fire (NOT NULL means we always have a value; check `=== 'UTC'`)
- [x] T045 [US-MB] Implement `project-repos/world-cup-madness/components/profile/TimezonePicker.tsx` (Client Component) — hand-rolled WAI-ARIA combobox per research.md R-2; reads IANA list from `lib/matches/iana-timezones.ts`; input filters by substring match (case-insensitive); listbox renders matches up to a max of 50 with virtualisation-free clipping for the rest; Tab/Shift+Tab focus management; calls `supabase.rpc('update_timezone', { p_timezone: value })` on Save; success toast via `role='status'` (mirroring `DisplayNameForm`); error banner via `role='alert'`
- [x] T046 [US-MB] Modify `project-repos/world-cup-madness/app/(participant)/profile/page.tsx` — mount `<TimezonePicker initialValue={participant.timezone}/>` below the existing `<DisplayNameForm/>`; preserve the `<dl>` email row + heading

**Test tasks**

- [x] T047 [P] [US-MB] Playwright test `project-repos/world-cup-madness/e2e/tests/timezone-auto-detect.spec.ts` covering TC-M7 (sign in as new user → `set_timezone` RPC fires once on first dashboard mount → participants.timezone reflects the browser's detected TZ → second mount is a no-op)
- [x] T048 [P] [US-MB] Playwright test `project-repos/world-cup-madness/e2e/tests/timezone-profile-override.spec.ts` covering TC-M8 (sign in, navigate `/profile`, change TZ, save, audit_log has `participant.updated` with old/new TZ, dashboard reflects new TZ on next load)
- [x] T049 [P] [US-MB] Playwright test `project-repos/world-cup-madness/e2e/tests/day-grouping-cross-tz.spec.ts` covering TC-M9 (two participants with different stored TZ see the same kickoff under different day buckets) — uses two `browser.newContext()` pairs each with `signInAs({ tenant: 'eligible', email: <unique> })` and a service-role-set TZ

---

## Phase 5 — US-MC: Admin provider sync

**Story goal**: An admin can trigger a fresh catalog sync from football-data.org; the sync is idempotent (no duplicates on re-run); concurrent invocations are serialised via Postgres advisory lock (the second caller short-circuits with `skipped` telemetry); all attempts are logged to `integration_runs` for operational visibility.

**Independent test criteria**: TC-M11, TC-M13, TC-M14. Story passes when all three Playwright specs are green and a manually-triggered fixture-mode bootstrap import populates 104 rows.

**Implementation tasks**

- [x] T050 [US-MC] Implement `project-repos/world-cup-madness/supabase/functions/sync-matches/lib/retry.ts` — exponential backoff helper per research.md R-3 with Retry-After header respect, 5-retry cap, jitter, returns final response or throws on exhaustion
- [x] T051 [US-MC] Add the frozen sample `project-repos/world-cup-madness/supabase/functions/sync-matches/__fixtures__/v4-sample.json` — minimum 12 matches across stages (group + knockout) with `IN_PLAY`, `FINISHED`, and `TIMED` status coverage; enough to drive bootstrap import for local dev without an API key
- [x] T052 [US-MC] Implement `project-repos/world-cup-madness/supabase/functions/sync-matches/provider/football-data-v4.ts` — exports `fetchMatches({ fixtureMode })` that hits `https://api.football-data.org/v4/competitions/WC/matches` with `X-Auth-Token` header (or reads from the fixture file when fixtureMode); returns normalised `MatchRow[]` + `TeamRow[]` per data-model.md R-1 status mapping table
- [x] T053 [US-MC] Implement `project-repos/world-cup-madness/supabase/functions/sync-matches/index.ts` — Deno entrypoint per `contracts/edge-sync-matches.md`: parse body → acquire advisory lock via service-role RPC → insert integration_runs (in-flight) → fetchMatches → upsert teams + matches with field-level diff → update integration_runs final row → release lock; full skipped/error/success outcome handling; `SYNC_FIXTURE_MODE` env-var honoured
- [x] T054 [US-MC] Add `project-repos/world-cup-madness/supabase/functions/sync-matches/README.md` — env vars table (FOOTBALL_DATA_API_KEY, SYNC_FIXTURE_MODE, FUNCTION_URL), local invocation cheatsheet (mirrors quickstart.md §4), deployment notes (Supabase secrets, fixture vs live mode)

**Test tasks**

- [x] T055 [P] [US-MC] Playwright test `project-repos/world-cup-madness/e2e/tests/match-sync-admin.spec.ts` covering TC-M11 (admin signs in, invokes the trigger RPC, waits for integration_runs row with `action='manual-resync'`, asserts records_processed > 0)
- [x] T056 [P] [US-MC] Playwright test `project-repos/world-cup-madness/e2e/tests/match-sync-idempotent.spec.ts` covering TC-M13 (run bootstrap twice in fixture mode, assert second run reports `records_processed == records_unchanged`, assert match row count unchanged, assert no duplicate provider_id rows)
- [x] T057 [P] [US-MC] Playwright test `project-repos/world-cup-madness/e2e/tests/match-sync-concurrent-skipped.spec.ts` covering TC-M14 (use `Promise.all([fetch, fetch])` to trigger two manual-resyncs simultaneously, assert exactly one returns `outcome='success'` and one returns `outcome='skipped'`, assert integration_runs has one skipped row with `error_message` containing the in-flight run's timestamp)

---

## Final Phase — Polish & Cross-Cutting Concerns

- [x] T058 [P] Extend `project-repos/world-cup-madness/e2e/tests/all-pages-a11y.spec.ts` to cover three new surfaces: `/matches` (with seeded catalog), `/matches/[id]` (one match), `/profile` (with TimezonePicker open). Each surface runs `@axe-core/playwright` with `wcag2a/wcag2aa/wcag21a/wcag21aa` tags, asserts zero violations
- [x] T059 Mark Phase 6 tasks in `project-repos/world-cup-madness/specs/002-match-catalog-read/tasks.md` as complete, then run the full pristine sweep: `npx supabase db test test/pgtap/*.sql` → `npm test` → `npx playwright test` → `npx tsc --noEmit` → `npm run lint`. All five MUST report zero failures / zero warnings
- [x] T060 Write `project-repos/world-cup-madness/specs/002-match-catalog-read/dod-verification.md` mirroring the feature-001 format: per-FR / per-NFR / per-TC coverage table; constraint verification (FR-M22 RLS, FR-M23 advisory lock, NFR-M6 revalidate); list outstanding external items (football-data.org API key procurement, native-speaker translation review of `matches.*` keys, pg_net availability check for the trigger RPC)
- [x] T061 [P] Update `project-repos/world-cup-madness/README.md` "Feature 001 — Authentication" section to add a sibling "Feature 002 — Match catalog" section: env-var additions, local test commands updated, troubleshooting matrix extended with the rows from quickstart.md §9
- [x] T062 [P] Update `.ai_project_memory/constitution-frontend.md` and `.ai_project_memory/constitution-backend.md` if any new libraries / patterns were introduced beyond what the Phase-1 stack-additions commit already captured (likely none — re-verify against final task list)
- [x] T063 [P] Add any newly-surfaced ADRs to `.ai/knowledge/decisions.md` (none expected — all design decisions were captured in research.md R-1 through R-7 and the spec clarifications)

---

## Dependencies

### Inter-phase

- **Phase 1** → blocks Phase 2 (need the directory tree before migrations can be authored against the right relative paths)
- **Phase 2** → blocks every user-story phase (schema + RPCs + helpers + i18n + RLS form the foundation)
- **US-MA / US-MB / US-MC** → independent of one another at the implementation layer (different files, different test specs); can be executed in parallel by different developers / agents
- **Final Phase** → depends on all three user stories being complete (a11y sweep needs the new surfaces, pristine sweep needs everything green, DoD verification needs every TC covered)

### Intra-phase highlights

- T010 (regenerate types) MUST follow T003–T009 (migrations) — Server Components in Phase 3 reference the regenerated types
- T026 (run pgTAP + Jest pristine check) is the Phase-2 gate before any user-story phase begins
- T031 (`/matches` page) depends on T027–T030 (its component dependencies) and T010 (types) and T015/T017/T019 (helpers) and T022 (i18n keys)
- T034 (`/matches/[id]` page) depends on T032–T033 (Client Component + Detail Card) and same shared deps
- T036 (dashboard update) depends on T035 (widget component) AND T044 (TimezoneAutoDetect) — must be ordered to land both wraps in one coherent commit (or T036 happens twice — once for the widget in US-MA, once for the TimezoneAutoDetect mount in US-MB; coordinate during implementation)
- T053 (Edge Function entrypoint) depends on T050–T052 (its lib + provider + fixtures)

---

## Parallel execution examples

### Phase 2 — pgTAP + helpers + i18n in parallel

After T003–T010 (migrations + types regen) complete, the following are independent and can be dispatched in one agent batch:

- T011, T012, T013, T014 (pgTAP files — different .sql files)
- T015 + T016 (lock-badge helper + test — same .ts pair, but pair is one unit; OK to combine into a single task call)
- T017 + T018 (day-bucket helper + test)
- T019 + T020 (format-kickoff helper + test)
- T021 (IANA list generator)
- T022, T023, T024, T025 (i18n keys per locale — different .json files)

Estimated 10-12 parallel tasks in this wave; gate at T026 to verify everything still green before moving to user-story phases.

### Phase 3 — US-MA components in parallel

After T027 (LockBadge), the following components can be developed in parallel (different files, no cross-dependencies):

- T028 (LockCountdownText)
- T029 (MatchCard — depends on T027 + T028, sequential after both)
- T030 (MatchFilters — independent)
- T032 (LockCountdownTicker — Client Component, independent of list-view components)
- T035 (UpcomingMatchesWidget — depends on T029)

Then T031 (`/matches` page) and T033/T034 (`/matches/[id]` chain) sequentially.

### Phase 3 — US-MA tests in parallel

T037, T038, T039, T040, T041, T042 are 6 independent Playwright specs ([P] tagged). Dispatch all in a single agent batch once the implementation tasks land.

### Phase 4 — US-MB tests in parallel

T047, T048, T049 — 3 independent Playwright specs.

### Phase 5 — US-MC tests in parallel

T055, T056, T057 — 3 independent Playwright specs. Note: T055 depends on T054 (admin-trigger RPC + Edge Function paths existing); T056 + T057 can run before T055 if fixture-mode invocation is wired first.

### Final Phase — independent polish

T061, T062, T063 are [P] (different files, no dependencies). T058 must complete before T059 (full sweep). T060 (dod-verification) depends on T059.

---

## Implementation Strategy

### Recommended sequencing for a single developer / single AI agent

1. **Phase 1** (T001–T002) — ~5 minutes total
2. **Phase 2 migrations + types** (T003–T010) — sequential; ~30 minutes including manual verification of `npx supabase db reset` output
3. **Phase 2 pgTAP + helpers + i18n** (T011–T026) — bulk-dispatch in agent batches; ~1–2 hours including the Jest + pgTAP green gate
4. **Phase 3 (US-MA)** — full browse path; ~3–4 hours including 6 Playwright specs
5. **Phase 4 (US-MB)** — TZ persist + picker; ~1.5–2 hours
6. **Phase 5 (US-MC)** — Edge Function + 3 tests; ~3–4 hours (the Edge Function is the most novel piece; fixture mode keeps it testable without external dependencies)
7. **Final Phase** — sweep + docs; ~1 hour

**Total estimate**: ~10–15 hours for a single developer with AI-agent dispatch. Adjust upward if external blockers materialise (e.g. football-data.org API key procurement).

### MVP scope (if launch pressure)

**Phase 1 + Phase 2 + Phase 3 (US-MA) only** delivers:
- Participants can browse the full catalog at `/matches` (hand-seeded via `npx supabase db psql` until US-MC lands)
- Per-match detail pages with countdown timer
- Dashboard widget replaces the empty-state placeholder
- All 6 US-MA Playwright specs green

US-MB (timezone) and US-MC (admin sync) can ship in follow-up commits without disturbing the MVP surface. The catalog will display in UTC for everyone until US-MB lands; admins will hand-seed via SQL until US-MC lands.

### Risk hotspots

- **T010 (type regen)** — regenerating types after migrations can occasionally produce unexpected changes if Supabase's local stack is out of sync; verify the diff before committing
- **T032 (LockCountdownTicker)** — second-by-second re-render risks performance issues on slow devices; profile during implementation
- **T045 (TimezonePicker)** — hand-rolled combobox accessibility is the riskiest UI work; allocate axe-core time during implementation, not just final sweep
- **T053 (Edge Function)** — first Deno code in the project; budget extra time for environment + deploy verification
- **T057 (concurrent sync test)** — racy by nature; expect flakiness and may need `Promise.all` + explicit barrier coordination to make it deterministic

---

## Task ID summary

| Phase | Task IDs | Count |
|---|---|---|
| 1 — Setup | T001–T002 | 2 |
| 2 — Foundational | T003–T026 | 24 |
| 3 — US-MA | T027–T042 | 16 |
| 4 — US-MB | T043–T049 | 7 |
| 5 — US-MC | T050–T057 | 8 |
| Final | T058–T063 | 6 |
| **Total** | T001–T063 | **63** |

(Plan estimate was 35–45; the final count is 63 because the foundational phase grew with the four-pgTAP + 6-Jest helper requirement, and US-MA has 6 component tasks rather than the 8 estimated — net ~+18 tasks vs estimate, all in foundational + per-helper testing per Constitution §4 "every project must have unit tests".)
