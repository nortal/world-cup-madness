# Tasks: Phase 5 — Operational Readiness

**Feature**: 006-phase-5-operational
**Input**: `specs/006-phase-5-operational/` — plan.md (required), spec.md, research.md, data-model.md, contracts/ (5 files), quickstart.md
**Generated**: 2026-06-12 via `/ai1st-dev-tasks`

## Overview

Tasks are organised into 8 phases:

- **Phase 1** — Setup (dirs + Edge Function scaffolding + CI secret-hygiene check)
- **Phase 2** — Foundational (migrations 0039 + 0040 + mock receiver Edge Function + generated types + 3 pgTAP suites; blocks every user story)
- **Phase 3** — US1: Provider-sync error notification + runbook (FR-O01, FR-O04; TC-O1, TC-O3; P1 kickoff MUST)
- **Phase 4** — US2: Scoring error notification + runbook (FR-O02, FR-O05; TC-O2, TC-O4; P1 kickoff MUST)
- **Phase 5** — US3: Health check bundle + leaderboard-refresh notification extension (FR-O08, FR-O09; TC-O5, TC-O6; P2 follow-on)
- **Phase 6** — US4: Secondary runbooks + archival plan (FR-O10, FR-O11, FR-O12; P2 follow-on)
- **Final Phase** — Polish (pristine sweep, DoD verification doc, README, constitution check, tasks-complete marking)

US1 + US2 share the foundational notification mechanism (single trigger function, single scrubber, single audit pattern). They differ only in (a) the `*_runs` table the trigger fires on — both attached in foundational Phase 2 — and (b) the runbook each story owns. US3 + US4 are additive follow-on; US3 expands the trigger to a third source (`audit_log` for `leaderboard.refresh_failed`) and adds the Studio health-query bundle; US4 ships the four secondary runbooks + archival plan.

**Recommended MVP scope is Phase 1 + Phase 2 + US1 + US2** — that's the kickoff MUST set. US3 + US4 land progressively across the early tournament per the spec's "tournament-active multi-week" framing.

Tests are integrated per phase per the AI-Kit convention — every FR has a TC and every TC is a task.

**Total tasks**: 32.

---

## Phase 1 — Setup

- [x] T001 Create `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/README.md` as the runbook index — a small markdown table with columns (Runbook | When to read it | Owner = ops admin = FR-A5 tournament admin). Initially empty body; each subsequent runbook task appends its own row.
- [x] T002 Create the mock Teams receiver Edge Function scaffold at `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/supabase/functions/mock-teams-receiver/` with `index.ts` (skeleton, body filled in T006) and the standard Supabase Edge Function `deno.json`. Per research.md §R-4 this is dev-only test infrastructure.
- [x] T003 [P] Add CI secret-hygiene grep script at `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/scripts/ci/secret-hygiene-grep.sh` that runs `git grep -F 'webhook.office.com' -- . :(exclude)docs/` and exits 1 on any match. Per FR-O06 + NFR-O05 + TC-O7 the Teams webhook URL MUST never land in any git-tracked file outside `docs/`. Make the script executable (`chmod +x`); wire it into the existing pre-commit / CI lane once Phase 2 lands.

---

## Phase 2 — Foundational (BLOCKS every user story)

### Migrations + functions

