# World Cup Madness

An internal Nortal prediction pool for the FIFA World Cup 2026 — a "March Madness for soccer." Eligible Nortal employees sign in via corporate identity, predict match scores (locked one hour before kickoff) plus four tournament-wide picks (champion, runner-up, top scorer, best player; locked at first kickoff), and compete on a live leaderboard scored automatically against official results.

## Where to start

- [docs/architecture/README.md](docs/architecture/README.md) — index of all product/architecture artifacts
- [docs/architecture/high-level-architecture.md](docs/architecture/high-level-architecture.md) — full Nortal architecture document
- [docs/architecture/acceptance-criteria.md](docs/architecture/acceptance-criteria.md) — test scenarios and acceptance criteria
- [docs/architecture/open-decisions.md](docs/architecture/open-decisions.md) — unresolved questions (OD-001…OD-008)
- [docs/architecture/scoring-model.md](docs/architecture/scoring-model.md) — locking + scoring + tie-breakers
- [docs/architecture/stack-decision.md](docs/architecture/stack-decision.md) — proposed implementation stack (draft ADR)

## Repository infrastructure

This repository uses a standardized pattern for:
- **Repository organization** via an auto-generated INDEX
- **Secret management** with local plaintext (gitignored) and encrypted (committed) secrets using age
- **Pre-commit enforcement** to prevent accidental secret leaks
- **Claude Code integration** with startup instructions

## Quick Start

### First-Time Setup

```bash
# Clone the repository
git clone <repository-url>
cd <repository-name>

# Run bootstrap (requires age to be installed)
./scripts/bootstrap.sh
```

### Prerequisites

| Tool | Check | Install (macOS) |
|------|-------|-----------------|
| Git 2.9+ | `git --version` | `brew install git` |
| Python 3.9+ | `python3 --version` | `brew install python` |
| age | `age --version` | `brew install age` |

## Directory Structure

```
.
├── .claude/           # Claude Code instructions
├── .githooks/         # Git hooks (pre-commit)
├── docs/              # Documentation
├── scripts/           # Automation scripts
│   ├── bootstrap.sh   # First-time setup
│   ├── install_hooks.sh
│   ├── index/         # INDEX.md generation
│   └── secrets/       # Secret encryption/decryption
├── secrets/
│   ├── plain/         # Plaintext secrets (gitignored)
│   ├── enc/           # Encrypted secrets (committed)
│   ├── recipients.txt # Public keys for encryption
│   └── manifest.json  # Secret metadata
├── CLAUDE.md          # Project nickname and agent rules
├── CLAUDE_START.md    # Agent getting started guide
├── INDEX.md           # Repository map (auto-generated)
└── README.md          # This file
```

## Secrets Workflow

### Creating Secrets

1. Create plaintext file in `secrets/plain/`:
   ```bash
   echo "API_KEY=secret123" > secrets/plain/my_secret.env
   ```

2. Encrypt all secrets:
   ```bash
   ./scripts/secrets/encrypt_all.sh
   ```

3. Commit encrypted files:
   ```bash
   git add secrets/enc/ secrets/manifest.json
   git commit -m "Add encrypted secret"
   ```

### Decrypting Secrets

After cloning or pulling:
```bash
./scripts/secrets/decrypt_all.sh
```

### Adding Team Members

1. Get their public key (they run `age-keygen` and share the `age1...` line)
2. Add to `secrets/recipients.txt`
3. Re-encrypt: `./scripts/secrets/encrypt_all.sh`
4. Commit and push

## Pre-commit Hook

The pre-commit hook blocks commits containing:
- Files in `secrets/plain/`
- Files matching `*.env`, `.env.*`, `*.pem`, `*.key`, `credentials.*`

To bypass (not recommended):
```bash
git commit --no-verify
```

## INDEX.md

The repository map in INDEX.md is auto-generated. To update:
```bash
./scripts/index/generate.sh
```

Human-editable sections are preserved across regenerations.

## Claude Code Integration

This repository is configured for Claude Code with:
- `CLAUDE_START.md` - Entry point for agents
- `CLAUDE.md` - Project nickname and behavior rules
- `.claude/instructions.md` - Detailed agent guidance
- `INDEX.md` - Repository structure for context

Agents are instructed to read these files first in any session.

---

## Feature 001 — Authentication and participant provisioning

