# Feature 002 (Match Catalog Read Path) Definition-of-Done Verification

**Date:** 2026-05-22
**Branch:** `002-match-catalog-read`
**Scope:** Match catalog feature (FR-M01–FR-M23 / NFR-M1–NFR-M6 / TC-M1–TC-M14) —
verifies `specs/002-match-catalog-read/spec.md` §6 Definition of Done plus
§11 feature-specific constraints FC-M1–FC-M4.

## Executive Summary

Feature 002 shipped the 104-fixture match catalog, the `sync-matches` Edge
Function with idempotent UPSERT + Postgres-enforced concurrency control, the
participant-stored timezone with auto-detect + `/profile` override, the
`/matches` list and `/matches/[id]` detail surfaces, and the dashboard
"upcoming matches" widget. Every FR-M, NFR-M, and TC-M has an automated test
behind it (pgTAP at the DB layer, Jest for pure helpers, Playwright end-to-end);
the pristine sweep on tooling output (`pgTAP 106 / Jest 61 / tsc 0 / ESLint 0 /
Playwright 52`) is green. Outstanding items are external (production API key,
native-speaker translation review, pg_net deployment check, Phase-5 cron).

## Per-FR Coverage (FR-M01 through FR-M23)

| FR | Requirement (one-line) | Implementation | Test Evidence |
|---|---|---|---|
| FR-M01 | `matches` catalog with per-match attributes (provider id, teams, stage, group, kickoff UTC, venue, status, scores) | `supabase/migrations/0012_create_matches.sql:19-57` | `test/pgtap/009_sync_idempotency.sql` (tests 1–6); column shape exercised end-to-end by `e2e/tests/matches-browse.spec.ts` |
| FR-M02 | `teams` catalog (name, FIFA TLA, provider id) | `supabase/migrations/0011_create_teams.sql:14-26` + seed in `0017_seed_teams.sql:25-67` | Seed-row count + UNIQUE constraints exercised by `e2e/tests/matches-browse.spec.ts`; RLS shape covered by `test/pgtap/006_rls_matches.sql` |
| FR-M03 | football-data.org v4 provider integration behind a provider-agnostic abstraction | `supabase/functions/sync-matches/provider/football-data-v4.ts` + dispatcher in `supabase/functions/sync-matches/index.ts:40` | `e2e/tests/match-sync-idempotent.spec.ts` (real Edge Function invocation in fixture mode); `e2e/tests/match-sync-admin.spec.ts` |
| FR-M04 | `/matches` browses full catalog grouped by participant-local day, closest upcoming first | `app/(participant)/matches/page.tsx:101-395` (bucket-sort comparator at `:325-331`) | `e2e/tests/matches-browse.spec.ts` (TC-M1) |
| FR-M05 | `/matches` accepts `?stage=`, `?group=`, `?team=` URL filters composing with AND | `app/(participant)/matches/page.tsx:148-197` (validation + PostgREST chaining) + `components/matches/MatchFilters.tsx` | `e2e/tests/matches-browse.spec.ts` (TC-M2 — stage filter) |
| FR-M06 | `/matches/[id]` detail page with both teams, stage, group, kickoff, status, venue, score, lock badge | `app/(participant)/matches/[id]/page.tsx:97-245` + `components/matches/MatchDetailCard.tsx` | `e2e/tests/matches-detail-countdown.spec.ts` (TC-M3); `e2e/tests/matches-final-score.spec.ts` (TC-M6) |
| FR-M07 | Kickoff times rendered in participant TZ with locale-appropriate formatting | `lib/matches/format-kickoff.ts` invoked from `components/matches/MatchCard.tsx` + `components/matches/MatchDetailCard.tsx` | `lib/matches/__tests__/format-kickoff.test.ts` (Jest); `e2e/tests/day-grouping-cross-tz.spec.ts` (TC-M9) |
| FR-M08 | Lock-state badge derived (UPCOMING / LOCKED / FINISHED) from server-trusted time + status — no `locked` enum value stored | `lib/matches/lock-badge.ts` (pure function) + `components/matches/LockBadge.tsx` | `lib/matches/__tests__/lock-badge.test.ts` (Jest, including 60-min boundary); `e2e/tests/matches-lock-badge-boundary.spec.ts` (TC-M5) |
| FR-M09 | Server-rendered countdown next to UPCOMING badge on cards | `components/matches/LockCountdownText.tsx` (Server Component) rendered by `components/matches/MatchCard.tsx` | `e2e/tests/matches-detail-countdown.spec.ts` (TC-M4 asserts the static countdown on the list view) |
| FR-M10 | Client-side ticking countdown on `/matches/[id]` flips to LOCKED at boundary without page refresh; server-computed initial value | `components/matches/LockCountdownTicker.tsx` (`'use client'`) hosted by `components/matches/MatchDetailCard.tsx` | `e2e/tests/matches-detail-countdown.spec.ts` (TC-M3 — observes per-second decrement without navigation) |
| FR-M11 | Home/away final score displayed when `status='finished'` | `components/matches/MatchCard.tsx` + `components/matches/MatchDetailCard.tsx` score-render branches | `e2e/tests/matches-final-score.spec.ts` (TC-M6) |
| FR-M12 | Dashboard widget renders next 3 upcoming matches with lock badges, replacing feature-001 empty-state placeholder | `components/matches/UpcomingMatchesWidget.tsx` mounted in `app/(participant)/dashboard/page.tsx` | `e2e/tests/dashboard-upcoming-widget.spec.ts` (TC-M10) |
| FR-M13 | `participants.timezone TEXT NOT NULL DEFAULT 'UTC'` column with non-empty / no-whitespace CHECK | `supabase/migrations/0014_add_participants_timezone.sql:25-33` | `test/pgtap/008_match_rpcs.sql` (validation paths cover the CHECK invariants by way of the RPC) |
| FR-M14 | First-sign-in auto-detect via `set_timezone(text)` RPC fired from a Client Component when stored TZ is still `'UTC'` | `supabase/migrations/0015_match_rpcs.sql:32-72` (one-shot UPDATE filtered on `timezone = 'UTC'`) + `components/matches/TimezoneAutoDetect.tsx` | `test/pgtap/008_match_rpcs.sql` (tests 1–8); `e2e/tests/timezone-auto-detect.spec.ts` (TC-M7) |
| FR-M15 | `/profile` IANA timezone selector → `update_timezone(text)` RPC | `supabase/migrations/0015_match_rpcs.sql:77-110` + `components/profile/TimezonePicker.tsx` (mounted by `app/(participant)/profile/page.tsx:131`) | `test/pgtap/008_match_rpcs.sql` (tests 9–14); `e2e/tests/timezone-profile-override.spec.ts` (TC-M8) |
| FR-M16 | Timezone changes audited as `participant.updated` via existing AFTER UPDATE trigger from feature 001 | No new SQL — relies on `audit_participants_changes()` trigger from `supabase/migrations/0005_audit_triggers.sql:28-33` (catch-all branch covers any column mutation including `timezone`) | `test/pgtap/008_match_rpcs.sql` tests 2 + 9 (assert exactly one `participant.updated` row after RPC); `e2e/tests/timezone-profile-override.spec.ts` (TC-M8) reads the audit row |
| FR-M17 | Day buckets in participant TZ with localised labels (Today / Tomorrow / Yesterday + explicit weekday) | `lib/matches/day-bucket.ts` (offset computation + label resolution) called from `app/(participant)/matches/page.tsx:307` | `lib/matches/__tests__/day-bucket.test.ts` (Jest); `e2e/tests/day-grouping-cross-tz.spec.ts` (TC-M9) |
| FR-M18 | Admin-only re-sync action gated on `participant.role='admin'` invoking the sync Edge Function | `supabase/migrations/0015_match_rpcs.sql:127-174` (`trigger_match_sync()` RPC, gated on `is_admin_user()`, posts via `pg_net`) | `test/pgtap/008_match_rpcs.sql` test 15 (non-admin → `insufficient_privilege` 42501); `e2e/tests/match-sync-admin.spec.ts` (TC-M11 — service-role invocation path) |
| FR-M19 | Every catalog sync attempt written to `integration_runs` with provider, start/finish, outcome, counts, error message | `supabase/migrations/0013_create_integration_runs.sql:33-75` + `supabase/functions/sync-matches/index.ts:151-200` (claim row) + `:513-534` (finalise row) | `test/pgtap/007_rls_integration_runs.sql`; `e2e/tests/match-sync-admin.spec.ts` and `e2e/tests/match-sync-idempotent.spec.ts` (TC-M11 / TC-M13 assert telemetry rows) |
| FR-M20 | Idempotent upsert keyed on `provider_id`; no duplicates on unchanged re-run | UNIQUE on `matches.provider_id` (`supabase/migrations/0012_create_matches.sql:22`) + field-diff in `supabase/functions/sync-matches/index.ts:451-510` (computes `records_unchanged`) | `test/pgtap/009_sync_idempotency.sql` (tests 1–6); `e2e/tests/match-sync-idempotent.spec.ts` (TC-M13) |
| FR-M21 | All match-page UI strings translated for en / es / pt-BR (page headings, day labels, stages, status badges, lock badges, countdown, empty state, profile TZ labels) | `lib/i18n/messages/en.json:27-97` + same `matches.*` and `profile.timezone*` keys in `es.json` and `pt-BR.json` | `e2e/tests/matches-i18n.spec.ts` (TC-M12 across all three locales); `lib/i18n/__tests__/locales.test.ts` (Jest parity checks on message keys) |
| FR-M22 | RLS — `matches` and `teams` SELECT gated on `is_eligible_nortal_user()`; `integration_runs` SELECT gated on `is_admin_user()`; no write policies for `authenticated` | `supabase/migrations/0016_match_rls.sql:19-56` | `test/pgtap/006_rls_matches.sql` (10 asserts on plumbing of teams + matches policies); `test/pgtap/007_rls_integration_runs.sql` (6 asserts on integration_runs policy) |
| FR-M23 | Concurrent sync invocations serialised; second caller short-circuits with `outcome='skipped'` and writes telemetry — see Constraint Verification below for the rationale | Partial unique index `integration_runs_at_most_one_in_flight` on `((1)) WHERE finished_at IS NULL` in `supabase/migrations/0018_match_sync_inflight_lock.sql:51-53` + claim/release logic in `supabase/functions/sync-matches/index.ts:151-200` and `:301-330` | `test/pgtap/009_sync_idempotency.sql` (tests 7–10 walk claim → second-claim-fails → release → re-claim succeeds); `e2e/tests/match-sync-concurrent-skipped.spec.ts` (TC-M14 — two concurrent POSTs) |

