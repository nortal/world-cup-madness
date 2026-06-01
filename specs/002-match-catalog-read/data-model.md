# Data Model — Match Catalog (002)

**Date**: 2026-05-20
**Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)
**Migrations covered**: `supabase/migrations/0011_*` through `0017_*`

This document specifies the schema additions for feature 002. It is the source of truth that the migrations + the regenerated `lib/supabase/database.types.ts` derive from. Notation: `NOT NULL` is the default; columns marked `NULL` are explicitly nullable. Identifiers use the snake_case + plural-table convention established in feature 001.

---

## Schema overview

```
┌─────────────────┐         ┌─────────────────┐
│     teams       │ ◄──┐    │    matches      │
│─────────────────│    └────│─────────────────│
│ id (uuid PK)    │         │ id (uuid PK)    │
│ name            │         │ provider_id     │
│ tla (3 chars)   │         │ home_team_id ──►│ teams.id
│ provider_team_id│         │ away_team_id ──►│ teams.id
│                 │         │ stage           │
└─────────────────┘         │ group_label NULL│
                            │ kickoff_utc NULL│
                            │ venue NULL      │
                            │ status          │
                            │ score_home NULL │
                            │ score_away NULL │
                            │ created_at      │
                            │ last_synced_at  │
                            └─────────────────┘

┌─────────────────────┐     ┌─────────────────────┐
│   integration_runs  │     │   participants      │ (extended)
│─────────────────────│     │─────────────────────│
│ id (bigserial PK)   │     │ ...existing cols... │
│ provider            │     │ timezone DEFAULT UTC│ ◄ NEW
│ action              │     └─────────────────────┘
│ started_at          │
│ finished_at NULL    │     ┌──────────────────────────────┐
│ status              │     │ acquire_match_sync_lock()    │
│ records_processed   │     │   RPC returning boolean      │
│ records_unchanged   │     │ (advisory lock helper)       │
│ error_message NULL  │     └──────────────────────────────┘
└─────────────────────┘
```

All three new tables sit alongside feature 001's `participants`, `tournament_config`, `audit_log`, and `participants_public` view. No foreign keys link 001 ↔ 002 directly; `audit_log` already covers `participants.timezone` changes via the existing UPDATE trigger.

---

## `teams` (migration 0011_create_teams.sql, seed 0017_seed_teams.sql)

