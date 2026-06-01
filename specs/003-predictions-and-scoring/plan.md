# Implementation Plan: Predictions and Scoring

**Branch**: `003-predictions-and-scoring` | **Date**: 2026-05-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/003-predictions-and-scoring/spec.md`

## Summary

Close the WCM core loop — *predict → wait for kickoff → see your score* — with three tightly-coupled write paths: (1) participant match-score predictions on `/matches/[id]` with a strict-greater-than 60-min lock enforced server-side by a Postgres RPC; (2) tournament-level final predictions (champion, runner-up, top scorer, best player) on `/predictions/final`, locked simultaneously at first kickoff; (3) a fully-derived scoring engine — `AFTER INSERT/UPDATE` Postgres triggers on `match_results` and on `tournament_config`/`final_predictions` rebuild `score_events` atomically via DELETE-then-INSERT, so admin corrections regenerate scores transactionally with the source-data write. Players come from a new table populated by extending feature 002's `sync-matches` Edge Function with a squad-fetch step. Scoring observability lands in a new `scoring_runs` table unified with `integration_runs` via an `all_runs` view (`security_invoker=true`). Breakdown UI ships at `/predictions/breakdown`; leaderboard view is explicitly deferred to feature 004.

## Implementation Conflicts

**Status**: No Conflicts Found

**Conflict check completed**: 2026-05-22. Checked against `specs/001-authentication-and-participant/plan.md` (auth + participant provisioning) and `specs/002-match-catalog-read/plan.md` (match catalog read path + sync). Feature 003 *adds* tables (`predictions`, `final_predictions`, `score_events`, `players`, `scoring_runs`), *extends* `tournament_config` with four nullable winner FKs, and *extends* the existing `sync-matches` Edge Function with a `squad-sync` step. The `/matches/[id]` page from feature 002 is modified to mount the prediction form below the existing read-only detail block (its existing Server Component shape stays). The existing audit trigger on `participants` from feature 001 is not modified; new audit-log rows for `prediction.created` / `prediction.updated` / `admin.*` / `scoring.*` are written by the new SECURITY DEFINER RPCs / triggers directly (same pattern as feature 001's `update_display_name`). No conflicting defaults, validation rules, or data formats.

**Implementation Conflicts Identified**: None.

**Conflict Check Date**: 2026-05-22
**Checked Against**: `specs/001-authentication-and-participant/plan.md`, `specs/001-authentication-and-participant/data-model.md`, `specs/002-match-catalog-read/plan.md`, `specs/002-match-catalog-read/data-model.md`

---

## Technical Context

**Language/Version**: TypeScript 6.x (Next.js App Router); SQL (PostgreSQL 15+); Deno (Supabase Edge Function runtime — squad-sync extension)
**Primary Dependencies**:
- Frontend: Next.js 15.5.x (App Router), React 19.x, next-intl 4.x, Tailwind v4, `@supabase/ssr` 0.10.x
- Backend: Supabase Postgres 15+ (PostgREST auto-API + new RPCs + new triggers), `@supabase/supabase-js` 2.x
- New for this feature: none — reuses the existing IANA combobox pattern (`<TimezonePicker/>`) as the template for `<PlayerPicker/>`; the prediction form is plain HTML inputs + a Client Component for optimistic UI
**Storage**: PostgreSQL 15+ managed by Supabase Cloud. New tables: `predictions`, `final_predictions`, `players`, `score_events`, `scoring_runs`. Extension: `tournament_config` gains four nullable FK columns (`champion_team_id`, `runner_up_team_id`, `top_scorer_player_id`, `best_player_player_id`). New view: `all_runs` (UNION over `integration_runs` + `scoring_runs`, `security_invoker=true`).
**Testing**: pgTAP for SQL/RLS/trigger semantics, Jest for pure-function units, Playwright (chromium + accessibility projects) for E2E + a11y. Same suite layout as features 001/002.
**Target Platform**: Next.js → Vercel (frontend); Supabase Cloud (Postgres + Edge Functions); browsers — modern evergreen Chrome / Firefox / Safari / Edge.
**Project Type**: Web application (Next.js App Router + Supabase Postgres + extended Supabase Edge Function).
**Performance Goals**:
- Match-scoring trigger ≤ 5 seconds for one match × 200 active participants (NFR-P2)
- `recalculate_all_scores()` RPC ≤ 2 minutes for 104 matches × 200 participants (NFR-P3)
- Prediction write < 500 ms p95 (NFR-P1)
- `/predictions/breakdown` initial render < 1 second on warm cache (carry-over from NFR-M1 pattern)
**Constraints**:
- Lock decisions use server-side trusted time only (NFR-P4 / BR-LOCK-001) — strict-greater-than comparator (FC-1)
- Scoring trigger transactional with the `match_results` UPDATE (FC-2) — if scoring fails, the score correction rolls back too
- `score_events` writes restricted to `SECURITY DEFINER` trigger functions (FC-3 / FR-P24); no role has direct INSERT/UPDATE
- All admin overrides re-derive scoring via triggers — no direct `score_events` writes (Round 2 Q9 resolution)
- WCAG 2.1 AA across every new surface (carry-over from feature 002 a11y commitment)
**Scale/Scope**: Up to 200 active participants × 104 matches = max 20,800 match-scoring `score_events` rows + up to 800 final-prediction rows (4 per participant). ~830 player rows from squad sync (32 teams × ~26 each). One tournament cycle (June–July 2026 + cleanup).

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Applicable Constitution**: both (frontend + backend; this feature spans Server Components, Client Components, schema migrations, RLS, RPCs, Postgres triggers, and an Edge Function extension)

**Source Documents**:
- `../.ai_project_memory/constitution.md` (core principles)
- `../.ai_project_memory/constitution-frontend.md` (Next.js, Tailwind, i18n patterns including ADR-013)
- `../.ai_project_memory/constitution-backend.md` (Supabase, Postgres, Edge Functions patterns; partial-unique-index mutex per feature 002)

### Compliance Checklist

**Universal (constitution.md):**

- [x] **§1.1 Code Organization — Modular monolith with DB-enforced rules** — Lock enforcement and scoring engine live in Postgres functions + triggers; UI calls server-side capabilities and never owns authoritative lock or scoring logic. The breakdown page reads `score_events` directly with RLS-filtered queries; it does not recompute. ✓
- [x] **§1.1 Root directory discipline** — No new files in repo root. ✓
- [x] **§1.2 Naming conventions** — kebab-case files (`predictions/final/page.tsx`, `score-events-trigger.sql`), PascalCase components (`PredictionForm`, `FinalPredictionsForm`, `PlayerPicker`, `BreakdownTable`), snake_case SQL columns (`predicted_home_score`, `score_events`, `tournament_config.champion_team_id`). ✓
- [x] **§1.3 Error handling — No silent failures** — Every RPC raises a typed Postgres EXCEPTION on validation failure (`PREDICTION_LOCKED`, `FINAL_PREDICTIONS_LOCKED`, `check_violation` for out-of-range scores). Scoring trigger failures roll back the whole `match_results` UPDATE per FC-2. Failed scoring runs land in `scoring_runs.status='error'` with the message. ✓
- [x] **§1.4 Documentation philosophy — Comments for "why" not "what"** — Inline comments will mark only the non-obvious decisions: DELETE-then-INSERT semantics (Clarify Q1), per-action partial-unique-index mutex (carry-over from feature 002), `security_invoker=true` on the `all_runs` view. ✓
- [x] **§2 Security/Compliance — service_role never in client** — All trigger functions are `SECURITY DEFINER`; the admin `recalculate_all_scores()` RPC is gated on `is_admin_user()`; the `set_tournament_winner()` RPC same. No service_role keys reach the browser. ✓
- [x] **§2 Domain eligibility enforced at DB layer** — Participant write paths for `predictions` and `final_predictions` carry the same RLS predicate (`participants.auth_user_id = auth.uid()` with `status='active'`) used in features 001/002. ✓
- [x] **§3 Git workflow — Feature branch + conventional commits + never `--no-verify`** — Branch `003-predictions-and-scoring` created off `master`. Pre-commit hook remains active. ✓
- [x] **§4 Testing — pgTAP + Jest + Playwright; output pristine** — pgTAP for RLS on 5 new tables + view + 3 trigger semantics + idempotency + lock-boundary at exactly −60/−61/−59 min. Jest for pure helpers (prediction validation, scoring summary). Playwright for every TC-P, including the mandatory lock-boundary triplet (NFR-P4). ✓
- [x] **§4 Lock boundary tests are MANDATORY** — TC-P3/P4/P5 explicitly cover the −60 / −61 / −59 minute cases and are first-class Playwright specs. ✓

**Frontend (constitution-frontend.md):**

- [x] **§I.1 Stack: Next.js 15.x App Router + TypeScript 6.x + Tailwind v4 + next-intl 4.x + @supabase/ssr 0.10.x + server-only** — Existing stack only; no new client dependencies. The new `<PlayerPicker/>` reuses the same hand-rolled WAI-ARIA combobox pattern as feature 002's `<TimezonePicker/>`. ✓
- [x] **§IV.1 Server Components by default; "use client" only for interactivity** — `/predictions/final`, `/predictions/breakdown` are Server Components. Client Components: `<PredictionForm/>` (optimistic UI + submit), `<FinalPredictionsForm/>` (form state across 4 pickers), `<PlayerPicker/>` (combobox state). ✓
- [x] **§IV.1 Lock status as UI truth — server-rendered; never client-computed** — Lock decisions are made by the `submit_prediction()` RPC (server-side `now()`). The form *displays* a countdown for UX, but the displayed lock state is rendered by the server from the same `kickoff_utc - now()` check; on submit, the server makes the authoritative decision. Mirrors feature 002's badge derivation. ✓
- [x] **§V Server-state via supabase server client in RSC** — Breakdown page reads `score_events` via `lib/supabase/server.ts`. Form submissions go through PostgREST RPCs called from Client Components using `createBrowserClient` (already in feature 001). ✓
- [x] **§VII Accessibility WCAG 2.1 AA** — Added to `all-pages-a11y.spec.ts` covering 2 new surfaces (`/predictions/final` with picker open + `/predictions/breakdown`). Prediction form on the existing `/matches/[id]` page is re-audited as part of the existing TC-M3 detail-page a11y test. ✓ (carry-over commitment)
- [x] **§IX Anti-patterns — no client-side lock calculation; no useEffect for initial data fetch; no service_role in client bundles** — The submit RPC is the authoritative lock; the displayed countdown is a hint, not a gate. Initial breakdown data is fetched in the Server Component. service_role stays server-side via `lib/supabase/admin.ts`. ✓
- [x] **i18n: hand-rolled Accept-Language detection per ADR-013** — Add `predictions.*` namespace keys to `messages/{en,es,pt-BR}.json`; no new locale machinery. ✓

**Backend (constitution-backend.md):**

- [x] **§I.1 Stack: Supabase Postgres + PostgREST + RPCs + Deno Edge Functions + pgTAP** — Existing stack; no new platform components. ✓
- [x] **§I.1 Concurrency primitive: partial unique index** — Reused from feature 002's resolution; the `scoring_runs` table will use the same `WHERE finished_at IS NULL` partial-unique-index pattern (scoped per-action) to serialise `recalculate_all_scores()` so two concurrent admin clicks can't run simultaneously. Per-match trigger paths don't need it (Postgres row-level locks on `match_results` serialise them naturally). ✓
- [x] **§IV API Design — PostgREST + RPC; business rules in DB** — Prediction submit / final-prediction submit / set-tournament-winner / recalculate-all are RPCs. Scoring is trigger-driven, not RPC-driven. Lock validation is inside the RPC (atomic with the write). ✓
- [x] **§V Data Access — no ORM; Supabase client + generated types** — Queries go through `@supabase/ssr` after `database.types.ts` regeneration following migrations. ✓
- [x] **§VI Security — service_role only server-side; RLS on all reads** — Participant write surfaces (`predictions`, `final_predictions`) use `auth.uid()`-derived predicates. Admin reads of `score_events` / `scoring_runs` use the `is_admin_user()` predicate (carry-over from feature 001 migration 0010). Admin write RPCs (`set_tournament_winner`, `recalculate_all_scores`) explicitly call `is_admin_user()` before any write. ✓
- [x] **§VII Error handling — structured logging + integration retry** — Scoring trigger errors propagate to the `match_results` UPDATE (transactional rollback); the admin sees the original state. The squad-sync extension to the Edge Function reuses feature 002's retry helper + `integration_runs` telemetry. ✓
- [x] **§IX Anti-patterns — no provider raw stored, no service_role in browser** — Player data is normalised before storage. Trigger functions are SECURITY DEFINER; service_role only used by the Edge Function and the admin RPCs (server-side). ✓

**Violations Found**: None.

**Remediation**: N/A.

---

## Project Structure

### Documentation (this feature)

```
specs/003-predictions-and-scoring/
├── spec.md                       # Feature specification (input)
├── plan.md                       # This file (/ai1st-dev-plan output)
├── research.md                   # Phase 0 output
├── data-model.md                 # Phase 1 output
├── contracts/                    # Phase 1 output (RPC + trigger contracts)
├── quickstart.md                 # Phase 1 output
├── checklists/
│   └── requirements.md           # Spec quality checklist (from /ai1st-po-specify)
└── tasks.md                      # Phase 2 output (/ai1st-dev-tasks — NOT this file)
```

### Source code (within `project-repos/world-cup-madness/`)

```
app/
├── (participant)/
│   ├── matches/[id]/page.tsx              # MODIFIED — mount <PredictionForm/> below detail block
│   ├── predictions/
│   │   ├── final/page.tsx                 # NEW — Server Component, 4 pickers + submit
│   │   └── breakdown/page.tsx             # NEW — Server Component, per-match score events table
│   ├── dashboard/page.tsx                 # MODIFIED — nav link to /predictions/final + /predictions/breakdown
│   └── ... (existing routes from features 001/002)
└── (admin)/                               # (no admin UI in this feature — service-role / Supabase Studio for MVP)

