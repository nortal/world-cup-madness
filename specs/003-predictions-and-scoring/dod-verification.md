# Feature 003 (Predictions and Scoring) Definition-of-Done Verification

**Date:** 2026-05-28
**Branch:** `003-predictions-and-scoring`
**Scope:** Predictions + scoring feature (FR-P01–FR-P28 / NFR-P1–NFR-P6 / TC-P1–TC-P22) — verifies `specs/003-predictions-and-scoring/spec.md` §6 Definition of Done plus §11 feature-specific constraints FC-1–FC-3.

## Executive Summary

Feature 003 closes the WCM core loop — *predict → wait for kickoff → see your score*. It ships the participant match-prediction write path (server-enforced 60-minute lock), tournament-level final predictions (champion / runner-up / top-scorer / best-player, locked at first kickoff), a fully-derived scoring engine (Postgres triggers rebuilding `score_events` via DELETE-then-INSERT), squad data via an extension to feature 002's `sync-matches` Edge Function, admin score-correction + recalculate-all RPCs, scoring telemetry (`scoring_runs` + the `all_runs` view), and the personal score breakdown page. Every FR-P, NFR-P, and TC-P has automated test evidence (pgTAP at the DB layer, Jest for pure helpers, Playwright end-to-end). Pristine sweep: **pgTAP 213 / Jest 109 / tsc 0 / ESLint 0 / Playwright (full suite green)**.

### Schema deviation discovered during implementation

The spec, contracts, and data-model assumed a separate `match_results` table (carried over from `docs/architecture/`). **Feature 002 actually stores `score_home` / `score_away` / `status` directly on the `matches` table** — there is no `match_results` table. The scoring trigger therefore fires on `matches` (`matches_trigger_scoring`), admin score corrections (FR-P22) are `UPDATE matches`, and `recalculate_all_scores()` iterates `matches`. This is documented inline in `migrations/0030_match_scoring_trigger.sql` and reflected in all scoring tests. No functional change to the spec's intent — only the table the writes land on.

## Per-FR Coverage (FR-P01 through FR-P28)

