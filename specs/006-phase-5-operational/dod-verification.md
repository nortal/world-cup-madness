# Feature 006 (Phase 5 Operational Readiness) Definition-of-Done Verification

**Date:** 2026-06-12
**Branch:** `006-phase-5-operational`
**Scope:** Operational layer for the live tournament window (FR-O01–FR-O12 / NFR-O01–NFR-O05 / TC-O1–TC-O12 / FC-O1–FC-O5).

## Executive Summary

Feature 006 adds an **operational layer** on top of features 001–005: when the two most likely tournament-time failure modes (provider sync errors via `integration_runs`, scoring trigger errors via `scoring_runs`) emit telemetry rows, a Microsoft Teams webhook POST reaches the configured channel within ≤ 5 minutes carrying a PII-scrubbed error context + a direct link to the relevant runbook in `docs/runbooks/`. Every notification attempt is audited to `audit_log` via two new actions (`notification.teams.sent` + `notification.teams.failed`), and a 60-second `pg_cron` reconciler updates the audit trail with the eventual HTTP outcome. A follow-on FR (FR-O09) extends notification coverage to `audit_log` rows where `action='leaderboard.refresh_failed'`. 8 runbooks ship in `docs/runbooks/`: 2 kickoff-MUST (provider-sync, scoring), 6 follow-on (health check, Realtime drop, MV refresh, manual recalc, lock-boundary triage, post-tournament archival). Pristine sweep: **pgTAP 54 / Playwright 6 / tsc 0 / ESLint deferred / secret-hygiene clean.**

### Implementation deviations from spec briefs

**`*_runs.outcome` → `*_runs.status`**: The spec brief (and the data-model.md initial draft) referenced an `outcome` column. The actual schema on both `integration_runs` (feature 002 migration 0013) and `scoring_runs` (feature 003 migration 0024) names it `status`. The trigger function (`notify_teams_on_runs_error`) and every test branches on `NEW.status`, not `NEW.outcome`. The `status` values are the same enum: `'success' | 'error' | 'skipped'`. Migration 0039 + contracts/trigger-notify-on-runs-error.md are accurate; only the original spec brief is slightly stale.

**`supautils` blocks `ALTER DATABASE ... SET app.*` for the `postgres` role**: discovered during T011/T014 Playwright authoring. The supautils extension's `privileged_role_allowed_configs` allow-list does NOT include the `app.*` namespace. Tests must run via `supabase_admin` (PGPASSWORD=postgres) and terminate idle PostgREST + pg_net worker backends after the `ALTER DATABASE ... SET` so the new GUC value propagates to fresh sessions on the next call. Captured in the test helpers + the quickstart troubleshooting matrix.

**`audit_log.entity_id` is UUID but `integration_runs.id` is BIGSERIAL**: the trigger function branches on `TG_TABLE_NAME` and populates `entity_id` only when the source table's id type matches UUID (i.e., for `scoring_runs` and the FR-O09 `audit_log`-source flow). For `integration_runs` the bigint id lives in `new_value->>'run_id'` and the reconciler joins by that field. Documented in contracts/audit-notification-sent.md.

## Per-FR Coverage (FR-O01 through FR-O12)

### Kickoff MUST (FR-O01..O07)

| FR | Requirement (one-line) | Implementation | Test Evidence |
|---|---|---|---|
| FR-O01 | Teams message ≤ 5 min of integration_runs error | `notify_teams_on_runs_error()` trigger in `migrations/0039_*.sql` | `test/pgtap/028_*.sql` (TEST 1-3); `e2e/tests/notification-integration-runs.spec.ts` (TC-O1) |
| FR-O02 | Teams message ≤ 5 min of scoring_runs error | same trigger, attached to `scoring_runs` | `test/pgtap/028_*.sql` (TEST 6-7); `e2e/tests/notification-scoring-runs.spec.ts` (TC-O2) |
| FR-O03 | Each message carries row id + action + scrubbed error_message + started_at + runbook link | `notify_teams_on_runs_error()` payload build via `format()` + `scrub_pii_for_teams()` | Playwright assertions in TC-O1 + TC-O2 verify each field; contracts/teams-webhook-payload.md |
| FR-O03a | PII-scrubbed `error_message` per regex set + `[REDACTED]` marker | `scrub_pii_for_teams(text)` IMMUTABLE function | `test/pgtap/027_*.sql` (12/12 cases); Playwright TC-O9 verifies in-payload |
| FR-O03b | Each attempt audited to `audit_log` with new actions | trigger inserts `notification.teams.sent` at enqueue; reconciler inserts `notification.teams.failed` on non-2xx | `test/pgtap/028_*.sql` (TEST 4-5); Playwright TC-O10 + TC-O11 |
| FR-O03c | One-shot, no retry | trigger fires once per row; reconciler never re-emits a failed row for the same req_id | Playwright TC-O12 (second reconciler tick → still 1 failed row) |
| FR-O04 | `docs/runbooks/provider-sync-failure.md` exists with the 4-step procedure | `docs/runbooks/provider-sync-failure.md` | peer-review skim against TC-O3 criteria (manual) |
| FR-O05 | `docs/runbooks/scoring-failure.md` exists with the 4-step procedure | `docs/runbooks/scoring-failure.md` | peer-review skim against TC-O4 criteria (manual) |
| FR-O06 | Teams webhook URL in Supabase project secrets / Vercel env only | `app.teams_webhook_url` GUC populated via `ALTER DATABASE`; CI script `scripts/ci/secret-hygiene-grep.sh` verifies no leak | `scripts/ci/secret-hygiene-grep.sh` exits 0 on the clean repo |
| FR-O07 | No notification on `outcome='success'` or `'skipped'` | early-return in `notify_teams_on_runs_error()` | `test/pgtap/028_*.sql` (TEST 1-2 + 8); Playwright covers via beforeEach not seeing residue |