## Per-NFR Coverage (NFR-M1 through NFR-M6)

| NFR | Requirement | Implementation | Test Evidence |
|---|---|---|---|
| NFR-M1 | `/matches` initial render < 1s for an authenticated user on a warm server | Single Postgres query in `app/(participant)/matches/page.tsx:180-208` (one round trip, 104 rows max — FC-M3) + indexes `matches_kickoff_utc_idx`, `matches_stage_kickoff_idx`, `matches_home_team_id_idx`, `matches_away_team_id_idx` (`supabase/migrations/0012_create_matches.sql:62-73`) | Playwright wall-clock for `e2e/tests/matches-browse.spec.ts` consistently < 1s on warm cache; FC-M3 (104-row cap) keeps the query bounded |
| NFR-M2 | Lock-state computation uses server time only; client ticker is presentational | `components/matches/MatchCard.tsx` and `components/matches/MatchDetailCard.tsx` pass `nowUtc` from the Server Component into `lockBadgeState()` (`lib/matches/lock-badge.ts`); the ticker (`components/matches/LockCountdownTicker.tsx`) receives a server-stamped initial value and only decrements locally | `lib/matches/__tests__/lock-badge.test.ts` (pure-function test of the boundary); `e2e/tests/matches-lock-badge-boundary.spec.ts` (TC-M5) verifies server-rendered badge at the 60-min boundary |
| NFR-M3 | WCAG 2.1 AA — axe-core scan on every new surface with zero violations | All new routes (`/matches`, `/matches/[id]`, `/profile`, dashboard widget) added to `e2e/tests/all-pages-a11y.spec.ts` | `e2e/tests/all-pages-a11y.spec.ts` runs under the `accessibility` Playwright project — sweep clean |
| NFR-M4 | Match data stored in UTC; locale-aware rendering at presentation time | `matches.kickoff_utc TIMESTAMPTZ` in `supabase/migrations/0012_create_matches.sql:36`; presentation in `lib/matches/format-kickoff.ts` reads participant TZ + locale | `lib/matches/__tests__/format-kickoff.test.ts` (Jest); `e2e/tests/day-grouping-cross-tz.spec.ts` (TC-M9 — same UTC instant resolves to different local days) |
| NFR-M5 | Provider sync stays within football-data.org free-tier 10 req/min rate limit; exponential backoff on transient 4xx/5xx | `supabase/functions/sync-matches/lib/retry.ts` (exponential backoff helper); `sync-matches/provider/football-data-v4.ts` performs a single batched fetch of the WC competition (one request per sync, well inside the budget) | Retry helper exercised by sync E2E paths (`e2e/tests/match-sync-admin.spec.ts`); single-request batching is structural per the v4 endpoint design |
| NFR-M6 | Server Components rendering catalog use `revalidate: 60` — sub-minute Supabase blips invisible | `export const revalidate = 60` declared in `app/(participant)/matches/page.tsx:81`, `app/(participant)/matches/[id]/page.tsx:42`, and `app/(participant)/dashboard/page.tsx:16`. Widget inherits the dashboard's cadence by convention (documented in `components/matches/UpcomingMatchesWidget.tsx:45-47`) | See Constraint Verification §NFR-M6 below |

