# Phase 5 — Operational Readiness Specification

**Feature Branch**: `006-phase-5-operational`
**Created**: 2026-06-10
**Status**: Draft
**Priority**: High
**Input**: User description: "Phase 5 — Operational readiness"
**Jira Ticket**: *(none)*

---

## 1. Primary User Story

**As a** Nortal tournament admin acting as the ops engineer during the FIFA World Cup 2026 match windows,
**I want** to know within minutes when the system stops working — provider sync errored, scoring failed, leaderboard refresh broke — and to have a written procedure I can follow at the moment,
**so that** I can restore service before participants notice and the audit trail records what happened, without paging anyone or waiting on a third-party dashboard tool we don't yet have.

## 2. Details

### Problem statement

Features 001–005 ship the participant-facing surface and the scoring + leaderboard backend, but the system has no operational layer — no runbooks for the predictable failure modes, no notification path when something fails inside the database (the only signal today is a row in `integration_runs` or `scoring_runs` with `outcome='error'`, which nothing reads), and no curated set of SQL queries an admin can run to answer "is the system healthy right now". The tournament begins 2026-06-11 (one day after this spec is written) and runs through July; the system must survive that window with two practical capabilities:

1. **Notification** — when a known failure mode trips, a message reaches the ops admin within minutes via a channel they already monitor (Microsoft Teams).
2. **Procedure** — when the ops admin sees the notification, a short markdown runbook in the repo tells them what to check, what to fix, and how to record the recovery in `audit_log`.

This feature is intentionally scoped to "tournament-active, multi-week, progressive" — a small subset MUST land by first kickoff; the rest fills in across the early tournament. Load testing, paging, third-party monitoring stacks, and a separate ops role are all explicitly OUT of scope.

### Clarifications

#### Round 1 (2026-06-10)

- **Q: Timeline / scope priority** → A: **(b) Tournament-active multi-week** — some pieces in place by kickoff, others follow during the early tournament.
- **Q: Monitoring stack** → A: **(a) Supabase Studio dashboards only**. No Grafana / Datadog / Logflare. Curated SQL queries the admin runs in Studio.
- **Q: On-call and paging model** → A: **(a) No paging.** Notification channel only; the ops admin monitors during match windows.
- **Q: Load testing** → A: **(c) Skip entirely.** Out of scope. Rely on monitoring + the dashboard suite's existing budgets.
- **Q: Runbook surface** → A: **(a) Markdown in `docs/runbooks/`** — on-call dev reads at incident time, lives with the code.

#### Round 2 (2026-06-10)

- **Q: Notification mechanism** → A: **Microsoft Teams via incoming webhook.** Nortal does not use Slack; Teams is already in the environment via Entra ID. Email may be added later but is not in MUST scope. Implementation path (Database Webhooks / `pg_net` trigger / Edge Function) decided in planning.
- **Q: Kickoff MUST vs follow-on** → A: **(a) Tight kickoff scope.** Two runbooks (provider sync, scoring) + Teams notifications wired for `integration_runs.outcome='error'` and `scoring_runs.outcome='error'`. Everything else (additional runbooks, Studio health-dashboard, expanded notifications, archival plan) is follow-on.
- **Q: Ops engineer role** → A: **(a) Same role as the existing tournament admin (FR-A5 admin nav).** No new role, no new RLS scope, no new audit_log filter.

### Session 2026-06-12 (via /ai1st-po-clarify)

- Q: PII handling in Teams notification messages — should `error_message` be scrubbed before posting? → A: **B — Scrub PII (email, oid, participant_id, player_id) before posting; keep error type + match_id + admin action context; the runbook tells the admin how to fetch the full row via psql.**
- Q: Observability of the notification path itself — how do we know notifications were actually delivered? → A: **B — Persist each notification attempt to `audit_log` (new `action='notification.teams.sent'` and `action='notification.teams.failed'` rows with HTTP status + truncated response body); follow-on health check scans for failures.** Re-uses existing audit_log (zero new schema, FC-O1 holds).
- Q: Retry behavior on Teams webhook failure — should the notification path retry before giving up? → A: **A — One-shot. Single POST, audit-log the outcome, no retry. The follow-on health check (FR-O08) surfaces the backlog at the next match-window readiness query.** Rationale: 4xx responses are non-retryable by nature; for 5xx, the audit trail + the next human readiness check are sufficient; retry-with-backoff inside the 5-minute SLA budget gets fiddly.

