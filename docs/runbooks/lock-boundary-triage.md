# Runbook — Lock-Boundary Dispute Triage

**Triggered by**: a participant disputes the lock state of one of their predictions — typically "I saved at 8:31 PM and the match locked at 9:30 PM, my submission should have counted but it shows as locked."

**Who you are**: the ops admin.

**What you'll do**: pull the prediction's audit trail, verify the BR-LOCK-003 boundary math, and either confirm the lock was correct (participant misremembers) OR escalate (real bug).

**Per FR-018 data minimization**: the admin does NOT modify the prediction unilaterally. The participant resubmits if they're still in their lock window.

---

## Step 1 — find the prediction

```sql
-- Identify the prediction by participant + match.
SELECT id, predicted_home_score, predicted_away_score, created_at, updated_at
FROM predictions
WHERE participant_id = (SELECT id FROM participants WHERE oid = '<participant_oid>')
  AND match_id = '<match_id>';
```

If the row doesn't exist, the participant never successfully submitted — no lock dispute, just a misunderstanding. Confirm with the participant; explain how to submit a fresh prediction if they're still in window.

## Step 2 — pull the audit trail for that prediction

```sql
\x on
SELECT occurred_at, action, actor_oid, new_value, old_value
FROM audit_log
WHERE entity_type = 'predictions'
  AND entity_id = '<prediction_id>'
ORDER BY occurred_at DESC;
```

Expected actions: `prediction.created`, possibly multiple `prediction.updated` rows. Each row carries `new_value` with the submitted scores AND the `occurred_at` timestamp.

## Step 3 — verify the lock-window math

BR-LOCK-003 states the prediction is editable iff `(kickoff_utc - now()) > interval '60 minutes'` — STRICT inequality. So at exactly −60 min the prediction IS locked.

```sql
SELECT
    m.kickoff_utc,
    m.kickoff_utc - <occurred_at_from_audit_step_2>::timestamptz   AS time_to_kickoff_at_submit,
    (m.kickoff_utc - <occurred_at_from_audit_step_2>::timestamptz)
        > interval '60 minutes'                                     AS submit_was_editable,
    m.kickoff_utc - now()                                            AS time_to_kickoff_now,
    (m.kickoff_utc - now()) > interval '60 minutes'                  AS now_is_editable
FROM matches m
WHERE m.id = '<match_id>';
```

Boundary cases:
- `submit_was_editable=true` AND row was created/updated → submission was correctly accepted. Show the participant their stored prediction.
- `submit_was_editable=false` AND row was created/updated → **bug**. Escalate immediately to engineering with the audit row + the math output above. The `submit_prediction` RPC should have rejected.
- `submit_was_editable=false` AND no row was created → the RPC correctly rejected. Confirm with the participant; the lock window had already closed when they tried to submit.

## Step 4 — record the triage outcome

There is no `admin.lock-boundary-triage` action in the current `audit_log.action` enum (feature 006 follow-on may add one — see DD list in spec.md). For now, record the triage via the closest existing action:

```sql
INSERT INTO audit_log (action, actor_oid, entity_type, entity_id, new_value)
VALUES (
    'admin.match-result-override',  -- closest existing action; semantically "admin touched this match's data lineage"
    '<your_oid>',
    'matches',
    '<match_id>',
    jsonb_build_object(
        'reason',         'lock-boundary triage requested by participant',
        'participant_id', '<participant_id>',
        'finding',        '<editable | not-editable | bug-escalated>',
        'triaged_at',     now()
    )
);
```

Adding a dedicated `admin.lock-boundary-triage` action enum value is tracked as a future-feature ask — see `specs/006-phase-5-operational/spec.md` DD-O4 area.

---

## References

- [Feature 003 — Predictions and scoring](../../specs/003-predictions-and-scoring/spec.md) — BR-LOCK-001 / BR-LOCK-003 + `submit_prediction` RPC
- [Feature 005 — Dashboard](../../specs/005-phase-4-dashboard/spec.md) — inline quick-edit FR-D08 + lock-countdown badge
- [Feature 006 spec](../../specs/006-phase-5-operational/spec.md) — FR-O10