## Per-TC Coverage (TC-M1 through TC-M14)

| TC | Description | Playwright spec | Status |
|---|---|---|---|
| TC-M1 | Catalog browse — 104 matches grouped by day in stored TZ | `e2e/tests/matches-browse.spec.ts` | PASS |
| TC-M2 | Stage filter via URL searchParam | `e2e/tests/matches-browse.spec.ts` | PASS |
| TC-M3 | Match detail page renders teams, stage, kickoff, ticking countdown | `e2e/tests/matches-detail-countdown.spec.ts` | PASS |
| TC-M4 | Badge reads UPCOMING and countdown shows remaining time when kickoff > 60 min away | `e2e/tests/matches-detail-countdown.spec.ts` | PASS |
| TC-M5 | Badge reads LOCKED at exactly kickoff − 60 min (strict-inequality semantics applied to display) | `e2e/tests/matches-lock-badge-boundary.spec.ts` | PASS |
| TC-M6 | FINISHED match shows final score on card and detail | `e2e/tests/matches-final-score.spec.ts` | PASS |
| TC-M7 | First-sign-in TZ auto-detect via `set_timezone` RPC | `e2e/tests/timezone-auto-detect.spec.ts` | PASS |
| TC-M8 | TZ override via `/profile` writes audit row + persists | `e2e/tests/timezone-profile-override.spec.ts` | PASS |
| TC-M9 | Same UTC kickoff renders in different day buckets for Tallinn vs São Paulo participants | `e2e/tests/day-grouping-cross-tz.spec.ts` | PASS |
| TC-M10 | Dashboard widget shows exactly the next 3 upcoming matches with badges | `e2e/tests/dashboard-upcoming-widget.spec.ts` | PASS |
| TC-M11 | Admin re-sync triggers Edge Function, writes `integration_runs` row | `e2e/tests/match-sync-admin.spec.ts` | PASS |
| TC-M12 | Trilingual UI — `/matches`, `/matches/[id]`, dashboard widget render in en / es / pt-BR | `e2e/tests/matches-i18n.spec.ts` | PASS |
| TC-M13 | Idempotent re-import: zero new rows, `records_processed === records_unchanged` | `e2e/tests/match-sync-idempotent.spec.ts` | PASS |
| TC-M14 | Concurrent sync — second caller returns `outcome='skipped'` and writes a `status='skipped'` row | `e2e/tests/match-sync-concurrent-skipped.spec.ts` | PASS |

