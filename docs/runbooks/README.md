# Runbooks — World Cup Madness Operations

This folder holds the operational procedures the **ops admin** (= the existing tournament admin per FR-A5) follows during the FIFA World Cup 2026 tournament window. Each runbook is the destination of one or more Microsoft Teams notifications emitted by feature 006 (Phase 5 Operational Readiness) when a failure is detected in the database telemetry tables (`integration_runs`, `scoring_runs`, `audit_log`).

## Index

| Runbook | When to read it | Owner |
|---------|------------------|-------|
| [provider-sync-failure.md](provider-sync-failure.md) | Teams pinged "WCM integration_runs error" → start here | Ops admin |
| [scoring-failure.md](scoring-failure.md) | Teams pinged "WCM scoring_runs error" → start here | Ops admin |

## Conventions

- Every step is **copy-pasteable**: either a shell command, a SQL block, or a one-sentence instruction (NFR-O03).
- For privacy reasons (FR-O03a, FR-018), the **Teams notification** contains a PII-scrubbed `error_message`. Every runbook starts with the SQL query to fetch the **full unredacted row** from `psql` once the admin is authenticated to Supabase Studio.
- All admin recovery actions land in `audit_log` automatically via the existing per-feature audit triggers. No runbook needs to manually emit audit rows.

## Related references

- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O01..O12, NFRs, TCs, FCs
- [Feature 006 DoD](../../specs/006-phase-5-operational/dod-verification.md) — per-FR test evidence + outstanding items
- [Backend constitution](../../.ai_project_memory/constitution-backend.md) — pg_net pattern, PII scrub helper, audit_log enum-extension precedent