components/
├── auth/                                  # (unchanged from feature 001)
├── matches/                               # (unchanged from feature 002)
├── profile/                               # (unchanged from feature 002)
├── predictions/
│   ├── PredictionForm.tsx                 # NEW — Client Component, optimistic UI, calls submit_prediction RPC
│   ├── LockedPredictionDisplay.tsx        # NEW — Server Component, readonly view post-lock
│   ├── FinalPredictionsForm.tsx           # NEW — Client Component, 4 pickers w/ partial-submit support
│   ├── TeamPicker.tsx                     # NEW — Server-rendered select over teams (32 options — small enough)
│   ├── PlayerPicker.tsx                   # NEW — Server-Component wrapper; renders disabled vs combobox
│   ├── PlayerPickerCombobox.tsx           # NEW — Client Component, WAI-ARIA combobox (mirrors <TimezonePicker/>)
│   ├── PlayerPickerDisabled.tsx           # NEW — Server Component, visible-but-disabled w/ "rosters pending" notice
│   └── BreakdownTable.tsx                 # NEW — Server Component, lists per-match score events + total

lib/
├── predictions/
│   ├── validate-prediction.ts             # NEW — pure helper, score range + outcome derivation (used by both UI + scoring)
│   ├── scoring-display.ts                 # NEW — pure helper, source-tag → human label mapping
│   └── lock-state.ts                      # NEW — pure helper mirroring feature 002 lock-badge for the prediction form UI
├── supabase/                              # (existing; types.ts regenerated after migrations)
└── i18n/                                  # (existing; predictions.* namespace added)