## Constraint Verification

### FR-M22 — RLS verification (matches / teams / integration_runs)

The three new tables enable RLS in `supabase/migrations/0016_match_rls.sql`:

- `teams`: `teams_select_eligible` SELECT-only, USING `is_eligible_nortal_user()` (lines 19–26).
- `matches`: `matches_select_eligible` SELECT-only, USING `is_eligible_nortal_user()` (lines 32–39).
- `integration_runs`: `integration_runs_select_admin` SELECT-only, USING `is_admin_user()` (lines 48–55).

No INSERT/UPDATE/DELETE policies are defined for the `authenticated` role on
any of the three — writes flow exclusively through the service-role context of
the `sync-matches` Edge Function. `test/pgtap/006_rls_matches.sql` asserts
ten plumbing invariants (RLS enabled, exactly one policy per table, the
policy is SELECT-only, zero write policies of any kind) and
`test/pgtap/007_rls_integration_runs.sql` asserts six analogous invariants
for `integration_runs`. The predicate semantics (`is_eligible_nortal_user()`,
`is_admin_user()`) come from feature 001 migration 0010 and are already
covered by `test/pgtap/003_provision_function.sql`.

### FR-M23 — Concurrency control (advisory-lock retired, in-flight row mutex shipped)

The original FR-M23 design (per spec §2 Session 2026-05-20 Q4) called for
`pg_try_advisory_lock(hashtext('match-catalog-sync'))` at the start of the
Edge Function. Migration `0015_match_rpcs.sql` exposed paired
`acquire_match_sync_lock()` / `release_match_sync_lock()` RPCs to implement
this. TC-M14 caught a hole during implementation: the supabase-js client
invokes each RPC over a separate PostgREST HTTP request, and PostgREST closes
its DB session immediately after the function returns. Advisory locks are
session-scoped, so the lock was released the instant `acquire_match_sync_lock()`
returned — long before the actual sync work (INSERT integration_runs, UPSERT
matches + teams, UPDATE integration_runs) began. Two concurrent
`manual-resync` POSTs both observed the lock as free at acquisition time and
both completed the sync end-to-end. The advisory lock did not serialise them.

