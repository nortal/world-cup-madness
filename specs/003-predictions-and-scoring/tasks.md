# Tasks: Predictions and Scoring

**Feature**: 003-predictions-and-scoring
**Input**: `specs/003-predictions-and-scoring/` — plan.md (required), spec.md, research.md, data-model.md, contracts/, quickstart.md
**Generated**: 2026-05-22 via `/ai1st-dev-tasks`

## Overview

Tasks are organised into 7 phases:

- **Phase 1** — Setup (dirs + env review)
- **Phase 2** — Foundational (schema migrations 0019-0024, 0028 RLS; pgTAP RLS coverage; type regen; audit-tag extension. Blocks every user story.)
- **Phase 3** — US-PA: Match prediction write path (FR-P01-P06; submit_prediction RPC; PredictionForm on `/matches/[id]`)
- **Phase 4** — US-PB: Final predictions write path + squad sync (FR-P07-P11, P19-P21; submit_final_prediction RPC; squad-sync extension to sync-matches Edge Function; FinalPredictionsForm + 4 pickers; `/predictions/final` page)
- **Phase 5** — US-PC: Scoring engine + admin overrides (FR-P12-P18, P22-P24, P28; both triggers; set_tournament_winner + recalculate_all_scores RPCs; scoring_runs telemetry)
- **Phase 6** — US-PD: Personal breakdown (FR-P27; BreakdownTable; `/predictions/breakdown` page; dashboard nav)
- **Final Phase** — Polish (a11y sweep extension, pristine test sweep, DoD verification, README, constitution review)

User stories are independent at the implementation layer (each can be developed + tested + demoed without the others) but share the foundational schema. **Recommended MVP scope is Phase 1 + Phase 2 + US-PA + US-PC + US-PD** — gives participants the complete *predict → score → see results* loop minus the final-predictions feature. US-PB is a discrete add-on that can ship in a follow-up commit.

Tests are integrated per phase per the AI-Kit convention (each user story produces both implementation and the TC-PX Playwright spec that validates it).

**Total tasks**: 74.

---

## Phase 1 — Setup

- [x] T001 Create the new feature directory tree: `mkdir -p project-repos/world-cup-madness/{components/predictions,lib/predictions,lib/predictions/__tests__,app/(participant)/predictions/{final,breakdown},supabase/functions/sync-matches/__fixtures__}`
- [x] T002 Verify `project-repos/world-cup-madness/.env.example` requires no new env vars for feature 003 (squad sync reuses `FOOTBALL_DATA_API_KEY` + `SYNC_FIXTURE_MODE=1` from feature 002); confirm by diffing against feature 002's quickstart and adding a section header `# feature 003 — predictions + scoring (no new env vars)` for clarity

---

## Phase 2 — Foundational (BLOCKS every user story)

### Schema migrations