## 3. Workflow

### Primary scenarios

#### Scenario A — Provider sync fails during a scheduled match-fetch window

1. The `sync-matches` Edge Function (feature 002) is invoked by an admin click (or by a scheduled cron in feature 002 follow-on work) and the football-data.org call returns a 5xx, times out, or fails JSON validation.
2. The function writes an `integration_runs` row with `outcome='error'` and a structured `error_message`.
3. A notification fires to the configured Teams channel within ≤ 5 minutes of the row being committed. The message carries: the `integration_runs.id`, the `action` ("bootstrap" / "incremental-sync" / "manual-resync"), the `error_message`, the `started_at` timestamp, and a one-line "what to do" pointing at `docs/runbooks/provider-sync-failure.md`.
4. The ops admin opens the runbook, follows the steps (verify provider status, check rate-budget, decide between manual-resync / wait-and-retry / admin manual fixture entry per FR-015), and the recovery action it instructs them to take is itself audit-logged via the existing `audit_log` infrastructure.

#### Scenario B — Scoring trigger errors mid-tournament

1. An admin updates `matches.status` to `finished` with scores (FR-P22), or the `set_tournament_winner()` RPC runs, and the scoring trigger (`matches_trigger_scoring` / final scoring) raises an exception.
2. A `scoring_runs` row lands with `outcome='error'`.
3. The same notification path delivers a Teams message within ≤ 5 minutes, citing the affected `match_id` (or "final" for final-scoring), the trigger that failed, and pointing at `docs/runbooks/scoring-failure.md`.
4. The runbook walks through: confirm the affected match, inspect `score_events` for partial state (per feature 003 idempotency guarantee, partial state is safe — the next call to `calculate_match_points()` rebuilds it), invoke `recalculate_all_scores()` if needed, and log the recovery decision.

#### Scenario C — Routine "is the system healthy" check before a match window (follow-on)

1. ~30 minutes before a known kickoff, the ops admin opens Supabase Studio and runs the bundled health-check queries shipped as `docs/runbooks/match-window-readiness.md`.
2. The bundle returns: most recent `integration_runs` outcome + timestamp, most recent `scoring_runs` outcome + timestamp, count of `audit_log` rows where `action LIKE '%error%' OR action LIKE '%fail%'` in the trailing 24 h, count of upcoming matches in the next 4 h (so the admin knows what to watch for), and `is_pre_tournament()` status.
3. Every row green → ready for the match window. Any red → consult the corresponding runbook.

### Test Cases

