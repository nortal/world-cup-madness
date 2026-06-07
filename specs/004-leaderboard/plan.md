# Implementation Plan: Leaderboard

**Branch**: `004-leaderboard` | **Date**: 2026-06-01 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/004-leaderboard/spec.md`

## Summary

Surface the points. Feature 003 made every active participant scorable; feature 004 makes them rankable. Single `/leaderboard` page with a stage tab strip (`All`, `Group`, `R16`, `Quarter`, `Semi`, `Final`); compact "Your rank ↑/↓ N" widget on `/dashboard`. Both surfaces read from one Postgres materialised view `leaderboard_snapshots` keyed by `(participant_id, stage)`, refreshed inside an exception-trapped block invoked by every scoring run (match trigger, final trigger, admin recalc-all) — refresh failures are logged but do NOT roll back scoring (FC-L2). A `pg_cron` job ticks every 5 minutes and gates the actual `REFRESH` on match-window proximity (5-min cadence when any match is within `now() ± 90 min`, otherwise ~60-min cadence). Supabase Realtime emits change events via an `audit_log` event proxy (R-2); the page subscribes and re-renders rank rows without a page reload. Tie-breakers follow `scoring-model.md` §7.4 items #1–#4 plus shared-rank (`1=`, `1=`, `3`); item #5 is explicitly NOT adopted.

## Implementation Conflicts

**Status**: No Conflicts Found

**Conflict check completed**: 2026-06-01. Checked against `specs/001-authentication-and-participant/plan.md` (auth + RLS + audit_log), `specs/002-match-catalog-read/plan.md` (dashboard + matches + integration_runs), and `specs/003-predictions-and-scoring/plan.md` (score_events + scoring_runs + admin RPCs). Feature 004 *adds* one materialised view, one RPC (`refresh_leaderboard()`), two new `audit_log.event_type` variants, one `pg_cron` schedule, one new participant route (`/leaderboard`), and one widget on the existing `/dashboard`. It does not modify any existing column semantics, RLS policy, RPC, or trigger. The `score_events`, `participants`, `matches`, and `scoring_runs` tables are read-only inputs to the MV.

Scoring triggers from feature 003 (`calculate_match_points`, `calculate_final_points`) and the admin `recalculate_all_scores()` RPC are MINIMALLY extended: each gets one extra final statement inside an exception-trapped `BEGIN ... EXCEPTION WHEN OTHERS THEN ... END;` block that invokes `refresh_leaderboard()`. The scoring transaction still commits regardless of the refresh outcome (FC-L2). No change to scoring semantics, contract, or test surface.

**Implementation Conflicts Identified**: None.

**Conflict Check Date**: 2026-06-01
**Checked Against**: `specs/001-authentication-and-participant/plan.md`, `specs/001-authentication-and-participant/data-model.md`, `specs/002-match-catalog-read/plan.md`, `specs/002-match-catalog-read/data-model.md`, `specs/003-predictions-and-scoring/plan.md`, `specs/003-predictions-and-scoring/data-model.md`

---

## Technical Context

**Language/Version**: TypeScript 6.x (Next.js App Router + Realtime client); SQL (PostgreSQL 15+); no Edge Function changes.
**Primary Dependencies**:
- Frontend: Next.js 15.5.x (App Router), React 19.x, next-intl 4.x, Tailwind v4, `@supabase/ssr` 0.10.x, `@supabase/supabase-js` 2.x Realtime client (already bundled since feature 002)
- Backend: Supabase Postgres 15+ + PostgREST + Postgres `MATERIALIZED VIEW` (with RLS, PG15+) + `pg_cron` extension (already enabled by feature 003)
- New for this feature: none — reuses Tailwind tab strip pattern (mirrors feature 002 `<MatchFilters/>`), data-table pattern (mirrors feature 003 `<BreakdownTable/>`), Realtime subscription pattern (mirrors feature 002's `tournament_config` admin sub)
**Storage**: PostgreSQL 15+ managed by Supabase Cloud. New materialised view: `leaderboard_snapshots`. New RPC: `refresh_leaderboard()`. New gating predicate: `should_refresh_leaderboard()`. New `audit_log.event_type` enum values: `leaderboard.refresh`, `leaderboard.refresh_failed`. New `pg_cron` schedule: `leaderboard-refresh-tick`. Zero new mutable tables.
**Testing**: pgTAP for MV definition + RLS + RPC semantics + cron gating logic; Jest for pure helpers (delta computation, stage-tab URL state, rank format `1=`); Playwright (chromium + accessibility) for page + widget + Realtime + a11y. Same suite layout as features 001-003.
**Target Platform**: Next.js → Vercel (frontend); Supabase Cloud (Postgres + Realtime); browsers — modern evergreen Chrome / Firefox / Safari / Edge.
**Project Type**: Web application — same layout as features 001-003.
**Performance Goals**:
- `/leaderboard` first paint ≤ 1 s @ 200 active participants (NFR-L1)
- Realtime rank update visible ≤ 5 s after scoring trigger commit (NFR-L2)
- `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` ≤ 500 ms @ 200 participants × 6 stages = 1,200 MV rows (NFR-L3)
- Stage-tab switch perceived latency ≤ 200 ms (NFR-L5)
- 50+ concurrent Realtime subscribers supported without backpressure (NFR-L7)
**Constraints**:
- MV is the only read surface for rankings (FC-L1)
- MV refresh invoked from each scoring run but DECOUPLED from scoring commit (FC-L2)
- Realtime subscription scope is the MV (via audit-event proxy), not `score_events` (FC-L3)
- Stage filter excludes finals (FC-L4): `final-*` source rows contribute only to `'all'`
- Tie-breaker stops at #4 + shared rank (FC-L5)
- Admin sees the same surface as participants (FC-L6)
- WCAG 2.1 AA across `/leaderboard` (all states) + `/dashboard` widget
**Scale/Scope**: 200 active participants × 6 stages = 1,200 MV rows refreshed at most every 5 minutes during match windows. ~21,600 `score_events` aggregated. One tournament cycle (June–July 2026 + cleanup).

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Applicable Constitution**: both (frontend + backend; this feature spans a Server Component page, a Client Component widget, Realtime subscription, a materialised view, an admin RPC, a pg_cron schedule, and audit-log additions)

**Source Documents**:
- `../.ai_project_memory/constitution.md` (core principles)
- `../.ai_project_memory/constitution-frontend.md` (Next.js, Tailwind, Realtime, i18n patterns)
- `../.ai_project_memory/constitution-backend.md` (Supabase, Postgres, RLS, materialised views, partial-unique-index mutex, security_invoker views, scoring trigger pattern)

### Compliance Checklist

**Universal (constitution.md):**

- [x] **§1.1 Code Organization — Modular monolith with DB-enforced rules** — Ranking aggregation lives in the materialised view; the UI never recomputes ranks. Tie-breaker chain expressed in SQL via `RANK() OVER (... ORDER BY total DESC, exact DESC, outcome DESC, final DESC)`. Refresh failure handling lives inside Postgres functions. ✓
- [x] **§1.1 Root directory discipline** — No new files in repo root. ✓
- [x] **§1.2 Naming conventions** — kebab-case files (`leaderboard/page.tsx`, `refresh-leaderboard.sql`), PascalCase components (`LeaderboardTable`, `StageTabStrip`, `RankWidget`), snake_case SQL (`leaderboard_snapshots`, `total_points`, `exact_hits`). ✓
- [x] **§1.3 Error handling — No silent failures** — MV refresh failure raises inside the exception-trapped block and is captured in `audit_log` with SQLSTATE + error message (FR-L20). Scoring still commits per FC-L2; admin retry RPC `refresh_leaderboard()` available. Realtime subscription drops surface a visible "Reconnecting…" indicator after 10 s (FR-L18). ✓
- [x] **§1.4 Documentation philosophy — Comments for "why" not "what"** — Inline comments will mark only the non-obvious decisions: exception-trapped decoupling (Clarify Session Q2), `pg_cron` gating logic (Clarify Q3), MV stage dimension via UNION ALL (R-8). ✓
- [x] **§2 Security/Compliance — service_role never in client** — `refresh_leaderboard()` is `SECURITY DEFINER` gated on `is_admin_user()`. The pg_cron job invokes it with elevated cron privileges. Browser only subscribes to the audit-event channel using the participant's anon JWT; RLS on `leaderboard_snapshots` restricts other-participant rows to the public projection (rank + name + active-tab total). ✓
- [x] **§2 Domain eligibility enforced at DB layer** — `/leaderboard` Server Component checks `auth.getUser()` server-side + queries `participants WHERE auth_user_id = auth.uid() AND status='active'` before rendering. Same auth gate convention as features 001-003. ✓
- [x] **§3 Git workflow — Feature branch + conventional commits + never `--no-verify`** — Branch `004-leaderboard` created off `003-predictions-and-scoring`. Pre-commit hook remains active. ✓
- [x] **§4 Testing — pgTAP + Jest + Playwright; output pristine** — pgTAP for MV row shape + RLS + RPC + cron gating + idempotency. Jest for pure helpers (delta, rank format, URL state, countdown). Playwright covers TC-L1..L19 across the page + widget + Realtime + a11y. ✓
- [x] **§4 Lock boundary tests not applicable** — Feature 004 has no lock semantics; the closest analog (pre-tournament hide via FR-L07) is exercised by TC-L3 + TC-L11. ✓

**Frontend (constitution-frontend.md):**

- [x] **§I.1 Stack: Next.js 15.x App Router + TypeScript 6.x + Tailwind v4 + next-intl 4.x + @supabase/ssr 0.10.x** — Existing stack only; no new client dependencies. ✓
- [x] **§IV.1 Server Components by default; "use client" only for interactivity** — `/leaderboard/page.tsx`, `<LeaderboardPage/>`, `<LeaderboardTable/>`, `<EmptyLeaderboardState/>` are Server Components. Client Components: `<LeaderboardRealtime/>`, `<StageTabStrip/>`, `<RankWidget/>`, `<ShowMyRankButton/>`, `<ReconnectingIndicator/>`. ✓
- [x] **§IV.1 Authoritative state server-rendered — never client-computed** — The MV is the authoritative read surface; the client subscribes for updates but never recomputes ranks. The "shared rank" `=` suffix is rendered server-side from the MV's `rank` column. ✓
- [x] **§V Server-state via supabase server client in RSC** — Initial MV read uses `lib/supabase/server.ts`. The Realtime subscription uses `createBrowserClient` (already in features 001-002). ✓
- [x] **§VII Accessibility WCAG 2.1 AA** — `all-pages-a11y.spec.ts` extended for: `/leaderboard` (populated state), `/leaderboard` (pre-tournament countdown state), `/leaderboard?stage=group` (filtered state). The `<StageTabStrip/>` uses the WAI-ARIA tabs pattern (`role="tablist"`, `role="tab"`, `aria-selected`, arrow-key navigation). ✓
- [x] **§IX Anti-patterns — no client-side computation of authoritative state; no useEffect for initial data fetch; no service_role in client bundles** — All ranks come from the server-rendered MV row. Initial page data is fetched in the Server Component. service_role stays server-side. ✓
- [x] **i18n: hand-rolled Accept-Language detection per ADR-013** — Add `leaderboard.*` namespace keys to `messages/{en,es,pt-BR}.json`; no new locale machinery. ✓
- [x] **Read-path caching deviation — no `export const revalidate`** — `/leaderboard` opts INTO fully dynamic rendering (no ISR window; the Realtime channel is the freshness mechanism). Documented under R-2. ✓

**Backend (constitution-backend.md):**

- [x] **§I.1 Stack: Supabase Postgres + PostgREST + RPCs + pgTAP + pg_cron + pg_net** — Existing stack. ✓
- [x] **§I.1 Concurrency primitive: partial unique index** — Not needed for `refresh_leaderboard()`: `REFRESH MATERIALIZED VIEW CONCURRENTLY` is itself serialised by Postgres. No application-level mutex required. R-4 documents the decision. ✓
- [x] **§I.1 Cross-table operator surface — view with security_invoker** — `leaderboard_snapshots` is a *materialised* view, not a regular view; `security_invoker` does not apply. RLS on materialised views (PG15+) used instead; documented under R-3 and reflected in data-model.md §3. New constitution row added post-design. ✓
- [x] **§I.1 Scoring trigger pattern (FR-P24 carry-over)** — `refresh_leaderboard()` is invoked from scoring-trigger functions via an exception-trapped block (DECOUPLED from scoring commit per FC-L2). Feature 003's trigger functions get a one-line extension; no change to their core semantics. ✓
- [x] **§IV API Design — PostgREST + RPC; business rules in DB** — Tie-breaker chain encoded as `RANK()` window function in the MV `SELECT`. Stage filter encoded as `WHERE stage = $tab` on top of the MV. ✓
- [x] **§V Data Access — no ORM; Supabase client + generated types** — Queries go through `@supabase/ssr` after `database.types.ts` regeneration following migration 0032. ✓
- [x] **§VI Security — service_role only server-side; RLS on all reads + privacy by projection** — RLS on `leaderboard_snapshots` permits authenticated participants to SELECT public-projection columns for any row but the `exact_hits`/`outcome_hits`/`final_points` columns are restricted to the self row via query-side projection backed by pgTAP-tested RLS. ✓
- [x] **§VII Error handling — structured + auditable** — Refresh success/failure both write structured rows to `audit_log` with `event_type` + duration + SQLSTATE + scoring_runs FK. ✓
- [x] **§IX Anti-patterns — no provider raw stored, no service_role in browser** — MV reads only internal tables. Realtime client uses anon JWT. ✓
- [x] **§I.1 Safe-update guard** — `refresh_leaderboard()` contains no UPDATE/DELETE statements (only `REFRESH MATERIALIZED VIEW` and `INSERT INTO audit_log`). FC-L4 stage-exclusion logic is expressed in the MV `SELECT`. No supautils risk. ✓

**Violations Found**: None.

**Remediation**: N/A.

---

## Project Structure

### Documentation (this feature)

```
specs/004-leaderboard/
├── spec.md                       # Feature specification (input)
├── plan.md                       # This file (/ai1st-dev-plan output)
├── research.md                   # Phase 0 output
├── data-model.md                 # Phase 1 output
├── contracts/                    # Phase 1 output (MV + RPC + cron + audit + realtime contracts)
├── quickstart.md                 # Phase 1 output
├── checklists/
│   └── requirements.md           # Spec quality checklist (from /ai1st-po-specify)
└── tasks.md                      # Phase 2 output (/ai1st-dev-tasks — NOT this file)
```

### Source code (within `project-repos/world-cup-madness/`)

```
app/
├── (participant)/
│   ├── leaderboard/page.tsx                # NEW — Server Component, initial snapshot + hydrates client subscriber
│   ├── dashboard/page.tsx                  # MODIFIED — adds <RankWidget/> above upcoming-matches widget
│   └── ... (existing routes from features 001/002/003)
└── (admin)/                                # (no admin-only UI for this feature — same surface per FC-L6)

