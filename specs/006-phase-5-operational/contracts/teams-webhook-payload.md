# Contract — Microsoft Teams Incoming Webhook Payload

**Endpoint**: `POST <teams_webhook_url>` (URL configured via `app.teams_webhook_url` Postgres setting; held in Supabase Vault / Vercel env).
**Content-Type**: `application/json`
**Direction**: WCM → Teams (outbound only)

## Request body (JSON)

```jsonc
{
    "text": "**WCM <run_table> error** — run <run_id> | action `<action>` | started <ISO-8601 UTC>\n\n<PII-scrubbed error_message>\n\nRunbook: https://github.com/nortal/world-cup-madness/blob/main/docs/runbooks/<runbook-name>.md"
}
```

### Field rules

| Token | Source | Notes |
|---|---|---|
| `<run_table>` | `TG_TABLE_NAME` inside the trigger | One of `integration_runs`, `scoring_runs`, `audit_log` (the third only when FR-O09 follow-on lands). |
| `<run_id>` | `NEW.id::text` | The numeric or UUID PK of the failing row. |
| `<action>` | `NEW.action` | Existing column on both `*_runs` tables. |
| `<ISO-8601 UTC>` | `to_char(NEW.started_at, 'YYYY-MM-DD HH24:MI:SS UTC')` | Human-readable; Teams users see this in their local time via the message metadata. |
| `<PII-scrubbed error_message>` | `scrub_pii_for_teams(NEW.error_message)` | Per FR-O03a — emails, UUIDs, nortal.com domain replaced with `[REDACTED]`. Truncated to 500 chars by the scrubber. |
| `<runbook-name>` | Static map from `run_table` to file slug | `integration_runs` → `provider-sync-failure`, `scoring_runs` → `scoring-failure`, `audit_log` (FR-O09 follow-on) → context-specific. |

## Why a plain `text` payload (not Adaptive Card)?

Adaptive Cards require the legacy MessageCard schema (deprecated alongside connectors) or the newer Workflows-specific format. Plain `text` works for BOTH legacy incoming webhooks AND Workflows HTTP triggers — single payload contract, smaller migration surface (R-2). The Teams renderer interprets the `**bold**` and `\n` markdown.

## Response

The trigger does NOT consume the response synchronously (R-5). The 2xx / 4xx / 5xx outcome is observed later by `reconcile_teams_notifications()` via `net._http_response`. The reconciler emits `notification.teams.failed` audit rows for non-2xx responses.

## Examples

### Successful provider-sync-error notification

Request body:

```json
{
    "text": "**WCM integration_runs error** — run 42 | action `bootstrap` | started 2026-06-12 09:15:23 UTC\n\nProvider returned 502; SQLSTATE 22023 from sync-matches Edge Function. Last successful sync at 2026-06-12 08:30:00 UTC.\n\nRunbook: https://github.com/nortal/world-cup-madness/blob/main/docs/runbooks/provider-sync-failure.md"
}
```

### Scoring-error notification with PII-bearing input

Input `NEW.error_message`:

> Failed to compute score for participant `00112233-4455-6677-8899-aabbccddeeff` on match `ffeeddcc-bbaa-9988-7766-554433221100` — predicted (`alice@nortal.com` chose 2-1) but matches row missing. SQLSTATE 23503.

Scrubbed output (what lands in the Teams payload):

> Failed to compute score for participant `[REDACTED]` on match `[REDACTED]` — predicted (`[REDACTED]` chose 2-1) but matches row missing. SQLSTATE 23503.

The runbook tells the admin: "for the full unredacted error, run `SELECT * FROM scoring_runs WHERE id = <run_id>;` in psql."