### Follow-on (FR-O08..O12)

| FR | Requirement (one-line) | Implementation | Test Evidence |
|---|---|---|---|
| FR-O08 | Match-window-readiness query bundle | `docs/runbooks/match-window-readiness.md` — 6-pane SQL block | Playwright TC-O6 parses the markdown's ```sql block and runs each pane against the local DB |
| FR-O09 | Notifications expand to cover `leaderboard.refresh_failed` audit rows | `migrations/0041_extend_notification_to_leaderboard_refresh_failed.sql` + `notify_teams_on_audit_refresh_failed()` trigger | `test/pgtap/029_*.sql` (8/8 asserts); WHEN clause filters out our own notification.teams.* rows so no loop |
| FR-O10 | Secondary runbooks ship | 4 markdown files in `docs/runbooks/` (`realtime-channel-drop.md`, `mv-refresh-stuck.md`, `admin-manual-recalc.md`, `lock-boundary-triage.md`) | peer-review skim against the secondary failure modes |
| FR-O11 | Post-tournament archival plan | `docs/runbooks/post-tournament-archival.md` — retention table + 6-step procedure | DD-O4 notes the concrete retention windows are decided in an August 2026 follow-up sub-track |
| FR-O12 | Every runbook cross-linked from `docs/runbooks/README.md` index | `docs/runbooks/README.md` lists all 8 runbooks in two sections (kickoff vs follow-on) | manual inspection — 8 rows in the table, each linking to the canonical filename |

## Per-NFR Coverage (NFR-O01..O05)

| NFR | Target | Evidence |
|---|---|---|
| NFR-O01 | Notification latency p95 ≤ 5 min from `*_runs` row commit to Teams delivery | local Playwright observes 2–3s end-to-end (insert → mock inbox row); production p95 verified post-deploy against the deployed Pro tier (deferred to post-deploy) |
| NFR-O02 | Runbook discoverability — ≤ 1 click from Teams message to canonical URL | trigger payload includes the canonical `github.com/nortal/world-cup-madness/blob/main/docs/runbooks/<name>.md` URL — verified by Playwright text assertion in TC-O1 + TC-O2 |
| NFR-O03 | Every runbook step is a copy-pasteable SQL block OR a one-sentence instruction | manual skim of all 8 runbooks — passes |
| NFR-O04 | No new persistent schema beyond the `audit_log.action` CHECK extension | only schema changes: migration 0039 (CHECK extension + 4 functions + 2 triggers + 1 cron job) + 0040 (dev-only `_test_mock_teams_inbox`) + 0041 (1 function + 1 trigger). No new tables in production. The `_test_mock_teams_inbox` table is gated on `app.env='development'` and is dropped on every production build (verified by data-model.md §3 + quickstart.md). |
| NFR-O05 | Secrets hygiene — webhook URL never in client bundle; grep returns zero | `scripts/ci/secret-hygiene-grep.sh` runs `git grep -F 'webhook.office.com' -- . :(exclude)docs/` and exits 0 — verified during pristine sweep |

## Per-TC Coverage (TC-O1..O12)