- [x] T004 Migration `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/supabase/migrations/0039_audit_log_action_extension_and_notifications.sql` per data-model.md. Single file landing five concerns in correct dependency order: (1) DROP-and-re-ADD the `audit_log_action_check` CHECK constraint to add `'notification.teams.sent'` + `'notification.teams.failed'` to the existing 18 values (per data-model.md §1 — listed verbatim); (2) `CREATE OR REPLACE FUNCTION scrub_pii_for_teams(input text) RETURNS text` IMMUTABLE with the 3 regex passes (email → UUID → bare `nortal.com`) + `substr(out, 1, 500)` truncate per contracts/function-scrub-pii.md; (3) `CREATE OR REPLACE FUNCTION notify_teams_on_runs_error()` SECURITY DEFINER trigger function with FR-O07 early-return + webhook-URL-not-configured silent-skip + `pg_net.http_post` enqueue + audit row INSERT per contracts/trigger-notify-on-runs-error.md; (4) AFTER INSERT FOR EACH ROW triggers `integration_runs_notify_teams` on `integration_runs` and `scoring_runs_notify_teams` on `scoring_runs`; (5) `CREATE OR REPLACE FUNCTION reconcile_teams_notifications()` + a thin `reconcile_teams_notifications_now()` wrapper for tests + `pg_cron` job `'reconcile-teams-notifications'` scheduled every 60 s. Header cites FR-O01..O07 + R-1 + R-5.
- [x] T005 [P] Migration `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/supabase/migrations/0040_dev_only_mock_teams_inbox.sql` per data-model.md §3 — DO block guarded by `current_setting('app.env', true) = 'development'` that `CREATE TABLE IF NOT EXISTS _test_mock_teams_inbox (id bigserial PK, body jsonb NOT NULL, headers jsonb NOT NULL DEFAULT '{}'::jsonb, status_sent int NOT NULL DEFAULT 200, received_at timestamptz NOT NULL DEFAULT now())`. No RLS — service-role-only writes. NEVER created in production builds.
- [x] T006 [P] Implement the mock Teams receiver Edge Function body at `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/supabase/functions/mock-teams-receiver/index.ts` per research.md §R-4. Accepts POST. Parses JSON body. Reads `?respond_with=<status>` query param (default 200). Persists `{body, headers, status_sent: <param>, received_at: now()}` to `_test_mock_teams_inbox`. Returns the requested status with empty body. Uses the service-role client (Edge Function default). No auth on the receiver endpoint itself — the URL is the secret.

### Generated types

- [x] T007 Regenerate `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/lib/supabase/database.types.ts` via `cd /Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness && npx supabase gen types typescript --local > /tmp/dbtypes.ts && tail -n +2 /tmp/dbtypes.ts | head -n -2 > lib/supabase/database.types.ts` after T004 + T005 apply. Confirms `Database['public']['Functions']['scrub_pii_for_teams']` and `Database['public']['Functions']['reconcile_teams_notifications_now']` are present.

### pgTAP

- [x] T008 [P] pgTAP `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/test/pgtap/026_audit_log_action_extension.sql` per contracts/audit-notification-sent.md + audit-notification-failed.md. Asserts: (1) every one of the 20 values (18 existing + 2 new) passes the new CHECK constraint; (2) an arbitrary string `'not.a.real.action'` is rejected; (3) the constraint name is exactly `audit_log_action_check`. ~6 asserts. Header cites FR-O03b + data-model.md §1.
- [x] T009 [P] pgTAP `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/test/pgtap/027_scrub_pii_for_teams.sql` per contracts/function-scrub-pii.md § Test coverage. 12 `is()` cases covering NULL → empty / empty → empty / no-pii passthrough / email-only / UUID-only / nortal.com-only / email + UUID combined / participant scoring error shape / repeat-truncation at 500 chars / uppercase-nortal-unchanged / uppercase-UUID-unchanged. Header cites FR-O03a + R-3.
- [x] T010 [P] pgTAP `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/test/pgtap/028_notify_teams_on_runs_error.sql` per contracts/trigger-notify-on-runs-error.md. Asserts: (1) FR-O07 / TC-O8 — `integration_runs.outcome='success'` does NOT enqueue a `net.http_post` (count `net.http_request_queue` before/after); (2) FR-O07 / TC-O8 — `integration_runs.outcome='skipped'` does NOT enqueue; (3) FR-O01 — `integration_runs.outcome='error'` DOES enqueue exactly one `net.http_post` AND inserts exactly one `audit_log` row with `action='notification.teams.sent'`; (4) same triple for `scoring_runs`; (5) webhook-URL-not-configured silent-skip — set `app.teams_webhook_url=''`, insert `outcome='error'`, assert NO `net.http_post` enqueued and NO audit row. ~10 asserts. Header cites FR-O01 + FR-O02 + FR-O07.

---

## Phase 3 — US1: Provider sync error → Teams notification + runbook

**Goal**: When `integration_runs.outcome='error'` lands during the live tournament (manual admin re-sync, scheduled cron sync, bootstrap import), the configured Teams channel receives a PII-scrubbed notification within ≤ 5 minutes pointing at a runbook the ops admin can follow.