- [x] T003 Migration `project-repos/world-cup-madness/supabase/migrations/0020_create_predictions.sql` per `data-model.md` §1.1 — UUID PK, FKs to participants + matches with ON DELETE CASCADE, `predicted_home_score` + `predicted_away_score` SMALLINT NOT NULL with BETWEEN 0 AND 20 CHECK, UNIQUE (participant_id, match_id), created_at + updated_at, indexes on participant_id + match_id; no RLS yet
- [x] T004 Migration `project-repos/world-cup-madness/supabase/migrations/0022_create_final_predictions.sql` per `data-model.md` §1.2 — UUID PK, FK to participants UNIQUE (one row per participant), 4 nullable FK columns (champion_team_id, runner_up_team_id with ON DELETE SET NULL to teams; top_scorer_player_id, best_player_player_id with ON DELETE SET NULL to players — forward-reference players table created in T005), CHECK constraint `champion_team_id IS NULL OR runner_up_team_id IS NULL OR champion_team_id <> runner_up_team_id`, 4 partial indexes on the pick columns; no RLS yet
- [x] T005 Migration `project-repos/world-cup-madness/supabase/migrations/0021_create_players.sql` per `data-model.md` §1.3 — UUID PK, `provider_player_id` INTEGER UNIQUE, `name` TEXT NOT NULL with non-empty CHECK, `position` TEXT nullable with CHECK constraint to {Goalkeeper, Defender, Midfielder, Attacker}, `team_id` FK to teams ON DELETE CASCADE, created_at + updated_at, indexes on team_id + name; no RLS yet. (Note: T004's forward-reference to players resolves once this migration applies; alternatively reorder so 0021 lands before 0020 — confirm with `supabase db reset` after writing.)
- [x] T006 Migration `project-repos/world-cup-madness/supabase/migrations/0023_extend_tournament_config_winners.sql` — `ALTER TABLE tournament_config ADD COLUMN champion_team_id UUID REFERENCES teams(id) ON DELETE SET NULL, ADD COLUMN runner_up_team_id UUID REFERENCES teams(id) ON DELETE SET NULL, ADD COLUMN top_scorer_player_id UUID REFERENCES players(id) ON DELETE SET NULL, ADD COLUMN best_player_player_id UUID REFERENCES players(id) ON DELETE SET NULL;` plus the `tournament_config_winners_champion_distinct_runner_up` CHECK constraint
- [x] T007 Migration `project-repos/world-cup-madness/supabase/migrations/0025_create_score_events.sql` per `data-model.md` §1.4 — `CREATE TYPE score_event_source AS ENUM (...)` with all 13 values; `score_events` table with UUID PK, FKs to participants + matches (matches nullable; CASCADE on participants, CASCADE on matches), `source` typed as `score_event_source`, `points` SMALLINT BETWEEN 0 AND 20, `awarded_at` TIMESTAMPTZ default now(), `scoring_run_id` UUID nullable FK to scoring_runs (forward ref; resolves in T008); CHECK constraint pairing source with match_id presence; two partial unique indexes per spec; supporting indexes
- [x] T008 Migration `project-repos/world-cup-madness/supabase/migrations/0024_create_scoring_runs_and_all_runs.sql` per `data-model.md` §1.5 + §3 — `CREATE TYPE scoring_action AS ENUM` + `CREATE TYPE scoring_status AS ENUM`; `scoring_runs` table with the action/match_id CHECK constraints; `CREATE UNIQUE INDEX scoring_runs_at_most_one_in_flight_per_action ON scoring_runs(action) WHERE finished_at IS NULL` (the per-action mutex per R-4); `CREATE VIEW all_runs WITH (security_invoker = true) AS ...` UNION ALL over integration_runs + scoring_runs per the column-shape unification in data-model.md
- [x] T009 Migration `project-repos/world-cup-madness/supabase/migrations/0029_prediction_rls.sql` per `data-model.md` §4 — ENABLE RLS on all 5 new tables (predictions, final_predictions, players, score_events, scoring_runs); SELECT/INSERT/UPDATE policies for participants on predictions + final_predictions keyed on `participants.auth_user_id = auth.uid()`; admin SELECT policy on predictions + final_predictions + score_events + scoring_runs via `is_admin_user()`; SELECT-only policy on players via `is_eligible_nortal_user()`; NO INSERT/UPDATE/DELETE policies on score_events for authenticated (enforces FR-P24); the `all_runs` view inherits RLS via `security_invoker = true` — no separate policy. Note: RPC migration 0027 lands in US-PA Phase 3; trigger migrations 0025/0026 land in US-PC Phase 5 — both modify behaviour but not the RLS surface.

### Audit-log action tag extension

- [x] T010 Migration `project-repos/world-cup-madness/supabase/migrations/0019_audit_log_action_extension.sql` (slots BEFORE T003's 0019 — rename to 0019_pre_extend_audit_actions.sql; renumber T003-T009 to 0020-0028 if collision). EXTEND the `audit_log.action` CHECK constraint from feature 001 to include the new action tags: `'prediction.created'`, `'prediction.updated'`, `'final_prediction.created'`, `'final_prediction.updated'`, `'admin.match-result-override'`, `'admin.tournament-winner-set'`, `'admin.recalc-all'`, `'scoring.match'`, `'scoring.final'`. Verify the original constraint allows extension via DROP CONSTRAINT + ADD CONSTRAINT (cannot ALTER CHECK in place). Alternatively, if feature 001's CHECK is open-ended (no enum), skip this migration and document the new tags in audit_log comments only.

### Generated types

- [x] T011 Regenerate `project-repos/world-cup-madness/lib/supabase/database.types.ts` via `npx supabase gen types typescript --local | sed '/^<claude-code-hint/,$d' > lib/supabase/database.types.ts` after running `npx supabase db reset`; commit the regenerated file alongside the migrations. (The `sed` filter strips the Supabase CLI's trailing notice line per feature 002's established workflow.)

### pgTAP tests (DB invariants — RLS only at this phase; trigger + RPC tests in US-PA/PC)

- [x] T012 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/010_rls_predictions.sql` — verify SELECT/INSERT/UPDATE policies for predictions: participant A sees own rows + can INSERT/UPDATE own; participant A cannot SELECT participant B's rows (returns zero) + cannot INSERT/UPDATE with B's participant_id (RLS check); admin SELECTs all; anon role denied
- [x] T013 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/011_rls_final_predictions.sql` — same shape as T012 for final_predictions: own-row read/write; cross-participant invisible; admin SELECT all
- [x] T014 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/012_rls_score_events.sql` — participant sees only own rows; admin sees all; **NO INSERT/UPDATE/DELETE policy for authenticated** — verify admin attempting `INSERT INTO score_events` returns `insufficient_privilege` (covers FR-P24 / TC-P22 at the SQL layer). The trigger function (in 0025/0026) is the only legitimate writer.
- [x] T015 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/013_rls_players.sql` — eligible-tenant participant can SELECT; ineligible returns zero; admin SELECTs all; no INSERT/UPDATE/DELETE for authenticated (service_role-only via squad-sync Edge Function)
- [x] T016 [P] pgTAP test `project-repos/world-cup-madness/test/pgtap/014_rls_scoring_runs_and_all_runs.sql` — admin SELECTs scoring_runs; non-admin authenticated returns zero; verify `all_runs` view with `security_invoker = true` applies the same admin-only gate to its UNION output (per R-5). Test pattern: set auth.uid() to a non-admin, query `SELECT * FROM all_runs`, assert zero rows.

### Sanity sweep

- [x] T017 Run `npx supabase db reset` to apply migrations 0019-0028 cleanly; then run all new pgTAP files (010-014) via `for f in test/pgtap/01[0-6]_*.sql; do docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -X -q -P pager=off -f - < "$f" | grep -E "^ ok|^ not ok|ERROR"; done` and confirm every assert passes
- [x] T018 Run `npm test` (Jest) + `npx tsc --noEmit` to confirm feature 002's existing tests still pristine after the migration set + regenerated database.types.ts; fix any TS errors that surface from the new tables landing in the types

---

## Phase 3 — US-PA: Participant submits + edits match predictions

**Story goal**: An authenticated participant lands on `/matches/[id]` for an upcoming match, sees the prediction form below the existing read-only detail block, submits a predicted score (0-20 per side), edits it as many times as they want until kickoff − 60 minutes, and sees the form lock automatically after that boundary. Every edit captured in `audit_log`; every attempt to submit a locked prediction returns a friendly error.

**Independent test criteria**: TC-P1 (submit), TC-P2 (edit), TC-P3 (boundary at −60 min — locked), TC-P4 (−61 min — editable), TC-P5 (−59 min — locked), TC-P6 (out-of-range), TC-P20 (RLS cross-participant), TC-P21 (audit log). Story passes when all eight Playwright specs are green against a hand-seeded catalog (predictions sit unscored until US-PC's scoring engine lands).

### RPC migration

- [x] T019 [US-PA] Migration `project-repos/world-cup-madness/supabase/migrations/0028_prediction_rpcs.sql` — create function `submit_prediction(p_match_id UUID, p_home INTEGER, p_away INTEGER) RETURNS jsonb` per `contracts/rpc-submit-prediction.md` §Behaviour; SECURITY DEFINER + SET search_path; resolves participant via auth.uid(); lock check using `kickoff_utc - now() > interval '60 minutes'` (strict); UPSERT with xmax=0 trick for action discrimination; audit emit. REVOKE EXECUTE FROM PUBLIC + GRANT EXECUTE TO authenticated. (The other 3 RPCs land in T038 and T053 — this migration file is created here and extended in later phases.)

### pgTAP for submit_prediction

- [x] T020 [P] [US-PA] pgTAP test `project-repos/world-cup-madness/test/pgtap/017_prediction_rpcs.sql` — first batch covering `submit_prediction`: happy-path INSERT + UPDATE distinction (action returned correctly); lock boundary triplet (T-60 / T-61 / T-59 — the mandatory NFR-P4 test); range violation (predicted_home_score=21 raises check_violation); MATCH_NOT_FOUND when match_id doesn't exist; PARTICIPANT_NOT_FOUND when no active participant for auth.uid(); audit_log row written per call with correct action tag. (The file is extended in T039 + T054 for the other RPCs.)

### Pure helpers + Jest unit tests

- [x] T021 [P] [US-PA] Implement `project-repos/world-cup-madness/lib/predictions/validate-prediction.ts` — pure function `validatePrediction(home: number, away: number): { ok: boolean; errorCode?: 'OUT_OF_RANGE' | 'NOT_INTEGER' }` mirroring the server-side CHECK constraint for client-side pre-validation. Also export `derivePredictionOutcome(home, away): 'home-win' | 'away-win' | 'draw'` (used by the scoring helper in US-PC).
- [x] T022 [P] [US-PA] Implement `project-repos/world-cup-madness/lib/predictions/lock-state.ts` — pure function `isPredictionLocked(kickoffUtc: string, nowUtc: Date): boolean` and `lockCountdownMs(kickoffUtc: string, nowUtc: Date): number`. Mirrors the SERVER-SIDE comparator (`kickoff_utc - now() > interval '60 minutes'` → strict, isLocked = true at exactly T-60). Wraps feature 002's lock-badge comparator per R-8 — extract the boundary check into a shared helper if `lib/matches/lock-badge.ts` exposes one; otherwise duplicate with a comment pointing at the SQL spec. Note: this helper is a UI hint only; the authoritative lock is `submit_prediction()` RPC.
- [x] T023 [P] [US-PA] Jest unit test `project-repos/world-cup-madness/lib/predictions/__tests__/validate-prediction.test.ts` — happy values (0, 5, 10, 20); boundary cases (-1, 21); non-integer values; outcome enum mapping for all home>away / home<away / home=away combinations
- [x] T024 [P] [US-PA] Jest unit test `project-repos/world-cup-madness/lib/predictions/__tests__/lock-state.test.ts` — boundary triplet at the helper layer (kickoff = now + 60min exactly → locked; +61min → editable; +59min → locked); countdown ms calculation; null / invalid kickoff string handling

### Components

- [x] T025 [US-PA] Implement `project-repos/world-cup-madness/components/predictions/PredictionForm.tsx` — Client Component (`'use client'`), props `{ matchId: string, kickoffUtc: string, initialPrediction: { home: number, away: number } | null }`. Two `<input type="number" min="0" max="20">` fields + Submit button; optimistic UI on save; calls `submit_prediction` RPC via supabase client; renders countdown using `lock-state.ts`; on PREDICTION_LOCKED response, swaps to read-only view via `<LockedPredictionDisplay/>`. i18n via `useTranslations('predictions')`.
- [x] T026 [US-PA] Implement `project-repos/world-cup-madness/components/predictions/LockedPredictionDisplay.tsx` — Server Component, props `{ prediction: { home, away }, kickoffUtc }`. Renders `<dl>` with the predicted score + a "Locked" badge using semantic `<output>` (not styled disabled inputs — axe-core flags those). i18n strings.

### Page modification

- [x] T027 [US-PA] Modify `project-repos/world-cup-madness/app/(participant)/matches/[id]/page.tsx` — read the participant's existing prediction for the match (if any) via supabase server client; conditionally mount `<PredictionForm/>` or `<LockedPredictionDisplay/>` based on the server-side lock check (`kickoffUtc - now > 60 min`); preserve the existing detail block above. Keep the page a Server Component; the form is the only Client Component on the surface.

### i18n keys

- [x] T028 [P] [US-PA] Add `predictions.*` namespace keys (form labels: home score / away score; submit button; saving toast; saved confirmation; locked-state heading; error messages: PREDICTION_LOCKED, OUT_OF_RANGE, MATCH_NOT_FOUND, generic; countdown text patterns "Locks in {hours}h {minutes}m") to `project-repos/world-cup-madness/lib/i18n/messages/en.json`
- [x] T029 [P] [US-PA] Mirror the same `predictions.*` keys with Spanish translations to `project-repos/world-cup-madness/lib/i18n/messages/es.json` (informal tú: "Tu pronóstico", "Local", "Visitante", "Guardar", "Bloqueado", "Se bloquea en {hours} h {minutes} min")
- [x] T030 [P] [US-PA] Mirror the same `predictions.*` keys with Brazilian Portuguese translations to `project-repos/world-cup-madness/lib/i18n/messages/pt-BR.json` (informal você: "Seu palpite", "Casa", "Fora", "Salvar", "Bloqueado", "Bloqueia em {hours}h {minutes}min")

### Playwright specs

- [x] T031 [P] [US-PA] Playwright test `project-repos/world-cup-madness/e2e/tests/predictions-submit.spec.ts` covering TC-P1 (submit valid prediction), TC-P2 (edit existing), TC-P6 (out-of-range rejected), TC-P21 (audit log captures every edit). Seeds an active participant + an upcoming match (kickoff = now + 2h); navigates to `/matches/[id]`; submits via the form; verifies via service-role read of predictions + audit_log.
- [x] T032 [P] [US-PA] Playwright test `project-repos/world-cup-madness/e2e/tests/predictions-lock-boundary.spec.ts` covering TC-P3 (T-60 = locked), TC-P4 (T-61 = editable), TC-P5 (T-59 = locked) — the **NFR-P4 mandatory triplet**. Test seeds three matches at the three boundaries (relative to a fixed `now()` injected via test fixture), attempts a submit on each, asserts response code. NOTE: requires the dev server to run with a clock-mockable Supabase OR the test directly hits the RPC via service-role with a frozen `now()` parameter (research depending on test infrastructure; prefer RPC-direct for determinism).
- [x] T033 [P] [US-PA] Playwright test `project-repos/world-cup-madness/e2e/tests/predictions-rls.spec.ts` covering TC-P20 — sign in as participant A; attempt to query `SELECT * FROM predictions WHERE participant_id = '<participant_B_id>'` via supabase client; assert zero rows returned (RLS filter).

---

## Phase 4 — US-PB: Final predictions write path + squad sync

**Story goal**: An authenticated participant lands on `/predictions/final`, picks up to four items (champion + runner-up from teams; top-scorer + best-player from players if available, else sees the disabled-with-notice state per FR-P11), submits partial or full, and can edit until first kickoff. Squad data flows in via an extension to the `sync-matches` Edge Function.

**Independent test criteria**: TC-P7 (submit all 4), TC-P8 (partial submit with NULL player picks), TC-P9 (lock at first kickoff), TC-P10 (player pickers disabled when no players seeded), TC-P11 (pickers auto-enable after squad sync). Story passes when both Playwright specs are green AND the squad-sync fixture mode produces ≥160 rows in `players`.

**Depends on**: Phase 2 foundational (players table + final_predictions table + RLS). US-PA optional (can ship in parallel — different RPC, different page).

### Squad-sync extension to Edge Function

- [x] T034 [P] [US-PB] Extend `project-repos/world-cup-madness/supabase/functions/sync-matches/provider/football-data-v4.ts` — add `fetchSquads(): Promise<PlayerRow[]>` that iterates `teams` (via the supabase service-role client passed in), calls `/v4/teams/{provider_team_id}/squad` for each, normalises the response into `{ provider_player_id, name, position, team_id }`, returns a flat array. Fixture-mode branch reads from `__fixtures__/v4-squads-sample.json` when `SYNC_FIXTURE_MODE=1`. Honour the retry helper from `lib/retry.ts` (carry-over from feature 002).
- [x] T035 [US-PB] Create `project-repos/world-cup-madness/supabase/functions/sync-matches/__fixtures__/v4-squads-sample.json` — 32 teams × 5-8 players each (~200 total) with realistic names + positions (Goalkeeper / Defender / Midfielder / Attacker) + `provider_player_id` values 10001-10256 (disjoint from any other fixture range). Use real 2022 World Cup squad approximations as proxy data; the file is fixture-only.
- [x] T036 [US-PB] Modify `project-repos/world-cup-madness/supabase/functions/sync-matches/index.ts` — add a Step 8 (after the existing UPSERT step) that calls `provider.fetchSquads()`, UPSERTs into `players` on `provider_player_id` with field-level diff (mirrors the matches diff pattern), adds the players count to the existing `integration_runs.records_processed` and `records_unchanged` totals. Update the README in the same directory.

### RPC migration (extends 0027)

- [x] T037 [US-PB] Extend `project-repos/world-cup-madness/supabase/migrations/0028_prediction_rpcs.sql` — add function `submit_final_prediction(p_champion UUID DEFAULT NULL, p_runner_up UUID DEFAULT NULL, p_top_scorer UUID DEFAULT NULL, p_best_player UUID DEFAULT NULL) RETURNS jsonb` per `contracts/rpc-submit-final-prediction.md` §Behaviour; lock check against `min(matches.kickoff_utc WHERE status != 'cancelled')`; upsert with xmax=0; audit emit. REVOKE EXECUTE FROM PUBLIC + GRANT EXECUTE TO authenticated.

### pgTAP for submit_final_prediction (extends 017)

- [x] T038 [US-PB] Extend `project-repos/world-cup-madness/test/pgtap/017_prediction_rpcs.sql` — second batch covering `submit_final_prediction`: happy path (all 4 picks); partial submit (only champion + runner_up); lock boundary at exact first kickoff (locked AT the moment of first kickoff, editable 1 second before); CHECK constraint violation when champion == runner_up; FK violation when player_id doesn't exist; audit_log emission per call

### Components

- [ ] T039 [P] [US-PB] Implement `project-repos/world-cup-madness/components/predictions/TeamPicker.tsx` — Server Component, props `{ name: string, selectedTeamId: string | null, teams: Team[] }`. Renders a styled `<select>` over the 32 teams (small enough; no combobox needed). Outputs the selected ID via a hidden form input. i18n labels.
- [ ] T040 [P] [US-PB] Implement `project-repos/world-cup-madness/components/predictions/PlayerPickerDisabled.tsx` — Server Component, props `{ label: string }`. Renders a disabled `<input role="combobox" aria-disabled="true">` with the "Player rosters not yet announced — pickers will activate when FIFA publishes squads" notice as `aria-describedby`. Mirrors the visible-but-disabled state per FR-P11.
- [ ] T041 [US-PB] Implement `project-repos/world-cup-madness/components/predictions/PlayerPickerCombobox.tsx` — Client Component (`'use client'`), WAI-ARIA combobox mirroring feature 002's `<TimezonePicker/>` shape. Props `{ name: string, selectedPlayerId: string | null, players: Player[] }`. Filters by name on keystroke; keyboard navigation (arrow keys + enter); outputs selected ID via hidden input.
- [ ] T042 [US-PB] Implement `project-repos/world-cup-madness/components/predictions/PlayerPicker.tsx` — Server Component wrapper, props `{ name: string, selectedPlayerId: string | null }`. Reads `players.count()` via supabase server client; if zero, renders `<PlayerPickerDisabled/>`; if ≥1, fetches the full player list and renders `<PlayerPickerCombobox/>` with the data.
- [ ] T043 [US-PB] Implement `project-repos/world-cup-madness/components/predictions/FinalPredictionsForm.tsx` — Client Component (`'use client'`), props `{ initial: FinalPrediction | null, teams: Team[] }`. Form state for 4 picks (champion team, runner-up team, top-scorer player, best-player player); calls `submit_final_prediction` RPC on submit; handles partial submissions (NULL = "not picked"); displays FINAL_PREDICTIONS_LOCKED if returned; renders the 4 picker components (TeamPicker × 2 + PlayerPicker × 2). i18n via `useTranslations('predictions.final')`.

### Page

- [ ] T044 [US-PB] Create `project-repos/world-cup-madness/app/(participant)/predictions/final/page.tsx` — Server Component; reads the participant's existing final_predictions row (if any); reads the full teams catalog; checks lock state (now ≥ min(kickoff_utc WHERE status != 'cancelled')); renders `<FinalPredictionsForm/>` with initial data and a server-rendered "Final predictions lock at {first kickoff timestamp}" caption.

### i18n keys

- [ ] T045 [P] [US-PB] Add `predictions.final.*` keys (page heading; per-pick labels: champion / runner-up / top-scorer / best-player; rosters-pending notice; lock countdown caption; success toast; FINAL_PREDICTIONS_LOCKED error; champion-equals-runner-up error) to `project-repos/world-cup-madness/lib/i18n/messages/en.json`
- [ ] T046 [P] [US-PB] Mirror to `project-repos/world-cup-madness/lib/i18n/messages/es.json` (Spanish: "Campeón", "Subcampeón", "Goleador", "Mejor jugador")
- [ ] T047 [P] [US-PB] Mirror to `project-repos/world-cup-madness/lib/i18n/messages/pt-BR.json` (Portuguese: "Campeão", "Vice-campeão", "Artilheiro", "Melhor jogador")

### Playwright specs

- [ ] T048 [P] [US-PB] Playwright test `project-repos/world-cup-madness/e2e/tests/predictions-final-submit.spec.ts` covering TC-P7 (all 4 picks), TC-P8 (partial submit), TC-P9 (lock at first kickoff)
- [ ] T049 [P] [US-PB] Playwright test `project-repos/world-cup-madness/e2e/tests/predictions-final-player-picker.spec.ts` covering TC-P10 (pickers disabled when players empty) + TC-P11 (auto-enable after squad sync). Test flow: reset DB so players is empty; load /predictions/final; assert pickers have `aria-disabled="true"` and the notice is visible; trigger squad-sync via fixture mode; reload; assert pickers are now interactive comboboxes.

---

## Phase 5 — US-PC: Scoring engine + admin overrides

**Story goal**: When a match's `match_results` row transitions to `status='finished'` (or `'cancelled'`) with non-null scores, the scoring trigger fires automatically and rebuilds `score_events` for every active participant. Admin can correct a score via direct UPDATE on `match_results` (or set tournament_config winners) and the relevant scoring trigger re-fires transactionally. Admin can also trigger a full recalc via `recalculate_all_scores()` RPC with mutex-protected serialisation.

**Independent test criteria**: TC-P12 (exact = 10), TC-P13 (outcome = 5), TC-P14 (wrong = 0), TC-P15 (no-prediction = 0), TC-P16 (cancelled = 0 to all), TC-P17 (idempotency), TC-P18 (admin correction re-fires), TC-P19 (final scoring 20), TC-P22 (admin cannot direct-INSERT score_events). Story passes when all five Playwright specs are green AND pgTAP capacity test for 200 participants completes in ≤ 5 seconds (NFR-P2).

**Depends on**: Phase 2 foundational. Independent of US-PA + US-PB (scoring can fire against any predictions, including zero).

### Trigger migrations

- [ ] T050 [US-PC] Migration `project-repos/world-cup-madness/supabase/migrations/0030_match_scoring_trigger.sql` — create function `calculate_match_points(p_match_id UUID) RETURNS VOID` per `contracts/trigger-calculate-match-points.md` (load match w/ FOR SHARE; DELETE existing match-scoring rows for this match; branch on status='cancelled' or 'finished'; INSERT ... SELECT with CASE expressions for source + points; audit emit). SECURITY DEFINER + SET search_path. REVOKE FROM PUBLIC. Then create trigger wrapper `calculate_match_points_trigger()` + the `AFTER INSERT OR UPDATE ON match_results FOR EACH ROW WHEN (...)` trigger per the data-model.md §5.1 WHEN clause.
- [ ] T051 [US-PC] Migration `project-repos/world-cup-madness/supabase/migrations/0031_final_scoring_trigger.sql` — create function `calculate_final_points(p_participant_id UUID DEFAULT NULL) RETURNS VOID` per `contracts/trigger-calculate-final-points.md` (load winners; DELETE final-source rows scoped to participant if non-null; 4 INSERT ... SELECT blocks for champion/runner-up/top-scorer/best-player; audit emit). Then create the two trigger wrappers + two triggers: `tournament_config_trigger_final_scoring` (full sweep on winner-column change) and `final_predictions_trigger_scoring` (single-participant rebuild on pick change including FK cascade).

### Admin RPC migration (extends 0027)

- [ ] T052 [US-PC] Extend `project-repos/world-cup-madness/supabase/migrations/0028_prediction_rpcs.sql` — add `set_tournament_winner(p_item TEXT, p_id UUID) RETURNS jsonb` per `contracts/rpc-set-tournament-winner.md` (admin gate via `is_admin_user()`; validate p_item enum; CASE-dispatched UPDATE on tournament_config; audit emit). Add `recalculate_all_scores() RETURNS jsonb` per `contracts/rpc-recalculate-all-scores.md` (admin gate; mutex via INSERT into scoring_runs catching 23505; per-match commit loop with savepoint-scoped EXCEPTION; finalisation UPDATE on scoring_runs; audit emit). REVOKE EXECUTE FROM PUBLIC + GRANT EXECUTE TO authenticated for both (admin gate is enforced inside the function body).

### pgTAP for triggers + admin RPCs

- [ ] T053 [P] [US-PC] pgTAP test `project-repos/world-cup-madness/test/pgtap/015_match_scoring_trigger.sql` — seed 1 match + 5 participants with mixed predictions; INSERT match_results with status='finished' + scores; assert trigger fires once; assert each participant's score_events row has correct (source, points) per the 10/5/0 formula; assert no-prediction case writes points=0 source='no-prediction'; assert cancelled-match path writes match-cancelled rows for all; assert trigger does NOT fire when status='live' (intermediate updates); assert DELETE-then-INSERT atomicity by querying from a parallel transaction during the trigger (via dblink or controlled CTE delay); CAPACITY test seeding 200 participants and asserting trigger completes < 5 seconds (NFR-P2)
- [ ] T054 [P] [US-PC] pgTAP test `project-repos/world-cup-madness/test/pgtap/016_final_scoring_trigger.sql` — seed tournament_config + 3 participants with mixed final predictions; UPDATE tournament_config.champion_team_id → assert all participants' final-champion rows rebuilt; UPDATE one participant's final_predictions → assert ONLY that participant's rows rebuild; DELETE a player that's been picked → assert FK cascade fires final_predictions trigger → assert participant's final-top-scorer row rebuilt as final-not-picked-top-scorer (the R-6 cascade test); idempotency: re-trigger with unchanged state → row count + points identical
- [ ] T055 [P] [US-PC] Extend `project-repos/world-cup-madness/test/pgtap/017_prediction_rpcs.sql` — third batch covering `set_tournament_winner` and `recalculate_all_scores`: admin-gate rejection for non-admin caller; INVALID_WINNER_ITEM for unknown item; FK violations propagate; trigger fires on successful set; recalc-all writes scoring_runs row + claims mutex; second simultaneous recalc-all returns outcome='skipped' (via two pgTAP transactions or via simulating the unique-violation directly)
- [ ] T056 [P] [US-PC] pgTAP test `project-repos/world-cup-madness/test/pgtap/018_scoring_idempotency.sql` — seed full grid (104 matches × 200 participants) via SQL fixture; run `recalculate_all_scores()` end-to-end; assert duration < 120 seconds (NFR-P3); run twice consecutively; assert second run produces zero functional state change (every points value identical, row count identical); assert per-action mutex correctly rejects simulated concurrent run

### Playwright specs

- [ ] T057 [P] [US-PC] Playwright test `project-repos/world-cup-madness/e2e/tests/scoring-match-points.spec.ts` covering TC-P12 (exact), TC-P13 (outcome), TC-P14 (wrong), TC-P15 (no-prediction), TC-P16 (cancelled). Seeds match + predictions; updates match_results via service-role; queries score_events; asserts (source, points) per case. Cleanup in afterAll wipes seeded matches + score_events to avoid polluting US-PD's breakdown spec.
- [ ] T058 [P] [US-PC] Playwright test `project-repos/world-cup-madness/e2e/tests/scoring-idempotency.spec.ts` covering TC-P17 — end-to-end through the trigger: seed match + prediction; UPDATE match_results to set scores; assert score_events row exists; UPDATE same row to set IDENTICAL scores; assert score_events row count + points unchanged
- [ ] T059 [P] [US-PC] Playwright test `project-repos/world-cup-madness/e2e/tests/scoring-admin-correction.spec.ts` covering TC-P18 (admin corrects → trigger re-fires + audit_log captures), TC-P22 (admin direct-INSERT score_events → insufficient_privilege via RLS gate from T014)
- [ ] T060 [P] [US-PC] Playwright test `project-repos/world-cup-madness/e2e/tests/scoring-final-points.spec.ts` covering TC-P19 — admin sets tournament_config.champion_team_id via `set_tournament_winner('champion', id)` RPC; assert participant with matching pick gets a `final-champion` score_events row with points=20; participant without the pick gets `final-champion` with points=0

---

## Phase 6 — US-PD: Personal breakdown read path

**Story goal**: An authenticated participant visits `/predictions/breakdown` and sees a per-match table of their score events (match, predicted score, official score, points, source label) plus a running total. Page reads `score_events` directly with the RLS-filtered query — no client-side computation.

**Independent test criteria**: TC-P20 partial (RLS coverage already in US-PA T033) + a new positive-path test that the breakdown renders correctly for a participant with mixed-source rows. Story passes when the page renders with seeded data + the a11y sweep in Final Phase covers it.

**Depends on**: Phase 2 foundational + US-PC (score_events table must have data to display; absent that, the breakdown shows the empty-state message).

### Pure helper + Jest

- [ ] T061 [P] [US-PD] Implement `project-repos/world-cup-madness/lib/predictions/scoring-display.ts` — pure helper `formatScoreSource(source: score_event_source, locale: 'en' | 'es' | 'pt-BR'): string` mapping the 13 enum values to translated human labels (e.g. `'match-exact' → 'Exact score'` / `'Marcador exacto'` / `'Placar exato'`); also `sumPoints(events: ScoreEvent[]): number` for the running total
- [ ] T062 [P] [US-PD] Jest unit test `project-repos/world-cup-madness/lib/predictions/__tests__/scoring-display.test.ts` — every enum value mapped in all 3 locales (no missing keys); `sumPoints` over mixed-source array

### Component + page

- [ ] T063 [US-PD] Implement `project-repos/world-cup-madness/components/predictions/BreakdownTable.tsx` — Server Component, props `{ events: ScoreEventWithMatch[], totalPoints: number }`. Renders an accessible `<table>` with semantic headers (Match / Predicted / Official / Points / Source); uses `<output>` for the running total at the bottom; empty-state message when events.length === 0. i18n labels via `useTranslations('predictions.breakdown')`.
- [ ] T064 [US-PD] Create `project-repos/world-cup-madness/app/(participant)/predictions/breakdown/page.tsx` — Server Component; reads `score_events` filtered by participant_id (RLS applies); joins to matches for predicted vs official scores (predictions also fetched); computes total; renders `<BreakdownTable/>`. `export const revalidate = 60` to mirror feature 002's read-path caching (NFR carry-over).

### Nav links from dashboard

- [ ] T065 [US-PD] Modify `project-repos/world-cup-madness/app/(participant)/dashboard/page.tsx` — add two navigation links: "Final predictions" → `/predictions/final` (gated on `now() < min(kickoff_utc WHERE status != 'cancelled')` — if locked, link to a read-only view or hide); "Your breakdown" → `/predictions/breakdown`. Use the established dashboard widget styling; i18n labels.

### i18n keys

- [ ] T066 [P] [US-PD] Add `predictions.breakdown.*` keys (page heading; column headers; source labels for all 13 enum values; total row; empty state) + `dashboard.nav.finalPredictions` and `dashboard.nav.breakdown` to all three locale files (en/es/pt-BR)

### Playwright spec

- [ ] T067 [P] [US-PD] Playwright test `project-repos/world-cup-madness/e2e/tests/predictions-breakdown.spec.ts` — seed a participant with predictions across 3 matches (1 exact, 1 outcome, 1 wrong) + complete those matches to trigger scoring; navigate to `/predictions/breakdown`; assert: 3 rows visible; each with correct (predicted, official, points, source label); total = 15; empty-state hidden

---

## Final Phase — Polish & Cross-Cutting Concerns

- [ ] T068 [P] Extend `project-repos/world-cup-madness/e2e/tests/all-pages-a11y.spec.ts` with 3 new axe-core surfaces: (a) `/matches/[id]` re-audited with `<PredictionForm/>` mounted (extend existing TC-M3 detail-page test or add a sibling); (b) `/predictions/final` with `<PlayerPickerCombobox/>` opened (mirrors feature 002's TimezonePicker-open test pattern); (c) `/predictions/breakdown` with seeded score_events visible. All at WCAG 2.1 AA, zero violations. Use provider_id range 7301-7310 for any match seeding to stay disjoint from other specs' ranges.
- [ ] T069 Run the full pristine sweep — pgTAP (`for f in test/pgtap/*.sql; do docker exec ... -f - < $f | grep -E "^ ok|^ not ok|ERROR"; done`), Jest (`npm test`), Playwright (`npx playwright test`), tsc (`npx tsc --noEmit`), ESLint (`npm run lint`). All five MUST report zero failures / zero warnings before T070 proceeds.
- [ ] T070 Write `project-repos/world-cup-madness/specs/003-predictions-and-scoring/dod-verification.md` mirroring feature 002's format: per-FR / per-NFR / per-TC coverage table; constraint verification (FC-1 strict-greater-than comparator, FC-2 trigger transactional rollback, FC-3 SECURITY DEFINER-only score_events writes); cite migration numbers + test files for each FR-P; list outstanding external items (FIFA squad publication timing, native-speaker translation review of new `predictions.*` keys, capacity verification against 200 actual participants — pgTAP simulated)
- [ ] T071 [P] Update `project-repos/world-cup-madness/README.md` — add a new "Feature 003 — Predictions and scoring" section sibling to features 001 + 002; document new local commands (how to seed a finished match to trigger scoring; how to invoke recalculate-all locally); troubleshooting matrix (3-5 rows from `quickstart.md` §11 verbatim — most likely: trigger-doesn't-fire, PREDICTION_LOCKED on clearly-unlocked match, stuck scoring_runs row, players empty after sync, `all_runs` returns empty for admin); cross-references to spec / DoD / contracts
- [ ] T072 [P] Update `.ai_project_memory/constitution-backend.md` if any new patterns emerged beyond the two already added (scoring-trigger pattern + security_invoker view). Likely none — re-verify against final implementation
- [ ] T073 [P] Add any newly-surfaced ADRs to `.ai/knowledge/decisions.md` (likely none — all design decisions captured in research.md R-1..R-8 and the spec clarifications). If `.ai/knowledge/decisions.md` doesn't exist yet, do not create it; document the decisions in dod-verification.md instead.
- [ ] T074 Mark all phase-2 through final-phase tasks complete in this file using the Python in-place-rewrite pattern from feature 002 (`python3 -c "re.sub r'^- \[ \] (T0\d{2}) ', r'- [x] \1 '"`). Commit the marked tasks.md alongside the DoD doc in the final commit.

---

## Dependencies & MVP delivery strategy

### Story-level dependency graph

```
Phase 1 (Setup)
    │
    ▼
Phase 2 (Foundational — schema + RLS + types)  ◄────  BLOCKS every story
    │
    ├──────────────────┬──────────────────┬──────────────────┐
    ▼                  ▼                  ▼                  │
US-PA (match write)   US-PB (final + squad)   US-PC (scoring + admin)
    │                  │                  │                  │
    │                  │                  ▼                  │
    │                  │            (creates score_events    │
    │                  │             data the breakdown      │
    │                  │             reads — see below)      │
    │                  │                  │                  │
    └──────────────────┴──────────────────▼──────────────────┘
                                          │
                                          ▼
                                US-PD (breakdown)
                                          │
                                          ▼
                                  Final Phase (polish)
```

### Story dependencies

- **US-PA** ↔ **US-PB**: independent. Different RPCs, different pages. Can ship in parallel after Phase 2.
- **US-PA** → **US-PC**: US-PC's scoring works without US-PA (writes `no-prediction` rows for every participant). But the *positive* scoring scenarios (TC-P12/P13/P14) require predictions to exist, which US-PA provides. For test pragmatism: ship US-PA before US-PC, OR seed predictions in US-PC's test fixtures.
- **US-PB** → **US-PC**: US-PC's final scoring works without US-PB (writes `final-not-picked-*` rows). Same test-pragmatism note as above.
- **US-PC** → **US-PD**: US-PD's breakdown is empty until US-PC writes score_events. The page works (renders the empty-state message); the positive-path test (T067) requires US-PC.

### Parallel execution opportunities

- **[P] markers** identify file-disjoint tasks that can be dispatched concurrently.
- **Phase 2** has 5 [P] pgTAP files (T012-T016) + 2 parallel sanity tasks (T017+T018 must serialise).
- **US-PA** has 4 [P] tasks: T020 (pgTAP), T021+T022 (helpers), T023+T024 (helper tests), T028-T030 (3 locale files), T031-T033 (3 Playwright specs) — total ~10 parallelisable units once T019 (RPC migration) lands.
- **US-PB** has T034 (provider extension), T035 (fixture), T036 (Edge Function index) sequential; T039-T042 (components) partly serial (PlayerPicker depends on PlayerPickerCombobox + PlayerPickerDisabled); T045-T047 (locales) [P]; T048+T049 (Playwright) [P].
- **US-PC** has triggers T050+T051 serial (migration order); pgTAP T053-T056 all [P]; Playwright T057-T060 all [P].
- **US-PD** has T061+T062 [P]; T063+T064 serial; T065 standalone; T066 standalone; T067 [P].
- **Final Phase** T071-T073 [P]; T068 [P] with others; T069 (pristine sweep) must serialise after all implementation; T070 + T074 last.

Estimated parallel-time speedup: ~40% reduction vs strict-sequential, achieved by dispatching all [P] tasks within a phase as concurrent subagent invocations.

### Independent test criteria per story

- **US-PA**: TC-P1, TC-P2, TC-P3, TC-P4, TC-P5, TC-P6, TC-P20, TC-P21 — 8 test cases; all green with hand-seeded matches; scoring engine not required.
- **US-PB**: TC-P7, TC-P8, TC-P9, TC-P10, TC-P11 — 5 test cases; all green with fixture-mode squad sync; final scoring not required for write-path tests (but is for TC-P19 which lives in US-PC).
- **US-PC**: TC-P12, TC-P13, TC-P14, TC-P15, TC-P16, TC-P17, TC-P18, TC-P19, TC-P22 — 9 test cases; all green with seeded match_results; pgTAP capacity test for 200 participants must pass NFR-P2.
- **US-PD**: positive-path test for breakdown render; depends on US-PC for non-empty fixture state.

### MVP delivery strategy

**Recommended MVP** = Phase 1 + Phase 2 + US-PA + US-PC + US-PD (skip US-PB).

Ships participants the complete loop: predict → wait for kickoff → see your score → see your breakdown. Final predictions (champion / runner-up / top-scorer / best-player) ship in a follow-up commit (US-PB) without disturbing the MVP surface — pure additive: a new page + a new RPC + the squad-sync extension.

This MVP:
- Lets participants engage with every match prediction from feature 002's catalog.
- Demonstrates the full scoring engine end-to-end (TC-P12..TC-P18 + TC-P22).
- Gives admins the recalculate-all path for support / corrections.
- Surfaces participants' running totals (US-PD).
- Defers ~15 tasks (US-PB) to a follow-up.

### Risk hotspots

- **T010 (audit_log CHECK extension)** — feature 001's CHECK semantics are not yet verified; if it's an enum-style check, this migration needs DROP+ADD pattern. Confirm by reading feature 001 migration 0005 before starting.
- **T032 (lock boundary triplet)** — needs deterministic `now()` injection (either RPC-direct with frozen time or test-fixture-mockable supabase). Allocate research time before writing.
- **T036 (Edge Function squad-sync)** — first modification to a working Deno function. Test in fixture mode end-to-end before deploying.
- **T050 / T051 (trigger functions)** — most complex SQL in the project to date. Build incrementally with `psql` REPL alongside pgTAP coverage.
- **T053 (capacity test)** — 200-participant trigger budget. May reveal the need for the `players_name_idx` to become a GIN index (deferred per data-model.md §9); also may reveal the need to batch the INSERT...SELECT (currently single statement, expected to be fine).
- **T056 (concurrent recalc-all mutex)** — pgTAP can't easily span two transactions; use the partial-unique-index 23505 simulation pattern (DELETE the in-flight row, INSERT a fake one with finished_at=NULL, then attempt the real insert) for deterministic coverage.

---

## Task ID summary

| Phase | Task IDs | Count |
|---|---|---|
| 1 — Setup | T001-T002 | 2 |
| 2 — Foundational | T003-T018 | 16 |
| 3 — US-PA | T019-T033 | 15 |
| 4 — US-PB | T034-T049 | 16 |
| 5 — US-PC | T050-T060 | 11 |
| 6 — US-PD | T061-T067 | 7 |
| Final | T068-T074 | 7 |
| **Total** | T001-T074 | **74** |

(Plan estimate was 45-55; the final count is 74 because pgTAP coverage expanded to 9 files — one per RLS surface plus 3 trigger/RPC files — and per-locale i18n forced 3-task groupings instead of 1-task batches. The expansion is invariant-coverage debt being paid up front: every RLS policy + every trigger semantic + every RPC contract has its own pgTAP file.)