components/
├── leaderboard/
│   ├── LeaderboardPage.tsx                 # NEW — Server Component, composes table + tab strip + auth gate
│   ├── LeaderboardTable.tsx                # NEW — Server Component, renders the rank table from MV rows
│   ├── LeaderboardRealtime.tsx             # NEW — Client Component wrapping the table, subscribes to audit events
│   ├── StageTabStrip.tsx                   # NEW — Client Component, WAI-ARIA tabs over ?stage= URL state
│   ├── EmptyLeaderboardState.tsx           # NEW — Server Component, pre-tournament + empty-stage countdown
│   ├── ShowMyRankButton.tsx                # NEW — Client Component, paginates + scrolls to self row
│   └── ReconnectingIndicator.tsx           # NEW — Client Component, surfaces after 10s Realtime offline
├── dashboard/
│   └── RankWidget.tsx                      # NEW — Client Component, subscribes + renders rank + delta
└── ... (existing components from features 001/002/003)

lib/
├── leaderboard/
│   ├── format-rank.ts                      # NEW — pure helper, rank → "1=" / "3" rendering
│   ├── compute-delta.ts                    # NEW — pure helper, previous vs current → "↑ 3" / "↓ 1" / "—"
│   ├── stage-url-state.ts                  # NEW — pure helper, ?stage= encode/decode + valid values
│   └── countdown-time.ts                   # NEW — pure helper, format "Leaderboard opens at [time in TZ]"
├── supabase/                               # (existing; types.ts regenerated after migrations)
└── i18n/                                   # (existing; leaderboard.* namespace added)