supabase/
├── migrations/
│   ├── 0019_create_predictions.sql                NEW
│   ├── 0020_create_final_predictions.sql          NEW
│   ├── 0021_create_players_and_seed_columns.sql   NEW
│   ├── 0022_extend_tournament_config_winners.sql  NEW (4 nullable FK columns)
│   ├── 0023_create_score_events.sql               NEW
│   ├── 0024_create_scoring_runs_and_all_runs.sql  NEW (table + view + per-action partial unique index)
│   ├── 0025_match_scoring_trigger.sql             NEW (calculate_match_points + trigger + audit)
│   ├── 0026_final_scoring_trigger.sql             NEW (calculate_final_points + 2 triggers + audit)
│   ├── 0027_prediction_rpcs.sql                   NEW (submit_prediction, submit_final_prediction, set_tournament_winner, recalculate_all_scores)
│   └── 0028_prediction_rls.sql                    NEW (RLS for 5 new tables + view)
├── functions/
│   └── sync-matches/
│       ├── index.ts                       MODIFIED (add squad-sync step in the main flow)
│       ├── provider/football-data-v4.ts   MODIFIED (add fetchSquads() returning normalised PlayerRow[])
│       ├── __fixtures__/v4-sample.json    UNCHANGED
│       ├── __fixtures__/v4-squads-sample.json  NEW (32 teams × 5-8 players each for fixture-mode squad sync)
│       └── README.md                      MODIFIED (squad-sync env var + invocation notes)
└── seed.sql                               (unchanged)

test/pgtap/
├── 010_rls_predictions.sql                NEW
├── 011_rls_final_predictions.sql          NEW
├── 012_rls_score_events.sql               NEW (incl. admin-cannot-direct-INSERT test for FR-P24)
├── 013_rls_players.sql                    NEW
├── 014_rls_scoring_runs_and_all_runs.sql  NEW (incl. security_invoker semantics check)
├── 015_match_scoring_trigger.sql          NEW (DELETE-then-INSERT semantics, cancelled-match path, no-prediction path)
├── 016_final_scoring_trigger.sql          NEW (tournament_config + final_predictions trigger paths, FK cascade)
├── 017_prediction_rpcs.sql                NEW (lock boundary in SQL, range validation, audit log emission)
└── 018_scoring_idempotency.sql            NEW (DB-layer idempotency + recalculate_all_scores per-action mutex)