**Spec:** [`specs/001-authentication-and-participant/`](specs/001-authentication-and-participant/) (FRs, TCs, ADRs)
**Setup guide:** [`specs/001-authentication-and-participant/quickstart.md`](specs/001-authentication-and-participant/quickstart.md) — step-by-step first-run instructions
**DoD report:** [`specs/001-authentication-and-participant/dod-verification.md`](specs/001-authentication-and-participant/dod-verification.md)

### Required environment variables

Copy `.env.example` to `.env.local` and fill from `npx supabase start` output (local) or your Supabase / Vercel project settings (deployed).

| Variable | Where it goes | Sourced from |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Server + browser bundles | `npx supabase status -o env` (`API_URL`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Server + browser bundles | `npx supabase status -o env` (`ANON_KEY`) |
| `SUPABASE_SERVICE_ROLE_KEY` | **Server-only** — never ship to client | `npx supabase status -o env` (`SERVICE_ROLE_KEY`) |
| `AUTH_AZURE_CLIENT_ID` | Supabase Auth provider config | Microsoft Entra app registration (Nortal IT) |
| `AUTH_AZURE_SECRET` | Supabase Auth provider config | Microsoft Entra app registration (Nortal IT) |
| `AUTH_AZURE_TENANT_ID` | Local dev: matches `tournament_config.nortal_tenant_id`; prod: Nortal tenant UUID | Nortal IT |

### Local test commands

```bash
# Unit (pure functions)
npm test

# E2E (chromium + accessibility projects)
npm run test:e2e
npm run test:a11y     # accessibility-only subset

# Database (pgTAP — needs `npx supabase start` first)
npx supabase db test test/pgtap/*.sql

# Static checks
npm run type-check
npm run lint
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run dev` returns 404 on every page including `/` | Stale `.next` cache from a Next or middleware change | `rm -rf .next && npm run dev` |
| Playwright timeout: `webServer didn't start within 120000ms` | Lingering `next dev` process holding port 3000 | `pkill -9 -f "next dev" && pkill -9 -f next-server`, then retry |
| `Supabase: failed to inspect container health` | Colima / Docker daemon not running | `colima start --cpu 4 --memory 4` (macOS); excludes `vector` per local convention: `npx supabase start --exclude vector` |
| pgTAP `Files=0, Tests=0, Result: NOTESTS` | Default test path doesn't pick up `test/pgtap/` | Pass paths explicitly: `npx supabase db test test/pgtap/*.sql` |
| Spanish / Portuguese sign-in shows English text | Stale `NEXT_LOCALE` cookie from a previous session | Clear browser cookies for `localhost:3000`; the middleware re-detects from `Accept-Language` on next request |
| `signInAs: admin.createUser failed for ...: Unable to validate email address` | Whitespace or invalid characters in test email | Supabase Auth's format validator rejects whitespace; use a clean email per the `e2e/fixtures/auth.ts` defaults |
| `infinite recursion detected in policy for relation 'participants'` | Stale local schema (pre-migration 0010) | `npx supabase db reset` — migration 0010 introduced the `is_admin_user()` SECURITY DEFINER helper that breaks the recursion |

---

## Feature 002 — Match catalog

**Spec:** [`specs/002-match-catalog-read/`](specs/002-match-catalog-read/) (FRs, NFRs, TCs)
**Setup guide:** [`specs/002-match-catalog-read/quickstart.md`](specs/002-match-catalog-read/quickstart.md) — step-by-step first-run instructions
**DoD report:** [`specs/002-match-catalog-read/dod-verification.md`](specs/002-match-catalog-read/dod-verification.md)
**Provider sync deep-dive:** [`supabase/functions/sync-matches/README.md`](supabase/functions/sync-matches/README.md)

### What shipped

Match catalog with provider sync (football-data.org v4), per-participant timezone (browser auto-detect + manual `/profile` picker), `/matches` browse + `/matches/[id]` detail pages, day-bucket grouping in the participant's timezone, lock-state badges, dashboard upcoming-matches widget, admin re-sync action, and idempotent + concurrency-safe sync via a Postgres advisory-lock mutex.

### New environment variables

Append to `.env.local` (template entries already in `.env.example`):

| Variable | Where it goes | Notes |
|---|---|---|
| `FOOTBALL_DATA_API_KEY` | Edge Function (server-only) | Required in deployed envs; **not** required when `SYNC_FIXTURE_MODE=1`. Sign up at https://www.football-data.org (free tier, 10 req/min). |
| `SYNC_FIXTURE_MODE` | Edge Function (server-only) | Set to `1` to read `supabase/functions/sync-matches/__fixtures__/v4-sample.json` instead of hitting the provider. Used by local dev + CI. Any other value (or unset) means live-provider mode. |

### Local test commands

In addition to the feature-001 commands above:

```bash
# Serve the Edge Function in fixture mode (no API key required;
# .env.local must contain FOOTBALL_DATA_API_KEY=<anything> and SYNC_FIXTURE_MODE=1)
SYNC_FIXTURE_MODE=1 npx supabase functions serve sync-matches --env-file .env.local

# pgTAP — matches + sync RPCs + advisory lock + RLS
npx supabase db test test/pgtap/*.sql

# Playwright — the new feature-002 specs
npx playwright test e2e/tests/matches-*.spec.ts \
                    e2e/tests/match-sync-*.spec.ts \
                    e2e/tests/timezone-*.spec.ts \
                    e2e/tests/day-grouping-cross-tz.spec.ts
```

### Troubleshooting

Most-hit rows from the [feature-002 quickstart §9](specs/002-match-catalog-read/quickstart.md#9-troubleshooting); see the quickstart for the full table.

| Symptom | Likely cause | Fix |
|---|---|---|
| `function net.http_post does not exist` | `pg_net` extension not enabled in local Supabase | Either skip the `trigger_match_sync` RPC tests (the function still works via direct Edge Function curl) or enable pg_net via `CREATE EXTENSION pg_net;` in a migration (Pro tier only — local stack may not support it) |
| `matches` table empty after running the sync | Check `integration_runs` for an `error` row | Most likely a missing API key — switch to fixture mode (`SYNC_FIXTURE_MODE=1`) |
| Kickoffs render in UTC even though your browser is on a different TZ | Auto-detect Client Component hasn't fired yet, or `participants.timezone` is still `'UTC'` | Visit `/dashboard` (auto-detect runs on first mount); alternatively set TZ manually at `/profile` |
| Filter chip on `/matches` not narrowing the list | Filters compose with AND; not all combinations are valid (e.g. `?group=A` only narrows group-stage matches) | Conflicting filters produce empty results — expected per FR-M05 |
| Advisory lock never releases | Edge Function crashed mid-flight | Wait ~10 seconds (connection-close fail-safe per research §R-4), then retry. If it persists, restart `supabase functions serve` |

### Cross-references

- [`specs/002-match-catalog-read/spec.md`](specs/002-match-catalog-read/spec.md) — FRs / NFRs / TCs
- [`specs/002-match-catalog-read/dod-verification.md`](specs/002-match-catalog-read/dod-verification.md) — audit evidence
- [`supabase/functions/sync-matches/README.md`](supabase/functions/sync-matches/README.md) — provider sync deep-dive (env vars, action types, concurrency model, deployment)

## Feature 003 — Predictions and scoring

### What shipped

The core predict → score → see-results loop:

- **Match predictions** — submit + edit a predicted score on `/matches/[id]`; server-enforced 60-minute lock (strict-greater-than per BR-LOCK-003).
- **Final predictions** — champion / runner-up (team pickers) + top-scorer / best-player (player comboboxes) on `/predictions/final`; one row per participant, locked at the first non-cancelled kickoff. Player pickers render disabled with a "rosters pending" notice until squads are synced (FR-P11).
- **Scoring engine** — Postgres `AFTER INSERT/UPDATE` triggers on `matches` (10/5/0 per match) and on `tournament_config` / `final_predictions` (20 per correct final pick), rebuilding `score_events` via DELETE-then-INSERT. Admin score corrections (`UPDATE matches`) and `set_tournament_winner()` re-fire scoring transactionally.
- **Squad sync** — the feature-002 `sync-matches` Edge Function gained a step that fetches each team's squad into a new `players` table.
- **Admin recalc** — `recalculate_all_scores()` RPC (admin-gated, mutex-protected via `scoring_runs`).
- **Personal breakdown** — `/predictions/breakdown` shows per-match + final-prediction points and a running total.

> **Schema note:** there is no `match_results` table. Feature 002 stores `score_home` / `score_away` / `status` directly on `matches`, so scoring fires on `matches` and admin corrections are `UPDATE matches`. (The spec/contracts say "match_results" — read "matches".)

### New environment variables

None. Squad sync reuses `FOOTBALL_DATA_API_KEY` + `SYNC_FIXTURE_MODE=1` from feature 002. In fixture mode the squad step reads `supabase/functions/sync-matches/__fixtures__/v4-squads-sample.json` (32 teams × 5 players).

### Local test commands

```bash
# pgTAP — predictions + scoring (RLS, triggers, RPCs, idempotency)
docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres \
  -X -q -f - < test/pgtap/015_match_scoring_trigger.sql
# (CREATE EXTENSION pgtap; is wiped by `supabase db reset` — re-run it first)

# Trigger scoring locally: finish a match (no match_results table — UPDATE matches)
#   UPDATE matches SET status='finished', score_home=2, score_away=1 WHERE id='...';

# Playwright — feature 003 surfaces
npx playwright test \
  e2e/tests/predictions-submit.spec.ts \
  e2e/tests/predictions-lock-boundary.spec.ts \
  e2e/tests/predictions-rls.spec.ts \
  e2e/tests/predictions-final-submit.spec.ts \
  e2e/tests/predictions-final-player-picker.spec.ts \
  e2e/tests/scoring-match-points.spec.ts \
  e2e/tests/scoring-idempotency.spec.ts \
  e2e/tests/scoring-admin-correction.spec.ts \
  e2e/tests/scoring-final-points.spec.ts \
  e2e/tests/predictions-breakdown.spec.ts

# Jest — pure helpers
npm test -- --testPathPatterns="lib/predictions"
```

See [`specs/003-predictions-and-scoring/quickstart.md`](specs/003-predictions-and-scoring/quickstart.md) for the full local-dev walkthrough.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Scoring trigger doesn't fire on a finished match | The match's `status` isn't `finished`/`cancelled`, or scores are NULL | The trigger WHEN clause needs `status='finished'` + non-null scores (or `status='cancelled'`). Set both in one UPDATE. |
| `PREDICTION_LOCKED` on a match clearly > 60 min out | Server clock vs your expectation | The RPC uses server `now()`; check `SELECT now()` and the match's `kickoff_utc`. At exactly T-60 the lock IS engaged (BR-LOCK-003). |
| `UPDATE requires a WHERE clause` (SQLSTATE 21000) inside an RPC | Supabase's safe-update guard (supautils) blocks unqualified UPDATE/DELETE | Add a WHERE clause — e.g. `set_tournament_winner` updates `tournament_config WHERE id = 1`. |
| `recalculate_all_scores()` returns `outcome: 'skipped'` | A prior recalc row is stuck in-flight | `DELETE FROM scoring_runs WHERE action='admin-recalc-all' AND finished_at IS NULL;` (runbook step). |
| Player pickers stay disabled | `players` table empty (squads not synced) | Run the `sync-matches` Edge Function in fixture mode, or seed players directly; the picker auto-enables when `players` has ≥1 row. |
| pgTAP "Looks like you planned N but ran M" | `ROLLBACK TO SAVEPOINT` reverts pgTAP's test counter | Use `RELEASE SAVEPOINT` instead (throws_ok self-manages its own exception savepoint). |

### Cross-references

- [`specs/003-predictions-and-scoring/spec.md`](specs/003-predictions-and-scoring/spec.md) — FRs / NFRs / TCs
- [`specs/003-predictions-and-scoring/dod-verification.md`](specs/003-predictions-and-scoring/dod-verification.md) — audit evidence (per-FR/NFR/TC table + the match_results→matches schema note)
- [`specs/003-predictions-and-scoring/contracts/`](specs/003-predictions-and-scoring/contracts/) — RPC + trigger contracts

## Feature 004 — Leaderboard

**Spec:** [`specs/004-leaderboard/`](specs/004-leaderboard/) (FRs, NFRs, TCs)
**Setup guide:** [`specs/004-leaderboard/quickstart.md`](specs/004-leaderboard/quickstart.md)
**DoD report:** [`specs/004-leaderboard/dod-verification.md`](specs/004-leaderboard/dod-verification.md)
**Contracts:** [`specs/004-leaderboard/contracts/`](specs/004-leaderboard/contracts/) — MV + RPC + Realtime channel + cron + audit-event schemas

### What shipped

The ranking surface that closes the *predict → score → see-where-you-stand* loop:

- **`/leaderboard` page** — Server-rendered table from the `leaderboard_snapshots` materialised view; one row per active participant (incl. 0-point joiners); rank + display name + active-tab points (per FR-L02 privacy projection).
- **Stage tab strip** — `All` / `Group` / `R16` / `Quarter` / `Semi` / `Final`, WAI-ARIA tabs with keyboard nav, persisted via `?stage=` URL param. Each specific stage counts only that stage's match points; finals only on `All` (FC-L4).
- **Deterministic tie-breakers** — total → exact hits → outcome hits → final-prediction points → shared rank (`1=`, `1=`, `3`). Tie-breaker #5 from `scoring-model.md` §7.4 (earliest submission time) is **not** adopted at launch (FC-L5).
- **Realtime rank updates** — Client subscribes to `audit_log` rows filtered by `action=eq.leaderboard.refresh` (audit-event proxy pattern); on each event the visible slice re-fetches from the MV. Table re-renders without a page reload within 5 s (NFR-L2).
- **Pre-tournament countdown** — Before the first `score_events` row exists, the rankings hide and a countdown to the first non-cancelled kickoff renders in the participant's timezone (FR-L07).
- **Dashboard widget** — Compact "Your rank ↑/↓ N" card on `/dashboard`, Realtime-subscribed, click-through to `/leaderboard` with "Show my rank" pre-fired.
- **Self-healing refresh** — `pg_cron` job `leaderboard-refresh-tick` runs every 5 minutes; `should_refresh_leaderboard()` STABLE predicate gates the actual `REFRESH MATERIALIZED VIEW CONCURRENTLY` (unconditional inside ±90 min of any match kickoff; otherwise only if the last refresh is >60 min old; skip pre-tournament entirely).
- **Decoupled refresh on scoring** — Feature 003's scoring functions get a trailing `refresh_leaderboard()` call inside an exception-trapped block; refresh failure does NOT roll back scoring (FC-L2). Failures write `audit_log` `action='leaderboard.refresh_failed'` with SQLSTATE + error message.
- **Privacy by projection** — Column-level `GRANT SELECT (participant_id, stage, display_name, total_points, rank, rank_is_shared)` on `leaderboard_snapshots`; the private columns (`exact_hits`, `outcome_hits`, `final_points`) are reachable only through the `leaderboard_self` companion view restricted to the caller's own row.

> **Privacy note:** PostgreSQL 15 does not support `ROW LEVEL SECURITY` on materialised views, so FR-L02 / NFR-L6 are enforced via column GRANTs + the `leaderboard_self` view rather than MV-level RLS. See [`dod-verification.md`](specs/004-leaderboard/dod-verification.md) "Spec-vs-actual deviations" for the full list.

### New environment variables

None. The materialised view, RPC, cron schedule, and Realtime channel are entirely internal to Supabase.

### Local commands

Manually force a leaderboard refresh (useful after seeding data or testing the audit-event Realtime path):

```bash
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "SELECT refresh_leaderboard();"
```

Inspect the cron schedule (should list exactly one row for `leaderboard-refresh-tick`):

```bash
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "SELECT jobname, schedule FROM cron.job WHERE jobname='leaderboard-refresh-tick';"
```

Inspect the last 10 leaderboard refresh audit rows (success + failure interleaved):

```bash
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "SELECT occurred_at, action, new_value FROM audit_log
      WHERE action IN ('leaderboard.refresh','leaderboard.refresh_failed')
      ORDER BY occurred_at DESC LIMIT 10;"
```

Trigger gating predicate at a synthetic clock (`should_refresh_leaderboard()` is STABLE → safe to call ad hoc):

```bash
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "SELECT should_refresh_leaderboard();"
```

### Local test commands

```bash
# pgTAP — MV + RLS + RPC + cron gating + scoring-trigger extension
docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres \
  -X -q -f - < test/pgtap/020_mv_leaderboard_snapshots.sql
# Repeat for 021_rls_leaderboard_snapshots.sql, 022_refresh_leaderboard_rpc.sql,
# 023_leaderboard_cron_gating.sql, 024_scoring_trigger_mv_extension.sql

# Jest — pure helpers (delta, rank format, URL state, countdown)
npm test -- --testPathPatterns="lib/leaderboard"

# Playwright — feature 004 surfaces
npx playwright test \
  e2e/tests/leaderboard-page.spec.ts \
  e2e/tests/leaderboard-tie-breakers.spec.ts \
  e2e/tests/leaderboard-stage-filter.spec.ts \
  e2e/tests/leaderboard-realtime.spec.ts \
  e2e/tests/leaderboard-dashboard-widget.spec.ts \
  e2e/tests/leaderboard-pre-tournament.spec.ts \
  e2e/tests/leaderboard-privacy.spec.ts
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `/leaderboard` shows stale ranks after a finished match | Last scoring run's refresh failed (FC-L2 commits scoring even when refresh throws) | Check the gating predicate state and the most recent audit rows: `SELECT should_refresh_leaderboard();` then `SELECT occurred_at, action, new_value FROM audit_log WHERE action LIKE 'leaderboard.%' ORDER BY occurred_at DESC LIMIT 5;` — look for a `leaderboard.refresh_failed` row. Force a manual refresh via `SELECT refresh_leaderboard();` |
| `permission denied for column exact_hits` (or `outcome_hits` / `final_points`) | Expected behaviour per FR-L02 — these columns are NOT in the public projection | Query the self row via the `leaderboard_self` view instead: `SELECT * FROM leaderboard_self WHERE stage='all';`. Cross-participant access to these columns is denied by design. |
| Realtime channel disconnects in DevTools | Network blip; the client reconnects with backoff and surfaces `<ReconnectingIndicator/>` after 10 s offline (FR-L18) | Open DevTools → Network → WS and check the `wsFrames` count; if frames resume and the indicator clears the recovery worked. If frames stay at zero past 30 s, restart `supabase start`. |
| Pre-tournament countdown still showing after a match has finished | Either `should_refresh_leaderboard()` returned false at the last cron tick (e.g. no scoring run has fired yet for that match) or the FR-L22 guard is still satisfied (no `score_events` row exists) | Verify a `score_events` row exists for the finished match (`SELECT count(*) FROM score_events;`); if zero, the match's `status` and scores may not have been committed — see feature 003 troubleshooting. |
| `cron.job` row missing in deployed Supabase Cloud project | `pg_cron` not enabled on the project, or migration 0035 hasn't run | Verify `CREATE EXTENSION pg_cron;` then re-run `supabase db push`; expected pg_cron is Pro tier+. |

### Cross-references

- [`specs/004-leaderboard/spec.md`](specs/004-leaderboard/spec.md) — FRs / NFRs / TCs / FC constraints
- [`specs/004-leaderboard/dod-verification.md`](specs/004-leaderboard/dod-verification.md) — audit evidence + spec-vs-actual deviation log
- [`specs/004-leaderboard/contracts/`](specs/004-leaderboard/contracts/) — MV / RPC / Realtime channel / cron / audit-event schemas
- [`specs/004-leaderboard/research.md`](specs/004-leaderboard/research.md) — design rationale (MV-level RLS, audit-event proxy, cron gating predicate)

## Feature 005 — Dashboard polish + mobile UX

The dashboard at `/dashboard` is now a mobile-first tabbed surface (Today / Pool) that collapses to a desktop 2-column grid above 768 px. The Today tab houses Upcoming + Rank + Snapshot; the Pool tab houses Neighborhood + Movers + Digest. The Upcoming widget supports inline quick-edit. A Realtime stale-while-revalidate path keeps the entire dashboard in sync with leaderboard MV refreshes, announced by a polite-live "Refreshing…" chip.

### Local commands

```bash
# Trigger a leaderboard refresh manually (audit-event broadcast handled by feature 004)
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "SELECT refresh_leaderboard();"

# Inspect movers aggregator output directly (debugging the FR-D11 widget)
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "SET ROLE authenticated; SELECT * FROM get_movers_24h_aggregate() LIMIT 10;"

# Force the refreshing chip to appear: in DevTools, throttle the network and
# fire a refresh event so the 300 ms debounce + transition is observable.
# The chip is mounted in the page header; it has role="status" and a
# blue-100 background — search the DOM for `[role="status"]` while a
# refresh is in flight.

# Simulate the 360 px mobile viewport via DevTools device emulation or via
# Playwright headed mode:
#   npx playwright test e2e/tests/dashboard-mobile-tabs.spec.ts --headed
```

### Tests (full feature 005 surface)

```bash
# Database — the dashboard adds one read-only RPC (FC-D1 carve-out)
docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres \
  < test/pgtap/025_movers_aggregate_rpc.sql
# (CREATE EXTENSION pgtap; is wiped by `supabase db reset` — re-run it first)

# Jest — pure helpers (tab URL state, neighborhood window, movers 24 h,
# weekly digest, snapshot lookup, lock countdown)
npm test -- lib/dashboard/__tests__

# Playwright — full dashboard suite (chromium)
npx playwright test e2e/tests/dashboard-mobile-tabs.spec.ts \
  e2e/tests/dashboard-inline-edit.spec.ts \
  e2e/tests/dashboard-upcoming-widget.spec.ts \
  e2e/tests/dashboard-neighborhood.spec.ts \
  e2e/tests/dashboard-movers.spec.ts \
  e2e/tests/dashboard-digest.spec.ts \
  e2e/tests/dashboard-realtime.spec.ts \
  e2e/tests/dashboard-pre-tournament.spec.ts

# Accessibility (4 new dashboard surfaces — populated mobile/desktop +
# pre-tournament). Use the existing accessibility project.
npx playwright test e2e/tests/all-pages-a11y.spec.ts -g "dashboard"
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Pool tab always shows "Awaiting the first match" placeholders | `is_pre_tournament()` returns true → no rows in `score_events` | Verify `SELECT count(*) FROM score_events;` — if zero, run the feature 003 scoring trigger first (UPDATE a match to `status='finished'` with scores). The Pool widgets repopulate after the next MV refresh. |
| Refreshing chip never appears during Realtime events | The leaderboard Realtime channel never received SUBSCRIBED, or `audit_log` events aren't being broadcast | Open DevTools → Network → WS, look for a `realtime` socket. If absent, `supabase start` may have failed Realtime — restart the stack. If present, fire `SELECT refresh_leaderboard();` and watch for an `audit_log` INSERT WHERE `action='leaderboard.refresh'`. |
| Mobile tab strip not visible at the 360 px viewport | DevTools device emulation may not have triggered a re-render of the `block md:hidden` class; the tab strip is purely CSS-toggled | Reload the page at 360 px; Tailwind only re-evaluates breakpoints on layout pass. Alternatively run `npx playwright test e2e/tests/dashboard-mobile-tabs.spec.ts --headed` to see it in a real mobile viewport. |
| Inline quick-edit save shows `errorLocked` when the match is > 60 min away | Server clock drift between the Postgres container and Node test process | The lock check is `kickoff_utc - now() > interval '60 minutes'` and runs server-side per BR-LOCK-001. If you see `errorLocked` with > 60 min remaining, `docker exec` the DB and inspect `SELECT now();` against your wall clock. Usually a Colima time-skew on macOS — restart Colima. |
| RankWidget throws `cannot add postgres_changes callbacks for realtime:leaderboard-refresh after subscribe()` | Two RankWidget instances mounted with the same channel topic; supabase-js coalesces channels by name | Fixed in commit `7a6363c` — RankWidget now appends a per-mount `useId()` suffix to the channel name. If you see this on a branch off `master`, rebase to pick up that fix. |

### Cross-references

- [`specs/005-phase-4-dashboard/spec.md`](specs/005-phase-4-dashboard/spec.md) — FRs (FR-D01..D21) / NFRs / TCs / FCs
- [`specs/005-phase-4-dashboard/dod-verification.md`](specs/005-phase-4-dashboard/dod-verification.md) — DoD audit + outstanding external items
- [`specs/005-phase-4-dashboard/contracts/`](specs/005-phase-4-dashboard/contracts/) — widget query contracts + reused-RPC docs
- [`specs/005-phase-4-dashboard/research.md`](specs/005-phase-4-dashboard/research.md) — design rationale (R-2 stale-while-revalidate, R-3 dual-render, R-4 movers RPC carve-out)
- [`.ai_project_memory/constitution-frontend.md`](.ai_project_memory/constitution-frontend.md) — stack rows for the mobile-tabbed dashboard + stale-while-revalidate refresh patterns

## Feature 006 — Phase 5 Operational Readiness

Adds the operational layer for the live tournament window: when `integration_runs.status='error'` or `scoring_runs.status='error'` lands, a Microsoft Teams webhook POST reaches the configured channel within ≤ 5 minutes carrying a PII-scrubbed error context + a direct link to one of two kickoff-MUST runbooks (`provider-sync-failure.md` / `scoring-failure.md`). Every notification attempt is audited to `audit_log` via two new actions (`notification.teams.sent` + `notification.teams.failed`), and a 60-second `pg_cron` reconciler updates the audit trail with the eventual HTTP outcome. Six follow-on runbooks land alongside (`match-window-readiness`, `realtime-channel-drop`, `mv-refresh-stuck`, `admin-manual-recalc`, `lock-boundary-triage`, `post-tournament-archival`).

### Local commands

```bash
# Configure the Teams webhook URL for local dev (mock receiver path)
docker exec -e PGPASSWORD=postgres supabase_db_world-cup-madness \
  psql -U supabase_admin -d postgres -c \
  "ALTER DATABASE postgres SET app.env = 'development'; \
   ALTER DATABASE postgres SET app.teams_webhook_url = 'http://kong:8000/functions/v1/mock-teams-receiver?respond_with=200'; \
   SELECT pg_reload_conf();"

# Boot the mock Teams receiver Edge Function
SYNC_FIXTURE_MODE=1 npx supabase functions serve mock-teams-receiver --env-file .env.local

# Fire a synthetic error and watch the audit_log stream
docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres <<SQL
INSERT INTO integration_runs (provider, action, status, error_message, started_at, finished_at)
VALUES ('football-data.org', 'bootstrap', 'error',
        'Synthetic — alice@nortal.com on participant 00112233-4455-6677-8899-aabbccddeeff',
        now(), now());
SELECT id, action, entity_type, new_value
FROM audit_log
WHERE action LIKE 'notification.teams.%'
ORDER BY occurred_at DESC LIMIT 3;
SQL

# Force-tick the reconciler so the audit row's http_status updates immediately
docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "SELECT reconcile_teams_notifications_now();"

# Run the match-window-readiness query bundle (paste into Supabase Studio)
cat docs/runbooks/match-window-readiness.md | sed -n '/```sql/,/```/p' | head -50
```

### Tests (full feature 006 surface)

```bash
# pgTAP — 4 suites covering CHECK enum + PII scrubber + trigger behaviour + FR-O09 extension
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres \
  -c "CREATE EXTENSION IF NOT EXISTS pgtap;"
for f in test/pgtap/026_audit_log_action_extension.sql \
         test/pgtap/027_scrub_pii_for_teams.sql \
         test/pgtap/028_notify_teams_on_runs_error.sql \
         test/pgtap/029_extend_notification_audit_log.sql; do
    docker exec -i supabase_db_world-cup-madness psql -U postgres -d postgres -X -q < "$f"
done

# Playwright — notification suite (3 specs covering TC-O1, TC-O2, TC-O5,
# TC-O6, TC-O9, TC-O10, TC-O11, TC-O12)
npx playwright test e2e/tests/notification-*.spec.ts --project=chromium

# Secret hygiene — verify no webhook URL leaked into a tracked file
bash scripts/ci/secret-hygiene-grep.sh
```

### Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `permission denied to set parameter "app.teams_webhook_url"` | `supautils` blocks the `postgres` role from `ALTER DATABASE … SET app.*` | Use `supabase_admin` with `PGPASSWORD=postgres` — see Local commands above |
| Teams message does not arrive | Stale connection in PostgREST / pg_net worker pool still holds the old `app.teams_webhook_url` value | The test helpers terminate idle backends + wait 1.5 s after every URL change so the new value lands. For manual setup, re-issue any command after the GUC change to force a reconnect |
| `_test_mock_teams_inbox` missing | `app.env` not set to `'development'` when migration 0040 applied | `ALTER DATABASE postgres SET app.env = 'development';` then re-apply 0040 (or `npx supabase db reset`) |
| Reconciler doesn't update `http_status` | `pg_cron` job stuck or the manual force-tick wrapper not used | `SELECT reconcile_teams_notifications_now();` runs the reconciler immediately. Confirm `pg_cron` job is active via `SELECT * FROM cron.job WHERE jobname='reconcile-teams-notifications';` |
| Notification audit row has `entity_id=NULL` for an `integration_runs` row | `audit_log.entity_id` is UUID; `integration_runs.id` is BIGSERIAL — no cast | By design — the bigint id is preserved in `new_value->>'run_id'`. The reconciler joins by `new_value->>'req_id'`, so the linkage stays intact |

### Cross-references

- [`specs/006-phase-5-operational/spec.md`](specs/006-phase-5-operational/spec.md) — FRs (FR-O01..O12) / NFRs (NFR-O01..O05) / TCs (TC-O1..O12) / FCs
- [`specs/006-phase-5-operational/dod-verification.md`](specs/006-phase-5-operational/dod-verification.md) — DoD audit + outstanding external items
- [`specs/006-phase-5-operational/research.md`](specs/006-phase-5-operational/research.md) — design rationale (R-1 pg_net trigger choice, R-3 PII scrub patterns, R-5 reconciler design)
- [`specs/006-phase-5-operational/contracts/`](specs/006-phase-5-operational/contracts/) — Teams payload + audit_log shapes + trigger + reconciler + scrubber contracts
- [`docs/runbooks/README.md`](docs/runbooks/README.md) — runbook index (8 entries: 2 kickoff MUST + 6 follow-on)
- [`.ai_project_memory/constitution-backend.md`](.ai_project_memory/constitution-backend.md) — 3 new stack rows: pg_net DB-trigger pattern, PII scrub helper, audit_log enum extension per feature