supabase/
├── migrations/
│   ├── 0032_create_leaderboard_snapshots.sql   NEW (MV definition + indexes + RLS)
│   ├── 0033_refresh_leaderboard_rpc.sql        NEW (RPC + audit event variants + gating predicate)
│   ├── 0034_extend_scoring_triggers_refresh.sql NEW (one-line extension of feature 003 triggers + recalc-all)
│   └── 0035_leaderboard_cron.sql               NEW (pg_cron schedule)
├── functions/                                  # (no Edge Function changes for this feature)
└── seed.sql                                    (unchanged)

test/pgtap/
├── 020_mv_leaderboard_snapshots.sql        NEW (row shape, tie-breaker SQL, stage projection, idempotency)
├── 021_rls_leaderboard_snapshots.sql       NEW (participant-vs-admin row contents, privacy projection)
├── 022_refresh_leaderboard_rpc.sql         NEW (success + failure audit emission, admin gate, gating logic)
├── 023_leaderboard_cron_gating.sql         NEW (should_refresh_leaderboard() predicate at various clock states)
└── 024_scoring_trigger_mv_extension.sql    NEW (refresh invocation + decoupling on failure)

e2e/tests/
├── leaderboard-page.spec.ts                NEW (TC-L1, TC-L2, TC-L9, TC-L13, TC-L14)
├── leaderboard-pre-tournament.spec.ts      NEW (TC-L3, TC-L11)
├── leaderboard-realtime.spec.ts            NEW (TC-L4, TC-L15)
├── leaderboard-tie-breakers.spec.ts        NEW (TC-L5, TC-L6)
├── leaderboard-stage-filter.spec.ts        NEW (TC-L7, TC-L8)
├── leaderboard-dashboard-widget.spec.ts    NEW (TC-L10, TC-L11)
├── leaderboard-privacy.spec.ts             NEW (TC-L12 — DOM + Realtime payload)
├── leaderboard-mid-tournament-join.spec.ts NEW (TC-L18, TC-L19)
└── all-pages-a11y.spec.ts                  MODIFIED (TC-L16 — 3 states)

