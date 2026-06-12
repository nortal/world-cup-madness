# Runbook — Scoring Failure

**Triggered by**: Microsoft Teams message `**WCM scoring_runs error**` referring you here. Source: feature 003's scoring trigger errored on a match status change, OR `recalculate_all_scores()` errored mid-run, OR `set_tournament_winner()` errored.

**Who you are**: the ops admin.

**What you'll do**: identify the affected match(es), inspect partial state in `score_events`, then pick one of two recovery branches. The scoring engine is idempotent per FR-P16 — re-running it is always safe.

---

## Step 1 — identify the affected match

The Teams message embeds the `scoring_runs.action` value. That tells you the scope:

```sql
\x on
SELECT id, action, status, error_message, started_at
FROM scoring_runs
WHERE id = '<run_id_from_teams_message>';
```

| `action` | Scope of failure |
|---|---|
| `admin-recalc-all` | Global recalc errored. The `error_message` usually contains the offending `match_id`. |
| `admin-tournament-winner-set` | Final-scoring trigger errored. Affected scope = the entire tournament's `final_predictions` slice. |
| `admin-match-result-override` | Per-match scoring trigger errored after an admin score correction. The `error_message` carries the `match_id`. |
| (other / null) | Trigger fired from a non-admin pathway — see `error_message` for the `match_id`. |

Extract the `match_id` from the `error_message` (it's a UUID — search for the standard `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` shape).

## Step 2 — inspect score_events for partial state

The scoring engine uses DELETE-then-INSERT inside one transaction (FR-P16). On a mid-trigger error the transaction rolls back, so `score_events` for the affected match is either:
- **Fully present** with the OLD points (the error happened before the DELETE committed), or
- **Fully absent** (the error happened between the DELETE and the INSERT).

Either way, partial state is **safe** — the next call to `calculate_match_points()` rebuilds the entire match slice atomically.

```sql
\x on
SELECT participant_id, source, points, awarded_at
FROM score_events
WHERE match_id = '<match_id_from_step_1>'
ORDER BY participant_id
LIMIT 20;
```

Sanity check: count of rows here should equal `(SELECT count(*) FROM participants WHERE status='active')` once recovery completes (every active participant gets a row per the FR-P14 contract — including `no-prediction` rows for participants who didn't submit).

## Step 3 — pick a recovery branch

### Branch A — retry a single match's scoring

Use when the affected scope is one match.

```sql
-- A no-op UPDATE retriggers matches_trigger_scoring.
UPDATE matches
SET status = status
WHERE id = '<match_id>';
```

Then re-run Step 2's `SELECT` and verify the row count matches active participants.

### Branch B — global recalc

Use when the affected scope is multiple matches (typically `admin-recalc-all` failures) OR you're not sure which matches were touched.

```sql
SELECT recalculate_all_scores();
```

This emits exactly one new `scoring_runs` row (action='admin-recalc-all') plus one `scoring.match` audit row per (participant, match) combination. Expect the call to take 5–15 seconds against a 200-participant fixture.

If `recalculate_all_scores()` ALSO fails, a fresh Teams notification will fire pointing back here. Don't loop — escalate. Most second failures are caused by a data integrity issue (e.g., orphaned prediction with no matching match) which needs a manual fix you'll discover by reading the second `scoring_runs.error_message`.

## Step 4 — verify recovery in audit_log

```sql
\x on
SELECT occurred_at, action, entity_type, entity_id, new_value
FROM audit_log
WHERE occurred_at > now() - interval '15 minutes'
  AND action IN (
    'scoring.match',
    'scoring.final',
    'admin.recalc-all',
    'leaderboard.refresh',
    'notification.teams.sent',
    'notification.teams.failed'
  )
ORDER BY occurred_at DESC;
```

Expected pattern:
- Many `scoring.match` rows (one per affected (participant, match)).
- For Branch B: a `admin.recalc-all` row anchors the whole batch.
- A `leaderboard.refresh` row lands within the next cron tick (≤ 5 min per feature 004).
- The original `notification.teams.sent` row stays — the incident is auditable; no action needed.

---

## References

- [Feature 003 — Predictions and scoring](../../specs/003-predictions-and-scoring/spec.md) — `recalculate_all_scores`, `calculate_match_points`, FR-P12..P17 + idempotency FR-P16
- [Feature 003 dod-verification](../../specs/003-predictions-and-scoring/dod-verification.md) — known caveats around the scoring trigger
- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O02 + FR-O05 + Scenario B