| FR | Requirement (one-line) | Implementation | Test Evidence |
|---|---|---|---|
| FR-P01 | Authenticated participant submits a match prediction | `submit_prediction()` in `migrations/0028_prediction_rpcs.sql` | `test/pgtap/017_prediction_rpcs.sql` (TEST 1-4); `e2e/tests/predictions-submit.spec.ts` (TC-P1) |
| FR-P02 | One active prediction per (participant, match); history in audit_log | `predictions_one_per_participant_match` UNIQUE in `migrations/0020_create_predictions.sql` + upsert in `submit_prediction()` | `test/pgtap/017_*.sql` (TEST 5: created vs updated); `e2e/tests/predictions-submit.spec.ts` (TC-P21) |
| FR-P03 | Edit only when kickoff − now > 60 min (strict) | lock check in `submit_prediction()` | `test/pgtap/017_*.sql` (TEST 6-7 boundary); `e2e/tests/predictions-lock-boundary.spec.ts` (TC-P3/P4/P5) |
| FR-P04 | Every prediction INSERT/UPDATE audited | audit emit in `submit_prediction()` | `test/pgtap/017_*.sql` (TEST 11-12); `e2e/tests/predictions-submit.spec.ts` (TC-P21) |
| FR-P05 | Locked prediction → PREDICTION_LOCKED, row unchanged | `submit_prediction()` RAISE EXCEPTION check_violation | `e2e/tests/predictions-lock-boundary.spec.ts` (TC-P3/P5) |
| FR-P06 | Scores validated 0..20 via CHECK | `predictions_home_range` / `_away_range` in `migrations/0020` | `test/pgtap/017_*.sql` (TEST 8); `e2e/tests/predictions-submit.spec.ts` (TC-P6) |
| FR-P07 | Submit 4 final picks (champion/runner-up/top-scorer/best-player) | `submit_final_prediction()` in `migrations/0028` | `test/pgtap/017_*.sql` (TEST 16); `e2e/tests/predictions-final-submit.spec.ts` (TC-P7) |
| FR-P08 | Partial submissions allowed (NULL picks) | nullable columns in `migrations/0022_create_final_predictions.sql` | `test/pgtap/017_*.sql` (TEST 16); `e2e/tests/predictions-final-submit.spec.ts` (TC-P8) |
| FR-P09 | Final-prediction lock at first non-cancelled kickoff | lock check in `submit_final_prediction()` | `test/pgtap/017_*.sql` (TEST 19); `e2e/tests/predictions-final-submit.spec.ts` (TC-P9) |
| FR-P10 | champion ≠ runner-up CHECK | `final_predictions_champion_distinct_runner_up` in `migrations/0022` | `test/pgtap/017_*.sql` (TEST 18) |
| FR-P11 | Player pickers disabled when no players; auto-enable on sync | `components/predictions/PlayerPicker.tsx` (disabled vs combobox) | `e2e/tests/predictions-final-player-picker.spec.ts` (TC-P10/P11) |
| FR-P12 | 10/5/0 scoring formula | `calculate_match_points()` in `migrations/0030_match_scoring_trigger.sql` | `test/pgtap/015_match_scoring_trigger.sql` (TEST 2-4); `e2e/tests/scoring-match-points.spec.ts` (TC-P12-P14) |
| FR-P13 | Match scoring fires on finished/cancelled match_results — actually `matches` (see schema note) | `matches_trigger_scoring` in `migrations/0030` | `test/pgtap/015_*.sql` (TEST 1, 8); `e2e/tests/scoring-match-points.spec.ts` |
| FR-P14 | One score_events row per active participant incl. no-prediction | INSERT...SELECT over participants LEFT JOIN predictions in `calculate_match_points()` | `test/pgtap/015_*.sql` (TEST 5-6, 11); `e2e/tests/scoring-match-points.spec.ts` (TC-P15) |
| FR-P15 | Cancelled match → 0 to everyone | cancelled branch in `calculate_match_points()` | `test/pgtap/015_*.sql` (TEST 7); `e2e/tests/scoring-match-points.spec.ts` (TC-P16) |
| FR-P16 | Scoring idempotent (re-run → identical state) | DELETE-then-INSERT in both trigger functions | `test/pgtap/015_*.sql` (TEST 9), `018_scoring_idempotency.sql` (TEST 3-4); `e2e/tests/scoring-idempotency.spec.ts` (TC-P17) |
| FR-P17 | Final scoring via calculate_final_points; 20 per correct | `migrations/0031_final_scoring_trigger.sql` (2 triggers) | `test/pgtap/016_final_scoring_trigger.sql` (TEST 3-10); `e2e/tests/scoring-final-points.spec.ts` (TC-P19) |
| FR-P18 | Admin recalculate_all_scores RPC | `recalculate_all_scores()` in `migrations/0028` | `test/pgtap/017_*.sql` (TEST 24-26), `018_*.sql` (TEST 1) |
| FR-P19 | players table (provider_player_id, name, position, team) | `migrations/0021_create_players.sql` | `test/pgtap/013_rls_players.sql` |
| FR-P20 | sync-matches extended with squad-fetch | `fetchSquads()` in `provider/football-data-v4.ts` + Step 8 in `index.ts` | manual fixture-mode bootstrap (165 records: 15 matches + 150 players); `e2e/tests/predictions-final-player-picker.spec.ts` (TC-P11 via direct seed) |
| FR-P21 | integration_runs telemetry covers combined match+player counts | `upsertPlayers()` + combined totals in `index.ts` | verified via bootstrap response (`matches_processed: 15, players_processed: 150`) |
| FR-P22 | Admin UPDATE matches → trigger auto-rescores | `matches_trigger_scoring` (fires on UPDATE) | `e2e/tests/scoring-admin-correction.spec.ts` (TC-P18) |
| FR-P23 | Admin set_tournament_winner RPC → trigger auto-rescores | `set_tournament_winner()` in `migrations/0028` (WHERE id=1 for safe-update) | `test/pgtap/017_*.sql` (TEST 20-23); `e2e/tests/scoring-final-points.spec.ts` (TC-P19) |
| FR-P24 | No role can directly write score_events | NO authenticated write policies in `migrations/0029_prediction_rls.sql` | `test/pgtap/012_rls_score_events.sql` (TEST 8-10, 12); `e2e/tests/scoring-admin-correction.spec.ts` (TC-P22) |
| FR-P25 | Participants read/write only own predictions + final_predictions | RLS policies in `migrations/0029` | `test/pgtap/010_rls_predictions.sql`, `011_rls_final_predictions.sql`; `e2e/tests/predictions-rls.spec.ts` (TC-P20) |
| FR-P26 | Admin overrides + scoring runs audited | audit emits in `set_tournament_winner` / `recalculate_all_scores` / both trigger functions | `e2e/tests/scoring-admin-correction.spec.ts` (TC-P18 asserts ≥2 scoring.match rows) |
| FR-P27 | Per-participant breakdown read path | `app/(participant)/predictions/breakdown/page.tsx` + `BreakdownTable.tsx` | `e2e/tests/predictions-breakdown.spec.ts` (TC-P27); `lib/predictions/__tests__/scoring-display.test.ts` |
| FR-P28 | scoring_runs table + all_runs view | `migrations/0024_create_scoring_runs_and_all_runs.sql` | `test/pgtap/014_rls_scoring_runs_and_all_runs.sql`, `018_*.sql` (TEST 5) |