**Independently testable**: with Phase 2 applied, run TC-O1 (Playwright) + read TC-O3 (peer-review skim of the runbook). Pass = US1 ships.

- [x] T011 [P] [US1] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/notification-integration-runs.spec.ts` covering TC-O1 + TC-O9 + TC-O10 + TC-O11 + TC-O12 against the `integration_runs` path. Pre-test setup: point `app.teams_webhook_url` at the local mock receiver (configurable `?respond_with` per case). Cases: (a) insert one `integration_runs.outcome='error'` with `error_message` containing a real email + UUID + nortal.com mention → assert `_test_mock_teams_inbox` grows by 1 within 5 s AND the inbox body's `text` field contains `[REDACTED]` for each PII token AND is missing the raw email/UUID/domain; (b) assert `audit_log` has exactly one new `notification.teams.sent` row with `entity_type='integration_runs'`, `new_value->>'req_id'` is a bigint, `http_status` initially null; (c) `SELECT reconcile_teams_notifications_now()` → re-query the audit row → `http_status='200'`; (d) repeat (a) with `?respond_with=410` mock, `SELECT reconcile_teams_notifications_now()` → assert NEW `notification.teams.failed` row with `http_status='410'` + scrubbed error_msg; (e) repeat (d) but verify a second `reconcile_teams_notifications_now()` call does NOT add another failed row (TC-O12). `test.setTimeout(60_000)`. Owned provider_id range: 9801-9810 (for the synthetic `integration_runs.action` value, no match seeding needed).
- [x] T012 [US1] Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/provider-sync-failure.md` per FR-O04 + TC-O3. Structure: (1) "When you read this" — Teams message links here when `integration_runs.outcome='error'`; (2) "Step 1 — confirm provider availability" — copy-pasteable `curl -s -o /dev/null -w "%{http_code}\n" https://api.football-data.org/v4/competitions/WC/matches`; (3) "Step 2 — read the failing row" — copy-pasteable `SELECT id, action, error_message, started_at, finished_at FROM integration_runs WHERE id = <run_id> \gx`; (4) "Step 3 — pick a branch" — three explicit decision branches: (a) provider responded but returned bad data → manual re-sync via `INSERT INTO integration_runs ... action='manual-resync'` flow + run `sync-matches` Edge Function; (b) provider down → wait 5 min and re-monitor, no admin action needed; (c) provider returning consistently bad data → fall back to admin manual fixture entry per FR-015 (link to feature 002 admin console). NFR-O03 — every step is a copy-pasteable command or a one-sentence instruction. Per FR-O12 the file is cross-linked from the index in T013.
- [x] T013 [US1] Update `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/README.md` (created in T001) to add the row: `| [provider-sync-failure.md](provider-sync-failure.md) | Teams pinged "WCM integration_runs error" → start here | Ops admin |`. Per NFR-O02 the link is the runbook's canonical GitHub URL so a single Teams-message click lands the admin on the right page.

---

## Phase 4 — US2: Scoring error → Teams notification + runbook

**Goal**: Same shape as US1 but the trigger source is `scoring_runs.outcome='error'` (admin manual recalc errored, scoring trigger errored on `set_tournament_winner()`, or `recalculate_all_scores()` errored).

**Independently testable**: with Phase 2 + US1 applied, run TC-O2 (Playwright) + read TC-O4 (peer-review skim).

