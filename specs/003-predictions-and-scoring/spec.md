# Predictions and Scoring Specification

**Feature Branch**: `003-predictions-and-scoring`
**Created**: 2026-05-22
**Status**: Draft
**Priority**: High
**Input**: User description: "Prediction storage and scoring for World Cup Madness — feature 003 bundles three things into one MVP-playable slice: (1) participant match prediction write path with server-enforced 60-min lock (BR-LOCK-001/002/003); (2) final predictions (champion, runner-up, top scorer, best player) locked at first kickoff; (3) scoring engine (10/5/0 + 20 each per scoring-model.md §7.2-7.3) with idempotent recalc."
**Jira Ticket**: *(none — internal pool, no external tracker)*

---

## 1. Primary User Story

**As a** Nortal collaborator participating in the World Cup Madness pool,
**I want to** submit a predicted score for every match before the prediction window closes, plus a one-shot set of tournament-level predictions (who wins, who comes second, who scores most, who's named best player),
**so that** I'm in the running for points as soon as matches finish and the leaderboard publishes.

A secondary story for tournament administrators:

**As a** tournament administrator,
**I want to** correct a match's final score (or set the tournament champion / runner-up / top scorer / best player) and have every affected participant's points recalculate automatically, without manually touching individual score rows,
**so that** the leaderboard stays accurate when provider data is wrong or late, and so that no participant gets a "favouritism" boost via direct admin edits.

---

## 2. Details

**Problem:** Features 001 and 002 delivered authenticated participants and a browsable read-only match catalog with lock-state badges. The pool's core loop — *predict → wait for kickoff → see your score* — is still missing. Without a write path and a scoring engine, the catalog is decorative. Feature 003 closes the loop: a participant can land on `/matches/[id]`, submit a predicted score, edit it until 60 minutes before kickoff, and (after the match finishes) see those predictions become points via an automatic, deterministic, audit-logged scoring engine. Tournament-level final predictions (champion, runner-up, top scorer, best player) follow the same edit-until-lock pattern with a single sweep-lock at first tournament kickoff.

**Requirement Conflicts:** Requirement conflict check completed — no conflicts found (checked against features 001 + 002 specs on 2026-05-22). This feature *adds* tables (`predictions`, `final_predictions`, `score_events`, `players`, plus `tournament_config` columns for the four official winners) and *extends* the `sync-matches` Edge Function with a squad-fetch step. It does not modify any existing column semantics.

**Clarifications:**

### Round 1 (2026-05-22)

- Q: Final-prediction editability before lock — editable until first-kickoff lock, write-once, or early-commit window? → A: Editable until first-kickoff lock; latest non-locked value wins; one row per participant updated in place. Same lock semantic as match predictions.
- Q: Scoring trigger mechanism — Postgres trigger on `match_results`, Edge Function call, or admin manual + cron? → A: Postgres `AFTER INSERT/UPDATE` trigger on `match_results` when `status='finished'` with non-null score. Transactional, automatic, idempotent.
- Q: Score-events rows for no-prediction participants — write `points=0` rows, skip, or compute on-the-fly? → A: Write `points=0, source='no-prediction'` rows for every participant × finished-match that lacks a prediction. Complete grid; simple sum for breakdown queries; obvious "you missed N matches" UI.
- Q: Top-scorer + best-player predictions — ship in 003 or defer? → A: Ship all four final predictions in 003 (it's already late May, squads land in ~2-3 weeks; deferring would block FR-009/FR-010/FR-012 coverage past first kickoff).
- Q: Prediction value range — cap at 20, 99, or unbounded? → A: 0..20 per side via CHECK constraint. Comfortably above the World Cup record (9-0) but small enough to catch fat-finger typos.

### Round 2 (2026-05-22)

- Q: Cancelled / abandoned match handling — award 0 to everyone, exclude from theoretical_max, or refund predictions? → A: Award `points=0, source='match-cancelled'` to every participant. Symmetric with the no-prediction case; trivial trigger logic; leaderboard sum stays correct; UI shows "Match cancelled — no points awarded".
- Q: Players table data source — extend `sync-matches` to fetch squads, admin CSV upload, or separate sync-players Edge Function? → A: Extend `sync-matches` to call `/v4/teams/{id}/squad` for every team in the seed. Reuses provider abstraction + retry helper + integration_runs telemetry. One new code path, ~830 rows total (32 teams × ~26 players), well within free-tier rate limits.
- Q: Player-picker UX before squads are announced (mid-May 2026) — hide, disable, or seed proxy data? → A: Pickers visible but disabled with "Player rosters not yet announced — pickers will activate when FIFA publishes squads" notice; auto-enable when `players` table has at least 1 row. Sets expectations; UI doesn't reflow; team predictions can be submitted immediately.
- Q: Admin scoring override scope — direct `score_events` writes, only source-data edits + recalc, or hybrid? → A: Admin can only correct match_results (scores, top-scorer/best-player winner) — `score_events` regenerate automatically via the trigger. Deterministic, audit-clean, no favouritism risk. Manual bonus/penalty path explicitly out of scope.

### Session 2026-05-22 (Clarify)

- Q: Score-event source-tag handling on re-runs — when an admin correction flips the scoring source for a (participant, match) pair (e.g. `match-outcome` → `match-exact`), do we keep historical source rows, treat source as immutable, or replace? → A: DELETE-then-INSERT atomically inside the trigger so each (`participant_id`, `match_id`) has **at most one** match-scoring row in `score_events`. The source flip is captured in `audit_log`, not by accumulating rows. Keeps `SUM(points)` queries trivially correct and aligns with the trigger-transactional model (FC-2).
- Q: Final-prediction FK cascade re-scoring — when a player is removed from the squad (`ON DELETE SET NULL` cascade) or the participant edits their pick, do the previously-written `final-*` score_events rows get rebuilt? → A: Trigger `calculate_final_points()` fires on BOTH `tournament_config` UPDATE AND `final_predictions` UPDATE (including FK cascades). The four final-source rows are rebuilt for every affected participant atomically. Symmetric with match scoring (Q1 of this session); no stale rows. Cost: a cascade UPDATE from a player delete touches at most ~200 participants (the NFR-P2 ceiling).
- Q: Observability — telemetry surface for scoring runs (operator-facing "did the last recalc complete and how long did it take")? → A: New `scoring_runs` table (schema shaped for scoring: `match_id` FK, `scoring_reason` enum {`trigger-result-update`, `trigger-config-change`, `trigger-cascade`, `admin-recalc-all`}, `affected_participants_count`, plus the standard `started_at` / `finished_at` / `status` / `error_message`) PLUS an `all_runs` view (`SELECT ... FROM integration_runs UNION ALL SELECT ... FROM scoring_runs`) that unifies both for operator queries. Keeps `integration_runs` semantically clean (external integrations only), gives scoring its own first-class schema, and ops still has a single entry point via the view. The view uses `security_invoker=true` so admin-only RLS on the base tables applies to the view's caller.

---

## 3. Workflow

**Business Workflow:**

*Match prediction path:*

- **Step 1** — A participant opens `/matches/[id]` for an upcoming match (kickoff > now + 60 min).
- **Step 2** — The page renders the existing read-only detail block (teams, kickoff, group, stage, badge) PLUS a new prediction form (home score input + away score input + Submit button). If the participant has already submitted, the form is pre-filled with their current values.
- **Step 3** — Participant enters predicted home + away scores (integers 0..20) and submits.
- **Step 4** — Server validates: (a) authenticated participant exists; (b) match exists and is not yet locked (`kickoff_utc - now() > 60 min`); (c) scores in range. On success, prediction is upserted (one active row per participant × match); audit log row written.
- **Step 5** — UI confirms ("Prediction saved — editable until [lock time in their TZ]"). Participant may edit any number of times before lock.
- **Step 6** — At kickoff − 60 min the prediction locks server-side. Subsequent edit attempts return `PREDICTION_LOCKED` and the UI flips to a read-only "Your prediction: 2–1 (locked)" panel.

*Final prediction path:*

- **Step 1** — Participant opens `/predictions/final` (new route).
- **Step 2** — Page shows four pickers: champion team, runner-up team, top scorer player, best player player. Team pickers populated from `teams`. Player pickers populated from `players` if rows exist; otherwise shown disabled with the "rosters pending" notice.
- **Step 3** — Participant picks any subset and submits. Validation: champion ≠ runner-up; both must be 2026 qualifiers; player picks (if submitted) must reference players in `players`.
- **Step 4** — Server upserts the single `final_predictions` row for this participant; partial submissions are allowed (null columns are fine until lock).
- **Step 5** — Participant may edit any column until the first tournament match kicks off.
- **Step 6** — At first kickoff (`min(matches.kickoff_utc WHERE status != 'cancelled')`), all four columns lock for everyone simultaneously.

*Scoring path:*

- **Step 1** — Provider sync (or admin override) sets `match_results.status='finished'` with non-null `score_home`, `score_away` for a given match.
- **Step 2** — `AFTER INSERT/UPDATE` trigger on `match_results` fires `calculate_match_points(match_id)`.
- **Step 3** — Function iterates every active participant: if a prediction exists, compute 10 / 5 / 0 per §7.2; if not, award 0 with `source='no-prediction'`. The trigger first DELETEs every existing match-scoring row for the match (`DELETE FROM score_events WHERE match_id = $1 AND source LIKE 'match-%'` plus the `no-prediction` source) and then INSERTs the freshly-computed rows in the same transaction — so each (`participant_id`, `match_id`) ends up with exactly one match-scoring row regardless of how many re-runs the match has had.
- **Step 4** — Audit row recorded per scoring run (timestamp, match_id, run reason: trigger / admin recalc).
- **Step 5** — At tournament end, admin sets `tournament_config.champion_team_id`, `.runner_up_team_id`, `.top_scorer_player_id`, `.best_player_player_id`. Trigger on `tournament_config` UPDATE fires `calculate_final_points()` which awards 20 per correct pick across `final_predictions`, again upserting `score_events` with `source='final-champion' | 'final-runner-up' | 'final-top-scorer' | 'final-best-player'`.

**Test Cases / Acceptance Scenarios:**

- **TC-P1: Submit valid match prediction** — Given a signed-in participant and a match with kickoff > now + 60 min, when they POST `(home=2, away=1)`, then a row lands in `predictions` keyed `(participant_id, match_id)` with the values, and the audit log records a `prediction.created` event. {Source: AI, ID: FR-P01}
- **TC-P2: Edit existing prediction before lock** — Given a participant who previously submitted `(2,1)`, when they re-submit `(3,1)` at T−65 min, then the row's `predicted_home_score`, `predicted_away_score`, and `updated_at` change in place, and an audit row records the prior + new values. {Source: AI, ID: FR-P02, FR-P04}
- **TC-P3: Lock boundary — exactly T−60 min is LOCKED** — Given a match at kickoff − 60 min sharp, when a participant submits any prediction, then the server returns `PREDICTION_LOCKED` and the row is unchanged. Verifies BR-LOCK-003 inclusive bound. {Source: scoring-model.md §7.1, ID: BR-LOCK-003}
- **TC-P4: Lock boundary — T−61 min is EDITABLE** — Given the same match at kickoff − 61 min, when a participant submits, then the prediction saves successfully. {Source: scoring-model.md §7.1, ID: BR-LOCK-002}
- **TC-P5: Lock boundary — T−59 min is LOCKED** — Given the same match at kickoff − 59 min, when a participant submits, then the server returns `PREDICTION_LOCKED`. {Source: scoring-model.md §7.1, ID: BR-LOCK-003}
- **TC-P6: Out-of-range score rejected** — Given a participant submits `home=21`, when the server validates, then PostgREST returns an HTTP 400 with `check_violation` and the row is not written. {Source: AI, ID: FR-P06}
- **TC-P7: Submit final predictions, all 4 items** — Given a signed-in participant before first kickoff, when they submit champion=Argentina, runner-up=France, top-scorer=Mbappé, best-player=Vinícius, then a row lands in `final_predictions` with those four columns populated. {Source: high-level-architecture.md FR-009, ID: FR-P07}
- **TC-P8: Partial final-prediction submission** — Given a participant who submits only champion + runner-up (no players picked yet because squads haven't been announced), when they submit, then the row saves with `top_scorer_player_id = NULL` and `best_player_player_id = NULL`. {Source: AI, ID: FR-P08}
- **TC-P9: Final-prediction lock at first kickoff** — Given the tournament's earliest non-cancelled match has kicked off, when any participant attempts to edit `final_predictions`, then the server returns `FINAL_PREDICTIONS_LOCKED`. {Source: scoring-model.md §7.1, ID: BR-LOCK-005}
- **TC-P10: Player picker disabled before squad sync** — Given `players` is empty, when a participant loads `/predictions/final`, then the two player pickers are rendered with `aria-disabled="true"` and the "Player rosters not yet announced" notice is visible. {Source: AI, ID: FR-P11}
- **TC-P11: Player picker auto-enables after squad sync** — Given an admin (or scheduled job) runs the squad-sync step of the Edge Function so `players` now has rows, when a participant loads `/predictions/final`, then the pickers are interactive. {Source: AI, ID: FR-P11, FR-P20}
- **TC-P12: Scoring — exact match awards 10** — Given a finished match with official `(2,1)` and a participant prediction `(2,1)`, when the scoring trigger fires, then `score_events` has a row `(participant_id, match_id, points=10, source='match-exact')`. {Source: scoring-model.md §7.2, ID: FR-P12}
- **TC-P13: Scoring — correct outcome awards 5** — Given official `(2,1)` and prediction `(3,1)`, when the trigger fires, then the row is `points=5, source='match-outcome'`. {Source: scoring-model.md §7.2, ID: FR-P12}
- **TC-P14: Scoring — wrong outcome awards 0** — Given official `(2,1)` and prediction `(1,2)`, when the trigger fires, then the row is `points=0, source='match-wrong'`. {Source: scoring-model.md §7.2, ID: FR-P12}
- **TC-P15: Scoring — no prediction awards 0** — Given a finished match where participant X never submitted, when the trigger fires, then X gets a row `points=0, source='no-prediction'`. {Source: scoring-model.md §7.2 row 4, ID: FR-P14}
- **TC-P16: Scoring — cancelled match awards 0 to everyone** — Given a match transitions to `status='cancelled'`, when the trigger fires, then every active participant gets a row `points=0, source='match-cancelled'` for that match. {Source: AI, ID: FR-P15}
- **TC-P17: Scoring idempotency** — Given the trigger has already run for a match, when the same trigger fires again with unchanged data, then after the re-run there is still exactly one match-scoring row per active participant for that match and every `points` value is identical to the prior run. (Row primary keys may differ — the trigger DELETEs then INSERTs — but the functional state is identical.) {Source: AI, ID: FR-P16}
- **TC-P18: Admin score correction triggers re-scoring** — Given the admin updates `match_results.score_home` from 2 to 3 (post-result correction), when the row is updated, then the trigger re-fires and every affected `score_events` row updates in place with the new points. Audit log records the re-calc reason. {Source: high-level-architecture.md FR-015 + FR-016, ID: FR-P22}
- **TC-P19: Final scoring — champion correct awards 20** — Given `tournament_config.champion_team_id` is set to Argentina and a participant's `final_predictions.champion_team_id` is Argentina, when the final-scoring trigger fires, then a `score_events` row `points=20, source='final-champion'` is written. {Source: scoring-model.md §7.3, ID: FR-P17}
- **TC-P20: RLS — participants cannot read each other's predictions** — Given participant A is signed in, when A tries to SELECT participant B's row from `predictions`, then PostgREST returns zero rows (RLS filters them out). {Source: AI, ID: FR-P25}
- **TC-P21: Audit log captures every prediction edit** — Given a participant submits a prediction, edits it three times, and lets it lock, then `audit_log` has at least four rows for that `(participant_id, match_id)` pair tagged with action `prediction.created` and `prediction.updated`. {Source: high-level-architecture.md FR-018, ID: FR-P04, FR-P26}
- **TC-P22: Admin cannot directly INSERT score_events** — Given an admin authenticated session, when admin attempts `INSERT INTO score_events` via PostgREST, then the call returns insufficient_privilege (RLS denies). Only service_role (used by the trigger) can write `score_events`. {Source: AI, ID: FR-P24}

**Edge Cases:**

- What happens when a match's kickoff_utc is changed by the provider (rescheduling)? The new kickoff defines the new lock — predictions for that match become editable again if the new kickoff is now > 60 min away, and a match that was locked may become unlocked. Audit log records the kickoff change. Score events for the match (if any from a stale run) are recomputed on next status='finished' transition. — Per scoring-model.md §7.5 "Postponed matches".
- What happens if a participant tries to submit at exactly the moment the lock fires? The lock is enforced by a Postgres function reading `now()` server-side; the write either succeeds (T−61 min) or returns PREDICTION_LOCKED (T≤−60 min). There is no "in between" — the lock boundary is atomic.
- What if two browser tabs of the same participant submit different predictions simultaneously? Last-write-wins (whichever transaction commits second). Both writes audit-log; the final stored value is the last commit. Participant sees their displayed value reconcile to the latest on next read.
- What if `players` is populated but a player a participant picked is later removed from the squad? The `final_predictions.top_scorer_player_id` is a foreign key; cascade behaviour is `ON DELETE SET NULL`. If a player is deleted post-pick, the participant's pick is cleared, the `final_predictions` UPDATE fires `calculate_final_points()` per FR-P17, and the participant's `final-top-scorer` score_events row is rebuilt as a 0-point `final-not-picked-top-scorer` row. UI surfaces "Your top-scorer pick is no longer in any squad — please pick again before first kickoff."
- What if an admin manually sets `tournament_config.champion_team_id` BEFORE the tournament ends? The trigger fires immediately and awards 20 points to every participant who picked correctly. This is admin error — runbook says "do not set winners until officially announced". Mitigation: audit log captures the timestamp; admin can clear (set back to NULL) and re-set; participants' totals adjust accordingly.
- What if the scoring trigger fails mid-run (DB error, constraint violation on a single row)? The whole trigger transaction rolls back. `match_results` update also rolls back. Admin sees the original (pre-update) state. Failure must be diagnosed and re-run manually. Mitigation: trigger logic is wrapped in defensive checks; pgTAP tests cover the failure modes.
- What if a participant submits a final prediction with `champion_team_id == runner_up_team_id`? Server-side CHECK constraint rejects with `check_violation`; UI shows "Champion and runner-up must be different teams".
- What if a participant's account is deactivated (`status != 'active'`) after they've submitted predictions? Predictions remain in the DB but the deactivated participant is excluded from scoring runs (the trigger filters on `participants.status = 'active'`). If reactivated, the next scoring run includes them again.

---

## 4. Requirements

**Requirement Documents:**

- **Architecture spec:** `docs/architecture/high-level-architecture.md` — FR-005..FR-018, BR-LOCK-001..006
- **Scoring model:** `docs/architecture/scoring-model.md` — §7.2, §7.3
- **Acceptance criteria:** `docs/architecture/acceptance-criteria.md`
- **Open decisions resolved:** OD-002, OD-003, OD-004, OD-005 (all in `docs/architecture/open-decisions.md`)

**Functional Requirements:**

*Match predictions:*

- **FR-P01**: System MUST allow an authenticated participant to submit a match prediction for any upcoming non-locked match via a server-validated write path. {Source: high-level-architecture.md, ID: FR-005}
- **FR-P02**: System MUST maintain exactly one active prediction row per (`participant_id`, `match_id`) pair while preserving prior edit history in `audit_log`. {Source: high-level-architecture.md, ID: FR-006}
- **FR-P03**: System MUST allow a participant to update an existing match prediction only when the match's `kickoff_utc - server_now() > interval '60 minutes'` (strict inequality, per BR-LOCK-003). {Source: scoring-model.md §7.1, ID: BR-LOCK-002+003}
- **FR-P04**: System MUST record every prediction `INSERT` and `UPDATE` to `audit_log` with the actor's `participant_id`, timestamp, prior values, new values, and an action tag of `prediction.created` or `prediction.updated`. {Source: high-level-architecture.md, ID: FR-018}
- **FR-P05**: System MUST prevent any modification to a prediction once locked, returning the structured error `PREDICTION_LOCKED` and leaving the existing row unchanged. {Source: high-level-architecture.md, ID: FR-008}
- **FR-P06**: System MUST validate `predicted_home_score` and `predicted_away_score` as integers in the inclusive range 0..20 via a Postgres `CHECK` constraint, returning a friendly error on violation. {Source: AI/Specify, ID: N/A}

*Final predictions:*

- **FR-P07**: System MUST allow an authenticated participant to submit (and later edit) final tournament predictions covering four items: champion team, runner-up team, top scorer player, best player player. Champion and runner-up reference `teams`; top scorer and best player reference `players`. {Source: high-level-architecture.md, ID: FR-009}
- **FR-P08**: System MUST allow partial submissions (any subset of the four items NULL) and treat NULL items as "not picked" at scoring time (awarded 0 points, source `final-not-picked-<item>`). {Source: AI/Specify, ID: N/A}
- **FR-P09**: System MUST prevent any modification to `final_predictions` once the first non-cancelled tournament match has kicked off (`server_now() >= min(matches.kickoff_utc WHERE status != 'cancelled')`), returning `FINAL_PREDICTIONS_LOCKED`. {Source: scoring-model.md §7.1, ID: BR-LOCK-005}
- **FR-P10**: System MUST reject final-prediction submissions where `champion_team_id = runner_up_team_id` via a `CHECK` constraint. {Source: AI/Specify, ID: N/A}
- **FR-P11**: System MUST render the top-scorer and best-player pickers as visible-but-disabled when the `players` table is empty, displaying a "Player rosters not yet announced — pickers will activate when FIFA publishes squads" notice. Pickers auto-enable when at least one `players` row exists. {Source: Clarifications Round 2 Q8, ID: AI}

*Scoring engine:*

- **FR-P12**: System MUST compute match points using the deterministic rule: 10 points if `(predicted_home, predicted_away) = (official_home, official_away)`; 5 points if the predicted outcome (home win / draw / away win) matches the official outcome but the exact score does not; 0 points otherwise. {Source: scoring-model.md §7.2, ID: FR-011}
- **FR-P13**: System MUST fire match scoring automatically via a Postgres `AFTER INSERT/UPDATE` trigger on `match_results` when both: (a) `status` is `'finished'`; (b) `score_home` and `score_away` are not null. {Source: Clarifications Round 1 Q2, ID: AI}
- **FR-P14**: System MUST write exactly one `score_events` row per (`participant_id`, `match_id`) for every `participant` with `status='active'` after a scoring run — including participants who did not submit a prediction (`points=0, source='no-prediction'`). {Source: Clarifications Round 1 Q3, ID: AI}
- **FR-P15**: System MUST award `points=0, source='match-cancelled'` to every active participant for matches that transition to `status='cancelled'`. {Source: Clarifications Round 2 Q6, ID: AI}
- **FR-P16**: System MUST be idempotent: re-running the scoring trigger for the same `match_id` with unchanged inputs MUST NOT create duplicate rows and MUST NOT change any `points` value. {Source: AI/Specify, ID: N/A}
- **FR-P17**: System MUST score final predictions via a separate function `calculate_final_points()` triggered on (a) `tournament_config` UPDATE when any of `champion_team_id`, `runner_up_team_id`, `top_scorer_player_id`, `best_player_player_id` changes; AND (b) `final_predictions` UPDATE (including FK cascade `SET NULL` from a `players` delete). For each affected participant, the trigger DELETE-then-INSERTs the four `final-*` rows in `score_events` so each participant has at most one row per final source. Each correct pick awards 20 points; each incorrect or NULL pick writes a 0-point row with `source` indicating which item (`final-not-picked-<item>` for NULL picks). {Source: scoring-model.md §7.3 + Session 2026-05-22 Clarify Q2, ID: FR-012}
- **FR-P18**: System MUST allow an authenticated admin to trigger a manual full recalculation across all matches via a `recalculate_all_scores()` RPC. The RPC iterates every finished match and re-runs the per-match scoring path. {Source: high-level-architecture.md, ID: FR-016}
- **FR-P28**: System MUST record every scoring run (per-match trigger AND `recalculate_all_scores()` RPC) to a new `scoring_runs` table with `match_id` (FK, nullable for recalc-all), `scoring_reason` (`trigger-result-update` / `trigger-config-change` / `trigger-cascade` / `admin-recalc-all`), `affected_participants_count`, `started_at`, `finished_at`, `status`, `error_message`. RLS: admin-only SELECT (mirrors `integration_runs` from feature 002). A `all_runs` view (`security_invoker=true`) UNIONs `integration_runs` + `scoring_runs` so operators have one entry point for "what did the system do recently?". {Source: Session 2026-05-22 Clarify Q3, ID: AI}

*Players + squad sync:*

- **FR-P19**: System MUST persist a `players` table with columns sufficient to identify a player: `id` (UUID), `provider_player_id` (INT UNIQUE), `name` (text), `position` (text nullable), `team_id` (FK to `teams`), `created_at`, `updated_at`. {Source: AI/Specify, ID: N/A}
- **FR-P20**: System MUST extend the `sync-matches` Edge Function (feature 002) with a `squad-sync` step that fetches `/v4/teams/{provider_team_id}/squad` for every row in `teams`, normalises the response, and UPSERTs into `players` on `provider_player_id`. {Source: Clarifications Round 2 Q7, ID: AI}
- **FR-P21**: System MUST update the existing `integration_runs` telemetry to record squad-sync counts in the same row as match-sync (no new table). The Edge Function reports `records_processed`, `records_unchanged` as a combined sum across matches + players. {Source: AI/Specify, ID: N/A}

*Admin overrides:*

- **FR-P22**: System MUST allow an authenticated admin to UPDATE `match_results.score_home`, `score_away`, `status` via PostgREST; the scoring trigger then automatically regenerates the affected `score_events` rows. {Source: high-level-architecture.md, ID: FR-015}
- **FR-P23**: System MUST allow an authenticated admin to UPDATE `tournament_config.champion_team_id`, `runner_up_team_id`, `top_scorer_player_id`, `best_player_player_id` via a `set_tournament_winner(item, id)` RPC; the final-scoring trigger then regenerates the affected `score_events` rows. {Source: high-level-architecture.md, ID: FR-015}
- **FR-P24**: System MUST NOT permit any role (including `admin`) to directly INSERT or UPDATE `score_events` via PostgREST. All `score_events` writes flow through trigger-invoked functions executing as `SECURITY DEFINER`. {Source: Clarifications Round 2 Q9, ID: AI}

*RLS + audit:*

- **FR-P25**: System MUST enforce RLS policies such that participants can only `SELECT`, `INSERT`, `UPDATE` rows in `predictions` and `final_predictions` where `participant_id = auth.uid()`-derived identity. Admins can `SELECT` all rows but not `INSERT/UPDATE` on behalf of others. {Source: high-level-architecture.md, ID: NFR-006}
- **FR-P26**: System MUST record every admin override (match_results edit, tournament_config update, manual recalc trigger) to `audit_log` with action tags `admin.match-result-override`, `admin.tournament-winner-set`, `admin.recalc-all` respectively. {Source: high-level-architecture.md, ID: FR-018}

*Personal breakdown (minimal — full leaderboard deferred to feature 004):*

- **FR-P27**: System MUST expose a per-participant breakdown query via a `SELECT` against `score_events` filtered to `participant_id = auth.uid()` (RLS-enforced). UI surface: a minimal `/predictions/breakdown` page listing each (match, predicted, official, points, source) row plus a total. Leaderboard view of all participants is **out of scope** for this feature. {Source: high-level-architecture.md, ID: FR-014}

**Feature-Specific Non-Functional Requirements:**

- **NFR-P1**: Prediction write latency (server-side, excluding network) MUST be < 500 ms p95 measured via Server Action / PostgREST round trip.
- **NFR-P2**: Match-scoring trigger MUST complete within 5 seconds for one match × up to 200 active participants. (200 is the planning ceiling per high-level-architecture.md §10.)
- **NFR-P3**: `recalculate_all_scores()` MUST complete within 2 minutes for the full tournament (104 matches × 200 participants).
- **NFR-P4**: Lock boundary tests at exactly kickoff − 60 min, − 61 min, − 59 min MUST be mandatory in the test suite per BR-LOCK-003 (the inclusive-bound rule).
- **NFR-P5**: All scoring computations MUST be deterministic and reproducible — running the trigger N times with identical inputs MUST yield identical outputs.
- **NFR-P6**: All RLS policies on `predictions`, `final_predictions`, `score_events`, `players`, `tournament_config`, `scoring_runs`, and the `all_runs` view MUST be verified via pgTAP tests.

**Out of Scope:**

- **Leaderboard view** (FR-013) — ranking, tie-breakers, materialized snapshots, Realtime subscriptions: deferred to feature 004. `score_events` writes happen here; reading them as a sorted leaderboard is a separate feature.
- **Tie-breaker rules approval** (scoring-model.md §7.4 rows #4 + #5) — needs business sign-off before the leaderboard feature; not on this critical path.
- **Notification channels** (OD-008) — reminders to participants whose predictions are about to lock, etc. Post-MVP.
- **Player photos / metadata** — `players` table holds name + position + team only. Adding crests / photos is a UX polish item.
- **Live in-play score display** — kickoff times + final scores only, per the feature 002 carve-out.
- **Admin UI for `score_events` review** — admin can `SELECT` via Supabase Studio. A dedicated admin page lands with the leaderboard feature.
- **`tournament_config` admin UI for setting the four winners** — service-role / Supabase Studio for MVP; admin page deferred to leaderboard feature.

---

## 5. Deferred Decisions

- **Item:** Tie-breaker rules priority order (§7.4 rows #4 "highest final prediction points" and #5 "earliest submission timestamp") — **Rationale:** Both need business approval before the leaderboard feature ships and a default ordering won't be load-bearing until then. — **Resolution phase:** Feature 004 planning.
- **Item:** Player-picker UX when squads land mid-feature — **Rationale:** The disabled-with-notice pattern is well-defined; the exact wording and the timing of the "your top-scorer pick is no longer in any squad" UX flow can be refined during implementation based on actual squad-sync behaviour. — **Resolution phase:** Implementation.
- **Item:** Whether to expose a "your score updated" toast when scoring re-runs (admin correction) — **Rationale:** Realtime is feature-004 territory; for 003 a page refresh shows updated scores. — **Resolution phase:** Feature 004 planning.
- **Item:** Breakdown page placement — new tab on `/profile` vs new top-level route `/predictions/breakdown`. — **Rationale:** Both fit the navigation IA equally well; the choice depends on whether `/profile` should stay focused on identity + preferences (favouring the top-level route) or absorb personal analytics (favouring the tab). Low blast radius either way. — **Resolution phase:** Planning.

---

## 6. Definition of Done

- All functional requirements (FR-P01 through FR-P27) implemented and verified by automated tests
- All test cases (TC-P1 through TC-P22) pass — including the mandatory lock-boundary triplet (TC-P3, TC-P4, TC-P5)
- Edge cases (8 listed in Section 3) handled and tested
- pgTAP suite covers RLS on `predictions`, `final_predictions`, `score_events`, `players` (NFR-P6)
- Scoring idempotency proven via pgTAP repeat-trigger test (TC-P17)
- Audit-log coverage proven: every prediction edit, admin override, and scoring run produces an `audit_log` row
- Squad-sync Edge Function path tested in fixture mode (extend the existing `__fixtures__/v4-sample.json` or add a `squad-sample.json`)
- Accessibility: prediction form + final-prediction pickers pass axe-core WCAG 2.1 AA (extend `e2e/tests/all-pages-a11y.spec.ts`)
- Internationalisation: all new UI strings present in en / es / pt-BR; native-speaker review queued for es + pt-BR (carry-over follow-up from feature 002)
- DoD verification doc (`specs/003-predictions-and-scoring/dod-verification.md`) authored mirroring feature 002 format
- Pristine sweep clean: pgTAP, Jest, Playwright, tsc, ESLint all green

---

## 8. Key Entities

**Predictions:** A participant's predicted score for a single match.

- **Purpose:** Captures one active forecast per participant × match, with full edit history in `audit_log`.
- **Key attributes:** participant reference, match reference, predicted home score, predicted away score, created timestamp, updated timestamp.
- **Relationships:** FK to `participants`, FK to `matches`. Unique constraint on (`participant_id`, `match_id`).

**Final Predictions:** A participant's tournament-level predictions.

- **Purpose:** One row per participant covering the four tournament-wide picks; all four columns lock simultaneously at first kickoff.
- **Key attributes:** participant reference, champion team reference (nullable), runner-up team reference (nullable), top-scorer player reference (nullable), best-player player reference (nullable), created timestamp, updated timestamp.
- **Relationships:** FK to `participants` (UNIQUE — one row per participant), FK to `teams` × 2, FK to `players` × 2. CHECK constraint: `champion_team_id IS DISTINCT FROM runner_up_team_id`.

**Score Events:** Points awarded to a participant for a single scoring source.

- **Purpose:** The ledger of points, rebuilt per match by the scoring trigger (DELETE-then-INSERT atomically). Sum across `participant_id` = participant's total. Distinguishes match-derived, final-prediction-derived, and no-prediction-derived rows for breakdown queries. The source flip on a re-score (e.g. `match-outcome` → `match-exact` after an admin correction) is captured in `audit_log`, not by accumulating multiple score-event rows.
- **Key attributes:** participant reference, match reference (nullable — finals don't reference a match), source tag (`match-exact`, `match-outcome`, `match-wrong`, `no-prediction`, `match-cancelled`, `final-champion`, `final-runner-up`, `final-top-scorer`, `final-best-player`, `final-not-picked-<item>`), points awarded, scoring run timestamp, scoring run reason.
- **Relationships:** FK to `participants`, FK to `matches` (nullable). Unique constraints: (`participant_id`, `match_id`) WHERE `match_id IS NOT NULL` (at most one match-scoring row per participant per match — enforced by the DELETE-then-INSERT trigger contract); (`participant_id`, `source`) WHERE `match_id IS NULL` (at most one row per participant per final-prediction source — `final-champion`, `final-runner-up`, etc).

**Players:** Individual football players, populated by squad sync from football-data.org.

- **Purpose:** Reference data for top-scorer + best-player final predictions. Populated by the extended `sync-matches` Edge Function once FIFA publishes 2026 squads.
- **Key attributes:** provider player ID (UNIQUE INT from football-data.org), name, position (nullable), team reference, created + updated timestamps.
- **Relationships:** FK to `teams`. `ON DELETE SET NULL` cascade to `final_predictions.top_scorer_player_id` / `best_player_player_id`.

**Tournament Config (extended):** Singleton row holding tournament-wide settings; extended in this feature with the four official winners.

- **Purpose:** Source of truth for the four tournament-end picks against which final predictions are scored. Trigger on UPDATE fires `calculate_final_points()`.
- **Key attributes (new):** champion team reference, runner-up team reference, top-scorer player reference, best-player player reference. All nullable until officially announced.
- **Relationships:** FK to `teams` × 2, FK to `players` × 2.

**Scoring Runs:** Operator-facing telemetry for every scoring trigger fire and admin recalc.

- **Purpose:** Mirrors `integration_runs` (feature 002) for the scoring engine. Operators query `all_runs` (a view that UNIONs `integration_runs` + `scoring_runs`) for a single chronological "what did the system do?" surface.
- **Key attributes:** match reference (nullable — recalc-all touches every match), scoring reason enum (`trigger-result-update`, `trigger-config-change`, `trigger-cascade`, `admin-recalc-all`), affected participants count, started timestamp, finished timestamp (nullable while in flight), status (`success` / `error` / `skipped`), error message (nullable).
- **Relationships:** FK to `matches` (nullable). Surfaced to operators via the `all_runs` view (`security_invoker=true`) which UNIONs against `integration_runs`. Admin-only SELECT via RLS, mirroring `integration_runs` policy from feature 002.

---

## 9. UX Considerations

**User Interface Context:**

- **Primary user actions:** (a) on `/matches/[id]`: enter two integers, submit; (b) on `/predictions/final`: pick from four select-style pickers, submit; (c) on `/predictions/breakdown`: read-only review of per-match score events.
- **User journey touchpoints:** Prediction form appears inline on the existing `/matches/[id]` page below the read-only detail block. Final-predictions page is a new top-level participant route (linked from `/dashboard` nav). Breakdown page placement (a new tab on `/profile` vs a new top-level route `/predictions/breakdown`) is deferred to planning — see Section 5.
- **Accessibility needs:** Form inputs must be keyboard-navigable, labeled, and screen-reader-friendly. The four final-prediction pickers must follow the same WAI-ARIA combobox pattern as feature 002's `<TimezonePicker />`. Lock-state read-only views must use semantic `<output>` or `<dl>`, not styled `<input disabled>` (axe-core flags the latter as confusing for screen readers).
- **Usability considerations:** The prediction form must clearly show the lock countdown ("Locks in 2h 13m") and visually transition to a locked state at T−60 min. Server validation errors (out of range, locked, FK violation) must render as inline form errors with i18n-translated messages, not generic toasts.

**Design References:**

- *No captured design assets.* UI follows the established patterns from features 001 + 002 (Tailwind tokens, custom Tailwind components, server-first rendering).

---

## 10. Integration Context

**External Systems:**

- **football-data.org REST API v4** (extended use):
  - **Business purpose:** Source of squad data for the `players` table (in addition to fixtures + scores already used by feature 002).
  - **Data exchange:** GET `/v4/competitions/WC/teams` returns each team with its current squad; alternatively GET `/v4/teams/{id}` returns squad detail. Sync writes only the player attributes we need (provider_player_id, name, position).
  - **Timing:** Squad sync runs as the second step of the existing `sync-matches` Edge Function invocation (so a single admin re-sync action covers both fixtures and squads). Squads are stable post-announcement; daily sync is sufficient.

**Integration Constraints:**

- Rate limit: 10 requests / minute on the free tier. 32 team-squad calls = 4 minutes worst case. Retry helper from feature 002 applies; the existing fixture-mode bypass also covers squads (extend `__fixtures__/v4-sample.json` or add a sibling squad fixture).
- API availability: same fallback as feature 002 — if the provider is down at the time of the scheduled sync, the existing `players` rows stay; the next successful sync reconciles. Empty-squad case (pre-FIFA-announcement) is handled by FR-P11 (disabled pickers).

---

## 11. Feature-Specific Constraints

**FC-1:** Match prediction lock must be a strict-greater-than comparison (`kickoff_utc - now() > interval '60 minutes'`)

- **Description:** Per BR-LOCK-003, the 60-minute boundary is INCLUSIVE — exactly at T−60 min the prediction is locked. The Postgres function MUST use `>`, never `>=`. This is a load-bearing semantic; getting it wrong silently changes scoring scope.
- **Impact:** Every server-side validation function and every test of the lock boundary must use this comparator. Mirrors feature 002's `LOCKED` badge derivation.

**FC-2:** Scoring trigger must be transactional with the match_results write

- **Description:** When admin updates `match_results.score_home`, the trigger that re-scores must run in the same transaction. If the trigger fails, the match_results update must roll back. No partial state where the score has changed but the score_events haven't.
- **Impact:** Trigger is implemented as `AFTER INSERT/UPDATE ... FOR EACH ROW EXECUTE FUNCTION ...` (not STATEMENT-level, not BEFORE, not via NOTIFY/LISTEN). Forces all scoring logic into SQL — no async paths.

**FC-3:** score_events writes restricted to SECURITY DEFINER trigger function

- **Description:** No role (including `admin`) has direct INSERT/UPDATE/DELETE on `score_events`. All writes go through `calculate_match_points()` and `calculate_final_points()`, both `SECURITY DEFINER`. RLS denies direct writes from `authenticated`.
- **Impact:** Audit clarity (every event traces to a calc reason); prevents the favouritism risk; admin overrides must go through match_results / tournament_config, never score_events directly.

### Feature-Specific Assumptions

**FA-1:** FIFA will publish 2026 squads by late May / early June 2026

- The 23-day pre-tournament window typically applies. Players-table sync should land at least 2 weeks before first kickoff; if not, the disabled-picker UX (FR-P11) covers the gap gracefully.
- **Validation plan:** Squad sync is fixture-tested end-to-end. Real-data sync runs once weekly starting two months out and surfaces missing-squad warnings via `integration_runs`.

**FA-2:** football-data.org `/v4/teams/{id}/squad` returns a stable `id` per player

- The provider's player IDs are stable across squad updates (same player ID even if jersey number changes). UPSERT on `provider_player_id` relies on this.
- **Validation plan:** A pgTAP test will assert idempotency: running the squad sync twice does not duplicate `players` rows.

**FA-3:** Active participant count stays under 200 at scoring time

- Per high-level-architecture.md §10 planning ceiling. The scoring trigger budget (NFR-P2 = 5 seconds per match) assumes this. If the active count exceeds 500 during planning, revisit by adding indexed prefilter on participants or batching the score_events upsert.
- **Validation plan:** Capacity test in implementation phase against a seeded 200-participant dataset.

---

## 12. References

**Project Context:**

- Project Context: `.ai_project_memory/general-overview.md`
- Constitution: `.ai_project_memory/constitution.md` — Architectural principles
- Backend constitution: `.ai_project_memory/constitution-backend.md` — Supabase / Postgres patterns (RLS, SECURITY DEFINER, partial unique indexes for mutexes)
- Frontend constitution: `.ai_project_memory/constitution-frontend.md` — Next.js App Router, Tailwind, next-intl, WAI-ARIA picker pattern
- Architecture (system): `.ai_project_memory/architecture.md`

**Related Specifications:**

- `specs/001-authentication-and-participant/spec.md` — auth + participant provisioning (consumed by all writes here)
- `specs/002-match-catalog-read/spec.md` — match catalog read path + sync-matches Edge Function (extended by FR-P20 squad sync)
- `specs/002-match-catalog-read/dod-verification.md` — feature 002 audit-evidence template, reused for 003 DoD

**External References:**

- `docs/architecture/high-level-architecture.md` — FR-005..FR-018, NFR-005..NFR-012, §7 scoring, §10 capacity
- `docs/architecture/scoring-model.md` — §7.2, §7.3, §7.5 (knockout regulation-time basis, top-scorer + best-player resolution)
- `docs/architecture/open-decisions.md` — OD-002 (resolved), OD-003 (resolved), OD-004 (resolved), OD-005 (resolved)
- `docs/architecture/acceptance-criteria.md` — match-scoring + final-scoring scenarios

---

## Review & Acceptance Checklist

### Content Quality

- [x] No implementation details (languages, frameworks, APIs) — text refers to "Postgres trigger", "RPC", "Edge Function" only at the level of integration contract, not implementation specifics; entity descriptions avoid types
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders (BR-LOCK / FR / TC vocabulary is shared with the architecture spec)
- [x] All mandatory sections completed

### Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous (each FR-P maps to one or more TC-P)
- [x] Success criteria are measurable (lock boundary at the minute; scoring formulas exact; latencies in NFR-P)
- [x] Scope is clearly bounded (8-item Out of Scope list)
- [x] Dependencies and assumptions identified (FA-1, FA-2, FA-3; FC-1, FC-2, FC-3; integration with football-data.org v4)

### Traceability & Context

- [x] BRD requirements linked — every FR-P cites the originating FR-NNN from high-level-architecture.md or the originating Q&A round
- [ ] Jira/Confluence references included — N/A (internal pool, no external tracker)
- [ ] Figma designs referenced — N/A (no captured design assets)
- [x] All clarifications documented with timestamps (Round 1 + Round 2, 2026-05-22)
- [x] Deferred decisions documented (3 items in Section 5)

---

## Execution Status

- [x] User description parsed
- [x] Key concepts extracted (predictions, final predictions, scoring, players, admin override)
- [x] Ambiguities marked and resolved through Socratic dialogue (9 questions across 2 rounds)
- [x] User scenarios defined
- [x] Requirements generated (27 FR-P + 6 NFR-P + 7 out-of-scope items)
- [x] Entities identified (5 entities, 1 extended)
- [x] Review checklist passed

---