lib/i18n/messages/
├── en.json                                 MODIFIED (leaderboard.* namespace added)
├── es.json                                 MODIFIED (leaderboard.* namespace added — native-speaker review queued)
└── pt-BR.json                              MODIFIED (leaderboard.* namespace added — native-speaker review queued)

lib/leaderboard/__tests__/
├── format-rank.test.ts                     NEW (rank → "N" / "N=" mapping, all branch cases)
├── compute-delta.test.ts                   NEW (previous=null / previous=current / above / below)
├── stage-url-state.test.ts                 NEW (encode/decode/validity)
└── countdown-time.test.ts                  NEW (pre-tournament message + TZ formatting)
```

**Structure Decision**: Web application — the existing Next.js + Supabase layout from features 001/002/003 carries forward. Feature 004 adds one new top-level participant route (`/leaderboard`), one widget on `/dashboard`, and a small backend layer (1 MV, 1 RPC, 1 predicate function, 1 cron schedule, 3 triggers extended by one line each, 2 audit event variants). No new packages, no monorepo refactor.

---

## Phase 0: Outline & Research

Unknowns to resolve before writing the data model and contracts:

1. **R-1 — Materialised view refresh strategy + RLS interaction**: Confirm `REFRESH MATERIALIZED VIEW CONCURRENTLY` on a view with RLS enabled works as expected. CONCURRENTLY requires a UNIQUE index on the MV. The refresh is executed in SECURITY DEFINER context (so it reads underlying tables ignoring caller RLS); subsequent SELECTs against the MV apply RLS to the caller.
2. **R-2 — Supabase Realtime + materialised views**: Does Supabase Realtime emit change events when an MV refreshes? Standard Realtime listens via logical replication on tables. MV refresh internally TRUNCATEs + repopulates — replication output is implementation-dependent. Decision needed: subscribe to the MV directly (if supported), OR subscribe to `audit_log` rows with `event_type = 'leaderboard.refresh'` and re-fetch the MV on each event.
3. **R-3 — RLS on materialised views (PostgreSQL 15)**: PG15+ supports RLS on materialised views. Verify the syntax + behaviour: `ALTER MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY`, `CREATE POLICY` with `auth.uid()` predicates, policies fire on SELECT only. Test whether column-level RLS is available for the privacy projection, or whether we need a separate VIEW over the MV for the self-only columns.
4. **R-4 — Tie-breaker chain in SQL with shared-rank semantics**: Postgres window functions — `RANK()` (gaps after ties: 1, 1, 3), `DENSE_RANK()` (no gaps: 1, 1, 2), `ROW_NUMBER()` (sequential). Pick `RANK()`. Render `N` if `rank` is unique within the stage, else `N=`. Performance verified at 200 rows.
5. **R-5 — pg_cron gating logic**: Express "5 min during match windows, ~60 min otherwise" as a single `*/5 * * * *` schedule with internal gating via `should_refresh_leaderboard()` predicate. Decide whether to keep the gating logic inside the RPC body or pull it into a separate predicate function for testability.
6. **R-6 — Dashboard widget "delta since last finished match"**: The widget shows `↑/↓ N` relative to the previous snapshot. Options: (a) history table; (b) compare against the previous `leaderboard.refresh` audit row; (c) compute client-side from two successive subscription payloads.
7. **R-7 — Pagination strategy at 200 rows**: 25 rows/page with offset pagination, plus a "Show my rank" button that jumps to the correct page. Default value chosen at spec time (FR-L09); R-7 confirms no perf-driven need to reduce or eliminate.
8. **R-8 — Stage dimension shape in the MV**: UNION ALL across 6 sub-selects (one per stage including `'all'`) vs cross-join on a stage enum. UNION ALL chosen for SQL clarity and the ability to apply different WHERE clauses per stage (`final-*` sources excluded for non-`'all'` stages per FC-L4).

Each item gets a `## R-N` block in `research.md` with Decision / Rationale / Alternatives. No NEEDS CLARIFICATION items remain after R-1 through R-8 close.