National-team catalog. 32 rows at WC 2026 expansion (note: WC 2026 is the first 48-team World Cup — verify in R-1 confirmation pass; spec assumes 48 → keep the table flexible).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()` | Internal identity; used as FK target from `matches`. |
| `name` | `TEXT` | NOT NULL | Display name as supplied by the provider (e.g. `"Brazil"`). Plain English; the localised variant is rendered at the UI layer via `Intl.DisplayNames`. |
| `tla` | `TEXT` | NOT NULL, UNIQUE, `CHECK (length(tla) = 3 AND tla ~ '^[A-Z]+$')` | FIFA three-letter abbreviation (`BRA`, `EST`, `USA`). Used for compact card rendering + filter chips. |
| `provider_team_id` | `INTEGER` | NOT NULL, UNIQUE | football-data.org v4 team id; used as the merge key on sync. |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, `DEFAULT now()` | |

**Indexes:** PK on `id`; UNIQUE on `tla`; UNIQUE on `provider_team_id`. No additional indexes needed at this scale.

**Seeding:** `0017_seed_teams.sql` inserts the 48 confirmed FIFA WC 2026 qualifiers (or as many as known at seed time; the sync function backfills the rest on first import). Seed values are pulled from football-data.org's frozen sample response (`supabase/functions/sync-matches/__fixtures__/v4-sample.json`) so the seed is reproducible and CI-friendly without a live API key.

**RLS:** `SELECT` policy gated on `is_eligible_nortal_user()` (per FR-M22). No `authenticated`-role INSERT/UPDATE/DELETE policies — writes happen via service-role during sync.

---

## `matches` (migration 0012_create_matches.sql)

The 104-row tournament catalog.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `UUID` | PK, `DEFAULT gen_random_uuid()` | Internal identity. Future predictions table (feature 003) references this. |
| `provider_id` | `INTEGER` | NOT NULL, UNIQUE | football-data.org v4 match id; the merge key on UPSERT. The UNIQUE constraint is what makes FR-M20 idempotency safe. |
| `home_team_id` | `UUID` | NOT NULL, REFERENCES `teams(id)` ON DELETE RESTRICT | RESTRICT (not CASCADE) — a team referenced by any match cannot be deleted without explicit cleanup. |
| `away_team_id` | `UUID` | NOT NULL, REFERENCES `teams(id)` ON DELETE RESTRICT | Same. |
| `stage` | `TEXT` | NOT NULL, `CHECK (stage IN ('group','round-of-16','quarter-final','semi-final','third-place','final'))` | Plain text + check constraint. (Postgres ENUMs are rejected here per project convention — they're hard to evolve.) |
| `group_label` | `TEXT` | NULL, `CHECK (group_label IS NULL OR group_label ~ '^[A-L]$')` | NULL for knockout matches; one of `A`..`L` for group stage (12 groups in WC 2026 expansion). |
| `kickoff_utc` | `TIMESTAMPTZ` | NULL | NULL only for `status='scheduled-tbd'` rows where the draw hasn't placed the team yet. NOT NULL is enforced indirectly by FR-M01 + the status check constraint below. |
| `venue` | `TEXT` | NULL | Provider-supplied venue name when available; optional per spec §5 deferred decision. |
| `status` | `TEXT` | NOT NULL, `CHECK (status IN ('scheduled','scheduled-tbd','live','finished','cancelled'))` | 5 values per spec §2 Clarifications (Session 2026-05-20 Q1). `locked` is NOT a stored status — it's derived. |
| `score_home` | `INTEGER` | NULL, `CHECK (score_home IS NULL OR score_home >= 0)` | Set when `status IN ('live','finished')` and provider has reported a score. |
| `score_away` | `INTEGER` | NULL, `CHECK (score_away IS NULL OR score_away >= 0)` | Same. |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, `DEFAULT now()` | |
| `last_synced_at` | `TIMESTAMPTZ` | NOT NULL, `DEFAULT now()` | Updated on every successful sync UPSERT (whether row data changed or not). Operational visibility — answers "when did we last hear about this match from the provider?". |

**Additional constraint:**

```sql
CHECK (
  (status = 'scheduled-tbd' AND kickoff_utc IS NULL)
  OR (status <> 'scheduled-tbd' AND kickoff_utc IS NOT NULL)
)
```

— Ensures the spec's edge case ("a match with no kickoff time yet → `status='scheduled-tbd'`") is enforced at the schema level. Prevents future bugs where someone hand-writes a `scheduled` row without a kickoff.

**Indexes:**
- PK on `id`
- UNIQUE on `provider_id` (merge key for sync UPSERT)
- `(kickoff_utc ASC NULLS LAST)` for the default `/matches` chronological query + `LIMIT 3` dashboard widget query
- `(stage, kickoff_utc)` composite for the `?stage=...` filter
- `(home_team_id)` and `(away_team_id)` for the `?team=BRA` filter (resolved to team UUIDs by the route handler)

**RLS:** `SELECT` policy gated on `is_eligible_nortal_user()` per FR-M22. No `authenticated`-role write policies.

---

## `integration_runs` (migration 0013_create_integration_runs.sql)

Telemetry for every sync attempt (success, error, skipped — see R-7).

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | `BIGSERIAL` | PK | BIGSERIAL (not UUID) — telemetry rows are write-heavy and read by timestamp ranges, so a cheap monotonic key wins. |
| `provider` | `TEXT` | NOT NULL, `CHECK (provider IN ('football-data.org'))` | Single-value enum today; check constraint expands easily when we add a second provider. |
| `action` | `TEXT` | NOT NULL, `CHECK (action IN ('bootstrap','incremental-sync','manual-resync'))` | Trigger source per R-7. |
| `started_at` | `TIMESTAMPTZ` | NOT NULL, `DEFAULT now()` | |
| `finished_at` | `TIMESTAMPTZ` | NULL | NULL while in flight; set when the Edge Function writes its final row. |
| `status` | `TEXT` | NOT NULL, `CHECK (status IN ('success','error','skipped'))` | 3 values per spec §8 + R-7. |
| `records_processed` | `INTEGER` | NOT NULL, `DEFAULT 0`, `CHECK (records_processed >= 0)` | Count of rows UPSERTed (provider returned). `0` for `status='skipped'`. |
| `records_unchanged` | `INTEGER` | NOT NULL, `DEFAULT 0`, `CHECK (records_unchanged >= 0)` | Of the processed rows, how many were field-identical to existing rows (no UPDATE fired). Lets idempotency tests (TC-M13) assert `records_processed = records_unchanged` after a no-op re-sync. |
| `error_message` | `TEXT` | NULL | On `status='error'`: provider error body or exception message. On `status='skipped'`: ISO timestamp of the in-flight run's `started_at` for triage per R-7. |

**Indexes:**
- PK on `id`
- `(started_at DESC)` for "show me the last 50 runs" admin queries
- `(action, status, started_at DESC)` for the operator query in R-7 scenario 3

**RLS:** `SELECT` policy gated on `is_admin_user()` per FR-M22. Non-admin sessions see zero rows. No `authenticated`-role write policies.

---

## `participants` extension (migration 0014_add_participants_timezone.sql)

```sql
ALTER TABLE participants
  ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

