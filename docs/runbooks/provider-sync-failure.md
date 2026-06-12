# Runbook — Provider Sync Failure

**Triggered by**: Microsoft Teams message `**WCM integration_runs error**` referring you here. Source: feature 002's `sync-matches` Edge Function failed mid-call against football-data.org.

**Who you are**: the ops admin (tournament admin per FR-A5).

**What you'll do**: identify what kind of provider failure occurred and pick one of three recovery branches. The whole runbook should take 5–10 minutes during a live match window.

---

## Step 1 — confirm provider availability

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  https://api.football-data.org/v4/competitions/WC/matches
```

| Response | Means |
|---|---|
| `200` | Provider is up and returning data. Skip to Step 3 Branch A. |
| `429` | Rate limit. Wait and re-check. Go to Step 3 Branch B. |
| `5xx`  | Provider degraded. Go to Step 3 Branch B. |
| `4xx` (other) | Auth or request-shape issue — likely a Nortal config rotation. Go to Step 3 Branch C. |

## Step 2 — read the failing row in psql

The Teams message embeds the PII-scrubbed `error_message`. The full unredacted row lives in the DB:

```sql
\x on
SELECT id, action, status, error_message, started_at, finished_at, records_processed
FROM integration_runs
WHERE id = <run_id_from_teams_message>;
```

Note:
- `status = 'error'` is the trigger condition.
- `action` tells you which invocation path failed: `'bootstrap'` (one-time import), `'incremental-sync'` (cron), or `'manual-resync'` (admin button).
- `error_message` carries the raw upstream response, often a stack trace from the Edge Function.

## Step 3 — pick a branch

### Branch A — provider responded but returned bad data

Symptom: `curl` returned 200 in Step 1, but `error_message` mentions JSON validation failure or a missing field.

```sql
-- Trigger a manual re-sync; the Edge Function re-fetches and writes a fresh
-- integration_runs row carrying the new outcome.
SELECT trigger_match_sync('manual-resync');
```

Then watch the new integration_runs row:

```sql
SELECT id, action, status, error_message, finished_at
FROM integration_runs
ORDER BY started_at DESC
LIMIT 1;
```

If the new row is `status='success'`, recovery complete. If `status='error'` again, escalate to Branch C.

### Branch B — provider down or rate-limited

Symptom: `curl` returned 429 or 5xx in Step 1.

Do nothing for 5 minutes. Then re-run Step 1's `curl`. The feature 002 retry/backoff inside `sync-matches` already handles transient outages — the trigger only fires when retries are exhausted. A second admin-driven retry within minutes will likely hit the same rate-limit budget.

If provider is still down after 30 minutes during a known match window, switch to Branch C (manual fixture entry) per FR-015 to keep the leaderboard ticking.

### Branch C — fall back to admin manual fixture entry

Symptom: provider sustainedly broken or returning unrecognizable data, AND a match is about to kick off / has just finished.

This is feature 002's FR-015 fallback. The tournament admin enters the score directly via the admin console at `/admin/matches`:

1. Open `/admin/matches` in the participant app (admin-gated route).
2. Locate the affected match by stage + teams.
3. Enter the final score and set the status to `finished`. This UPDATEs `matches.status` + `matches.score_home` + `matches.score_away` and the feature 003 scoring trigger fires automatically.
4. The leaderboard MV refresh follows within one cron tick (≤ 5 min per feature 004).

Audit-trail expectation:
- One `audit_log` row with `action='admin.match-result-override'` and `entity_id=<match_id>`.
- Several `audit_log` rows with `action='scoring.match'`, one per participant who predicted the match.
- One `audit_log` row with `action='leaderboard.refresh'` after the next cron tick.

## Step 4 — confirm recovery in audit_log

```sql
\x on
SELECT occurred_at, action, entity_type, entity_id, new_value
FROM audit_log
WHERE occurred_at > now() - interval '15 minutes'
  AND action IN (
    'admin.match-result-override',
    'scoring.match',
    'leaderboard.refresh',
    'notification.teams.sent',
    'notification.teams.failed'
  )
ORDER BY occurred_at DESC;
```

You should see — in chronological order — your recovery action, the scoring rebuild rows, then the leaderboard refresh. If a `notification.teams.failed` row appears for the original incident, that's expected (the original 5xx-shaped run still got audited as a failed Teams delivery); no separate action needed.

---

## References

- [Feature 002 — Match catalog](../../specs/002-match-catalog-read/spec.md) — `sync-matches` Edge Function + FR-015 admin manual entry + FR-M23 advisory-lock concurrency
- [Feature 002 sync-matches README](../../supabase/functions/sync-matches/README.md) — direct invocation patterns
- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O01 + FR-O04 + Scenario A