- [x] T014 [P] [US2] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/notification-scoring-runs.spec.ts` covering TC-O2. Mirror T011's structure but seed a `scoring_runs.outcome='error'` row with `action='admin-recalc-all'` and an `error_message` carrying `participant_id` + `match_id` UUIDs. Assertions: (a) mock inbox body contains `**WCM scoring_runs error**` and the runbook link `docs/runbooks/scoring-failure.md`; (b) the PII-scrubbed body has `[REDACTED]` replacing both UUIDs (the runbook tells the admin to fetch the unredacted row via psql); (c) audit_log row exists per the same shape as US1. Owned provider_id range: 9811-9820 (synthetic, no match seeding needed).
- [x] T015 [US2] Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/scoring-failure.md` per FR-O05 + TC-O4. Structure: (1) "When you read this" — Teams pinged "WCM scoring_runs error"; (2) "Step 1 — identify the affected match" — `SELECT id, action, error_message, started_at FROM scoring_runs WHERE id = <run_id> \gx` — for `action='admin-recalc-all'` the affected scope is global; for `action='admin-tournament-winner-set'` the affected match is the final; for trigger-emitted rows extract `match_id` from `error_message` if present; (3) "Step 2 — inspect score_events for partial state" — `SELECT participant_id, source, points, awarded_at FROM score_events WHERE match_id = '<match_id>' ORDER BY awarded_at \gx` — note the feature 003 idempotency guarantee (partial state is safe — the next scoring call rebuilds it); (4) "Step 3 — pick a branch" — two recovery branches: (a) re-run the trigger via `UPDATE matches SET status = status WHERE id = '<match_id>'` (a no-op UPDATE retriggers `matches_trigger_scoring`); (b) global recalc via `SELECT recalculate_all_scores()` (feature 003 RPC) — note this rewrites the entire score_events slice transactionally; (5) "Step 4 — verify recovery in audit_log" — `SELECT action, occurred_at, new_value FROM audit_log WHERE action IN ('scoring.match', 'scoring.final', 'admin.recalc-all') AND occurred_at > <run.started_at> ORDER BY occurred_at \gx`. NFR-O03 holds throughout.
- [x] T016 [US2] Update `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/README.md` to add the row: `| [scoring-failure.md](scoring-failure.md) | Teams pinged "WCM scoring_runs error" → start here | Ops admin |`. Per FR-O12.

---

## Phase 5 — US3: Health check bundle + leaderboard-refresh notification extension

**Goal**: Two follow-on capabilities. (a) FR-O08: a curated SQL block the admin runs in Supabase Studio ≤ 30 min before each match window, returning a 5-row health summary. (b) FR-O09: extend the notification trigger family to cover `audit_log` rows where `action='leaderboard.refresh_failed'` — these are emitted by feature 004 when the MV refresh fails inside `pg_cron`'s `leaderboard-refresh-tick`.

**Independently testable**: Phase 5 ships once the health-check markdown runs to completion against a seeded local DB AND a synthetic `leaderboard.refresh_failed` audit row produces a Teams message.