-- Validation: must be a non-empty IANA-ish string. We do NOT try to validate
-- against the live IANA database at the column level — Postgres has no native
-- way to do that, and the IANA db evolves. Renderer-side fallback handles
-- invalid values per spec.md §3 edge cases.
ALTER TABLE participants
  ADD CONSTRAINT participants_timezone_nonempty
  CHECK (length(timezone) > 0 AND timezone NOT LIKE '% %');
```

The existing `audit_participants_changes()` AFTER UPDATE trigger from feature 001 (migration 0005) catches `timezone` changes automatically and writes a `participant.updated` audit row — satisfying FR-M16 with **zero new SQL**. The trigger's catch-all branch (`ELSIF OLD IS DISTINCT FROM NEW`) fires for any column change not handled by an earlier branch.

**Migration backfill:** All existing participant rows get `'UTC'` via the column default. No data loss; first sign-in after the column lands triggers the auto-detect Client Component (FR-M14) which overwrites the default with the actual browser TZ.

---

## RPCs (migration 0015_match_rpcs.sql)

Three SECURITY DEFINER functions plus one helper. All follow the feature 001 convention: explicit REVOKE FROM PUBLIC + targeted GRANT to `authenticated` (or `service_role` for admin-only).

### `set_timezone(p_timezone TEXT) RETURNS jsonb`

Called once from the first-sign-in Client Component (FR-M14).

```
- SECURITY DEFINER, search_path = public, auth
- Reads auth.uid() to identify the caller
- Validates p_timezone: length > 0, no whitespace, length <= 64
- UPDATE participants SET timezone = p_timezone
    WHERE auth_user_id = auth.uid() AND status = 'active' AND timezone = 'UTC'
- If NOT FOUND: returns {outcome: 'no-op', reason: 'already-set' or 'not-eligible'}
- If updated: returns {outcome: 'success', timezone: p_timezone}
- GRANT EXECUTE TO authenticated
```

The `timezone = 'UTC'` filter in the WHERE clause makes this RPC a one-shot: subsequent calls (e.g. if the Client Component fires twice due to a React StrictMode double-render) are silently no-ops, not error states. Spec FR-M14 wording ("fires once on first dashboard mount") is enforced at the DB layer, not the client layer.

### `update_timezone(p_timezone TEXT) RETURNS jsonb`

Called from the `/profile` TimezonePicker (FR-M15). Mirrors `update_display_name` from feature 001.

```
- SECURITY DEFINER, search_path = public, auth
- Validates p_timezone (same rules as set_timezone)
- UPDATE participants SET timezone = p_timezone
    WHERE auth_user_id = auth.uid() AND status = 'active'
- If NOT FOUND: RAISE EXCEPTION 'participant not found or inactive'
    USING ERRCODE = 'no_data_found'
- Returns {outcome: 'success', timezone: p_timezone}
- GRANT EXECUTE TO authenticated
```

Audit-trigger handles the participant.updated row (no manual audit_log INSERT here).

### `trigger_match_sync() RETURNS jsonb` (admin)

Called from the admin re-sync route (FR-M18). Issues an HTTP POST to the Edge Function URL via `pg_net` extension (assumes the Supabase Pro tier exposes pg_net; if not, this RPC just records intent and a separate admin UI button does the actual HTTP call from the browser via a service-role API route — fallback decided at implementation time).

```
- SECURITY DEFINER, search_path = public, net
- IF NOT is_admin_user() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = 'insufficient_privilege'
- Issue pg_net HTTP POST to {function_url}/sync-matches with body {action: 'manual-resync'}
- Returns {outcome: 'triggered', request_id: <pg_net request id for telemetry>}
- GRANT EXECUTE TO authenticated  (RLS check inside)
```

### `acquire_match_sync_lock() RETURNS boolean` (helper, called by Edge Function)

Per R-4: returns the result of `pg_try_advisory_lock(hashtext('match-catalog-sync'))`. The Edge Function calls this via the service-role client at start-of-run; on `false` it short-circuits with `outcome='skipped'`.

```
- SECURITY DEFINER, search_path = public
- RETURN pg_try_advisory_lock(hashtext('match-catalog-sync'))
- REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO service_role
```

(There is no corresponding `release_match_sync_lock` RPC — Edge Function calls `pg_advisory_unlock` directly via the SQL client, or relies on session-close fail-safe.)

---

## RLS policies (migration 0016_match_rls.sql)

```sql
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_runs ENABLE ROW LEVEL SECURITY;