e2e/tests/
├── predictions-submit.spec.ts                       NEW (TC-P1, TC-P2, TC-P6, TC-P21)
├── predictions-lock-boundary.spec.ts                NEW (TC-P3, TC-P4, TC-P5 — mandatory triplet)
├── predictions-final-submit.spec.ts                 NEW (TC-P7, TC-P8, TC-P9)
├── predictions-final-player-picker.spec.ts          NEW (TC-P10, TC-P11)
├── scoring-match-points.spec.ts                     NEW (TC-P12, TC-P13, TC-P14, TC-P15, TC-P16)
├── scoring-idempotency.spec.ts                      NEW (TC-P17 — end-to-end through the trigger)
├── scoring-admin-correction.spec.ts                 NEW (TC-P18, TC-P22)
├── scoring-final-points.spec.ts                     NEW (TC-P19)
├── predictions-rls.spec.ts                          NEW (TC-P20)
└── all-pages-a11y.spec.ts                           MODIFIED (add /predictions/final w/ picker open + /predictions/breakdown)

lib/i18n/messages/
├── en.json                                MODIFIED (predictions.* namespace added)
├── es.json                                MODIFIED (predictions.* namespace added — native-speaker review queued)
└── pt-BR.json                             MODIFIED (predictions.* namespace added — native-speaker review queued)

lib/predictions/__tests__/
├── validate-prediction.test.ts            NEW (range, outcome enum, scoring formula unit tests)
├── scoring-display.test.ts                NEW (source → label mapping across all enum values)
└── lock-state.test.ts                     NEW (boundary cases mirroring TC-P3/P4/P5 at the pure-helper layer)
```

**Structure Decision**: Web application — the existing Next.js + Supabase layout from features 001 + 002 carries forward. Feature 003 adds two new top-level participant routes (`/predictions/final`, `/predictions/breakdown`), one modification to `/matches/[id]`, and a substantial backend layer (5 new tables, 1 view, 6 functions, RLS for all of them). No new packages, no monorepo refactor.

---

## Phase 0: Outline & Research

Unknowns to resolve before writing the data model and contracts:

1. **R-1 — Postgres trigger fan-out cost for match scoring**: When the trigger fires for one match × 200 participants, what's the realistic execution time? `AFTER UPDATE FOR EACH ROW EXECUTE FUNCTION calculate_match_points(NEW.match_id)` runs inside the same transaction as the `match_results` UPDATE — confirm that 200 INSERTs to `score_events` complete within NFR-P2's 5-second budget without lock contention.
2. **R-2 — `recalculate_all_scores()` transaction strategy**: 104 matches × 200 participants = 20,800 score_events rows touched. Single transaction (worst case ~30s lock on `score_events`) vs per-match commit loop (no long lock, but partial-recalc state visible mid-run)? Decide which fits NFR-P3 + admin-UX expectations.
3. **R-3 — DELETE-then-INSERT atomicity in trigger** (Clarify Q1): Verify that `DELETE FROM score_events WHERE match_id = $1 AND source LIKE 'match-%'; INSERT ... ;` inside a single trigger function is atomic from the perspective of any other reader (i.e. a participant's breakdown page query never sees the intermediate "0 rows for this match" state).
4. **R-4 — Per-action partial-unique-index mutex**: Feature 002's mutex is `((1)) WHERE finished_at IS NULL` — at-most-one-in-flight globally. The new `scoring_runs` table needs its own at-most-one-in-flight constraint. Confirm that adding a per-table partial unique index (independent of `integration_runs`'s index) is the right pattern, vs unifying both under one index on the `all_runs` view (not possible — views can't have indexes).
5. **R-5 — `all_runs` view with `security_invoker=true`** (Clarify Q3): Confirm PostgreSQL 15+ semantics — does setting `security_invoker=true` on a view correctly apply the underlying tables' RLS to the view's caller? Test with a non-admin role attempting to read `all_runs`.
6. **R-6 — Trigger interaction on FK cascade** (Clarify Q2): When `ON DELETE SET NULL` cascades from `players` into `final_predictions.top_scorer_player_id`, does the cascade fire `AFTER UPDATE` triggers on `final_predictions`? (Postgres docs say yes for `BEFORE`/`AFTER` triggers, but the trigger sees `NEW` with the NULL value — need a pgTAP test to nail this down before writing `calculate_final_points()`.)
7. **R-7 — Squad sync extension to `sync-matches`**: 32 team-squad calls at 10 req/min = 3.2 minutes worst case. Does the existing retry helper handle the longer run gracefully? Fixture-mode toggle: extend the existing `SYNC_FIXTURE_MODE=1` flag (single toggle, includes squads) or add a separate `SYNC_SQUAD_FIXTURE_MODE=1`? Decide based on operational simplicity vs flexibility.
8. **R-8 — Lock-state mirroring (UI vs RPC)**: The prediction form shows a countdown ("Locks in 2h 14m") for UX, but the *authoritative* lock is the RPC. Both must use the same `kickoff_utc - now()` semantics. Decide: extract `lock-state.ts` from feature 002's `lock-badge.ts` into a shared helper, or duplicate the logic with a comment? (Constitution §1.1 prefers duplication over wrong abstraction; the logic is identical enough that a shared helper is justified.)

Each item gets a `## R-N` block in `research.md` with Decision / Rationale / Alternatives. No NEEDS CLARIFICATION items remain after R-1 through R-8 close.

**Output**: `research.md` (Phase 0)

---

## Phase 1: Design & Contracts

**Prerequisites**: `research.md` complete.

### Artifacts produced

1. **`data-model.md`** — Schema definitions for `predictions`, `final_predictions`, `players`, `score_events`, `scoring_runs`; the `tournament_config` 4-column extension; the `all_runs` view definition with `security_invoker=true`; check constraints (`predicted_home_score BETWEEN 0 AND 20`, `champion_team_id IS DISTINCT FROM runner_up_team_id`); unique constraints (predictions on `(participant_id, match_id)`, final_predictions on `participant_id`, score_events on `(participant_id, match_id) WHERE match_id IS NOT NULL` + `(participant_id, source) WHERE match_id IS NULL`, scoring_runs partial-unique-index `((action)) WHERE finished_at IS NULL`); RLS policies in human-readable form; trigger function pseudo-code for `calculate_match_points` and `calculate_final_points`.

