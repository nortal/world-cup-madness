# Phase 0 Research: Predictions and Scoring

**Feature**: `003-predictions-and-scoring` | **Date**: 2026-05-22 | **Plan**: [plan.md](./plan.md)

Eight unknowns identified in plan.md §Phase 0. This document resolves each.

---

## R-1 — Postgres trigger fan-out cost for match scoring

**Question**: When the trigger fires for one match × 200 participants, does the `AFTER UPDATE FOR EACH ROW EXECUTE FUNCTION calculate_match_points(NEW.match_id)` shape complete within NFR-P2's 5-second budget without lock contention?

**Decision**: Use `AFTER INSERT OR UPDATE ON match_results FOR EACH ROW WHEN (...) EXECUTE FUNCTION calculate_match_points(NEW.match_id)`. Inside the function, do the work as a single `DELETE` followed by a single `INSERT ... SELECT` over `participants × predictions` (left-joined). One round-trip from the trigger; ~200 row deletes + ~200 row inserts = trivially under 5 seconds on Supabase Pro Postgres.

**Rationale**:
- The PostgreSQL planner can satisfy `INSERT ... SELECT FROM participants LEFT JOIN predictions USING (participant_id, match_id) WHERE participants.status='active'` as a single sequential scan + nested loop over a tiny `match_results` row. ~200 rows of insert is microseconds.
- `score_events` has indexes on `(participant_id, match_id)` (unique, partial) and `(match_id)` — the delete is index-scoped to the single match. No table scan.
- Row-level locking: `match_results` UPDATE holds an exclusive lock on the single row being updated; the trigger fires inside that lock; no other trigger for the same `match_id` can run concurrently. Different `match_id` triggers don't contend with each other (different rows).
- Per-statement vs per-row: per-row trigger has higher overhead for bulk updates, but `match_results` is only ever updated one row at a time in practice (admin correcting one score, or provider sync updating one row). Per-row matches the actual update pattern.

**Alternatives considered**:
- **Statement-level trigger**: `FOR EACH STATEMENT` with a transition table. Would let bulk updates fire once. Rejected — `match_results` updates are always single-row in practice, statement-level adds complexity without speed.
- **Async via NOTIFY/LISTEN**: trigger sends NOTIFY; a worker listens and runs scoring. Rejected — breaks FC-2 (scoring transactional with the source UPDATE).
- **Call the function from app code**: Edge Function or app calls `calculate_match_points()` after every admin update. Rejected — couples scoring to the call site; admin updates via Supabase Studio or direct psql would bypass it.

**Source**: Manual analysis based on PostgreSQL trigger semantics + the scale (200 participants ceiling per FA-3).

---

## R-2 — `recalculate_all_scores()` transaction strategy

**Question**: 104 matches × 200 participants = 20,800 `score_events` rows touched. Single transaction (long lock) vs per-match commit loop (partial-recalc state visible)?

**Decision**: Per-match commit loop. The RPC opens with `BEGIN; INSERT INTO scoring_runs (..., action='admin-recalc-all', status='success' /* placeholder */); COMMIT;` (claims the in-flight mutex), then iterates `SELECT id FROM matches WHERE status IN ('finished', 'cancelled') ORDER BY kickoff_utc` and for each match opens its own transaction that calls `calculate_match_points(match_id)`. Final `UPDATE scoring_runs SET finished_at = now() WHERE id = $1` releases the mutex.