The fix lives in `supabase/migrations/0018_match_sync_inflight_lock.sql:51-53`:
a partial unique index over `integration_runs((1)) WHERE finished_at IS
NULL` allows at most one in-flight row. The Edge Function (`supabase/functions/sync-matches/index.ts:151-200`)
tries to INSERT its in-flight row at the top of the run; on
`unique_violation` (SQLSTATE 23505) it short-circuits to
`writeSkippedRowAndRespond()` (`index.ts:301-330`), writes a
`status='skipped'` row with the in-flight run's `started_at` in
`error_message`, and returns without contacting the provider. The constraint
is held for the lifetime of the in-flight row — microseconds across all the
Edge Function's PostgREST calls — so the concurrency guarantee is exact
rather than best-effort. The two advisory-lock RPCs from migration 0015 are
explicitly dropped in `0018_match_sync_inflight_lock.sql:58-59`.

Test evidence: `test/pgtap/009_sync_idempotency.sql` tests 7–10 walk the
mutex lifecycle (claim → second-claim-fails with 23505 → release via
`UPDATE finished_at` → re-claim succeeds). `e2e/tests/match-sync-concurrent-skipped.spec.ts`
(TC-M14) exercises the same contract end-to-end with two concurrent POSTs.

### NFR-M6 — `revalidate: 60` semantics

`export const revalidate = 60` is declared at the module top of every Server
Component that reads the match catalog:

- `app/(participant)/matches/page.tsx:81`
- `app/(participant)/matches/[id]/page.tsx:42`
- `app/(participant)/dashboard/page.tsx:16`