2. **`contracts/`** — RPC + trigger contracts:
   - `submit_prediction(p_match_id UUID, p_home INT, p_away INT)` RPC contract (lock check, range check, upsert, audit emission)
   - `submit_final_prediction(p_champion UUID?, p_runner_up UUID?, p_top_scorer UUID?, p_best_player UUID?)` RPC contract (lock check, distinctness check, upsert, audit emission)
   - `set_tournament_winner(p_item TEXT, p_id UUID)` admin RPC contract (admin gate, tournament_config update, trigger cascades to final scoring)
   - `recalculate_all_scores()` admin RPC contract (admin gate, per-action mutex acquire, per-match loop, scoring_runs telemetry)
   - `calculate_match_points(p_match_id UUID)` trigger function contract (DELETE-then-INSERT semantics, source enum, cancelled-match special case, audit emission per scoring run)
   - `calculate_final_points(p_participant_id UUID?)` trigger function contract (full sweep if NULL, single participant if provided, four-source rebuild)
   - Sample PostgREST queries the breakdown page issues (for documentation)

3. **`quickstart.md`** — Step-by-step local dev setup for feature 003: env vars (no new ones), how to seed a few predictions + a finished match to trigger scoring locally, how to verify the lock-boundary RPC behavior at −60/−61/−59 via psql, how to exercise the admin recalc RPC, how to verify the `all_runs` view returns both sync + scoring rows interleaved.

4. **Stack constitution update** — Add to `constitution-backend.md` §I.1: "View pattern" row (security_invoker=true views for cross-table operator surfaces). All other backend tech is already documented. Frontend constitution: no new rows; `<PlayerPicker/>` reuses the existing WAI-ARIA combobox row already documented for `<TimezonePicker/>`.

### Phase 1 design moves (informing the artifacts above)

- **Lock check inside the RPC**: `submit_prediction()` opens with `IF (SELECT kickoff_utc FROM matches WHERE id = p_match_id) - now() <= interval '60 minutes' THEN RAISE EXCEPTION 'PREDICTION_LOCKED' USING ERRCODE='check_violation'; END IF;` — strict-greater-than is enforced by the comparator. Same shape for `submit_final_prediction()` against `min(matches.kickoff_utc WHERE status != 'cancelled')`.
- **DELETE-then-INSERT scoring**: `calculate_match_points()` body opens with `DELETE FROM score_events WHERE match_id = p_match_id` (covers the `match-*` + `no-prediction` + `match-cancelled` sources for this match), then a single `INSERT ... SELECT` over `participants × predictions` left-joined to compute each row's points. One write per affected participant. Cancelled-match path: branch in the function on `match.status = 'cancelled'` and skip the prediction-join, just write 0s.
- **Trigger surface**: `AFTER INSERT OR UPDATE ON match_results FOR EACH ROW WHEN (NEW.status IN ('finished', 'cancelled') AND ((NEW.score_home IS NOT NULL AND NEW.score_away IS NOT NULL) OR NEW.status = 'cancelled'))`. The WHEN clause prevents the trigger from firing during the in-progress score updates.
- **Final-scoring triggers**: two triggers — `AFTER UPDATE ON tournament_config FOR EACH ROW WHEN (one of the 4 winner cols changed)` calls `calculate_final_points(NULL)` (full sweep across all participants); `AFTER UPDATE ON final_predictions FOR EACH ROW` calls `calculate_final_points(NEW.participant_id)` (single-participant rebuild). Both reuse the same body with the participant filter optional.
- **Mutex on `recalculate_all_scores()`**: insert an in-flight `scoring_runs` row with `action='admin-recalc-all'` first; if the partial unique index rejects (`23505`), return `outcome='skipped'` like the sync function does. Per-match trigger paths don't write `scoring_runs` rows (they're transactional with the source UPDATE and observability lives in `audit_log` for those).
- **Squad-sync extension**: `sync-matches` Edge Function gains a Step 8 (after the existing UPSERT step) that calls `provider.fetchSquads()` returning a flat `PlayerRow[]`, then UPSERTs into `players` on `provider_player_id`. Records count is included in the existing `integration_runs.records_processed`. Fixture mode is gated on the existing `SYNC_FIXTURE_MODE=1` flag — single toggle, includes squads (R-7 resolves toward operational simplicity).
- **Player picker UX**: `<PlayerPicker/>` is a Server Component wrapper that reads `players.count()`; if zero, it renders `<PlayerPickerDisabled/>` (Server Component with the "rosters pending" notice); if ≥1, it renders `<PlayerPickerCombobox/>` (Client Component, hand-rolled WAI-ARIA combobox modelled on `<TimezonePicker/>`).

### Re-evaluate Constitution Check post-design

(Performed after Phase 1 artifacts land — see "Post-design re-check" section at the bottom of this plan once research.md + data-model.md + contracts/ are written. Expected: all checks still ✓ with no new violations.)

**Output**: `data-model.md`, `contracts/*`, `quickstart.md`, updated stack constitution.

---

## Phase 2: Task Planning Approach

*This section describes what `/ai1st-dev-tasks` will do — DO NOT execute during /plan.*

**Task Generation Strategy**:

- Load `.ai/2_templates/tasks-template.md` as base.
- Generate tasks from Phase 1 design docs (contracts, data-model, plus the source-code tree above).
- Each migration → one task; migrations 0019→0028 enforce order via natural ordering.
- Each pgTAP file → one task tagged [DB][TEST].
- Each RPC → one task in the corresponding migration (0027 holds all four RPCs) plus a contract-aligned pgTAP test in `017_prediction_rpcs.sql`.
- Each trigger function → one task in its migration (0025 for match scoring, 0026 for final scoring) plus `015_*` / `016_*` pgTAP tests.
- Each pure helper in `lib/predictions/` → one task plus its `__tests__` Jest spec (tagged [UI][TEST]).
- Each Server / Client Component → one task tagged [UI].
- Each Playwright spec → one task tagged [TEST]; mark [P] where independent.
- Squad-sync extension to Edge Function → one task tagged [INT] (modifies index.ts + football-data-v4.ts + adds fixture).
- i18n keys (predictions.* namespace) → one task per locale (3 in parallel) tagged [UI].
- README + dod-verification refresh → final-phase task tagged [I].