-- Read-path: eligible participants only
CREATE POLICY teams_select_eligible
  ON teams FOR SELECT TO authenticated
  USING (is_eligible_nortal_user());

CREATE POLICY matches_select_eligible
  ON matches FOR SELECT TO authenticated
  USING (is_eligible_nortal_user());

-- Admin-only telemetry
CREATE POLICY integration_runs_select_admin
  ON integration_runs FOR SELECT TO authenticated
  USING (is_admin_user());

-- No INSERT/UPDATE/DELETE policies for `authenticated` — writes happen via
-- service_role from the sync Edge Function. PostgREST will return 401
-- to any authenticated-role attempt to write these tables, which is the
-- desired behaviour.
```

(pgTAP test `006_rls_matches.sql` asserts the read predicate for eligible / ineligible / admin / anon sessions and asserts the absence of write policies for the `authenticated` role.)

---

## Lock-badge derivation

The `lock_badge_state(kickoff_utc, status, now_utc)` decision lives in TS (`lib/matches/lock-badge.ts`) per plan.md §"Phase 1 design moves". A SQL-side helper is **not** introduced in this feature — every query that needs to filter or sort by badge state can do so with inline expressions:

```sql
-- "Next 3 upcoming" (dashboard widget query):
SELECT *
  FROM matches
 WHERE status = 'scheduled'
   AND kickoff_utc > now() + INTERVAL '60 minutes'
 ORDER BY kickoff_utc ASC
 LIMIT 3;
```

The TS helper handles the same logic on the render side after rows arrive. If a future feature needs to JOIN matches with predictions filtered by badge state, we can revisit and add a SQL helper at that point.

---

## Edge cases enforced at schema level

| Spec §3 edge case | Schema mechanism |
|---|---|
| Match with no kickoff yet → `status='scheduled-tbd'` AND `kickoff_utc IS NULL` | CHECK constraint on the (status, kickoff_utc) pair |
| Provider 5xx → catalog unchanged | Sync transaction structure (per-match UPSERT inside one tx; failures roll back individual upserts) plus integration_runs telemetry |
| Invalid stored TZ → renderer fallback | TS-level (no schema enforcement; CHECK constraint only rejects empty + whitespace) |
| Cross-TZ day grouping | TS-level (day-bucket helper); no schema implication |
| Idempotent re-sync | UNIQUE constraint on `provider_id` + UPSERT semantics |
| Concurrent sync | `acquire_match_sync_lock` RPC + `pg_try_advisory_lock` |

---

## Migration order + dependency

```
0011_create_teams.sql              (independent)
  ↓
0012_create_matches.sql            (FK to teams)
  ↓
0013_create_integration_runs.sql   (independent)
0014_add_participants_timezone.sql (independent of 002 tables — extends 001 schema)
  ↓
0015_match_rpcs.sql                (depends on participants extension for set/update_timezone)
  ↓
0016_match_rls.sql                 (depends on all three new tables + is_eligible_nortal_user / is_admin_user from 001)
  ↓
0017_seed_teams.sql                (seed-only; depends on 0011)
```

Migrations apply in order via `npx supabase db reset` (the existing convention from feature 001). pgTAP tests 006–009 run after `db reset` against the fully-migrated schema.

---

## Type-generation impact

After migrations land, run:

```bash
npx supabase gen types typescript --local > lib/supabase/database.types.ts
```

The regenerated file picks up:
- `teams`, `matches`, `integration_runs` row + insert + update types
- `participants.timezone` column added to the existing row type
- RPC return shapes for `set_timezone`, `update_timezone`, `trigger_match_sync`

Every Server Component query and every RPC client call inherits new types automatically.

---

## Related artifacts

- [contracts/](./contracts/) — RPC + Edge Function HTTP contracts
- [research.md](./research.md) — R-1 (provider response shape) and R-7 (telemetry conventions) drive the table designs above
- [plan.md](./plan.md) §"Project Structure" — file-level mapping of these tables/RPCs to migrations + components