**Output**: `research.md` (Phase 0)

---

## Phase 1: Design & Contracts

**Prerequisites**: `research.md` complete.

### Artifacts produced

1. **`data-model.md`** — Materialised view `leaderboard_snapshots` definition (the `SELECT` defining each `(participant_id, stage)` row); the UNIQUE index required for `REFRESH CONCURRENTLY`; secondary indexes; RLS policies for the MV; `refresh_leaderboard()` RPC body pseudo-code (refresh + audit + exception-trapped failure path); `should_refresh_leaderboard()` predicate function; two new `audit_log.event_type` enum values + their column populations; pg_cron schedule SQL; one-line extension to feature 003's `calculate_match_points()`, `calculate_final_points()`, and `recalculate_all_scores()`.

2. **`contracts/`** — Per-surface contracts (5 files):
   - `mv-leaderboard-snapshots.md` — MV SELECT definition, column types, refresh semantics, RLS policies, tie-breaker RANK() clause, stage dimension via UNION ALL
   - `rpc-refresh-leaderboard.md` — RPC contract: admin-only via `is_admin_user()`; cron-invoked via `cron.schedule`; body + audit emission + idempotency + error envelope + pgTAP coverage
   - `cron-leaderboard-refresh-tick.md` — `pg_cron` schedule contract: `*/5 * * * *` with `should_refresh_leaderboard()` gating
   - `audit-event-leaderboard-refresh.md` — Schema population for the new `event_type` values; FK to `scoring_runs.id` semantics (set for trigger paths, NULL for cron + admin paths)
   - `realtime-channel-leaderboard-snapshots.md` — Subscription pattern via audit-event proxy; payload shape; reconnect strategy

3. **`quickstart.md`** — Local dev walkthrough: applying migrations 0032-0035; verifying the MV materialises; manually triggering a refresh via `SELECT refresh_leaderboard()`; verifying audit + Realtime emission; verifying the pg_cron schedule fires; running the leaderboard Playwright suite.

4. **Stack constitution update** — Add to `constitution-backend.md` §I.1:
   - "Materialised view with RLS" row (PG15+; `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` on MVs)
   - "Realtime over materialised view" row (subscribe to `audit_log` event proxy + re-fetch; FR-L16 / FC-L3)
   - "pg_cron gating predicate pattern" row (separate `should_refresh_*()` function for testability)

   Frontend constitution: no new rows; reuses the existing data-table + tab-strip + Realtime subscription patterns.

### Phase 1 design moves (informing the artifacts above)

