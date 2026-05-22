# Scoring Model

Extracted from §7 of [`high-level-architecture.md`](high-level-architecture.md). The `.docx` remains the source of truth.

## §7.1 Time and Locking Rules

| ID | Rule | Definition |
|---|---|---|
| **BR-LOCK-001** | Trusted time source | All lock decisions shall use trusted server-side time. **Client device time shall never determine editability.** |
| **BR-LOCK-002** | Match prediction lock window | A match prediction is editable only when **more than 60 minutes** remain before the official kickoff time. |
| **BR-LOCK-003** | Boundary condition | At exactly kickoff minus 60 minutes, the prediction becomes locked. The rule is strict: remaining time must be **greater than** 60 minutes to allow edits. |
| **BR-LOCK-004** | Started match | No prediction can be created or modified after the match has started, even if an incorrect kickoff time was displayed. Administrative correction may be required if schedule data was wrong. |
| **BR-LOCK-005** | Final predictions | Final tournament predictions are editable only before the first official match kickoff. At first kickoff, champion, runner-up, top scorer, and best player predictions become immutable. |
| **BR-LOCK-006** | Time zone handling | Kickoff times must be stored in UTC (or another normalized canonical time standard) and displayed according to user locale or configured tournament view. |

## §7.2 Match Prediction Scoring

For every completed match with an official score, the application evaluates the user's predicted score against the official score.

| Scenario | Condition | Points | Example |
|---|---|---|---|
| **Exact score** | Predicted home and away scores both equal the official scores | **10** | Predicted 2–1, official 2–1 |
| **Correct outcome only** | Predicted outcome (home win / draw / away win) matches official outcome, but exact score does not | **5** | Predicted 3–2, official 2–1 (correctly picked home win) |
| **Incorrect outcome** | Predicted outcome does not match the official outcome | **0** | Predicted 1–0, official 0–1 |
| **No valid prediction** | No prediction submitted before lock, or prediction invalidated by an administrative decision | **0** | Missed the lock deadline |

**Theoretical maximum from match scoring** (104 matches × 10 pts) = **1,040 points**.

## §7.3 Final Tournament Prediction Scoring

Predictions submitted once, locked at first kickoff (BR-LOCK-005).

| Item | Condition | Points |
|---|---|---|
| **Champion team** | User predicted the tournament champion correctly | **20** |
| **Runner-up team** | User predicted the second-place team correctly | **20** |
| **Top scorer** | User predicted the official tournament top scorer correctly | **20** |
| **Best player** | User predicted the official tournament best player correctly | **20** |

**Theoretical maximum from final predictions** = **80 points**.

**Combined theoretical maximum** = **1,120 points**.

## §7.4 Tie-Breaking Rules for Leaderboards

The default tie-breaker order, in priority sequence (business should approve before launch):

1. Highest total points
2. Highest number of **exact-score** hits
3. Highest number of **correct-outcome** hits
4. Highest **final tournament** prediction points
5. *(only if approved)* Earliest timestamp of last valid prediction submission
6. **Shared rank** if all configured tie-breakers remain equal

## §7.5 Important Rule Clarifications

| Topic | Clarification |
|---|---|
| **Official score basis** | **Regular time (90 min + injury time) only** — knockout predictions are scored against the 90-min result regardless of extra time or penalty shootouts. Resolved per [OD-002](open-decisions.md#od-002--official-score-basis-for-knockouts). |
| **Penalty shootouts** | **Excluded** from the predicted score. Predictions are score-only; penalty shootouts never affect scoring. UI shows the post-shootout result for context but the prediction is scored against the 90-min score. Resolved per [OD-003](open-decisions.md#od-003--penalty-shootouts). |
| **Abandoned or postponed matches** | If a match is postponed, the lock time should follow the corrected kickoff time unless the original match had already locked and business decides otherwise. |
| **Provider data changes** | If a provider changes a score after recalculation, the application must preserve the prior calculation and record a new recalculation event (FR-018 audit trail). |
| **Top scorer ties** | **FIFA's Golden Boot tiebreakers apply** (most goals → most assists → fewest minutes). Only the officially awarded player is the correct top scorer. Resolved per [OD-004](open-decisions.md#od-004--top-scorer-ties). |
| **Best player source** | **Adidas Golden Ball (FIFA Player of the Tournament)** announced at the closing ceremony. Admin sets the awarded player via FR-015. Resolved per [OD-005](open-decisions.md#od-005--best-player-source). |

## Linked FRs

| FR | Topic |
|---|---|
| FR-007 | Prediction update (>60 min remaining) |
| FR-008 | Match lock (server time ≥ kickoff − 60 min) |
| FR-009 | Final predictions before first match |
| FR-010 | Final prediction lock at first kickoff |
| FR-011 | Match score calculation (10 / 5 / 0) |
| FR-012 | Final prediction scoring (20 each) |
| FR-013 | Leaderboard with tie-breaking |
| FR-014 | Personal point breakdown |
| FR-015 | Administrative override |
| FR-016 | Recalculation |
| FR-018 | Audit trail |
| FR-020 | Configuration (lock window, scoring values, allowed domains, etc.) |