- [x] T017 [P] [US3] Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/match-window-readiness.md` per FR-O08 + TC-O6. The body is a single SQL block the admin pastes into Supabase Studio. The block consists of 5 queries, separated by `\g` so the admin sees 5 distinct result panes: (1) `SELECT id, action, outcome, started_at, finished_at FROM integration_runs ORDER BY started_at DESC LIMIT 1;` — latest provider sync; (2) `SELECT id, action, outcome, started_at FROM scoring_runs ORDER BY started_at DESC LIMIT 1;` — latest scoring run; (3) `SELECT count(*) AS error_rows_24h FROM audit_log WHERE (action LIKE '%error%' OR action LIKE '%fail%') AND occurred_at > now() - interval '24 hours';` — recent error-shaped audit rows; (4) `SELECT count(*) AS failed_notifications_24h, max(occurred_at) AS most_recent FROM audit_log WHERE action='notification.teams.failed' AND occurred_at > now() - interval '24 hours';` — Teams delivery failures (per FR-O03b); (5) `SELECT count(*) AS upcoming_4h FROM matches WHERE status != 'cancelled' AND kickoff_utc BETWEEN now() AND now() + interval '4 hours';` — match volume in next 4 h; (6) `SELECT is_pre_tournament();` — feature 004 helper. Header section "When you read this": 30 min before any known match window; on first sign of a Teams-message backlog; ad-hoc to confirm system health.
- [x] T018 [US3] Migration `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/supabase/migrations/0041_extend_notification_to_leaderboard_refresh_failed.sql` per FR-O09. `CREATE OR REPLACE FUNCTION notify_teams_on_audit_refresh_failed() RETURNS TRIGGER` — separate function (cleaner branch than further overloading `notify_teams_on_runs_error`). Function body: early-return if `NEW.action <> 'leaderboard.refresh_failed'`; otherwise read `app.teams_webhook_url`; build payload with `text = '**WCM leaderboard.refresh_failed** — see docs/runbooks/README.md → MV refresh stuck runbook (US4 T023)'`; `pg_net.http_post`; INSERT `notification.teams.sent` audit row with `entity_type='audit_log'`, `entity_id=NEW.id::text`. Wire as `AFTER INSERT FOR EACH ROW WHEN (NEW.action='leaderboard.refresh_failed')` trigger on `audit_log` named `audit_log_notify_teams_refresh_failed`. Note: the trigger fires on the audit_log table itself — DOES it loop when our own `notification.teams.sent` row lands? No, because of the `WHEN` clause filtering on `action='leaderboard.refresh_failed'` — our notification rows are filtered out at the trigger level. Verify with TC during T019.
- [x] T019 [US3] pgTAP `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/test/pgtap/029_extend_notification_audit_log.sql` per FR-O09. Asserts: (1) inserting an `audit_log` row with `action='leaderboard.refresh_failed'` enqueues exactly one `pg_net.http_post` AND inserts exactly one `notification.teams.sent` row; (2) inserting a `notification.teams.sent` row does NOT enqueue another `pg_net.http_post` (no loop); (3) inserting an `audit_log` row with `action='leaderboard.refresh'` (the success case) does NOT enqueue; (4) all 18 prior non-notification action values do NOT fire this trigger. ~8 asserts.
- [x] T020 [P] [US3] Playwright spec `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/e2e/tests/notification-followon.spec.ts` covering TC-O5 (no dedup) + TC-O6 (health bundle returns parseable output). TC-O5: insert two `integration_runs.outcome='error'` rows within 60 seconds, force-tick reconciler, assert mock inbox grew by EXACTLY 2 (not 1, not 0). TC-O6: read the SQL block from `docs/runbooks/match-window-readiness.md` via `fs.readFileSync`, split on `\g`, execute each query via service-role psql, assert each query returns ≥ 1 row and the output is parseable (no syntax errors, no empty result on the COUNT queries). Owned provider_id range: 9821-9830.
- [x] T021 [US3] Update `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/README.md` to add the row: `| [match-window-readiness.md](match-window-readiness.md) | Run 30 min before any known match window — answers "is the system healthy" | Ops admin |`. Per FR-O12.

---

## Phase 6 — US4: Secondary runbooks + post-tournament archival

**Goal**: Ship the remaining 4 runbooks called out by FR-O10 (Realtime channel drop, MV refresh stuck, admin manual recalc, lock-boundary triage) + the post-tournament archival plan (FR-O11) + the final runbook index (FR-O12).

**Independently testable**: each markdown ships; the runbook index lists all 8 entries with correct cross-links.

- [x] T022 [P] [US4] Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/realtime-channel-drop.md` per FR-O10. Triggered by: ReconnectingIndicator surfaces in `/dashboard` or `/leaderboard` and stays > 60 s. Steps: (1) check Supabase Realtime status `SELECT pg_total_relation_size('realtime.subscription');` — > 100 MB suggests stuck subscriptions; (2) check `audit_log` for `action='leaderboard.refresh'` in last 5 min — if absent, MV refresh tick is stuck (see T023); (3) restart Realtime via Supabase Studio → Project Settings → Reset Realtime; (4) verify recovery — `audit_log.action='leaderboard.refresh'` should resume within 5 min of next tick. NFR-O03 throughout.
- [x] T023 [P] [US4] Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/mv-refresh-stuck.md` per FR-O10. Triggered by: `match-window-readiness.md` shows `failed_notifications_24h > 0` with most recent action `leaderboard.refresh_failed`. Steps: (1) check `SELECT * FROM cron.job_run_details WHERE jobname='leaderboard-refresh-tick' ORDER BY start_time DESC LIMIT 5;` (per feature 004 R-5); (2) check the gating predicate: `SELECT should_refresh_leaderboard();` — false = expected silence, true = an actual refresh attempt that errored; (3) inspect the failing query inline: `EXPLAIN ANALYZE REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;` — long-running CONCURRENTLY refreshes can deadlock with an in-flight scoring trigger; (4) recovery: `REFRESH MATERIALIZED VIEW leaderboard_snapshots;` (without CONCURRENTLY) — exclusive lock, but fast.
- [x] T024 [P] [US4] Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/admin-manual-recalc.md` per FR-O10. Triggered by: discovered score discrepancy after a match correction. Steps: (1) confirm the source-of-truth match row: `SELECT id, status, score_home, score_away FROM matches WHERE id='<match_id>';`; (2) UPDATE the match to re-trigger scoring: `UPDATE matches SET status=status WHERE id='<match_id>';` (no-op UPDATE retriggers `matches_trigger_scoring`); (3) verify `score_events` rebuild: `SELECT participant_id, source, points FROM score_events WHERE match_id='<match_id>' ORDER BY participant_id LIMIT 20;`; (4) for full-tournament recalc (admin button): `SELECT recalculate_all_scores();` — emits one `scoring_runs` row + many `audit_log scoring.match` rows.
- [x] T025 [P] [US4] Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/lock-boundary-triage.md` per FR-O10. Triggered by: participant disputes claiming "my prediction saved but it shows as locked". Steps: (1) check the prediction's audit history `SELECT occurred_at, action, new_value FROM audit_log WHERE entity_type='predictions' AND entity_id='<prediction_id>' ORDER BY occurred_at;`; (2) verify the lock-window math: `SELECT m.kickoff_utc, m.kickoff_utc - now() AS time_to_kickoff, m.kickoff_utc - now() > interval '60 minutes' AS still_editable FROM matches m WHERE m.id='<match_id>';` — BR-LOCK-003 says editable iff `> 60 minutes` strict (so exactly −60 min is LOCKED); (3) per FR-018 data minimization the admin DOES NOT modify the prediction unilaterally — the participant resubmits if still in window; (4) record the triage outcome: `INSERT INTO audit_log (action, entity_type, entity_id, new_value) VALUES ('admin.match-result-override', ...)` — this is the closest existing action; consider proposing a new `admin.lock-boundary-triage` value in a future feature.
- [x] T026 [P] [US4] Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/post-tournament-archival.md` per FR-O11. Sections: (1) Retention table — what stays vs what purges (predictions: keep indefinitely per audit-trail principles; participants: keep but mark `status='archived'`; score_events: keep indefinitely; audit_log: keep indefinitely — tamper-resistant trail; football-data.org raw responses: never persisted past `integration_runs.error_message`); (2) Purge script — SQL block to deactivate participant sessions, drop the `*_test_*` dev-only tables, set `tournament_config.active=false`; (3) DD-O4 — exact retention windows + PII purge sequence are still open and decided in a future Phase 6 planning sub-track (likely August 2026 post-tournament).
- [x] T027 [US4] Final update to `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/docs/runbooks/README.md`. Each new runbook from T022-T026 gets a row in the index table. Sort the table: kickoff-MUST runbooks (T012, T015) first, then follow-on (T017, T022, T023, T024, T025, T026). Per FR-O12 + NFR-O02 — the index is the canonical landing surface from any Teams message.