| TC | Behaviour | Test |
|---|---|---|
| TC-O1 | Teams webhook delivery on integration_runs error within 5 min | `notification-integration-runs.spec.ts` |
| TC-O2 | Teams webhook delivery on scoring_runs error within 5 min | `notification-scoring-runs.spec.ts` |
| TC-O3 | Provider-sync runbook completeness | manual skim of `docs/runbooks/provider-sync-failure.md` against the brief |
| TC-O4 | Scoring runbook completeness | manual skim of `docs/runbooks/scoring-failure.md` against the brief |
| TC-O5 | No dedup — 2 errors in 60 s → 2 messages | `notification-followon.spec.ts` |
| TC-O6 | Match-window-readiness SQL bundle parses + runs | `notification-followon.spec.ts` |
| TC-O7 | Webhook URL secret hygiene — git grep returns 0 | `scripts/ci/secret-hygiene-grep.sh` |
| TC-O8 | No notification on success | `test/pgtap/028_*.sql` (TEST 1-2 + 8) |
| TC-O9 | PII scrubbing in Teams payload | `notification-integration-runs.spec.ts` TC-O1 + `test/pgtap/027_*.sql` |
| TC-O10 | Notification delivery audited (sent row) | `notification-integration-runs.spec.ts` TC-O1 (assertion on `audit_log.notification.teams.sent` row + reconciler update) |
| TC-O11 | Notification failure audited (failed row) | `notification-integration-runs.spec.ts` TC-O11 (410 path) |
| TC-O12 | No retry on second reconciler tick | `notification-integration-runs.spec.ts` TC-O12 (500 path, two reconciler ticks, exactly 1 failed row remains) |

## Constraint Verification (FC-O1..O5)

| FC | Constraint | Verification |
|---|---|---|
| FC-O1 | No new persistent schema beyond CHECK extension | migration 0039 extends one CHECK constraint on existing `audit_log.action`; migration 0041 adds one function + one trigger on existing `audit_log`. The only new table (`_test_mock_teams_inbox`, migration 0040) is dev-only and never created in production. Verified by pg_dump diff (manual) + migration headers cite this constraint. |
| FC-O2 | No new role | trigger functions are SECURITY DEFINER (run as their owner). Audit_log read access already covered by existing admin RLS from feature 004. No new RLS policy added. |
| FC-O3 | Teams webhook is the only notification channel | implementation uses `pg_net.http_post` against the Teams webhook URL; no email/SMS/PagerDuty path exists in any migration or function. |
| FC-O4 | No external monitoring stack | monitoring = `docs/runbooks/match-window-readiness.md` SQL bundle the admin runs in Supabase Studio. No Grafana/Datadog/Logflare client lib, no external infra. |
| FC-O5 | No load testing | no load test framework added. Tournament-active load capacity is inherited from features 002–005's existing budgets. |

## Outstanding External Items

The feature ships green on every automatable assertion. The remaining items require external infrastructure, human review, or post-deploy verification:

1. **Production Teams webhook URL configuration** — the ops admin must provision the webhook URL on the Nortal Teams channel and set `app.teams_webhook_url` via `npx supabase secrets set TEAMS_WEBHOOK_URL=…` + a post-deploy migration that reads it into the DB session. See `quickstart.md` § 2 Configuration.
2. **NFR-O01 production p95 verification** — local Playwright observes 2–3 s end-to-end; the 5-min budget on the deployed Pro tier needs a post-deploy soak with a synthetic error injection.
3. **TC-O3 + TC-O4 peer-review skim** — runbook content quality is verified by a human reading the markdown. Not automatable. Plan a 30-minute review pass with the ops admin before the next match window.
4. **DD-O4 archival retention windows** — `post-tournament-archival.md` documents the intent and references DD-O4. Concrete windows + execution date are owned by the August 2026 archival sub-track planning session.
5. **DD-O2 second-channel fallback** — Teams webhook revocation leaves notifications recorded in `audit_log` but no second channel pings. Accepted risk for the Nortal-internal scope; revisit if the channel proves unreliable in practice.

## Pristine Sweep — Results (2026-06-12)

| Check | Command | Result |
|---|---|---|
| pgTAP 026 (CHECK extension) | `docker exec -i supabase_db_world-cup-madness psql … < test/pgtap/026_audit_log_action_extension.sql` | **22 / 22 PASS** |
| pgTAP 027 (PII scrubber) | `… < test/pgtap/027_scrub_pii_for_teams.sql` | **12 / 12 PASS** |
| pgTAP 028 (trigger behaviour) | `… < test/pgtap/028_notify_teams_on_runs_error.sql` | **12 / 12 PASS** |
| pgTAP 029 (FR-O09 extension) | `… < test/pgtap/029_extend_notification_audit_log.sql` | **8 / 8 PASS** |
| pgTAP total | — | **54 / 54 PASS** |
| TypeScript | `npx tsc --noEmit` | **0 errors** |
| Secret hygiene | `bash scripts/ci/secret-hygiene-grep.sh` | exit 0 |
| Playwright (notification suite) | `npx playwright test e2e/tests/notification-*.spec.ts --project=chromium` | **6 / 6 PASS** (14.5 s) |
