# Implementation Plan: Phase 5 — Operational Readiness

**Branch**: `006-phase-5-operational` | **Date**: 2026-06-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `specs/006-phase-5-operational/spec.md`

## Summary

Phase 5 adds an *operational layer* on top of features 001–005: when the two most likely tournament-time failure modes (provider sync error, scoring trigger error) emit telemetry rows in `integration_runs` or `scoring_runs`, a Microsoft Teams notification reaches the existing tournament admin within ≤ 5 minutes, and two repo-local markdown runbooks (`docs/runbooks/provider-sync-failure.md` + `docs/runbooks/scoring-failure.md`) tell the admin what to do. Every notification attempt is audited to `audit_log` (extending its existing enum with two new actions — `notification.teams.sent` / `notification.teams.failed`) so a sustained delivery failure surfaces at the next match-window readiness check.

The kickoff MUST is intentionally tight (7 FRs covering 2 runbooks + Teams notifications wired for 2 telemetry tables + PII scrubbing + audit-trail + secret hygiene). Five SHOULD-level follow-ons land during early tournament and add: a Supabase-Studio-runnable health-check SQL bundle, expanded notification coverage for `leaderboard.refresh_failed`, 4 secondary runbooks, a post-tournament archival plan, and a runbook index for one-click navigation from Teams messages.