---

## Final Phase — Polish

- [x] T028 Run the full pristine sweep — pgTAP (`docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -f - < test/pgtap/026_audit_log_action_extension.sql 2>&1 | grep -cE '^ ok'` then 027 then 028 then 029; expected total ok-count = sum of 6 + 12 + 10 + 8 = 36), Jest (`npm test`), Playwright against the production build (`npm run build && npm start &; until curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ | grep -qE '^(2|3)'; do sleep 1; done && npx playwright test e2e/tests/notification-*.spec.ts --project=chromium --reporter=list`), tsc (`npx tsc --noEmit`), ESLint (`npm run lint`), and the new secret-hygiene grep (`bash scripts/ci/secret-hygiene-grep.sh`). All six MUST report zero failures / zero warnings before T029 proceeds.
- [x] T029 Write `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/specs/006-phase-5-operational/dod-verification.md` mirroring feature 005's format: executive summary + per-FR (FR-O01..O12) / per-NFR (NFR-O01..O05) / per-TC (TC-O1..O12) coverage table; constraint verification (FC-O1..O5); cite migration 0039 + 0040 + 0041 + each runbook for each FR-O; list outstanding external items (Microsoft Teams webhook URL configured by ops admin out-of-band; native-speaker review of any Teams-message localisation NOT needed since feature 006 ships no UI; post-tournament archival rules per DD-O4; etc.).
- [x] T030 [P] Update `/Users/mikehitchcock/AI/ai-first-wrapper/project-repos/world-cup-madness/README.md` — add a new "Feature 006 — Phase 5 Operational Readiness" section sibling to features 001-005; document new local commands (how to set `app.teams_webhook_url` + `app.env`; how to bring up the mock receiver; how to read the audit_log notification-row stream; how to force-tick the reconciler); troubleshooting matrix from `quickstart.md` § Troubleshooting; cross-references to spec / DoD / contracts / each runbook.
- [x] T031 [P] Verify `/Users/mikehitchcock/AI/ai-first-wrapper/.ai_project_memory/constitution-backend.md` has the three new stack rows added during plan workflow (outbound notification via DB trigger; PII scrub helper; audit_log action enum extension per feature). If absent, re-add per `plan.md` Phase 1 stack constitution update. No frontend-constitution changes (no UI).
- [x] T032 Mark all phase-1 through final-phase tasks complete in this file using the Python in-place-rewrite pattern from features 002/003/004/005 (`python3 -c "import re; ..."`). Commit the marked tasks.md alongside the DoD doc + README + constitution check in the final commit.