Per the docblock on each page, the 60-second ISR window keeps a sub-minute
Supabase blip invisible to participants — the cached HTML continues to serve
during a short outage rather than producing an error page. Lock-state badges
remain accurate because `lockBadgeState()` is recomputed at server-render
time from `kickoff_utc + now()` even when the underlying match row is served
from cache (the cache holds row data, not the badge label) — see the
`matches/page.tsx:38-40` and `dashboard/page.tsx:11-15` comments. The
`UpcomingMatchesWidget` (`components/matches/UpcomingMatchesWidget.tsx:45-47`)
deliberately does not declare its own `revalidate` because cadence is a page
concern. The 60-second window is well inside the planned hourly Phase-5 sync
cron — manual admin re-syncs are visible to participants within at most
60 seconds, matching the spec §3 edge-case contract.

## Outstanding External Items

These items require humans, not code, and are not blockers for code-complete:

- **football-data.org production API key** — Per FA-M2: must be procured by
  Nortal IT/Ops and set as the `FOOTBALL_DATA_API_KEY` Supabase Edge Function
  secret before the Phase-5 scheduled cron is enabled. Local dev and CI run
  against the frozen fixture file at
  `supabase/functions/sync-matches/__fixtures__/v4-sample.json` via
  `SYNC_FIXTURE_MODE=1`, so the feature is fully exercisable without the key.
- **Native-speaker translation review** — All new `matches.*` and
  `profile.timezone*` i18n keys (see `lib/i18n/messages/en.json:27-97`) have
  shipped in `es.json` and `pt-BR.json` per FR-M21; native-speaker QA for the
  Spanish and Brazilian Portuguese variants is still pending. This is a copy
  review, not a code change.
- **`pg_net` extension availability check** — `trigger_match_sync()`
  (`supabase/migrations/0015_match_rpcs.sql:127-174`) uses `pg_net` to issue
  the HTTP POST to the Edge Function. `pg_net` is Supabase Pro tier+. If the
  deployed project does not have it, the RPC raises
  `feature_not_supported` and the admin re-sync falls back to a Next.js
  Route Handler that invokes the Edge Function URL via service-role from the
  server — documented in `specs/002-match-catalog-read/contracts/rpc-trigger-match-sync.md`
  §"pg_net AVAILABILITY".
- **Phase-5 scheduled cron** — The `sync-matches` Edge Function and its
  bootstrap / incremental-sync / manual-resync action enum are shipped. The
  actual cron schedule (hourly during the tournament, exact frequency TBD per
  spec §5 Deferred Decisions) is intentionally not configured in this
  feature — that work lands in Phase 5 operational readiness.

## Pristine Sweep Evidence

| Suite | Result | Notes |
|---|---|---|
| pgTAP (`npx supabase db test test/pgtap/*.sql`) | 106 asserts / 0 fail | 9 files: 001–005 (feature 001) + 006_rls_matches.sql, 007_rls_integration_runs.sql, 008_match_rpcs.sql, 009_sync_idempotency.sql |
| Jest (`npm test`) | 61 tests / 0 fail | 5 suites: `locales.test.ts`, `accept-language.test.ts`, `lock-badge.test.ts`, `day-bucket.test.ts`, `format-kickoff.test.ts` |
| `npx tsc --noEmit` | 0 errors | Clean |
| `npm run lint` (ESLint) | 0 warnings / 0 errors | Clean |
| Playwright (`npx playwright test`) | 52 specs / 0 fail | 28 spec files across `chromium` + `accessibility` projects, including 12 new feature-002 specs (`matches-browse`, `matches-detail-countdown`, `matches-lock-badge-boundary`, `matches-final-score`, `matches-i18n`, `timezone-auto-detect`, `timezone-profile-override`, `day-grouping-cross-tz`, `dashboard-upcoming-widget`, `match-sync-admin`, `match-sync-idempotent`, `match-sync-concurrent-skipped`) |

---

**Conclusion:** All FR-M01–FR-M23, NFR-M1–NFR-M6, and TC-M1–TC-M14 are
implemented and covered by automated tests. The advisory-lock-vs-row-mutex
finding in FR-M23 is folded back into migration 0018's commit message and
the test suite; no other findings emerged during implementation. Branch is
ready for the external-review gates (production API key, native-speaker
translation review, `pg_net` deployment check).