- **TC-O1: Teams webhook delivery on `integration_runs.outcome='error'`** — Inserting an `integration_runs` row with `outcome='error'` triggers a Teams message within 5 minutes. The message includes the run id, action, and a link to `docs/runbooks/provider-sync-failure.md`.
- **TC-O2: Teams webhook delivery on `scoring_runs.outcome='error'`** — Inserting a `scoring_runs` row with `outcome='error'` triggers a Teams message within 5 minutes. The message includes the `match_id` (or the literal `final`), the scoring source, and a link to `docs/runbooks/scoring-failure.md`.
- **TC-O3: Provider-sync runbook completeness** — The markdown contains, in order: how to confirm provider availability, how to read the most recent `integration_runs` row in psql, the three decision branches (provider returned data → re-run; provider down → wait + monitor; provider returning bad data → admin manual entry per FR-015), and the exact SQL or psql commands for each branch.
- **TC-O4: Scoring runbook completeness** — The markdown contains: how to identify the affected match from `scoring_runs.action`, the psql query to inspect `score_events` for the match, the two recovery branches (retry the trigger by `UPDATE matches SET ...` versus call `recalculate_all_scores()`), and the audit-log expectation for each.
- **TC-O5: Notification dedup behaviour (follow-on)** — Inserting two `integration_runs` rows with `outcome='error'` within 60 seconds delivers two Teams messages, not one — explicit per the spec: dedup is NOT required in v1, because every error is a distinct event the admin should see. (Listed as a TC so a later behaviour change doesn't silently happen.)
- **TC-O6: Match-window-readiness runbook works for at least one configured stage (follow-on)** — Running the bundled SQL block from `docs/runbooks/match-window-readiness.md` against a freshly-seeded local Supabase returns at least one row per query and the output is human-parseable.
- **TC-O7: Webhook URL secret hygiene** — The Teams incoming-webhook URL is stored in Supabase project secrets (or Vercel server env), NEVER committed to the repo. Verified by a static grep of the repo at CI time.
- **TC-O8: Notification absence when an `*_runs` row succeeds** — A successful `integration_runs.outcome='success'` row does NOT trigger any Teams message. (Prevents notification fatigue.)
- **TC-O9: PII scrubbing in Teams payload (FR-O03a)** — A synthetic `*_runs` row with `error_message` containing an email, an `oid`, and a `participant_id` UUID produces a Teams payload where every one of those patterns is replaced by `[REDACTED]` and the surrounding non-PII context (error class, `match_id`, SQLSTATE) is preserved. Verified against a local mock Teams receiver capturing the raw POST body.
- **TC-O10: Notification delivery audited (FR-O03b)** — After a notification fires against the local mock receiver (HTTP 200), an `audit_log` row with `action='notification.teams.sent'` and `new_value` carrying the run id + http_status lands within ≤ 2 seconds of the POST.
- **TC-O11: Notification failure audited (FR-O03b)** — When the mock receiver returns HTTP 410 (simulating a revoked webhook) or hangs, an `audit_log` row with `action='notification.teams.failed'` lands, carrying the PII-scrubbed response body (or empty for transport failures).
- **TC-O12: No retry after failure (FR-O03c)** — When the mock receiver returns HTTP 500 to the first POST, NO second POST arrives within the next 60 seconds — verified by counting receiver-side requests. Exactly one `audit_log` row with `action='notification.teams.failed'` exists for the triggering `*_runs.id`.

### Edge Cases

- **`pg_net` not available in the deployed environment.** Per the backend constitution `pg_net` is bundled on Supabase Pro tier. If we end up on a tier that lacks it, the planning step must fall back to either Supabase Database Webhooks (built-in, no extension required) or a small Edge Function that subscribes to the `*_runs` tables and POSTs to Teams. The spec is implementation-agnostic; planning picks.
- **Teams webhook URL expired or revoked.** The webhook responds 410 / 403 / 401. The spec does NOT require a second-channel fallback in v1, but per FR-O03b every failure lands an `audit_log` row (`action='notification.teams.failed'`) — so the failure is recorded, not silent. Per FR-O03c the path is one-shot (no retry). The match-window-readiness check (FR-O08 follow-on, Scenario C) surfaces the failure backlog at the next readiness query. Documented as a residual risk under § Deferred Decisions (DD-O2).
- **Burst of failures at first-kickoff if the provider catalog is incomplete.** Multiple `integration_runs.outcome='error'` rows could fire in a tight window. Per TC-O5 we send every one (no dedup). Acceptable for v1; if the channel becomes noisy in practice, dedup lands as a follow-on with its own decision document.
- **Notification arrives after the match window has ended.** SLA is "best-effort within 5 minutes" — not a hard guarantee. If the Teams platform itself is slow, the admin reads the message late and runs the runbook against a now-stale incident. Acceptable v1 behaviour; the runbook handles "incident is older than X" cases inside the procedure.

## 4. Requirements

### Functional Requirements

#### Kickoff MUST (in place by 2026-06-11)

- **FR-O01**: System MUST deliver a Microsoft Teams message to the configured channel within ≤ 5 minutes of any new `integration_runs` row landing with `outcome='error'`. {Source: AI/Specify, derived from Q7/Round 2}
- **FR-O02**: System MUST deliver a Microsoft Teams message to the configured channel within ≤ 5 minutes of any new `scoring_runs` row landing with `outcome='error'`. {Source: AI/Specify, derived from Q7/Round 2}
- **FR-O03**: Each Teams message MUST carry, at minimum: the row id, the `action` value, the **PII-scrubbed** `error_message` field (truncated to ≤ 500 characters if longer), the `started_at` timestamp, and a direct link to the corresponding runbook at `docs/runbooks/<name>.md` on the canonical branch. {Source: AI/Specify}
- **FR-O03a**: Before posting to Teams, the notification path MUST scrub the following PII patterns from `error_message`: participant email (RFC 5322 shape), Microsoft `oid` (UUID), `participant_id` (UUID), `player_id` (UUID), and any literal Nortal email-domain matches. Replacement marker MUST be `[REDACTED]`. Non-PII context (error class, error code, `match_id`, RPC name, SQLSTATE) MUST survive scrubbing. The runbook tells the admin how to fetch the full unredacted row from psql once they're authenticated to Supabase Studio. {Source: AI/Specify (Session 2026-06-12), Constitution §2 + Backend Constitution §6.2/§7.1, FR-018 data minimization}
- **FR-O03b**: Each Teams notification attempt MUST emit an `audit_log` row capturing the delivery outcome. On HTTP 2xx response: `action='notification.teams.sent'`, `entity_type='*_runs'`, `new_value` carrying `{run_id, run_table, http_status, attempted_at}`. On HTTP non-2xx, timeout, or transport failure: `action='notification.teams.failed'`, `new_value` additionally carrying `{response_body}` truncated to ≤ 500 characters and PII-scrubbed via the same rules as FR-O03a. The audit row MUST land regardless of webhook response so the follow-on health check (FR-O08) can detect a stuck or revoked webhook. {Source: AI/Specify (Session 2026-06-12)}
- **FR-O03c**: The notification path MUST be one-shot — a single POST per triggering `*_runs` row, with no retry on any response class (2xx audited as sent; 4xx / 5xx / timeout / transport failure audited as failed and abandoned). The follow-on health check (FR-O08) is the recovery mechanism for sustained delivery failures; the spec deliberately does not introduce backoff logic inside the ≤ 5-minute SLA. {Source: AI/Specify (Session 2026-06-12), aligns with DD-O2 (no second-channel fallback)}
- **FR-O04**: A runbook at `docs/runbooks/provider-sync-failure.md` MUST exist by kickoff containing: provider-availability check, the psql query to read the failing `integration_runs` row, and three explicit decision branches (re-run / wait / fall back to admin manual fixture entry per FR-015). {Source: AI/Specify, derived from Q7/Round 2}
- **FR-O05**: A runbook at `docs/runbooks/scoring-failure.md` MUST exist by kickoff containing: the psql query to identify the affected match from `scoring_runs.action`, the inspection query for `score_events`, and the two recovery branches (retry the trigger via UPDATE / call `recalculate_all_scores()`). {Source: AI/Specify, derived from Q7/Round 2}
- **FR-O06**: The Teams incoming-webhook URL MUST be stored in Supabase project secrets or Vercel server-side environment variables. It MUST NOT appear in any file committed to git. {Source: Constitution §2, AI/Specify}
- **FR-O07**: Notifications MUST NOT fire on successful `*_runs` rows (`outcome='success'` or `outcome='skipped'`). {Source: AI/Specify, derived from TC-O8}

#### Follow-on (lands during early tournament, no specific deadline)

- **FR-O08**: A runbook at `docs/runbooks/match-window-readiness.md` SHOULD ship a curated SQL block ("health check bundle") an admin runs in Supabase Studio ≤ 30 minutes before each match window, returning: latest `integration_runs` outcome, latest `scoring_runs` outcome, count of error-shaped `audit_log` rows in the trailing 24 h, **count and most recent occurrence of `action='notification.teams.failed'` audit rows in the trailing 24 h (per FR-O03b)**, count of upcoming matches in the next 4 h, and `is_pre_tournament()` status. {Source: AI/Specify, Scenario C}
- **FR-O09**: Teams notifications SHOULD expand to cover `audit_log` rows where `action='leaderboard.refresh_failed'` (feature 004 audit row when MV refresh errors). {Source: AI/Specify, FC-L2}
- **FR-O10**: Additional runbooks SHOULD ship covering: Realtime channel drop diagnosis, MV refresh stuck > 60 minutes triage, admin manual recalc procedure, lock-boundary triage (BR-LOCK-003 disputes). {Source: AI/Specify}
- **FR-O11**: A post-tournament archival plan SHOULD ship as `docs/runbooks/post-tournament-archival.md` covering: what data is retained, what is purged, and the SQL or Edge Function that performs the purge. {Source: AI/Specify, derived from FR-018 data minimization}
- **FR-O12**: Each new runbook MUST be cross-linked from `docs/runbooks/README.md` (an index) so the on-call admin lands on the right document in one click from a Teams message. {Source: AI/Specify}

### Non-Functional Requirements

- **NFR-O01**: Notification latency p95 ≤ 5 minutes from `*_runs` row commit to Teams message delivery, measured against the local Supabase stack with a synthetic webhook receiver. {Source: AI/Specify}
- **NFR-O02**: Runbook discoverability — the on-call admin MUST reach the right runbook from the Teams message in ≤ 1 click (the message embeds the canonical GitHub URL). {Source: AI/Specify}
- **NFR-O03**: Runbook readability — every procedure step is either a copy-pasteable psql / SQL block OR a one-sentence instruction. No paragraph-length prose in step bodies. {Source: AI/Specify}
- **NFR-O04**: No new persistent schema beyond what features 001–005 ship. The notification path consumes existing telemetry (`integration_runs`, `scoring_runs`, `audit_log`) only. {Source: FC-O1 below}
- **NFR-O05**: Secrets hygiene — the Teams webhook URL is unreachable from any client bundle. A grep of the build output for the URL pattern returns zero matches. {Source: Constitution §2}

## 5. Deferred Decisions

| # | Deferred decision | Why deferred |
|---|---|---|
| DD-O1 | **Notification dedup** — collapsing N error rows within X seconds into one Teams message. | Deferred per TC-O5: v1 sends every error. If practice shows channel noise, dedup lands as a follow-on commit with its own decision. |
| DD-O2 | **Second-channel fallback** — Teams webhook failure triggers email or another channel. | Deferred per § Edge Cases. Acceptable risk for the Nortal-internal, no-customer-facing scope. The match-window-readiness query (FR-O08) is the human safety net. |
| DD-O3 | **Notification mechanism** — Supabase Database Webhooks vs `pg_net` trigger vs Edge Function. | Implementation detail. Decided in `/ai1st-dev-plan`. The spec only requires the contract (FR-O01..O03). |
| DD-O4 | **Post-tournament archival rules** — what's retained, what's purged. | Tracked as FR-O11 but the concrete retention windows + PII purge sequence are decided during the planning phase for the archival sub-track (likely August 2026 post-tournament). |
| DD-O5 | **Cron + recurring health check** — auto-running FR-O08's bundled queries on a schedule and posting summary to Teams. | Not in MUST or follow-on. Could land in a Phase 6 if one is opened post-tournament. |

## 6. Definition of Done

### Kickoff MUST (gate for tournament Day 1 readiness)

- FR-O01 + FR-O02 + FR-O03 have a green Playwright (or pgTAP, depending on planning's mechanism choice) test exercising the end-to-end notification path against a local mock Teams receiver.
- FR-O04 + FR-O05 markdown files exist on the branch and pass a peer-review skim for completeness against TC-O3 + TC-O4.
- FR-O06 + NFR-O05 verified by a `git grep` of the canonical Teams webhook URL pattern returning zero matches across the entire repo.
- FR-O07 + TC-O8 verified by a unit / pgTAP test that inserts a success-shaped `*_runs` row and asserts no webhook fires.

### Follow-on (gate for "Phase 5 complete")

- FR-O08 health-check bundle ships as runnable SQL in `docs/runbooks/match-window-readiness.md` + at least one TC asserting the queries return parseable output against a seeded local Supabase.
- FR-O09 + FR-O10 + FR-O11 + FR-O12 each land with their own test evidence per the same shape as MUST-side items.

## 7. Solution Overview

This feature adds an *operational layer* on top of features 001–005 — it does not change participant-facing surfaces. The kickoff MUST is intentionally narrow: when the two most likely failure modes during the live tournament (provider sync errors and scoring trigger errors) emit their telemetry rows, a Teams notification reaches the ops admin within minutes, and that admin has a written procedure in `docs/runbooks/` telling them what to do. Both runbooks deliberately mirror procedures that already exist informally in the dod-verification docs of features 002 and 003; this feature just makes them discoverable at incident time.

The follow-on layer fills in the rest of the operational picture across the early tournament — additional runbooks for the secondary failure modes, a Supabase-Studio-runnable health-check bundle for pre-match-window readiness, expanded notification coverage to include `leaderboard.refresh_failed` audit events, and a post-tournament archival plan. None of these blocks Day 1.

Architecturally the feature adds zero persistent schema. Everything routes through telemetry tables features 002–004 already shipped (`integration_runs`, `scoring_runs`, `audit_log`). The notification path is a single external integration — a Teams incoming webhook — wired via either Supabase Database Webhooks, a `pg_net` trigger, or a small Edge Function (decided in planning). Runbooks are plain markdown in the repo.

## 8. Key Entities

This feature reads existing telemetry and emits external notifications; it does NOT introduce any new entities. The tables it consumes:

| Table | Source | What this feature reads |
|---|---|---|
| `integration_runs` | feature 002 | `id`, `action`, `outcome`, `error_message`, `started_at`, `finished_at` |
| `scoring_runs` | feature 003 | `id`, `action`, `outcome`, `error_message`, `started_at` |
| `audit_log` | feature 001/004 | `action` (for `leaderboard.refresh_failed` rows in follow-on FR-O09) |

The Teams webhook URL is held in Supabase project secrets / Vercel env vars — not a database row, not an entity.

## 10. Integration Context

| System | Protocol | Purpose | Direction | Authentication |
|---|---|---|---|---|
| **Microsoft Teams** | HTTPS POST to incoming-webhook URL | Receive notification messages for `*_runs.outcome='error'` rows | WCM → Teams (outbound only) | The webhook URL itself; no other secret |
| **Supabase project secrets / Vercel env** | (not a runtime call) | Hold the Teams webhook URL | Storage | Project access controls |

No inbound integrations. No new external systems beyond Teams. Football-data.org (feature 002) and Microsoft Entra ID (feature 001) are unchanged.

## 11. Feature-Specific Constraints

### Feature-Specific Constraints

**FC-O1**: **No new persistent schema.** Phase 5 consumes the telemetry tables `integration_runs` (feature 002), `scoring_runs` (feature 003), and `audit_log` (feature 001 / 004) only. No new tables, no new columns. Notification state (last-fired-at, dedup hashes, etc.) is held outside the database — in the chosen mechanism's own runtime — if at all.

**FC-O2**: **No new role.** The ops admin is the existing tournament admin (FR-A5 + `tournament_config.admin_oids`). All RLS scoping, audit visibility, and runbook-following authority flow from that role. No new participant role, no new RLS policies.

**FC-O3**: **Teams-channel notification only — no paging.** The Microsoft Teams incoming webhook is the only notification channel in v1. No email, no SMS, no PagerDuty, no on-call rotation tooling. The match-window-readiness query (FR-O08) is the human safety net for missed messages.

**FC-O4**: **No external monitoring stack.** Monitoring is the curated SQL the admin runs in Supabase Studio (FR-O08). No Grafana, Datadog, Logflare, Better Stack, or other paid telemetry product is introduced. If a future phase wants one, it gets its own spec.

**FC-O5**: **No load testing.** Out of scope. The 200-participant + Realtime-burst envelope established by features 004 and 005 stands; this feature does not validate or extend it.

### Feature-Specific Assumptions

- The Teams workspace and channel already exist on the Nortal tenant. Phase 5 does not create the workspace, only the webhook integration.
- `integration_runs` and `scoring_runs` `outcome` values are stable contracts from features 002 / 003: `success`, `error`, `skipped` (for integration_runs only). New outcome values would require a notification-filter update; tracked as a planning consideration not a spec constraint.
- Supabase Pro tier is in use (per feature 004 cron + pg_net dependencies). `pg_net` is therefore available if planning picks the trigger path.
- The tournament admin (per FR-A5) has access to Supabase Studio.

## 12. References

### Project context

- [General Overview](../../.ai_project_memory/general-overview.md) — Project identity + the Phase 5 entry in the delivery roadmap.
- [Architecture](../../.ai_project_memory/architecture.md) — System components Phase 5 consumes (`integration_runs`, `scoring_runs`, `audit_log`).
- [Backend Constitution](../../.ai_project_memory/constitution-backend.md) — `pg_net` availability, RLS conventions, structured-logging contract (§1.3) that the notification message format mirrors.
- [Frontend Constitution](../../.ai_project_memory/constitution-frontend.md) — Not directly relevant; Phase 5 ships no UI.

### Prior feature specs

- [Feature 002 — Match catalog](../002-match-catalog-read/spec.md) — Source of `integration_runs` telemetry and the `sync-matches` Edge Function.
- [Feature 003 — Predictions and scoring](../003-predictions-and-scoring/spec.md) — Source of `scoring_runs` telemetry and the scoring triggers.
- [Feature 004 — Leaderboard](../004-leaderboard/spec.md) — Source of `audit_log` `leaderboard.refresh` / `leaderboard.refresh_failed` rows used by FR-O09 follow-on.
- [Feature 005 — Phase 4 Dashboard](../005-phase-4-dashboard/spec.md) — Establishes the Realtime channel patterns Phase 5's "Realtime drop" follow-on runbook documents.

### External references

- Microsoft Teams — [Send to a channel via Workflows / incoming webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook) — implementation reference for planning.
- Supabase — [Database Webhooks](https://supabase.com/docs/guides/database/webhooks) — one of the three mechanism options for FR-O01 / FR-O02.
- Supabase — [pg_net extension](https://supabase.com/docs/guides/database/extensions/pg_net) — already enabled per backend constitution; usable for the trigger-based notification path.

---

## Review & Acceptance Checklist

### Content Quality

- [x] No implementation details bleed into FR / NFR statements — DD-O3 explicitly defers the mechanism to planning.
- [x] Focused on user value: ops admin gets timely notification + has a written procedure.
- [x] Written for business stakeholders: scope, deadlines, channels, who's responsible, what's deferred.
- [x] All mandatory sections completed (1, 2, 3, 4, 6, 7, 8, 10, 11, 12).

### Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain.
- [x] Every FR / NFR is testable (TC-O1..O8 cover the kickoff MUST set; follow-on items have their own DoD gate per § 6).
- [x] Success criteria are measurable (FR-O01/O02: ≤ 5 minutes; NFR-O01: p95 ≤ 5 minutes).
- [x] Success criteria are technology-agnostic where possible — the mechanism (Database Webhooks vs `pg_net` vs Edge Function) is deferred.
- [x] All acceptance scenarios are defined in § 3.
- [x] Edge cases identified in § 3.
- [x] Scope is clearly bounded by FC-O1..O5 and the MUST vs follow-on split.
- [x] Dependencies + assumptions identified in § 11 Feature-Specific Assumptions.

### Traceability & Context

- [x] Each FR cites its source (AI/Specify + the Q&A round that generated it).
- [x] § 12 References cross-link the four prior feature specs and the backend constitution.
- [x] § 8 maps directly to existing telemetry tables — no invented entities.

## Execution Status

- [x] Phase 1: Setup complete — branch `006-phase-5-operational` created via `create-new-feature.sh`.
- [x] Phase 2: Socratic dialogue complete — 2 rounds, 8 questions, all answered.
- [x] Phase 3: Spec written and self-validated against the Review & Acceptance Checklist.
- [ ] Next: `/ai1st-po-clarify` (optional — spec has no remaining [NEEDS CLARIFICATION] markers) → `/ai1st-dev-plan` → `/ai1st-dev-tasks` → `/ai1st-dev-implement`.