**Rationale**:
- One-transaction-per-match keeps each scoring step bounded (NFR-P2 budget per match). Per-match transaction lock is held for ~50ms; total RPC duration is ~104 × 50ms ≈ 5-7s (well within NFR-P3's 2-minute budget).
- Single huge transaction would hold an exclusive lock on every `score_events` row in the database for the full duration — blocks every participant's breakdown query for the whole recalc.
- Partial-recalc state visibility is acceptable: from the participant's perspective, breakdown values update progressively as each match's scoring re-completes. The alternative (all-or-nothing) hides progress for 30s+ and looks broken.
- The in-flight mutex (claimed in its own transaction up front) prevents two concurrent recalc-alls from interleaving; each per-match transaction sees consistent input.

**Alternatives considered**:
- **Single transaction**: simpler code; blocks all reads for the duration; rejected.
- **Asynchronous job queue** (`pg_cron` + worker): adds infrastructure; admin can't see immediate completion; rejected for this scale.
- **Batched per-stage** (e.g. recalc all group-stage matches together): saves a few mutex acquires; adds branching logic; marginal benefit at this scale. Rejected.

**Source**: Manual analysis; PostgreSQL docs on row-level locking + transaction visibility.

---

## R-3 — DELETE-then-INSERT atomicity in trigger

**Question**: Inside `calculate_match_points()`, the sequence `DELETE FROM score_events WHERE match_id = $1; INSERT INTO score_events SELECT ...;` — is this atomic from any other reader's perspective? Could a participant's breakdown query see the intermediate "0 rows for this match" state?

**Decision**: Yes, atomic. PostgreSQL's default `READ COMMITTED` isolation level guarantees that other transactions see either the pre-trigger state or the post-trigger state of `score_events`, never the intermediate state, because the trigger and the surrounding `UPDATE match_results` are in one transaction; other readers' SELECTs see the snapshot at the start of their own transactions.

**Rationale**:
- PostgreSQL MVCC: a reader's SELECT sees the row versions visible at the moment its transaction started (or at the moment of the SELECT statement under READ COMMITTED). The trigger's DELETE marks rows as "deleted in transaction X"; the INSERT creates new rows tagged "created in transaction X". Other transactions don't see either change until X commits.
- The trigger runs inside the implicit transaction of the `UPDATE match_results` statement. When that transaction commits, all its changes (DELETE old score_events + INSERT new score_events + the match_results UPDATE itself) become visible to other readers atomically.
- pgTAP test in `015_match_scoring_trigger.sql` will assert: from a parallel session, query `score_events` mid-trigger (forced via a CTE that introduces a controlled delay between DELETE and INSERT inside the function). Assert count remains at the pre-trigger value until the outer transaction commits.

**Alternatives considered**:
- **`UPSERT` per row**: each `INSERT ... ON CONFLICT DO UPDATE` avoids the DELETE entirely. Rejected — the source-tag column is part of the composite source semantics; switching from `match-outcome` to `match-exact` requires deleting the old source row (Clarify Q1 contract). UPSERT doesn't support "delete row with different source key".
- **`MERGE` statement** (PG15+): could collapse DELETE + INSERT into one statement. Adds complexity (the MATCH/NOT MATCHED branching), and PostgreSQL's MERGE doesn't handle the "delete then insert with different unique-key fields" case as cleanly as the explicit two-step. Rejected.

**Source**: PostgreSQL docs on MVCC + transaction isolation (default READ COMMITTED).

---

## R-4 — Per-action partial-unique-index mutex

**Question**: Feature 002's mutex is `((1)) WHERE finished_at IS NULL` — at-most-one-in-flight globally for `integration_runs`. The new `scoring_runs` table needs its own at-most-one-in-flight. Per-table independent index, or unified across both via a view?

**Decision**: Per-table independent partial-unique-index. `scoring_runs` gets `CREATE UNIQUE INDEX scoring_runs_at_most_one_in_flight ON scoring_runs ((action)) WHERE finished_at IS NULL`. Scope by `action` so an admin-recalc-all in flight doesn't block a future per-match trigger entry (trigger entries don't go to `scoring_runs` anyway — they're transactional with the source UPDATE). The mutex is purely for the long-running `recalculate_all_scores()` RPC.

**Rationale**:
- Views cannot have indexes; the `all_runs` view's purpose is read-side aggregation only. The mutex semantic is "at-most-one in-flight write", which has to live on the underlying table.
- Per-table independence avoids the cross-action interference that bit feature 002's first attempt (resolved in migration 0018). An in-flight sync doesn't block a scoring run and vice versa.
- Within `scoring_runs`, the partial index keyed on `(action)` means: at-most-one admin-recalc-all in flight AND at-most-one of any future scoring action (the action column is the natural mutex key). For this feature there's only one action (`admin-recalc-all`), so `((1)) WHERE finished_at IS NULL` would work equally well — but keying on `(action)` future-proofs for additional scoring actions without needing another migration.

**Alternatives considered**:
- **Single global `runs` table** with an `action` discriminator (consolidate `integration_runs` + `scoring_runs`): would unify the mutex, but at the cost of merging two semantically distinct tables back together (the opposite of Clarify Q3's resolution). Rejected.
- **Advisory locks**: feature 002 already demonstrated these don't span PostgREST sessions cleanly. The `recalculate_all_scores()` RPC could use a transaction-scoped advisory lock since the whole RPC runs in one session, but the partial-unique-index pattern is more discoverable (it's a visible schema invariant). Decision: stick with the established pattern.

**Source**: Feature 002 migration 0018 commit message + manual analysis.

---

## R-5 — `all_runs` view with `security_invoker=true`

**Question**: Does PostgreSQL 15+'s `security_invoker=true` on a view correctly apply the underlying tables' RLS to the view's caller? Specifically, can an admin SELECT from `all_runs` and see both `integration_runs` + `scoring_runs` rows, while a non-admin sees neither?

**Decision**: Yes. `CREATE VIEW all_runs WITH (security_invoker=true) AS SELECT ... FROM integration_runs UNION ALL SELECT ... FROM scoring_runs` causes PostgreSQL to evaluate the SELECT in the caller's security context, applying RLS on the underlying tables to the view's query. The admin-only `is_admin_user()` RLS policy on each underlying table will gate access through the view.

**Rationale**:
- Per the PostgreSQL 15 release notes (CREATE VIEW), the `security_invoker` option (set as a storage parameter) changes the view's permission check from view-owner to view-caller. RLS policies are applied against the caller's roles.
- The view query rewriter substitutes the view's SELECT into the calling query; the rewritten query then has RLS applied. As long as both base tables have admin-only RLS, the view inherits that restriction.
- pgTAP test in `014_rls_scoring_runs_and_all_runs.sql` will set up a non-admin role, attempt `SELECT * FROM all_runs`, and assert zero rows returned (RLS filters everything out).

**Alternatives considered**:
- **Materialized view + scheduled refresh**: kills the real-time semantics; rejected.
- **Function returning a TABLE**: rather than a view, a `SECURITY INVOKER` function that returns the UNION query. Functionally identical; views are the more discoverable PostgREST surface (auto-exposed as an endpoint). Rejected.
- **Two separate endpoints** (no view): operator queries two tables independently. Rejected per Clarify Q3 D choice.

**Source**: PostgreSQL 15 documentation — [CREATE VIEW](https://www.postgresql.org/docs/15/sql-createview.html) and [Updatable Views](https://www.postgresql.org/docs/15/rules-views.html) (security_invoker option).

---

## R-6 — Trigger interaction on FK cascade

**Question**: When `ON DELETE SET NULL` cascades from `players` into `final_predictions.top_scorer_player_id`, does the cascade fire `AFTER UPDATE` triggers on `final_predictions`?

**Decision**: Yes. PostgreSQL fires AFTER UPDATE triggers on a table when a FK cascade modifies a column in that table, with `NEW` reflecting the post-cascade state (the NULL value). The trigger `AFTER UPDATE ON final_predictions FOR EACH ROW EXECUTE FUNCTION calculate_final_points(NEW.participant_id)` will fire for every cascade-affected row.

**Rationale**:
- PostgreSQL docs (Triggers): "if a foreign-key column is updated due to a cascade ... AFTER UPDATE triggers on the referencing table will be fired with NEW reflecting the post-cascade values".
- `calculate_final_points(NEW.participant_id)` will then DELETE-then-INSERT the four `final-*` rows for that participant. The old `final-top-scorer` 20-point row (if any) gets replaced with a 0-point `final-not-picked-top-scorer` row.
- Cost: a single player delete that cascades to N participants triggers N invocations of `calculate_final_points()`. Each invocation touches 4 score_events rows. So N×4 row writes. Well within the per-cascade budget (N ≤ 200 per FA-3).
- pgTAP test in `016_final_scoring_trigger.sql` will: (a) seed a player, a final_prediction referencing it, an awarded 20-point score_events row; (b) `DELETE FROM players WHERE id = $player_id`; (c) assert the final_predictions row's top_scorer_player_id is now NULL AND the score_events row has been rebuilt with `points=0, source='final-not-picked-top-scorer'`.

**Alternatives considered**:
- **`ON DELETE RESTRICT`**: prevents player deletion if any participant picked them. Forces admin to clear picks first. Operationally hostile during a tournament with substitutions/withdrawals. Rejected per Clarify Q2 option C dismissal.
- **`ON DELETE CASCADE`** (delete the whole final_predictions row): destroys the participant's other 3 picks. Rejected.

**Source**: PostgreSQL Triggers docs + manual analysis.

---

## R-7 — Squad sync extension to `sync-matches`

**Question**: 32 team-squad calls at 10 req/min = 3.2 minutes worst case. Retry helper handling? Fixture mode toggle — single flag or separate?

**Decision**:
1. Extend the existing retry helper as-is. Feature 002's `lib/retry.ts` honors `Retry-After`; for squad sync, the same backoff strategy applies. The longer total runtime (3-4 minutes vs ~10 seconds for fixtures) doesn't change the retry semantics.
2. Single fixture flag: `SYNC_FIXTURE_MODE=1` makes both the match-sync step AND the new squad-sync step read from `__fixtures__/`. Operationally simpler — one toggle, one cache state. Adds a single new fixture file `__fixtures__/v4-squads-sample.json` with all 32 teams' squad data inline.

**Rationale**:
- 32 sequential calls at 10 req/min = 3.2 minutes nominal. The Edge Function runtime allows up to 5 minutes per invocation on Supabase Pro tier, so it fits.
- The existing retry helper retries on 429 (rate limit) with `Retry-After` honored; a burst-then-stall pattern is handled correctly.
- Single fixture flag matches the developer mental model: "I'm in fixture mode, everything is fake". Two flags would invite bugs where match-sync is real but squads are fixture (mismatched provider_team_ids → silent FK failures).
- A future split (e.g. squad-only sync) can override the flag for that path, but defaulting to the unified toggle minimises surprise.

**Alternatives considered**:
- **Parallel team-squad calls** with a semaphore: would shave time at the cost of complexity. Rejected — 3-4 minutes is fine, the sync runs at most weekly.
- **Separate `sync-squads` Edge Function**: clean separation but duplicates fixture-mode logic, retry helper config, and `integration_runs` telemetry. Rejected per Clarify Round 2 Q7 option B/C dismissal.
- **Separate `SYNC_SQUAD_FIXTURE_MODE=1` flag**: more flexible, more bug surface. Rejected for operational simplicity.

**Source**: Manual analysis + feature 002 retry helper implementation.

---

## R-8 — Lock-state mirroring (UI vs RPC)

**Question**: The prediction form shows a countdown for UX; the RPC enforces the authoritative lock. Both must use the same `kickoff_utc - now() > interval '60 minutes'` semantics. Extract a shared helper, or duplicate?

**Decision**: Extract a shared TypeScript helper `lib/predictions/lock-state.ts` that wraps feature 002's `lib/matches/lock-badge.ts` (or imports its core comparator function). The UI's countdown is presentational only; the RPC is authoritative. Naming distinguishes purpose: `lock-badge.ts` is the read-side badge derivation for the catalog UI; `lock-state.ts` is the prediction-form's submit-readiness check + countdown display. Both share the underlying `isLocked(kickoffUtc, now)` boolean.

**Rationale**:
- Both functions answer the same question (is `(kickoff_utc - now) > 60 minutes` true?). Duplicating the comparator would invite drift (someone changes `>` to `>=` in one place); a shared helper makes the boundary-rule semantic load-bearing across one file.
- Constitution §1.1 prefers duplication over *wrong* abstraction. This is the *right* abstraction: the comparator is identical, the inputs are identical, the output is identical (boolean for the lock + a duration for the countdown). Both call sites genuinely want the same answer.
- The Postgres RPC `submit_prediction()` independently implements the rule in SQL (`kickoff_utc - now() > interval '60 minutes'`). That's *not* a duplication — the RPC is the authoritative source; the TS helpers are UX hints. pgTAP test `017_prediction_rpcs.sql` covers the SQL side; Jest tests in `lib/predictions/__tests__/lock-state.test.ts` cover the TS side. Both must agree on −60/−61/−59 boundaries.

**Alternatives considered**:
- **Duplicate the helper**: rejected per shared-comparator argument above.
- **Use the SQL helper from TS via PostgREST**: would require a `SELECT is_prediction_locked(match_id)` round-trip on every render. Latency cost not worth it; the comparator is trivially cacheable.
- **Server-side render the lock state only** (no client countdown): would simplify but loses the live "Locks in 2h 14m" UX. The countdown is a user-facing feature, not a load-bearing decision.

**Source**: Constitution §1.1; feature 002 lock-badge helper precedent.

---

## Resolution summary

| ID | Decision | Phase 1 artifact affected |
|---|---|---|
| R-1 | `AFTER ... FOR EACH ROW` trigger with single DELETE + INSERT...SELECT inside the function | `data-model.md` trigger pseudo-code; pgTAP `015_*.sql` capacity test |
| R-2 | Per-match commit loop inside `recalculate_all_scores()` RPC | `contracts/rpc-recalculate-all-scores.md`; pgTAP `018_*.sql` |
| R-3 | DELETE-then-INSERT is atomic under READ COMMITTED | `data-model.md` trigger pseudo-code; pgTAP `015_*.sql` parallel-session test |
| R-4 | Per-table partial unique index on `scoring_runs((action)) WHERE finished_at IS NULL` | `data-model.md` `scoring_runs` schema; migration 0024 |
| R-5 | View with `security_invoker=true`; admin-only access flows through underlying RLS | `data-model.md` `all_runs` view definition; migration 0024; pgTAP `014_*.sql` |
| R-6 | FK cascade fires AFTER UPDATE trigger on `final_predictions`; trigger handles NULL pick correctly | `data-model.md` trigger pseudo-code; pgTAP `016_*.sql` cascade test |
| R-7 | Reuse retry helper; single `SYNC_FIXTURE_MODE=1` flag includes squads | `contracts/edge-sync-matches-squads.md`; new fixture file |
| R-8 | Shared TS helper `lib/predictions/lock-state.ts` wrapping the boundary comparator; RPC is authoritative | `data-model.md` notes; Jest `lock-state.test.ts` |

No NEEDS CLARIFICATION items remain. Ready for Phase 1 (data-model + contracts + quickstart).