- **MV column projection**: 8 columns per row — `participant_id UUID`, `stage TEXT` (`'all'` or one of `{group, r16, quarter, semi, final}`), `display_name TEXT`, `total_points INTEGER`, `exact_hits INTEGER`, `outcome_hits INTEGER`, `final_points INTEGER`, `rank INTEGER` (via `RANK() OVER (PARTITION BY stage ORDER BY total_points DESC, exact_hits DESC, outcome_hits DESC, final_points DESC)`).
- **Stage dimension via UNION ALL (R-8)**: the MV SELECT is `UNION ALL` of 6 sub-selects — one for `'all'` (every source counted) and one each for `group`, `r16`, `quarter`, `semi`, `final` (each filtering `score_events JOIN matches` to that stage; `final-*` sources excluded per FC-L4).
- **UNIQUE index for CONCURRENTLY (R-1)**: `CREATE UNIQUE INDEX leaderboard_snapshots_pk ON leaderboard_snapshots (participant_id, stage)` — required by Postgres for `REFRESH CONCURRENTLY`. Doubles as the primary lookup index for the dashboard widget.
- **RLS on MV (R-3)**: two policies on `leaderboard_snapshots`. Privacy is enforced primarily by query projection (server doesn't request the private columns for OTHER rows); RLS is defence-in-depth. pgTAP `021_*.sql` verifies the negative case.
- **`refresh_leaderboard()` body**: `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` inside a `BEGIN ... EXCEPTION WHEN OTHERS THEN ... END;` block; either branch writes one `audit_log` row. Includes the gating short-circuit when invoked from cron context.
- **One-line extension of feature 003 scoring functions**: append `BEGIN PERFORM refresh_leaderboard(); EXCEPTION WHEN OTHERS THEN NULL; END;` to each of `calculate_match_points()`, `calculate_final_points()`, `recalculate_all_scores()` (the inner EXCEPTION block is a NO-OP because `refresh_leaderboard()` writes its own failure audit row).
- **`should_refresh_leaderboard()` predicate**: pure SQL function returning BOOLEAN. Returns false if `score_events` is empty (pre-tournament short-circuit per FR-L22); otherwise returns true if any non-cancelled match has kickoff within `now() ± 90 min`, OR if the last `leaderboard.refresh` audit row is more than 60 minutes old.
- **pg_cron schedule**: `cron.schedule('leaderboard-refresh-tick', '*/5 * * * *', $$ SET LOCAL app.cron_caller = 'true'; SELECT refresh_leaderboard(); $$)`.
- **Realtime delivery (R-2)**: subscribe to `audit_log` rows filtered by `event_type = 'leaderboard.refresh'`. On each event, the client re-fetches `leaderboard_snapshots` for the active stage. Payload is tiny (~80 bytes per event); cheaper than MV-row diffs.
- **Dashboard widget delta (R-6)**: the widget subscribes to the same event stream; on each event re-fetches its own MV row and compares the new `rank` against the previous value held in component state. First load → `—`. Server-rendered initial state pulls the participant's row from the MV via `lib/supabase/server.ts`.

### Re-evaluate Constitution Check post-design

(Performed after Phase 1 artifacts land — see "Post-design re-check" at the bottom of this plan. Expected: all checks still ✓ with no new violations; three new constitution-backend rows added.)

**Output**: `data-model.md`, `contracts/*` (5 files), `quickstart.md`, updated stack constitution.

---

## Phase 2: Task Planning Approach

*This section describes what `/ai1st-dev-tasks` will do — DO NOT execute during /plan.*

**Task Generation Strategy**:

- Load `.ai/2_templates/tasks-template.md` as base.
- Generate tasks from Phase 1 design docs.
- Each migration → one task; migrations 0032→0035 enforce order via natural ordering.
- Each pgTAP file → one task tagged [DB][TEST].
- `refresh_leaderboard()` RPC + `should_refresh_leaderboard()` predicate → tasks in migration 0033 plus contract-aligned pgTAP tests in `022_*.sql` + `023_*.sql`.
- Scoring trigger extension → one task in migration 0034 plus pgTAP test in `024_*.sql` (asserts: success path writes audit row + MV refreshed; failure path writes audit row + scoring commits + MV unchanged).
- pg_cron schedule → one task in migration 0035.
- Each pure helper in `lib/leaderboard/` → one task plus its `__tests__` Jest spec [P]; 4 helpers in parallel.
- Each Server / Client Component → one task tagged [UI].
- Each Playwright spec → one task tagged [TEST]; mark [P] where independent.
- i18n keys (leaderboard.* namespace) → one task per locale (3 in parallel) tagged [UI].
- README + dod-verification refresh → final-phase task tagged [I].

**Ordering Strategy**:

- Migrations first (MV + RPC + scoring extension + cron in that order).
- pgTAP tests for MV + RLS + RPC + cron + scoring extension next (lock down DB invariants).
- Pure helpers + their Jest tests (no UI dependency, all parallel via [P]).
- Server Components (page + initial table render) — depend on regenerated types + helpers.
- Client Components — depend on RPCs being callable + Realtime subscription pattern.
- Playwright specs last per surface; the Realtime spec requires the page + scoring trigger end-to-end.
- i18n key additions can run in parallel with all UI work.

**Estimated Output**: ~35-45 tasks in `tasks.md`. (Smaller than feature 003 because: 1 MV vs 5 tables; 1 RPC vs 4; no Edge Function changes; reuse of established UI patterns.)

**IMPORTANT**: This phase is executed by `/ai1st-dev-tasks`, NOT by `/ai1st-dev-plan`.

---

## Dependencies Analysis

### Prerequisites

*What must exist before this feature can be implemented.*

| Dependency | Source | Status | Notes |
|---|---|---|---|
| `score_events` table + 9 source enum values | Feature 003 | Required | The MV aggregates from here. |
| `participants` table + RLS | Feature 001 | Required | LEFT-joined for display_name; `status='active'` filter. |
| `matches` table + `stage` column | Feature 002 | Required | Used for the stage dimension of the MV. |
| `scoring_runs` table | Feature 003 | Required | FK target for trigger-initiated `leaderboard.refresh` audit rows. |
| `audit_log` table | Feature 001 | Required | Two new `event_type` enum values added by migration 0033. |
| `is_admin_user()` predicate | Feature 001 migration 0010 | Required | Gates the `refresh_leaderboard()` RPC. |
| Scoring triggers + recalc-all RPC | Feature 003 | Required | Extended (one-line each) by migration 0034. |
| `pg_cron` extension | Feature 003 (already enabled) | Required | Used for `leaderboard-refresh-tick` schedule. |
| `@supabase/supabase-js` Realtime client | Feature 002 | Required | Already in the bundle; subscription pattern reused. |
| Hand-rolled Accept-Language + i18n namespace pattern | Feature 001 ADR-013 | Required | `leaderboard.*` namespace added. |

### Provides (to other features)

*What this feature enables for downstream use cases.*

| Output | Used By | Description |
|---|---|---|
| `leaderboard_snapshots` materialised view | Future "comeback narratives" feature (rich-row variant), future per-stage analytics | The aggregation surface generalises; richer columns can be added with a migration rather than rebuilding. |
| `refresh_leaderboard()` RPC + audit event variants | Feature 005 (ops dashboards) | Operator surfacing of refresh health alongside `all_runs` (sync + scoring + leaderboard refresh in one place). |
| Realtime-over-audit-event pattern | Future Realtime-driven surfaces (live match-status ticker, etc.) | Cheap, reliable pattern: subscribe to audit rows + re-fetch authoritative state on each event. |
| Tie-breaker chain as MV columns | Future "tie-breaker explainer" tooltip (engagement polish) | Each tie-breaker column already populated; UI can surface "you ranked above X because more exact hits". |

---

## Work Streams

### Stream Definitions

| Stream | Tag | Scope | Typical Executor |
|---|---|---|---|
| Database | [DB] | Migrations 0032-0035, pgTAP tests 020-024, MV definition, RLS policies, RPC, cron schedule | Direct edits / Agent for migrations |
| Frontend UI | [UI] | Page, table, tab strip, widget, helpers, i18n keys, Jest unit tests | Agent dispatched [P] for independent components |
| End-to-end testing | [TEST] | 8 new Playwright specs + a11y extension | Agent dispatched [P] for independent specs |
| Integration | [I] | README updates, dod-verification refresh, final pristine sweep | Direct + Agent |

### Active Streams for This Feature

- [x] **[DB]** — 4 new migrations, 5 new pgTAP files, RLS for 1 MV, 1 new RPC, 1 predicate, 1 cron schedule, scoring trigger extensions
- [x] **[UI]** — 1 new page, 1 modified page, 7 components, 4 pure helpers, 3 i18n namespace additions
- [x] **[TEST]** — 8 new Playwright specs + a11y sweep extension
- [ ] **[INT]** — None (no Edge Function changes)
- [ ] **[INFRA]** — None
- [x] **[I]** — README + dod-verification.md for feature 004

### Stream Dependencies

- [UI] depends on [DB] for: regenerated `lib/supabase/database.types.ts` after migration 0032 applies (adds `leaderboard_snapshots` to the type surface)
- [TEST] depends on: [UI] and [DB] implementations
- [DB] internal ordering: 0032 (MV + RLS) → 0033 (RPC + audit events + predicate) → 0034 (scoring trigger extension) → 0035 (cron schedule). Each depends on the previous.
- [I] depends on: every other stream completing

---

## Complexity Tracking

*No constitution violations.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(none)* | — | — |

---

## Use Case Specific NFRs

*Extracted from spec.md §5 NFR-L1..NFR-L7 and consolidated for traceability.*

### Performance

| Requirement | Target | Measurement |
|---|---|---|
| `/leaderboard` first paint | ≤ 1 s @ 200 active participants | Lighthouse CI + Playwright timing in `leaderboard-page.spec.ts` |
| Realtime rank update visible after scoring trigger commit | ≤ 5 s end-to-end | `leaderboard-realtime.spec.ts` (TC-L4) end-to-end timing assertion |
| `REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots` | ≤ 500 ms @ 200 participants × 6 stages | pgTAP `020_*.sql` timing assertion with seeded 200-participant fixture |
| Stage-tab switch perceived latency | ≤ 200 ms | `leaderboard-stage-filter.spec.ts` timing |

### Reliability

| Requirement | Target | Measurement |
|---|---|---|
| Refresh failure decoupled from scoring commit | Scoring still commits + `leaderboard.refresh_failed` audit row written | pgTAP `024_*.sql` injects refresh failure + asserts scoring committed + audit row present |
| Cron self-healing in quiet periods | Stale MV recovers within 60 min without admin action | pgTAP `023_*.sql` exercises the gating predicate at various clock states |
| Concurrent refresh handling | Two concurrent `refresh_leaderboard()` invocations succeed (Postgres CONCURRENTLY queues internally) | pgTAP `022_*.sql` (within-test serialised; Playwright integration test for true concurrency from two browser sessions) |

### Accessibility

| Requirement | Target | Measurement |
|---|---|---|
| `/leaderboard` (every state) | WCAG 2.1 AA, zero axe-core violations | `all-pages-a11y.spec.ts` extension — 3 states (populated, pre-tournament, stage-filtered) |
| `<RankWidget/>` on `/dashboard` | Re-audited as part of existing dashboard a11y test | Existing test extended to scan with the widget mounted |

### Scalability

| Requirement | Target | Measurement |
|---|---|---|
| Active participant ceiling | 200 (FA-3 carry-over) | MV row count and refresh budget sized for this; capacity test in pgTAP `020_*.sql` |
| Realtime subscribers | 50+ concurrent without dropped events | Manual load test against Pro-tier Supabase; documented in `dod-verification.md` |

### Security & Privacy

| Requirement | Target | Measurement |
|---|---|---|
| Privacy: other-participant row exposes only rank + name + active-tab points | No `exact_hits`/`outcome_hits`/`final_points`/per-source data in DOM or Realtime payload | `leaderboard-privacy.spec.ts` (TC-L12) + pgTAP `021_*.sql` RLS test |
| Admin parity: admin sees the same surface | No admin-only columns or impersonation | `leaderboard-privacy.spec.ts` extended for admin role |

---

## Acceptance Criteria

### BRD Traceability

*BRD references: FR-013 (Leaderboard), FR-014 (Personal breakdown — read-side query patterns shared), FR-018 (Audit trail) — all from `docs/architecture/high-level-architecture.md` + `docs/architecture/scoring-model.md`.*
*This project has no design-system.md or Figma references; design ships with implementation.*

### Page + Widget

- [FR-L01] Authenticated participant can load `/leaderboard` and see every active participant ranked by total points {Source: FR-013}
- [FR-L02] Only rank + display name + active-tab points exposed for OTHER participants {Source: FR-018 (data-minimisation)}
- [FR-L03] Tie-breaker chain (#1 total → #2 exact hits → #3 outcome hits → #4 final points → shared rank) applied via `RANK() OVER (...)` {Source: scoring-model.md §7.4}
- [FR-L04] Stage filter with tab strip (`All`/`Group`/`R16`/`Quarter`/`Semi`/`Final`); active tab persists via `?stage=` URL query {Source: Round 1 Q1}
- [FR-L05] Stage-filtered ranking counts only that stage's match points; `final-*` sources included only when `All` is active {Source: Round 2 Q1}
- [FR-L06] Supabase Realtime subscription updates the visible table within 5 s of MV refresh {Source: Round 1 Q2}
- [FR-L07] Pre-tournament countdown replaces rankings when no `score_events` row exists {Source: Round 1 Q4}
- [FR-L08] `<RankWidget/>` on `/dashboard` shows rank + delta + pre-tournament fallback {Source: Round 2 Q2}
- [FR-L09] Pagination at 25 rows/page + "Show my rank" anchor {Source: AI/Specify}
- [FR-L10] `/leaderboard` requires authenticated active participant; otherwise 307 redirect to `/` {Source: AI/Specify}

### Data + Refresh

- [FR-L11] `leaderboard_snapshots` MV is the sole read surface for rankings {Source: FC-L1}
- [FR-L12] Successful refresh writes `leaderboard.refresh` audit row (duration, participant_count, scoring_runs FK) {Source: AI/Specify}
- [FR-L16] Realtime subscription scope is the audit-event proxy (per R-2), not `score_events` {Source: FC-L3}
- [FR-L17] Stage tab switch cancels the prior Realtime subscription {Source: AI/Specify}
- [FR-L18] Realtime disconnect → exponential backoff + `Reconnecting…` chip after 10 s {Source: AI/Specify}
- [FR-L19] Admin `refresh_leaderboard()` RPC available {Source: Session 2026-06-01 Q2}
- [FR-L20] Refresh outcome (success OR failure) always produces exactly one audit row with required fields {Source: Session 2026-06-01 Q2}
- [FR-L21] `pg_cron` schedule `leaderboard-refresh-tick` at `*/5 * * * *` with internal gating per `should_refresh_leaderboard()` {Source: Session 2026-06-01 Q3}
- [FR-L22] Cron skips refresh when no `score_events` row exists (pre-tournament no-op) {Source: Session 2026-06-01 Q3}

### Cross-cutting

- [FR-L13] `leaderboard.*` i18n namespace in en / es / pt-BR {Source: AI/Specify (carry-over)}
- [FR-L14] WCAG 2.1 AA across `/leaderboard` (all states) + `/dashboard` widget {Source: AI/Specify (carry-over)}
- [FR-L15] Usable at 360 px viewport (mobile minimum) {Source: AI/Specify}

### Quality

- [NFR-L1] First paint ≤ 1 s @ 200 participants
- [NFR-L2] Realtime rank update visible ≤ 5 s of scoring trigger commit
- [NFR-L3] MV refresh ≤ 500 ms @ 200 participants × 6 stages
- [NFR-L4] WCAG 2.1 AA: zero axe-core violations across page states
- [NFR-L5] Stage-tab switch ≤ 200 ms perceived latency
- [NFR-L6] Privacy boundary: no other-participant data beyond rank + name + active-tab total in DOM or wire
- [NFR-L7] 50+ concurrent Realtime subscribers supported

---

## Post-design Constitution Re-check

*Performed 2026-06-01 after research.md, data-model.md, contracts/ (5 files), and quickstart.md landed.*

**Status**: **PASS** — no new violations; all Pre-design checks remain ✓.

**Design choices re-validated against the constitutions:**

| Pre-design check | Post-design evidence |
|---|---|
| §1.1 Modular monolith with DB-enforced rules | Tie-breaker chain in `RANK() OVER (...)` SQL clause (data-model.md §2.3); refresh decoupling enforced inside `refresh_leaderboard()` EXCEPTION block (data-model.md §3.2); stage exclusion enforced in MV SELECT (data-model.md §2.2). UI computes nothing authoritative. |
| §1.3 No silent failures | Every refresh attempt writes exactly one audit row (success or failed) — `audit-event-leaderboard-refresh.md`. Realtime disconnect surfaces UI indicator (FR-L18). Scoring trigger extension's outer EXCEPTION block is a NO-OP that intentionally swallows nothing — `refresh_leaderboard()` writes its own failure audit row, so the outer block has nothing to do. |
| §2 service_role never in client | `refresh_leaderboard()` is SECURITY DEFINER + admin-gated. pg_cron invokes with elevated postgres role. Browser uses anon JWT + RLS-restricted MV SELECT only. |
| §4 Testing — pgTAP + Jest + Playwright | pgTAP `020-024` cover MV + RLS + RPC + cron + scoring extension. Jest covers 4 pure helpers. Playwright covers 8 specs + a11y extension. |
| Frontend §IV.1 Server Components by default | `/leaderboard/page.tsx` + `<LeaderboardPage/>` + `<LeaderboardTable/>` + `<EmptyLeaderboardState/>` are Server Components. Client Components: `<LeaderboardRealtime/>`, `<StageTabStrip/>`, `<RankWidget/>`, `<ShowMyRankButton/>`, `<ReconnectingIndicator/>` — each justified by Realtime subscription, URL state, or interactivity. |
| Backend §I.1 Concurrency primitive | NOT used here — `REFRESH MATERIALIZED VIEW CONCURRENTLY` is Postgres-native serialised. R-4 documents the decision. |
| Backend §I.1 RLS on materialised views | New constitution-backend.md row added (PG15+ feature). MV-level RLS exercised by pgTAP `021_*.sql`. |
| Backend §VI Security — RLS + projection | Other-participant rows hide `exact_hits`/`outcome_hits`/`final_points` via query projection (server side) backed by RLS (pgTAP). FC-L3 enforces same boundary on the Realtime wire — subscription scope is the audit event, not score_events. |
| Backend §I.1 Scoring trigger pattern (carry-over) | Feature 003 trigger functions get a one-line tail extension that is exception-trapped; scoring semantics unchanged. Documented in migration 0034 + data-model.md §4. |

**New surface introduced post-design that warranted a constitution add:**

- **Materialised view with RLS** (PG15+) — added to constitution-backend.md §I.1.
- **Realtime over audit-event proxy** — added to constitution-backend.md §I.1.
- **pg_cron gating predicate pattern** — added to constitution-backend.md §I.1.

**Frontend constitution**: no new rows; the page reuses the existing data-table + tab-strip + Realtime subscription patterns already documented.

**Violations found**: None.
**Remediation**: N/A.

**Ready for `/ai1st-dev-tasks`**.

---

*Based on Constitution — see `.ai_project_memory/constitution.md`.*