---

## Dependencies

```
Phase 1 (Setup)         T001 → T002 → T003 (independent)
                              ↓
Phase 2 (Foundational)  T004 (blocks everything below)
                          ↓
                        T005 [P] + T006 [P] (parallel with each other)
                          ↓
                        T007 (regen types) ← depends on T004 + T005
                          ↓
                        T008 [P] + T009 [P] + T010 [P] (pgTAP, parallel)
                          ↓
─ Phase 3 (US1) ──────────  T011 [P] + T012 + T013 (T011 parallel with T012; T013 depends on T001 + T012)
                                         ↓ (US1 + US2 are independent — could run in parallel after Phase 2)
─ Phase 4 (US2) ──────────  T014 [P] + T015 + T016 (same shape as US1)
                                         ↓ (US3 depends on US1 + US2 being applied for the README index ordering)
─ Phase 5 (US3) ──────────  T017 [P] + T018 → T019 → T020 [P] + T021
                                         ↓
─ Phase 6 (US4) ──────────  T022 [P] + T023 [P] + T024 [P] + T025 [P] + T026 [P] + T027
                                         ↓
─ Final ─────────────────  T028 → T029 → T030 [P] + T031 [P] → T032
```

User-story dependency summary:

| Story | Depends on | Independent test |
|-------|------------|-------------------|
| US1 | Phase 2 (foundational) | Run TC-O1 (Playwright) + read TC-O3 (runbook skim). Pass = US1 ships. |
| US2 | Phase 2 (foundational). NOT US1. | Run TC-O2 (Playwright) + read TC-O4. Pass = US2 ships. |
| US3 | Phase 2 + at least one of US1 or US2 (for index ordering only) | TC-O5 + TC-O6 + pgTAP 029 green. |
| US4 | Phase 2 + US1 + US2 + US3 (for full index) | All 4 runbooks ship + README index lists all 8 rows in correct order. |

Parallel opportunities:

- **Within Phase 2**: T005, T006 in parallel; then T008/T009/T010 in parallel (3 pgTAP suites, 3 files).
- **Across phases**: US1 (T011-T013) + US2 (T014-T016) can run in parallel after Phase 2 — they share no files and share no state beyond the foundational migration. ~6 tasks can run as 2 parallel pairs.
- **Within Phase 6 (US4)**: 5 runbook tasks (T022-T026) all touch independent files — fully parallel. The T027 index update is the join point.

---

## Implementation Strategy

**MVP scope = Phase 1 + Phase 2 + US1 + US2** (13 tasks: T001..T016).
- Ships kickoff MUST per the spec.
- Tournament-Day-1 ready: notifications fire for both telemetry tables, both runbooks exist, the audit trail is in place, PII is scrubbed.

**Week 2-3 follow-on = US3 + US4 + Final** (16 tasks: T017..T032).
- Adds the Studio health-check bundle, expands notification coverage to `leaderboard.refresh_failed`, ships 4 secondary runbooks + archival plan, closes with the DoD doc + README + pristine sweep.

**Suggested commit cadence**: one commit per US (US1, US2, US3, US4) + one final commit (T028-T032 bundled). That gives the PR reviewer a clean per-story history and the DoD doc lands once everything is verified green together.
