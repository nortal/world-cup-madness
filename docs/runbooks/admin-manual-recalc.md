# Runbook — Admin Manual Score Recalc

**Triggered by**: discovered score discrepancy after a match correction, or after `scoring-failure.md` Branch B identifies a global issue, or before a public leaderboard reveal where you want to guarantee freshness.

**Who you are**: the ops admin.

**What you'll do**: pick between a per-match retrigger and a full-tournament recalc. The scoring engine is idempotent (FR-P16) — both paths are safe.

---

## Step 1 — decide single-match vs. global

| Scope | Use | Recovery RPC |
|---|---|---|
| One match's predictions are wrong | Single-match retrigger | UPDATE matches (Branch A) |
| Multiple matches OR tournament-winner just set | Global recalc | `recalculate_all_scores()` (Branch B) |
| Final predictions only (champion / top-scorer) | Final-only recalc | `set_tournament_winner()` retriggers final scoring (Branch C) |

## Step 2 — confirm current state

```sql
\x on
SELECT id, status, score_home, score_away, kickoff_utc
FROM matches
WHERE id = '<match_id>';
```

For a global recalc:

```sql
SELECT count(*) AS finished_matches
FROM matches
WHERE status = 'finished';

SELECT count(*) AS active_participants
FROM participants
WHERE status = 'active';
```

Expected `score_events` count after recalc: `finished_matches × active_participants`.

## Step 3 — pick a branch

### Branch A — Single-match retrigger

A no-op UPDATE on `matches.status` fires the `matches_trigger_scoring` trigger, which rebuilds `score_events` for that match in DELETE-then-INSERT fashion (FR-P16 idempotent).

```sql
UPDATE matches
SET status = status
WHERE id = '<match_id>';
```

Then verify:

```sql
SELECT participant_id, source, points
FROM score_events
WHERE match_id = '<match_id>'
ORDER BY participant_id
LIMIT 20;
```

You should see one row per active participant (some `source='no-prediction'` for participants who didn't predict).

### Branch B — Global recalc

```sql
SELECT recalculate_all_scores();
```

This:
- DELETEs every `score_events` row (except final-prediction events).
- Re-inserts the full slice by iterating over `matches WHERE status='finished'`.
- Emits one `scoring_runs` row with `action='admin-recalc-all'`.
- Emits one `audit_log` row with `action='admin.recalc-all'`.

Duration on a 200-participant + 20-finished-matches fixture: 5–15 seconds. If it takes > 60 seconds, suspect a missing index — escalate.

### Branch C — Final-only recalc

When the final predictions need re-evaluation (e.g., the tournament winner was just confirmed but final scoring trigger fired before the matches table reflected it):

```sql
-- Replays the existing tournament_config row, retriggering the final
-- scoring trigger transactionally.
SELECT set_tournament_winner('<winning_team_id>');
```

## Step 4 — refresh the leaderboard

The MV refresh runs on a 5-min cron schedule. To skip the wait:

```sql
SELECT refresh_leaderboard();
```

This lands a `leaderboard.refresh` audit row and broadcasts via Realtime, so any open `/dashboard` or `/leaderboard` tab re-renders within seconds.

## Step 5 — verify in audit_log

```sql
SELECT occurred_at, action, entity_type, entity_id, new_value
FROM audit_log
WHERE occurred_at > now() - interval '15 minutes'
  AND action IN (
    'scoring.match',
    'scoring.final',
    'admin.recalc-all',
    'admin.tournament-winner-set',
    'leaderboard.refresh'
  )
ORDER BY occurred_at DESC
LIMIT 20;
```

Expected pattern (for Branch B):
1. One `admin.recalc-all` row.
2. Many `scoring.match` rows (one per (participant, match) recalc).
3. One `leaderboard.refresh` row (after the next cron tick or your manual call).

---

## References

- [Feature 003 — Predictions and scoring](../../specs/003-predictions-and-scoring/spec.md) — `recalculate_all_scores`, `calculate_match_points`, FR-P12..P17 + idempotency FR-P16
- [Feature 003 — admin RPCs](../../specs/003-predictions-and-scoring/contracts/) — `set_tournament_winner` contract
- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O10