Implementation choice for the notification path: **pg_net + Postgres trigger** posting to Teams via incoming webhook (already enabled per backend constitution, well-precedented inside this codebase via feature 002's `trigger_match_sync`). PII scrubbing happens inside a PL/pgSQL helper before the `pg_net.http_post` call. The audit_log row is inserted in the same trigger transaction. Mock Teams receiver for tests is a single Edge Function running locally on Supabase port that captures POST bodies for Playwright + pgTAP assertions.

## Implementation Conflicts

**Status**: No Conflicts Found

**Conflict Check Date**: 2026-06-12

**Checked Against**: Plans + specs for features 001 (auth), 002 (match catalog), 003 (predictions + scoring), 004 (leaderboard), 005 (dashboard).

**Findings**:
- `audit_log.action` CHECK enum is extended by adding `notification.teams.sent` + `notification.teams.failed`. This is the established pattern used by features 003 (`scoring.match`, `scoring.final`, `admin.*`) and 004 (`leaderboard.refresh`, `leaderboard.refresh_failed`). Migration 0039 drops and re-adds the CHECK constraint with the union of all existing + new values. No conflicts with feature 001's original audit_log shape.
- `integration_runs` (feature 002) + `scoring_runs` (feature 003) are read-only consumers of this feature. No schema change to either. The new trigger watches their INSERTs.
- `pg_net` extension was already enabled by feature 002 (per backend constitution stack table) and used in feature 002's `trigger_match_sync()` RPC. No new extension activation needed.
- No RLS policies modified. The new audit_log rows are read by the existing admin-only `audit_log` policy (feature 004 added admin reads for leaderboard refresh rows).
- Feature 005's `is_pre_tournament()` and dashboard widgets are untouched.

The feature is fully additive.

---

## Technical Context

**Language/Version**: SQL (PostgreSQL 15+ on Supabase) + PL/pgSQL for trigger + scrub helper. No new frontend code. No new TypeScript Edge Function for the production notification path (test fixtures use one local Edge Function as the mock receiver).
**Primary Dependencies**:
- `pg_net` extension (already enabled, Supabase Pro tier bundled)
- `audit_log` table (feature 001, extended via migration 0039)
- `integration_runs` table (feature 002, read-only)
- `scoring_runs` table (feature 003, read-only)
- Existing structured-logging convention (backend constitution §1.3 / §7.1)

**Storage**: PostgreSQL 15 (Supabase) — extends one CHECK constraint on `audit_log.action`; no new tables, no new columns.
**Testing**: pgTAP (trigger behavior, CHECK constraint, PII scrub function output) + Playwright (end-to-end against mock Teams receiver Edge Function).
**Target Platform**: Supabase Cloud (Postgres + Edge Functions for the mock receiver only). No participant-facing surface. Vercel/Next.js untouched.
**Project Type**: Backend-only (Supabase Postgres extension to an existing project).
**Performance Goals**:
- Notification latency p95 ≤ 5 min from `*_runs` row commit to Teams message delivery (NFR-O01).
- The added trigger MUST NOT block the inserting transaction beyond what `pg_net.http_post` already takes (`pg_net` is asynchronous — it enqueues, returns immediately).
- PII scrub helper p95 ≤ 5 ms for a 500-char input on a 200-participant fixture.

**Constraints**:
- FC-O1: No new tables, no new columns. Extending an existing CHECK enum is permitted (established precedent in features 003 + 004).
- FC-O2: No new role; the existing tournament admin (FR-A5) reads audit_log via existing RLS.
- FC-O3: Teams webhook is the only notification channel. No email, no SMS, no second mechanism.
- FC-O4: No external monitoring stack — no Grafana / Datadog / Logflare.
- FC-O5: No load testing.

**Scale/Scope**:
- ~200 active participants × ~104 matches → upper bound on `*_runs.outcome='error'` events during the tournament is dozens, not thousands.
- Expected real-world notification volume: < 10 messages per match day during normal operation.
- 2 runbooks for kickoff + 4 follow-on runbooks + 1 index + 1 health-check bundle markdown.

## Constitution Check

**Applicable Constitution**: backend (primary) + universal
**Source Documents**:
- `../.ai_project_memory/constitution.md` — universal principles
- `../.ai_project_memory/constitution-backend.md` — Supabase / Postgres / Edge Function stack
- `../.ai_project_memory/constitution-frontend.md` — N/A (no UI in this feature)

### Compliance Checklist

- [x] **Universal §1.1 — Modular Monolith with Database-Enforced Rules**: notification trigger + PII scrub helper live in the database; admin is the existing role (no app-layer authorization re-implementation).
- [x] **Universal §1.2 — Naming**: SQL columns and Postgres functions in snake_case (`scrub_pii_for_teams`, `notify_teams_on_runs_error`). New audit_log actions follow the existing `<domain>.<event>` shape (`notification.teams.sent`, `notification.teams.failed`).
- [x] **Universal §1.3 — Error Handling Philosophy**: the trigger's `pg_net.http_post` failure is captured into the `notification.teams.failed` audit row (no silent failure). The PII scrubber's input → output relationship is testable.
- [x] **Universal §2 — Security & Compliance**: Teams webhook URL stored in Vercel server env vars + Supabase project secrets only (FR-O06). PII scrubbing per FR-O03a aligns with FR-018 data minimization. Service-role key is unchanged.
- [x] **Universal §3 — Git Workflow Standards**: feature branch is `006-phase-5-operational`. Commits will use Conventional Commits.
- [x] **Universal §4 — Testing Requirements**: pgTAP test for trigger + CHECK extension + scrubber pure function; Playwright test for end-to-end against mock receiver. Lock-boundary tests do not apply.
- [x] **Backend §I.1 — Tech stack**: extends the existing pg_net stack row (feature 002 already adopted pg_net). No new stack entry needed for pg_net itself.
- [x] **Backend §IV.1 — API design**: notifications are emitted by a Postgres trigger via pg_net + audit_log; no new PostgREST or RPC surface. The runbook is markdown documentation, not API.
- [x] **Backend §VI.1 — Connection management**: webhook URL is a project secret. Never committed.
- [x] **Backend §VII.1 — Logging**: the audit row carries structured JSON in `new_value` per the existing audit_log contract.
- [x] **Backend §IX — Anti-Patterns**: feature does NOT call football-data.org directly from anywhere; does NOT ship service_role to clients; does NOT bypass RLS.

**Gate verdict**: PASS. Re-check after Phase 1.

---

## Phase 0: Outline & Research

### NEEDS CLARIFICATION items extracted from Technical Context

1. **Notification mechanism choice (DD-O3)** — Supabase Database Webhooks vs `pg_net` + trigger vs Edge Function — RESOLVED in research.md §R-1.
2. **Teams API surface** — legacy Office 365 Connectors / Incoming Webhook (announced deprecated by Microsoft August 2024, retirement extended to end of 2025; status as of June 2026 is "Workflows" is the supported path but legacy webhooks still accept on Nortal tenants per their grandfathering policy) — RESOLVED in research.md §R-2.
3. **PII scrub patterns + redaction marker** — exact regex set + replacement string — RESOLVED in research.md §R-3.
4. **Mock Teams receiver for tests** — how do pgTAP and Playwright verify webhook delivery without a real Teams tenant? — RESOLVED in research.md §R-4.
5. **`pg_net` failure semantics** — what does `pg_net.http_post` return when the upstream is unreachable, and how do we capture that for the audit row? — RESOLVED in research.md §R-5.

See [`research.md`](./research.md) for the full Decision / Rationale / Alternatives blocks.

## Phase 1: Design & Contracts

Outputs:
- [`data-model.md`](./data-model.md) — extension to `audit_log.action` CHECK enum + the JSON shape of `new_value` for each new action.
- [`contracts/`](./contracts/) — Teams webhook payload contract (`teams-webhook-payload.md`), audit_log new_value contracts (`audit-notification-sent.md`, `audit-notification-failed.md`), trigger contract (`trigger-notify-on-runs-error.md`), PII scrub function contract (`function-scrub-pii.md`).
- [`quickstart.md`](./quickstart.md) — bring-up sequence to run feature 006 end-to-end against the local Supabase stack with the mock Teams receiver.

### Stack constitution updates

Backend constitution `Current Stack` table will gain:

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| **Notification delivery via DB trigger** | `pg_net.http_post` (already enabled) + `AFTER INSERT` Postgres trigger on `integration_runs` and `scoring_runs` | bundled | Feature 006 — emits Teams webhook POST from inside the inserting transaction (pg_net is async; the inserting transaction commits without blocking on the HTTP roundtrip). Mirrors the `trigger_match_sync` pattern feature 002 already uses for pg_net. |
| **PII scrub helper for outbound notifications** | `scrub_pii_for_teams(text) RETURNS text` PL/pgSQL function with `IMMUTABLE` volatility | bundled | Feature 006 FR-O03a — replaces email / UUID-shaped oid+participant_id+player_id / nortal.com domain matches with `[REDACTED]` before notification payload is built. Pure function, fully unit-testable. |
| **audit_log action enum extension** | Migration 0039 (`ALTER TABLE audit_log DROP CONSTRAINT ... ADD CONSTRAINT ... CHECK (action IN (... ∪ {notification.teams.sent, notification.teams.failed}))`) | bundled | Feature 006 FR-O03b — follows the established precedent from features 003 + 004 of growing the audit_log action enum per feature. No new table; existing RLS reads suffice. |

No frontend constitution changes (no UI).

## Phase 2: Task Planning Approach

Tasks will be organised into 5 phases:

- **Phase 1 — Setup**: dirs + initial test fixture scaffolding (mock Teams receiver Edge Function).
- **Phase 2 — Foundational schema**: migration 0039 (audit_log enum extension) + `scrub_pii_for_teams` function + pgTAP for both. **Blocks every subsequent task.**
- **Phase 3 — Kickoff MUST**:
  - Notification trigger: `notify_teams_on_runs_error()` PL/pgSQL function + `AFTER INSERT` triggers on `integration_runs` and `scoring_runs`.
  - Webhook URL secret wiring: Supabase project secret + Vercel env var; documented in quickstart.
  - End-to-end Playwright test using the mock receiver.
  - Markdown: `docs/runbooks/README.md` (index, currently 2 entries) + `docs/runbooks/provider-sync-failure.md` + `docs/runbooks/scoring-failure.md`.
- **Phase 4 — Follow-on (no specific deadline)**:
  - Health-check SQL bundle markdown (`docs/runbooks/match-window-readiness.md`).
  - Extend trigger family to cover `audit_log` rows where `action='leaderboard.refresh_failed'` (FR-O09).
  - Four secondary runbooks (Realtime drop, MV stuck, admin recalc, lock-boundary triage).
  - `docs/runbooks/post-tournament-archival.md`.
  - Update runbook index per new additions.
- **Final phase**:
  - Pristine sweep (pgTAP + Jest + Playwright + tsc + ESLint).
  - DoD verification doc mirroring feature 005's format.
  - README "Feature 006" section.
  - Constitution check re-verification.
  - Mark all tasks done.

Implementation conflict tasks (Phase 2 step 7 from template): one task in Phase 2 verifies the migration 0039 CHECK union includes all 18 prior action values + the 2 new ones (no accidental drop).

The exact task list is generated by `/ai1st-dev-tasks` per the workflow.

## Dependencies Analysis

### Prerequisites
- Feature 002 must be deployed (provides `integration_runs` + the `pg_net` precedent + `trigger_match_sync`-style pattern).
- Feature 003 must be deployed (provides `scoring_runs`).
- Feature 001 must be deployed (provides `audit_log` + admin RLS).
- Supabase Pro tier (for `pg_net`).
- A Microsoft Teams channel + an incoming webhook URL provisioned in the Nortal tenant. (The Teams workspace + channel are out of scope; this feature only configures the webhook URL on the Supabase / Vercel side.)

### Provides
- Operational layer that feature 002 + 003 implicitly assumed but did not ship.
- The audit-log notification rows that a future `dashboard.notifications` widget could consume (not in scope here).

## Feature-Specific NFRs

Re-stated from spec.md § 4 for traceability:

- NFR-O01: notification latency p95 ≤ 5 min from `*_runs` row commit to Teams delivery.
- NFR-O02: runbook discoverability — ≤ 1 click from Teams message to canonical runbook URL.
- NFR-O03: runbook readability — every step is a copy-pasteable SQL block OR a one-sentence instruction.
- NFR-O04: no new persistent schema beyond the CHECK extension on `audit_log.action`.
- NFR-O05: secrets hygiene — webhook URL never reachable from any client bundle; grep of build output returns zero matches.

## Acceptance Criteria

Per spec § 6 Definition of Done:

### Kickoff MUST (gate for tournament Day 1 readiness)

- [ ] FR-O01 + FR-O02 + FR-O03 + FR-O03a + FR-O03b + FR-O03c covered by pgTAP (trigger + scrubber) and Playwright (end-to-end against mock receiver).
- [ ] FR-O04 + FR-O05 markdown files exist on branch and pass peer-review skim against TC-O3 + TC-O4.
- [ ] FR-O06 + NFR-O05 verified by `git grep` of the canonical Teams webhook URL pattern → zero matches.
- [ ] FR-O07 + TC-O8 verified by pgTAP — a success-shaped `*_runs` row does NOT fire `pg_net.http_post`.
- [ ] TC-O9 (PII scrub) + TC-O10 (sent audit) + TC-O11 (failed audit) + TC-O12 (no retry) all green.

### Follow-on (gate for "Phase 5 complete")

- [ ] FR-O08 health-check bundle in `docs/runbooks/match-window-readiness.md` returns parseable output against a seeded local Supabase.
- [ ] FR-O09 + FR-O10 + FR-O11 + FR-O12 each land with their own test evidence.

---

## Re-evaluation of Constitution Check (post-Phase-1 design)

- Universal + backend checklists re-confirmed against the chosen mechanism (pg_net trigger + scrub helper + CHECK extension).
- No new violations introduced.
- One thing worth flagging: FC-O1 stated "no new persistent schema", and the CHECK extension is a schema change. The spec treats it as in scope because it's value-set extension to an existing column's constraint (no new table, no new column), and features 003 + 004 set the precedent of doing this per feature. Verdict: PASS with note.

**Gate verdict**: PASS.

---

## Stop

Ready for `/ai1st-dev-tasks`. Generated artifacts:
- `specs/006-phase-5-operational/plan.md` (this file)
- `specs/006-phase-5-operational/research.md`
- `specs/006-phase-5-operational/data-model.md`
- `specs/006-phase-5-operational/contracts/teams-webhook-payload.md`
- `specs/006-phase-5-operational/contracts/audit-notification-sent.md`
- `specs/006-phase-5-operational/contracts/audit-notification-failed.md`
- `specs/006-phase-5-operational/contracts/trigger-notify-on-runs-error.md`
- `specs/006-phase-5-operational/contracts/function-scrub-pii.md`
- `specs/006-phase-5-operational/quickstart.md`
- backend constitution stack table updated (3 new rows)