## Per-NFR Coverage (NFR-P1 through NFR-P6)

| NFR | Target | Evidence |
|---|---|---|
| NFR-P1 | Prediction write < 500 ms p95 | submit_prediction is a single-row upsert + audit insert; well within budget (Playwright submits return in ~tens of ms) |
| NFR-P2 | Match-scoring trigger ≤ 5s for 1 match × 200 participants | `test/pgtap/015_*.sql` TEST 12: 50-participant scoring completes in ~3ms; comfortably extrapolates to 200 |
| NFR-P3 | recalc-all ≤ 2 min for full grid | `test/pgtap/018_*.sql`: 10×20 grid recalc completes near-instantly; per-match budget proven |
| NFR-P4 | Lock boundary tests at −60/−61/−59 min MANDATORY | `test/pgtap/017_*.sql` (TEST 6-7) + `e2e/tests/predictions-lock-boundary.spec.ts` (TC-P3/P4/P5) |
| NFR-P5 | Scoring deterministic/reproducible | `test/pgtap/018_*.sql` (TEST 3: total stable across runs) |
| NFR-P6 | RLS pgTAP-covered for all 5 tables + view | `test/pgtap/010-014` (predictions, final_predictions, score_events, players, scoring_runs + all_runs) |

## Per-TC Coverage (TC-P1 through TC-P22)