**Ordering Strategy**:

- Migrations first (DB layer is the foundation; types regenerated after each migration set).
- pgTAP tests for RLS + triggers + idempotency next (lock down DB invariants before any UI work).
- Pure helpers + their Jest tests (no UI dependency, can run in parallel via [P]).
- Server Components (read path for breakdown) — depend on regenerated types + helpers.
- Client Components — depend on RPCs being callable (contracts written; PostgREST will expose them).
- Playwright specs last per surface (each depends on the surface existing); the scoring specs depend on triggers being live.
- Squad-sync extension to Edge Function can run in parallel with the prediction UI track once migration 0021 (players table) lands.

**Estimated Output**: ~45-55 tasks in `tasks.md`. (Feature 002 was 63; feature 003 has more triggers + scoring logic but the established patterns from features 001 + 002 — auth, RLS, audit, i18n, a11y, sync — accelerate the path.)

**IMPORTANT**: This phase is executed by `/ai1st-dev-tasks`, NOT by `/ai1st-dev-plan`.

---

## Dependencies Analysis

### Prerequisites

*What must exist before this feature can be implemented.*

| Dependency | Source | Status | Notes |
|---|---|---|---|
| Authenticated participant + RLS + audit machinery | Feature 001 (PR #2, open) | Required | Branched off `master`; feature 003 assumes the schema from feature 001 is applied via `npx supabase db reset`. |
| Match catalog + `matches` / `teams` / `integration_runs` tables | Feature 002 (PR #3, open) | Required | Branched off `master` after feature 002 merged locally. Feature 003 extends `tournament_config`, references `matches.id` + `teams.id`. |
| `sync-matches` Edge Function | Feature 002 | Required | Extended with squad-sync step here; the retry helper + fixture-mode flag + integration_runs telemetry all reused. |
| Existing audit-log infrastructure | Feature 001 migration 0005 | Required | New action tags (`prediction.created`, `prediction.updated`, `admin.match-result-override`, `admin.tournament-winner-set`, `admin.recalc-all`, `scoring.match`, `scoring.final`) all use the existing `audit_log` schema. |
| Hand-rolled WAI-ARIA combobox pattern | Feature 002 `<TimezonePicker/>` | Required | `<PlayerPickerCombobox/>` mirrors the structure; no new picker library introduced. |
| Hand-rolled Accept-Language + i18n namespace pattern | Feature 001 ADR-013 + constitution-frontend.md | Required | `predictions.*` namespace added; no new locale machinery. |
| football-data.org API key | Nortal IT | Required for production squad data | Local dev: extended fixture mode (`SYNC_FIXTURE_MODE=1`) reads `__fixtures__/v4-squads-sample.json`. |

### Provides (to other features)

*What this feature enables for downstream use cases.*

| Output | Used By | Description |
|---|---|---|
| `score_events` table + scoring engine | Feature 004 (leaderboard) | Sum across `participant_id` = participant's total. Materialized leaderboard view in feature 004 will aggregate from here. |
| `predictions` / `final_predictions` tables | Feature 004 (leaderboard) + future per-participant analytics | Per-participant breakdown queries (already in this feature) generalise to leaderboard rankings in feature 004. |
| `players` table | Feature 004 (top-scorer leaderboard display) + any future player-data feature | Squad sync becomes a permanent feed once enabled. |
| `scoring_runs` table + `all_runs` view | Feature 005 (operational dashboards) | One operator surface for "what did the system do recently?" across sync + scoring; future maintenance jobs (cleanup, archival) can write to the same telemetry surface. |
| `tournament_config` winner columns | Feature 004 (leaderboard) + final tournament view | Source-of-truth for the four official picks; scoring re-fires when these change. |
| Trigger-based scoring pattern | Future scoring extensions (knockout-stage bonuses, group-stage standings) | Established pattern: source data write → trigger → DELETE-then-INSERT score_events. |

---

## Work Streams

### Stream Definitions

| Stream | Tag | Scope | Typical Executor |
|---|---|---|---|
| Database | [DB] | Migrations 0019-0028, pgTAP tests 010-018, RLS policies, RPCs, triggers, view | Direct edits / Agent for migrations |
| Backend integration | [INT] | Squad-sync extension to `sync-matches` (index.ts + provider + fixture), recalc-all RPC | Agent via subagent dispatch |
| Frontend UI | [UI] | Pages, components, pure helpers, i18n keys, Jest unit tests | Agent dispatched [P] for independent components |
| End-to-end testing | [TEST] | Playwright specs (10 new + a11y extension), trigger-driven scoring scenarios | Agent dispatched [P] for independent specs |
| Integration | [I] | README updates, dod-verification refresh, final pristine sweep | Direct + Agent |

### Active Streams for This Feature

- [x] **[DB]** — 10 new migrations, 9 new pgTAP files, RLS for 5 tables + 1 view, 2 trigger functions, 4 RPCs
- [x] **[INT]** — `sync-matches` squad-sync extension + new squad fixture, admin recalc RPC orchestration
- [x] **[UI]** — 1 modified page, 2 new pages, ~7 components, 3 pure helpers, 3 i18n namespace additions
- [x] **[TEST]** — 9 new Playwright specs + 3 new Jest unit specs + a11y sweep extension
- [ ] **[INFRA]** — None (cron for recalc-all is Phase 5; not in this feature)
- [x] **[I]** — README + dod-verification.md for feature 003

### Stream Dependencies

- [UI] depends on [DB] for: regenerated `lib/supabase/database.types.ts` after migrations apply
- [TEST] depends on: [UI] and [DB]/[INT] implementations
- [INT] depends on [DB] for: `players` table existing (migration 0021); admin recalc RPC requires `scoring_runs` table (0024) + per-action mutex; recalc-all triggers `calculate_match_points()` so the trigger (0025) must be in place
- [I] depends on: every other stream completing

---

## Complexity Tracking

*No constitution violations.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| *(none)* | — | — |

---

## Use Case Specific NFRs

*Extracted from spec.md §4 NFR-P1..NFR-P6 and consolidated for traceability.*

### Performance

| Requirement | Target | Measurement |
|---|---|---|
| Prediction write latency | < 500 ms p95 | Server timing measured inside `submit_prediction()` RPC + Playwright timing assertion in `predictions-submit.spec.ts` |
| Match-scoring trigger | ≤ 5 seconds for 1 match × 200 participants | pgTAP test `015_match_scoring_trigger.sql` seeds 200 participants + asserts trigger completion time |
| `recalculate_all_scores()` | ≤ 2 minutes for 104 matches × 200 participants | pgTAP test `018_scoring_idempotency.sql` seeds the full grid + asserts total execution time |
| `/predictions/breakdown` initial render | < 1 second on warm cache | Manual Lighthouse check |

### Reliability

| Requirement | Target | Measurement |
|---|---|---|
| Scoring trigger transactional | Failed scoring rolls back the source UPDATE (FC-2) | pgTAP test `015_*.sql` injects a constraint violation mid-scoring + asserts `match_results` UPDATE rolled back |
| Scoring determinism | Same inputs → same outputs across N runs (NFR-P5) | `scoring-idempotency.spec.ts` (TC-P17) + pgTAP `018_*.sql` repeat-trigger test |
| Concurrent recalc-all | At-most-one in flight via per-action partial-unique-index mutex | pgTAP `018_*.sql` + Playwright `scoring-admin-correction.spec.ts` if concurrency is testable from there (otherwise pgTAP-only) |

### Accessibility

| Requirement | Target | Measurement |
|---|---|---|
| All new surfaces | WCAG 2.1 AA, zero axe-core violations | `all-pages-a11y.spec.ts` extension covering `/predictions/final` (with picker open) + `/predictions/breakdown` |
| Prediction form on existing `/matches/[id]` | Re-audited as part of TC-M3 detail-page test | Existing test extended to scan with the form mounted |

### Scalability

| Requirement | Target | Measurement |
|---|---|---|
| Active participant ceiling | 200 (FA-3) | Trigger budget (NFR-P2) sized for this; capacity test in pgTAP `015_*.sql` |
| score_events row count | ≤ 20,800 match-scoring + ~800 final = ~21,600 | Implicit (the data model has no separate cap; query patterns optimised for this size) |

### Security

| Requirement | Target | Measurement |
|---|---|---|
| score_events write restriction | Only SECURITY DEFINER trigger functions can INSERT/UPDATE (FC-3 / FR-P24) | pgTAP `012_rls_score_events.sql` test with admin role attempting direct INSERT → expects insufficient_privilege |
| Cross-participant RLS isolation | Participants cannot read each other's predictions or final_predictions (FR-P25) | pgTAP `010_*.sql` + `011_*.sql` + Playwright `predictions-rls.spec.ts` (TC-P20) |

---

## Acceptance Criteria

### BRD Traceability

*BRD references: FR-005 (Prediction entry), FR-006 (Single active prediction), FR-007 (Update window), FR-008 (Match lock), FR-009 (Final predictions), FR-010 (Final lock), FR-011 (Match scoring), FR-012 (Final scoring), FR-014 (Personal breakdown), FR-015 (Admin override), FR-016 (Recalculation), FR-018 (Audit trail); BR-LOCK-001..006 — all from `docs/architecture/high-level-architecture.md` (Approved 2026-05-15) + `docs/architecture/scoring-model.md`.*
*This project has no design-system.md or Figma references; design ships with implementation.*

### Match prediction write path

- [FR-P01] Authenticated participant can submit a match prediction for any upcoming non-locked match {Source: FR-005}
- [FR-P02] Exactly one active prediction row per (participant, match); prior values preserved in audit_log {Source: FR-006}
- [FR-P03] Edits allowed only when `kickoff_utc - now() > interval '60 minutes'` (strict-greater-than) {Source: BR-LOCK-002+003}
- [FR-P04] Every INSERT / UPDATE to predictions audit-logged with prior + new values {Source: FR-018}
- [FR-P05] Locked predictions return PREDICTION_LOCKED error; row unchanged {Source: FR-008}
- [FR-P06] Scores validated as integers 0..20 via CHECK constraint {Source: AI/Specify}

### Final predictions write path

- [FR-P07] Participant can submit champion / runner-up / top-scorer / best-player {Source: FR-009}
- [FR-P08] Partial submissions allowed; NULL items scored as 0 with `final-not-picked-<item>` {Source: AI/Specify}
- [FR-P09] Lock fires at first non-cancelled kickoff via FINAL_PREDICTIONS_LOCKED error {Source: BR-LOCK-005}
- [FR-P10] Champion ≠ runner-up enforced by CHECK constraint {Source: AI/Specify}
- [FR-P11] Player pickers visible-but-disabled when `players` is empty; auto-enable on first squad sync {Source: Clarify Round 2 Q8}

### Scoring engine

- [FR-P12] 10/5/0 scoring formula deterministic per scoring-model.md §7.2 {Source: FR-011}
- [FR-P13] Match scoring fires on AFTER INSERT/UPDATE to match_results with status='finished' + non-null scores {Source: Clarify Round 1 Q2}
- [FR-P14] Every active participant gets one score_events row per finished match (including no-prediction) {Source: Clarify Round 1 Q3}
- [FR-P15] Cancelled matches award 0 to everyone with source='match-cancelled' {Source: Clarify Round 2 Q6}
- [FR-P16] Scoring trigger idempotent — re-runs with unchanged inputs produce identical functional state {Source: AI/Specify}
- [FR-P17] Final-scoring trigger fires on tournament_config OR final_predictions UPDATE (incl. FK cascades) {Source: FR-012 + Clarify Q2}
- [FR-P18] Admin recalculate_all_scores RPC iterates all finished matches {Source: FR-016}
- [FR-P28] Scoring runs telemetry in scoring_runs table + all_runs view unifying sync + scoring telemetry {Source: Clarify Q3}

### Players + squad sync

- [FR-P19] players table schema (provider_player_id, name, position, team_id) {Source: AI/Specify}
- [FR-P20] sync-matches Edge Function extended with squad-fetch step {Source: Clarify Round 2 Q7}
- [FR-P21] integration_runs telemetry covers combined matches+players counts {Source: AI/Specify}

### Admin overrides

- [FR-P22] Admin can UPDATE match_results.score_home/score_away/status; trigger auto-rescores {Source: FR-015}
- [FR-P23] Admin can set tournament_config winners via set_tournament_winner RPC; trigger auto-rescores {Source: FR-015}
- [FR-P24] No role can directly INSERT/UPDATE score_events — all writes via SECURITY DEFINER trigger functions {Source: Clarify Round 2 Q9}

### RLS + audit

- [FR-P25] Participants can only SELECT/INSERT/UPDATE their own predictions and final_predictions {Source: NFR-006}
- [FR-P26] Admin overrides + scoring runs all recorded in audit_log with action tags {Source: FR-018}

### Personal breakdown

- [FR-P27] Breakdown query exposes per-match scoring events to the participant via RLS-filtered SELECT (page at `/predictions/breakdown`) {Source: FR-014}

### Quality

- [NFR-P1] Prediction write < 500ms p95
- [NFR-P2] Match-scoring trigger ≤ 5s for 1 match × 200 participants
- [NFR-P3] Recalculate-all ≤ 2 minutes for 104 × 200
- [NFR-P4] Lock boundary tests at exactly −60/−61/−59 minute MANDATORY (TC-P3/P4/P5)
- [NFR-P5] All scoring deterministic and reproducible
- [NFR-P6] RLS policies pgTAP-covered for all 5 new tables + view

---

## Post-design Constitution Re-check

*Performed 2026-05-22 after research.md, data-model.md, contracts/ (6 files), and quickstart.md landed.*

**Status**: **PASS** — no new violations; all Pre-design checks remain ✓.

**Design choices re-validated against the constitutions:**

| Pre-design check | Post-design evidence |
|---|---|
| §1.1 Modular monolith with DB-enforced rules | Lock RPC + 2 trigger functions all live in Postgres per data-model.md §5; UI never owns the lock or scoring computations. Breakdown page reads `score_events` directly (no recompute). |
| §1.3 No silent failures | Every RPC raises a typed Postgres EXCEPTION; trigger failures roll back the source UPDATE per FC-2 (data-model.md §5.1); `scoring_runs` records error_message with status='error'; admin recalc-all catches per-match failures via savepoint-scoped EXCEPTION block (contracts/rpc-recalculate-all-scores.md §Behaviour step 4). |
| §2 service_role never in client | All trigger functions are SECURITY DEFINER (data-model.md §5); admin RPCs gated on `is_admin_user()` (contracts/rpc-set-tournament-winner.md, rpc-recalculate-all-scores.md). Browser only calls participant RPCs (`submit_prediction`, `submit_final_prediction`) which have no service_role context. |
| §4 Testing — pgTAP + Jest + Playwright + pristine | pgTAP coverage enumerated in every contract file (010-018); Jest specs in `lib/predictions/__tests__/`; Playwright TC-P1..TC-P22 enumerated in plan.md §Project Structure. |
| §4 Lock boundary tests MANDATORY | TC-P3/P4/P5 (−60/−61/−59 min) called out in quickstart.md §5 + Playwright spec dedicated to the triplet. pgTAP `017_*.sql` covers the SQL-side boundary (same comparator). |
| Frontend §IV.1 Server Components by default | Project structure shows 2 new Server Components (pages) + 7 new components split server/client per interactivity. Client Components: `<PredictionForm/>`, `<FinalPredictionsForm/>`, `<PlayerPickerCombobox/>`. Each justified by form-state or combobox interactivity. |
| Frontend §I.1 i18n via hand-rolled Accept-Language (ADR-013) | `predictions.*` namespace added to existing en/es/pt-BR JSONs; no new locale machinery. |
| Backend §I.1 Stack | Constitution updated 2026-05-22 with the new "Scoring trigger pattern" + "Cross-table operator surface (view with security_invoker)" rows. Concurrency primitive row extended to mention scoring_runs reuse. |
| Backend §I.1 Concurrency primitive (partial unique index) | `scoring_runs((action)) WHERE finished_at IS NULL` follows the established pattern; per-action scope (vs feature 002's global scope) future-proofs for additional scoring actions. R-4 documents the choice. |
| Backend §VI Security — RLS on all reads + no admin write to score_events | data-model.md §4 spells out the RLS for all 5 new tables + view. `score_events` deliberately has NO authenticated INSERT/UPDATE/DELETE policies — enforces FR-P24. pgTAP `012_*.sql` covers the negative case. |
| Backend §IX Anti-patterns — no raw provider data stored | Player data normalised in `provider/football-data-v4.ts` extension before INSERT (quickstart.md §3 confirms `players` schema mirrors what was decided in data-model.md §1.3, not a raw provider response). |

**New surface introduced post-design that warranted a constitution add:**

- **DELETE-then-INSERT trigger function pattern** (FR-P24's SECURITY DEFINER + atomic-via-transaction) — added to constitution-backend.md §I.1 as "Scoring trigger pattern" row.
- **View with `security_invoker = true` for cross-table operator surfaces** — added to constitution-backend.md §I.1 as "Cross-table operator surface" row.

**Frontend constitution**: no new rows. The `<PlayerPickerCombobox/>` reuses the existing WAI-ARIA combobox row documented for `<TimezonePicker/>`.

**Violations found**: None.
**Remediation**: N/A.

**Ready for `/ai1st-dev-tasks`**.

---

*Based on Constitution — see `.ai_project_memory/constitution.md`.*
