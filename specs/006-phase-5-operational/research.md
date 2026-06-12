# Phase 0 Research — Feature 006 (Phase 5 Operational Readiness)

**Date**: 2026-06-12
**Resolved against**: plan.md Technical Context § NEEDS CLARIFICATION items 1-5.

All five items are resolved here. No outstanding unknowns block Phase 1.

---

## R-1 — Notification mechanism: pg_net + Postgres trigger

**Decision**: Use a Postgres `AFTER INSERT` trigger on `integration_runs` and `scoring_runs` that calls `pg_net.http_post(...)` to the Teams incoming-webhook URL, and inserts the corresponding `audit_log` row in the same trigger function. The webhook URL is read at trigger-execution time from a Supabase Vault secret (or, in local dev, from a `tournament_config` row that itself never contains the secret — only a fetch-handle).

**Rationale**:
- The `pg_net` extension is already enabled in this project (per backend constitution stack table, used by feature 002's `trigger_match_sync`).
- `pg_net.http_post` is asynchronous: it enqueues to the `net.http_request_queue` table and the worker drains it. The inserting transaction commits without blocking on the HTTP roundtrip — preserves NFR-M5 (provider rate budget) and avoids inflating `*_runs` insert latency.
- The trigger function is a single PL/pgSQL routine — no new Edge Function to deploy, no new external service to monitor, no new RPC surface. Reduces operational surface (matches FC-O4 "no external monitoring stack").
- Audit insert in the same trigger transaction: if the trigger crashes before the audit row lands, the inserting `*_runs` transaction also rolls back — but the upstream caller's intent (e.g. the `sync-matches` Edge Function) sees the failure and retries. Acceptable.

**Alternatives considered**:
1. **Supabase Database Webhooks** — built-in feature that posts to any URL on row insert. Rejected because: (a) it cannot run our PII scrubber on the payload before posting; (b) it cannot conditionally fire only on `outcome='error'` without a separate filter table; (c) the audit_log row would have to be emitted by a separate trigger anyway, doubling the moving parts.
2. **Edge Function with Realtime subscription** — function listens to `*_runs` table changes, formats + posts. Rejected because: (a) introduces a new long-running service to monitor; (b) Realtime subscription failures themselves would need their own runbook; (c) more code to ship and test.
3. **Application-layer trigger inside Next.js** — Next.js serverless route handler scans `*_runs` on a cron. Rejected: it can't react within minutes without an external scheduler we don't have.

**Source**: Manual analysis of the three Supabase-native notification paths, anchored on feature 002's pg_net precedent.

---

## R-2 — Teams API surface: legacy incoming webhook, with Workflows as a planning-phase fallback

**Decision**: Use the legacy **Office 365 Connectors / Incoming Webhook** (`outlook.office.com/webhook/...`-shape URL) for the kickoff MUST. The Nortal Microsoft tenant grandfathers existing connectors per their internal IT policy. The webhook URL is provisioned in the Nortal Teams channel by the ops admin out-of-band (one-time setup, captured in `quickstart.md`).

If, during follow-on work, the legacy webhook is revoked by Microsoft or by Nortal IT, the migration path is **Microsoft Workflows / Power Automate** with an HTTP request trigger — the JSON payload contract from `contracts/teams-webhook-payload.md` is API-compatible; only the URL changes.

**Rationale**:
- Microsoft announced deprecation of Office 365 Connectors in August 2024 with original retirement October 2024, extended several times. As of June 2026, legacy webhooks still accept POSTs on tenants that opted in to the grandfathering policy.
- Nortal IT has not (as of clarification round 2 with the ops admin) issued a directive to migrate. The legacy URL is the path of least resistance for the tournament window.
- Switching to Workflows is a URL-and-headers change inside the Postgres trigger function — no other code change required.

**Alternatives considered**:
1. **Migrate to Workflows / Power Automate now** — defers kickoff readiness for one-time-provisioning work in the Power Automate UI. Rejected for the tight kickoff timeline.
2. **Microsoft Graph chat-message API** — requires app registration + delegated permissions + an OAuth2 client credentials flow. Rejected: massively higher complexity for the same delivery semantics.

**Source**: Microsoft Learn — [Send to channel via Workflows / incoming webhook](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/add-incoming-webhook). Nortal IT policy is local context, not externally documented.

---

## R-3 — PII scrub patterns + redaction marker

**Decision**: A single PL/pgSQL function `scrub_pii_for_teams(input text) RETURNS text` IMMUTABLE applies the following regex substitutions in order, replacing every match with the literal token `[REDACTED]`:

| # | Pattern (POSIX, anchored as appropriate) | Catches |
|---|------------------------------------------|---------|
| 1 | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | RFC 5322-shape emails (covers `participant@nortal.com`, vendor support addresses in upstream error messages, etc.) |
| 2 | `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}` | UUIDs (Microsoft `oid`, `participant_id`, `player_id`, `match_id`). **Match_id is also a UUID and gets scrubbed; that's acceptable — the runbook tells the admin to fetch the full row via psql where the unredacted match_id is visible.** |
| 3 | `\bnortal\.com\b` | Bare Nortal domain mentions outside the email pattern |

**Replacement marker**: literal `[REDACTED]`. Chosen because: (a) it's unambiguous in a Teams message; (b) it doesn't itself look like data; (c) it survives Teams markdown rendering without escaping.

**Volatility**: `IMMUTABLE`. The function's output depends only on its input; no clock, no SELECT, no SET. This allows Postgres to inline it inside the trigger and unit-test it deterministically via pgTAP.

**Rationale**:
- Three patterns cover the entire PII surface identified across features 001 (auth — emails, oids), 002 (matches — match_id and stage_id UUIDs), 003 (predictions + scoring — participant_id, player_id), and 005 (dashboard — same identifiers).
- Order matters only insofar as the email pattern is more specific than the UUID pattern; running the email pattern first means a `participant@nortal.com` string gets fully redacted as one unit rather than the UUID-shape inside it (none exists, but defensive).
- The match_id scrub is a known cost. The runbook compensates: every runbook starts with "psql query to read the full unredacted row".

**Alternatives considered**:
1. **Whitelist (only allow `[A-Z0-9_.]+`)** — too aggressive; would strip SQLSTATE codes (`23514`) and error class names that the admin needs to triage quickly.
2. **Field-level scrub at the application layer in the trigger** — would require parsing the `error_message` JSON-shape every time. Rejected: `error_message` is plain text in the existing `*_runs` schema, not structured.
3. **Don't scrub match_id** — adds a fourth pattern (`NOT match_id_pattern` lookbehind). Rejected: PostgreSQL regex doesn't support lookbehind, and the cost of one extra "go look at the full row" line in the runbook is trivial.

**Source**: Manual analysis of the PII surface across features 001-005; PostgreSQL regex documentation.

---

## R-4 — Mock Teams receiver for tests

**Decision**: Ship a single Deno Edge Function at `supabase/functions/mock-teams-receiver/index.ts` that accepts POSTs on `http://127.0.0.1:54321/functions/v1/mock-teams-receiver`, persists each received request body + status code into a local-only table `_test_mock_teams_inbox(id bigserial PK, body jsonb, received_at timestamptz default now())`, and returns the HTTP status configured by a query-string param (`?respond_with=200` → 200; `?respond_with=410` → 410; etc.).

Tests (pgTAP + Playwright):
- **pgTAP**: directly verify the trigger calls `pg_net.http_post(...)` with the right URL+payload by querying `net.http_request_queue` after the trigger fires. No mock receiver needed.
- **Playwright**: configures the trigger's webhook URL to point at the mock receiver, inserts a synthetic `*_runs` error row via service-role, waits for `_test_mock_teams_inbox` to grow by 1, and asserts the body + headers + audit_log presence.

The `_test_mock_teams_inbox` table is created by a DEV-only migration `0040_dev_only_mock_teams_inbox.sql` gated by `WHERE current_setting('app.env', true) = 'development'` and dropped in any production build.

**Rationale**:
- Direct query of `net.http_request_queue` lets pgTAP run without an HTTP receiver — fast, deterministic, no Edge Function bring-up needed.
- The mock receiver is needed only for the end-to-end Playwright path; using a real Edge Function (already a supported Supabase pattern via feature 002's `sync-matches`) avoids inventing a new test infrastructure.
- The inbox table is local-only — feature 002 set the precedent of dev-only migrations via the `app.env` guard.

**Alternatives considered**:
1. **External HTTP-bin / Pipedream public endpoint** — rejected: introduces network flakiness into tests + exposes test traffic externally + can't run offline.
2. **In-Postgres mock via a SECURITY DEFINER function that intercepts `pg_net.http_post`** — rejected: requires patching the trigger to dispatch differently in test mode, which means the test isn't testing the production code path.

**Source**: Manual analysis. Supabase Edge Functions are already a project dependency.

---

## R-5 — `pg_net.http_post` failure semantics

**Decision**: `pg_net.http_post` returns a `bigint` request id immediately (enqueue-only). The actual HTTP response lands later in `net._http_response(id, status_code, content, headers, error_msg, created_at)`. The notification trigger therefore CANNOT inline the response into the audit row — it must use the deferred pattern: emit a `notification.teams.sent` audit row with `http_status=null` at enqueue time, then run a small reconciler that periodically scans `net._http_response` for the latest response and UPDATEs / supplements the audit_log row.

**Concretely**:
1. Trigger inserts the `*_runs` row → trigger function calls `pg_net.http_post` → gets `req_id` back → inserts audit row `notification.teams.sent` with `new_value = {run_id, run_table, req_id, attempted_at, http_status: null}` (initial state).
2. A small `pg_cron` job runs every 60 seconds (cron already enabled per feature 004's `leaderboard-refresh-tick`): scan `net._http_response` for rows newer than the last reconcile mark. For each:
   - If `status_code >= 200 AND status_code < 300`: UPDATE the matching audit row, set `new_value.http_status = status_code`. Action stays `notification.teams.sent`.
   - If `status_code >= 400 OR error_msg IS NOT NULL`: UPDATE the matching audit row, INSERT a NEW `notification.teams.failed` row carrying `{req_id, status_code, error_msg, response_body_scrubbed}`. The original `sent` row stays for the request-attempt audit trail; the new `failed` row signals to FR-O08's health check.

The 60-second reconcile cadence keeps the worst-case Teams-message-to-audit-log-failure-row latency at ≤ 60 seconds, well inside NFR-O01's 5-minute budget.

**Rationale**:
- `pg_net` is fire-and-forget by design; chasing the response inside the trigger transaction would block the inserting commit (defeating the async benefit).
- The reconciler is a natural extension of feature 004's existing `pg_cron` setup — no new infrastructure.
- The two-row pattern (sent at enqueue, failed at reconcile) preserves the FR-O03b contract: every attempt is audited, and a failed delivery is distinguishable from a queued-but-unconfirmed delivery.

**Alternatives considered**:
1. **Block the trigger on `pg_net.http_post` response** — `pg_net` doesn't expose a synchronous variant. Rejected.
2. **Skip the reconciler; trust the enqueue audit row** — rejected: FR-O03b explicitly requires capturing the HTTP outcome, not just the attempt.
3. **Use a Postgres `LISTEN/NOTIFY` channel for the reconciler** — overkill for a 60-second cadence; `pg_cron` is simpler.

**Source**: Supabase pg_net docs + manual schema inspection of the `net` schema.

---

## Summary

| Item | Decision | Source |
|---|---|---|
| R-1 Notification mechanism | pg_net + AFTER INSERT trigger + same-tx audit insert | Manual |
| R-2 Teams API surface | Legacy incoming webhook; Workflows path documented as fallback | Manual + Microsoft Learn |
| R-3 PII scrub | 3 regex patterns (email, UUID, nortal.com domain), `[REDACTED]` marker, IMMUTABLE function | Manual + PostgreSQL docs |
| R-4 Mock Teams receiver | Dev-only Edge Function + `_test_mock_teams_inbox` table, gated on `app.env='development'` | Manual + feature 002 precedent |
| R-5 pg_net response semantics | Two-row audit pattern: `sent` at enqueue, `failed` at 60-s reconcile job (pg_cron, reuses feature 004 cron) | Manual + Supabase pg_net docs |

All NEEDS CLARIFICATION items resolved. Phase 1 (data-model + contracts) proceeds.
