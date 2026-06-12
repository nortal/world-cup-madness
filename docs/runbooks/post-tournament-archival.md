# Runbook — Post-Tournament Archival

**When to run**: 2 weeks after the final match. Per spec DD-O4 this plan documents the intent — the concrete retention windows + execution date are decided in a follow-up planning sub-track in August 2026.

**Who you are**: the ops admin acting in coordination with the business sponsor.

**What you'll do**: deactivate participant sessions, archive the tournament state, clear dev-only test residue, and document the snapshot in audit_log.

---

## Retention table

| Data | Retention | Why |
|---|---|---|
| `predictions` | Indefinitely | Audit-trail principle. The prediction history is the participant's record of their tournament — no PII beyond `participant_id` which is itself indirect. |
| `final_predictions` | Indefinitely | Same as above. Champion / top-scorer picks are part of the historical record. |
| `score_events` | Indefinitely | Derived from predictions + matches; no PII; auditable. |
| `audit_log` | Indefinitely | Tamper-resistant event trail (ADR-010). Never purged. |
| `participants` | Indefinitely; status flipped to `'archived'` | Email + oid are PII but FR-018 already minimised the column set. The participant row stays so historical prediction rows still join. |
| `auth.users` | Per Supabase Auth defaults | Out of scope — managed by Supabase Auth, not WCM. |
| `integration_runs` | 90 days | Operational telemetry; not needed long-term. |
| `scoring_runs` | 90 days | Same as above. |
| `matches` / `teams` / `players` | Indefinitely | Reference data; small footprint. |
| `_test_*` tables (dev-only) | Drop entirely | Created by migrations gated on `app.env='development'`. |
| Football-data.org raw responses | Already not persisted | Per feature 002 normalisation — only the failure message lives on as `integration_runs.error_message`. |

## Step 1 — flip the tournament off

```sql
UPDATE tournament_config
SET active = FALSE,
    archived_at = now()
WHERE id = 1;
```

(Note: an `archived_at` column doesn't currently exist on `tournament_config`. Either add it via a small migration in the archival sub-track, or store the archive timestamp in `tournament_config.some_jsonb_field` if there is one. DD-O4 picks the concrete schema.)

## Step 2 — flip participants to archived

```sql
UPDATE participants
SET status = 'archived'
WHERE status = 'active';
```

This is RLS-safe: archived participants still satisfy any join from `predictions`, but new sign-ins via Microsoft Entra trigger the provisioning RPC which sees `tournament_config.active=false` and rejects.

## Step 3 — purge operational telemetry > 90 days

```sql
DELETE FROM integration_runs
WHERE started_at < now() - interval '90 days';

DELETE FROM scoring_runs
WHERE started_at < now() - interval '90 days';
```

These are the only purges per the retention table. NO purge of `audit_log`, `predictions`, `score_events`, `participants`.

## Step 4 — drop dev-only test residue

If the production DB somehow has the dev-only `_test_mock_teams_inbox` table (it shouldn't — migration 0040 is gated on `app.env='development'`), drop it now:

```sql
DROP TABLE IF EXISTS _test_mock_teams_inbox;
```

## Step 5 — record the archival in audit_log

```sql
INSERT INTO audit_log (action, actor_oid, entity_type, new_value)
VALUES (
    'admin.tournament-winner-set',  -- closest existing action — "admin closed the tournament"
    '<your_oid>',
    'tournament_config',
    jsonb_build_object(
        'archived_at',     now(),
        'final_match_id',  '<the_final_match_uuid>',
        'champion_id',     (SELECT champion_id FROM tournament_config WHERE id = 1),
        'top_scorer_id',   (SELECT top_scorer_id FROM tournament_config WHERE id = 1),
        'best_player_id',  (SELECT best_player_id FROM tournament_config WHERE id = 1),
        'note',            'Tournament archived per post-tournament-archival.md'
    )
);
```

A dedicated `admin.tournament-archived` action enum value would be cleaner — propose for a future schema migration if this runbook is exercised more than once.

## Step 6 — rotate Teams webhook URL

The Teams webhook URL is a secret. After the tournament, it has no further use. Coordinate with Nortal IT to revoke the webhook on the Teams side, then clear the value:

```bash
# On Supabase Cloud:
npx supabase secrets unset TEAMS_WEBHOOK_URL

# In Postgres:
ALTER DATABASE postgres RESET app.teams_webhook_url;
```

---

## Deferred decisions

Per spec DD-O4, the following are NOT decided in this runbook:
- Exact retention windows beyond what's listed (e.g., do we EVER drop `participants` rows for departed Nortal employees? Compliance question).
- Whether to ship a one-time data export so business sponsors can publish tournament statistics.
- Whether `audit_log` rows older than the tournament window get compressed or moved to cold storage.

These are tracked for the archival sub-track planning session — see the spec's § 5 Deferred Decisions table.

---

## References

- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O11 + DD-O4
- [General overview](../../.ai_project_memory/general-overview.md) — FR-018 data minimization + privacy posture
