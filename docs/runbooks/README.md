# Runbooks — World Cup Madness Operations

This folder holds the operational procedures the **ops admin** (= the existing tournament admin per FR-A5) follows during the FIFA World Cup 2026 tournament window. Each runbook is the destination of one or more Microsoft Teams notifications emitted by feature 006 (Phase 5 Operational Readiness) when a failure is detected in the database telemetry tables (`integration_runs`, `scoring_runs`, `audit_log`).

## Index

### Kickoff MUST runbooks (in scope for tournament Day 1)

| Runbook | When to read it | Owner |
|---------|------------------|-------|
| [provider-sync-failure.md](provider-sync-failure.md) | Teams pinged "WCM integration_runs error" → start here | Ops admin |
| [scoring-failure.md](scoring-failure.md) | Teams pinged "WCM scoring_runs error" → start here | Ops admin |

### Follow-on runbooks (lands progressively across the early tournament)

| Runbook | When to read it | Owner |
|---------|------------------|-------|
| [match-window-readiness.md](match-window-readiness.md) | Run 30 min before any known match window — answers "is the system healthy" | Ops admin |
| [realtime-channel-drop.md](realtime-channel-drop.md) | `ReconnectingIndicator` chip stays visible > 60 s on /dashboard or /leaderboard | Ops admin |
| [mv-refresh-stuck.md](mv-refresh-stuck.md) | Teams pinged "WCM leaderboard.refresh_failed" OR `match-window-readiness` pane 4 has a failed-notification backlog | Ops admin |
| [admin-manual-recalc.md](admin-manual-recalc.md) | Discovered score discrepancy after match correction; or before a public leaderboard reveal | Ops admin |
| [lock-boundary-triage.md](lock-boundary-triage.md) | Participant disputes whether their prediction was correctly accepted or rejected at the lock boundary | Ops admin |
| [post-tournament-archival.md](post-tournament-archival.md) | 2 weeks after the final match | Ops admin + business sponsor |

## Conventions

- Every step is **copy-pasteable**: either a shell command, a SQL block, or a one-sentence instruction (NFR-O03).
- For privacy reasons (FR-O03a, FR-018), the **Teams notification** contains a PII-scrubbed `error_message`. Every runbook starts with the SQL query to fetch the **full unredacted row** from `psql` once the admin is authenticated to Supabase Studio.
- All admin recovery actions land in `audit_log` automatically via the existing per-feature audit triggers. No runbook needs to manually emit audit rows.

## Related references

- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O01..O12, NFRs, TCs, FCs
- [Feature 006 DoD](../../specs/006-phase-5-operational/dod-verification.md) — per-FR test evidence + outstanding items
- [Backend constitution](../../.ai_project_memory/constitution-backend.md) — pg_net pattern, PII scrub helper, audit_log enum-extension precedent