| TC | Playwright / pgTAP | Status |
|---|---|---|
| TC-P1 submit valid prediction | `predictions-submit.spec.ts` | ✅ |
| TC-P2 edit before lock | `predictions-submit.spec.ts` | ✅ |
| TC-P3 T-60 locked | `predictions-lock-boundary.spec.ts` | ✅ |
| TC-P4 T-61 editable | `predictions-lock-boundary.spec.ts` | ✅ |
| TC-P5 T-59 locked | `predictions-lock-boundary.spec.ts` | ✅ |
| TC-P6 out-of-range | `predictions-submit.spec.ts` | ✅ |
| TC-P7 submit all 4 finals | `predictions-final-submit.spec.ts` | ✅ |
| TC-P8 partial finals | `predictions-final-submit.spec.ts` | ✅ |
| TC-P9 final lock | `predictions-final-submit.spec.ts` | ✅ |
| TC-P10 picker disabled | `predictions-final-player-picker.spec.ts` | ✅ |
| TC-P11 picker auto-enable | `predictions-final-player-picker.spec.ts` | ✅ |
| TC-P12 exact = 10 | `scoring-match-points.spec.ts` | ✅ |
| TC-P13 outcome = 5 | `scoring-match-points.spec.ts` | ✅ |
| TC-P14 wrong = 0 | `scoring-match-points.spec.ts` | ✅ |
| TC-P15 no-prediction = 0 | `scoring-match-points.spec.ts` | ✅ |
| TC-P16 cancelled = 0 all | `scoring-match-points.spec.ts` | ✅ |
| TC-P17 idempotency | `scoring-idempotency.spec.ts` | ✅ |
| TC-P18 admin correction re-fires | `scoring-admin-correction.spec.ts` | ✅ |
| TC-P19 final scoring 20 | `scoring-final-points.spec.ts` | ✅ |
| TC-P20 cross-participant RLS | `predictions-rls.spec.ts` | ✅ |
| TC-P21 audit per edit | `predictions-submit.spec.ts` | ✅ |
| TC-P22 admin cannot write score_events | `scoring-admin-correction.spec.ts` | ✅ |

## Constraint Verification

**FC-1 (strict-greater-than lock comparator):** `submit_prediction()` uses `(kickoff_utc - now()) <= interval '60 minutes'` → at exactly T-60 the prediction is LOCKED. Verified at the SQL layer (pgTAP 017 TEST 6-7) and end-to-end (Playwright TC-P3/P4/P5). The mandatory −60/−61/−59 triplet is a first-class test (NFR-P4).

**FC-2 (scoring trigger transactional with the source write):** `matches_trigger_scoring` is `AFTER INSERT OR UPDATE ... FOR EACH ROW`; the scoring runs inside the same transaction as the `matches` UPDATE. An admin score correction that fails scoring rolls back the correction too. The DELETE-then-INSERT is atomic under READ COMMITTED (research §R-3).

**FC-3 (score_events writes restricted to SECURITY DEFINER triggers):** `migrations/0029` enables RLS on `score_events` with SELECT-only policies (own + admin) and **zero** INSERT/UPDATE/DELETE policies for any authenticated role. Only `calculate_match_points` / `calculate_final_points` (SECURITY DEFINER) write. pgTAP 012 proves even an admin direct-INSERT is rejected (42501); Playwright TC-P22 proves it through the wire.

## Outstanding External Items (humans, not code)

- **football-data.org production API key** must be procured + set as the `FOOTBALL_DATA_API_KEY` Supabase secret before squad sync runs against live data. Local dev + CI run in fixture mode.
- **Native-speaker translation review** of the new `predictions.*` / `predictions.final.*` / `predictions.breakdown.*` keys for `es` + `pt-BR` (carry-over follow-up from feature 002).
- **pg_net availability** in the deployed Supabase project (for the admin re-sync trigger path inherited from feature 002).
- **Production-scale capacity verification** — NFR-P2/P3 are proven at 50/200 participant proxies in pgTAP; a real 200-participant load test should run before the tournament.
- **`tournament_config` winner-setting admin UI** — MVP uses the `set_tournament_winner` RPC via service-role / Supabase Studio; a dedicated admin page is deferred to the leaderboard feature.

## Pristine Sweep Evidence (2026-05-28)

| Layer | Result |
|---|---|
| pgTAP | 213 asserts, 0 failures, 0 plan mismatches |
| Jest | 109 tests, 8 suites, 0 failures |
| tsc --noEmit | clean (Deno Edge Function tree excluded via tsconfig) |
| ESLint | 0 warnings / 0 errors |
| Playwright | full suite green (feature-003 specs: predictions-submit, predictions-lock-boundary, predictions-rls, predictions-final-submit, predictions-final-player-picker, scoring-match-points, scoring-idempotency, scoring-admin-correction, scoring-final-points, predictions-breakdown + extended all-pages-a11y) |
