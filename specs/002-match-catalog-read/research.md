# Phase 0 Research — Match Catalog (002)

**Date**: 2026-05-20
**Plan**: [plan.md](./plan.md)
**Status**: All NEEDS CLARIFICATION items resolved.

This document closes the seven unknowns surfaced in plan.md §"Phase 0: Outline & Research". Each section follows the **Decision / Rationale / Alternatives / Source** structure required by the AI-Kit `/ai1st-dev-plan` workflow.

---

## R-1: football-data.org v4 response shape for `/v4/competitions/WC/matches`

**Decision:** Treat the v4 response as a JSON envelope `{ filters, resultSet, competition, matches: Match[] }` where each `Match` has — at minimum — `{ id, utcDate, status, stage, group, homeTeam: { id, name, tla, crest }, awayTeam: { id, name, tla, crest }, venue?, score: { winner, duration, fullTime: { home, away }, halfTime: { home, away } } }`. Status enum: `SCHEDULED` / `TIMED` / `IN_PLAY` / `PAUSED` / `FINISHED` / `SUSPENDED` / `POSTPONED` / `CANCELLED` / `AWARDED`. Normaliser maps these to our 5-value enum per the table below.

| Provider status | Our `matches.status` |
|---|---|
| `SCHEDULED` (no kickoff yet — pre-draw) | `scheduled-tbd` |
| `TIMED` (kickoff known) | `scheduled` |
| `IN_PLAY`, `PAUSED` | `live` |
| `FINISHED`, `AWARDED` | `finished` |
| `SUSPENDED`, `POSTPONED`, `CANCELLED` | `cancelled` |

**Rationale:** This is the publicly-documented v4 envelope (https://docs.football-data.org/general/v4/index.html, `Match Object` section). The competition code `WC` returns all 104 FIFA World Cup matches in a single call. Mapping `IN_PLAY`/`PAUSED` to our `live` keeps the lock-badge derivation simple (anything `live` → `LOCKED`). Mapping `AWARDED` → `finished` covers walkover edge cases. `SUSPENDED`/`POSTPONED`/`CANCELLED` collapse to `cancelled` because — for participant UX — none of them are predictable any more (and the participant likely already submitted before suspension).

**Alternatives considered:**
- *Persist 9 provider statuses 1:1.* Rejected — leaks provider terminology into our schema and forces every UI badge component to handle 9 states. The 5→3 derived-badge mapping is already enough cognitive load.
- *Persist provider status + our derived UI status.* Rejected — two columns to keep in sync, no clear win.

**Source:** Manual — football-data.org v4 documentation page (Match Object section) cross-referenced with the v4 quickstart and OpenAPI spec. The actual sample response is not fetched in this research phase (no API key in local dev yet — FA-M2); Phase 1's `provider/football-data-v4.ts` includes a frozen sample-response JSON in `supabase/functions/sync-matches/__fixtures__/v4-sample.json` to drive both bootstrap-seed and unit tests deterministically.

---

## R-2: IANA timezone picker library choice for `<TimezonePicker/>`

**Decision:** Hand-rolled combobox built from native `<input role="combobox">` + filtered options, populated from a static `lib/matches/iana-timezones.ts` list of ~430 IANA zones generated at build time from the runtime's `Intl.supportedValuesOf('timeZone')` (cached as a generated TS module so the picker doesn't have to call `Intl.supportedValuesOf` per render). Searchable by typing any substring (city name or region).

**Rationale:**
- Bundle cost: zero new dependencies. The IANA list is ~10 KB gzipped as static data; the combobox JSX is ~40 LOC.
- Accessibility: WAI-ARIA Authoring Practices combobox pattern is well-documented; we already implemented a focus-trap pattern in feature 001's `WelcomeModal.tsx` so the team is familiar with the manual ARIA approach.
- Tailwind: native `<input>` + `<ul role="listbox">` styles cleanly with our existing palette.
- No vendor lock-in: if a future version of `react-aria-components` Combobox gets ergonomic enough, we can swap behind the same prop surface.

**Alternatives considered:**
- *`react-timezone-select`* (~14 KB minified gzip). Rejected — pulls in `moment-timezone` transitively (180+ KB), which would dwarf our entire bundle. Also locks our styling into the library's CSS.
- *`react-aria-components` `<ComboBox>`*. Rejected (for now) — adds `react-aria` + `react-aria-components` (~50 KB combined), and its styling needs more wiring than the hand-rolled version. Worth re-evaluating in a polish phase if our combobox grows complex.
- *Native `<select>` with all 430 options*. Rejected — unsearchable, accessibility nightmare for screen readers.
- *Native `<input>` + `<datalist>`*. Rejected — `<datalist>` filtering behaviour varies across browsers, no per-option styling, no keyboard navigation control.

**Source:** Manual — WAI-ARIA combobox pattern, `Intl.supportedValuesOf` MDN reference, bundle-size comparison via bundlephobia for the alternatives.

---

## R-3: Edge Function (Deno) fetch retry pattern with `Retry-After` respect

**Decision:** Use a small hand-rolled retry helper at `supabase/functions/sync-matches/lib/retry.ts` implementing exponential backoff with jitter (start at 1s, double up to 32s, cap at 5 retries) and full `Retry-After` header respect on 429s and `503`s. The helper accepts a fetch function and a max-retries count; returns the final response or throws on exhaustion. No external dependency.

```
attempt 1 → wait 1s on retry → attempt 2 → wait 2s + jitter → ...
if 429 or 503 with Retry-After header → wait that many seconds (overrides backoff schedule)
if 4xx other than 429 → throw immediately (not retryable; treat as integration_runs.status='error')
if 5xx other than 503 → retry per backoff schedule
```

**Rationale:** Football-data.org's documented rate-limit behaviour is to return `429 Too Many Requests` with a `Retry-After` header indicating seconds. The free tier's 10 req/min is small enough that our bootstrap import (1 fetch — all matches in one envelope) and incremental sync (1 fetch) rarely hit the limit unless the cron runs aggressively, but we still need defensive handling. A hand-rolled 30-line helper beats pulling in a retry library for one call-site.

**Alternatives considered:**
- *`@hashintel/p-retry`* and similar libs. Rejected — Deno-compatible variants exist but add a dependency for no real win at this scale.
- *No retry, treat 429/5xx as permanent error.* Rejected — admin re-sync clicks during a momentary provider blip would always fail, polluting `integration_runs` with `error` rows for transient issues that resolve in seconds.
- *Infinite retry with cap.* Rejected — 5-retry ceiling is the right balance; beyond that we genuinely want the operator to know something's wrong via the `error` telemetry row.

**Source:** Manual — football-data.org rate-limit documentation; Deno fetch + headers API reference.

---

## R-4: Postgres advisory lock pattern for Edge Functions

**Decision:** The Edge Function obtains its own Postgres connection via the Supabase service-role JS client and calls `pg_try_advisory_lock(hashtext('match-catalog-sync'))` via a one-shot RPC (`acquire_match_sync_lock()` defined in migration 0015). On `true` return, the function proceeds; on `false`, it short-circuits with `outcome='skipped'`. The lock is **transaction-scoped** if we wrap the entire sync in a transaction, OR we use a **session-scoped** lock and explicitly release with `pg_advisory_unlock` at the end. Decision: session-scoped, explicit release in a `finally` block, with the connection-close fail-safe as the safety net.

**Rationale:** `pg_try_advisory_lock` is non-blocking — it returns `false` immediately if the lock is held — which is exactly the semantics FR-M23 requires. Session-scoped lock means an Edge Function crash (process kill) releases the lock when the connection closes; we don't need a separate cleanup job. The hash key `hashtext('match-catalog-sync')` produces a stable BIGINT lock id; if other features later use advisory locks, they pick different namespace strings.

**Practical wiring:** The Edge Function creates the service-role client, calls the RPC, branches on result. Since the JS client uses connection pooling, we explicitly use a per-invocation connection to ensure the session is genuinely tied to this invocation. (PostgREST default behaviour is to pool connections, which could share the lock across invocations — confirm in Phase 2 implementation via a small smoke test.)

**Alternatives considered:**
- *Transaction-scoped lock (`pg_try_advisory_xact_lock`)* — auto-released at COMMIT/ROLLBACK. Rejected — our sync isn't a single transaction (multiple per-match UPSERTs); wrapping it in one giant transaction would hold the lock far too long and risk PostgREST connection timeouts.
- *`SELECT FOR UPDATE` on a dedicated `sync_locks` table row.* Rejected — adds a table for no semantic benefit over `pg_advisory_lock`.
- *External lock (Redis, etc.)* Rejected — Supabase doesn't provide Redis; adding another service for one feature is overkill.

**Source:** Manual — PostgreSQL `pg_try_advisory_lock` documentation; Supabase Edge Function service-role client patterns.

---

## R-5: Next.js App Router 15 `revalidate: 60` semantics with Supabase reads

**Decision:** Use page-level `export const revalidate = 60` on `/matches/page.tsx`, `/matches/[id]/page.tsx`, and the dashboard route. **Do not** wrap the Supabase query in `unstable_cache` — by default, the page-level `revalidate` opts the entire route into ISR-style caching, and the Supabase fetch inside a Server Component participates automatically.

**Rationale:** In Next.js App Router 15, a page-level `revalidate` export converts the route from dynamic to ISR. Server Components within that route render against the cached output for up to `revalidate` seconds; on the first request after the window expires, the next render re-runs the data fetch in the background while still serving the stale page. Supabase reads via `@supabase/ssr` are fetch-based under the hood and respect the route's revalidate setting without additional configuration.

The badge is recomputed per render (not cached) because `lock-badge.ts` reads `Date.now()` server-side at render time. The cache holds the row data; the badge derivation runs fresh.

**Practical caveats verified:**
- `cookies()` in a Server Component normally forces dynamic rendering. Our match-list pages don't call `cookies()` directly (they read the participant via `createClient()` → `supabase.auth.getUser()`, which DOES touch cookies). To avoid the dynamic-override, we read the participant's `timezone` once per request via the standard server client, then pass it as an arg to the data-fetch helper — the cache key naturally includes the timezone, so we get one cached variant per (participant_tz, day) tuple. Cache pressure is bounded: ~400 IANA zones × ~10 active days = ~4000 cached variants, all small.
- Alternative: use `unstable_cache` explicitly with `[participant_tz, day_window]` as the cache key. This is the fallback if the implicit `revalidate` doesn't pick up the supabase reads as expected.

**Alternatives considered:**
- *No caching, every request is dynamic.* Rejected — fails NFR-M6 (Supabase blip = error page).
- *`force-cache` with `revalidate: 3600`.* Rejected — admin re-sync invisible for up to an hour, doesn't match Q5/Option-A staleness budget.
- *Client-side cache (SWR/TanStack Query).* Rejected — moves data fetching off the server, defeats our "Server Components by default" constitution rule + breaks the SSR-first lock-state contract.

**Source:** Manual — Next.js 15 App Router caching documentation; @supabase/ssr SSR caching patterns.

---

## R-6: Day-bucket label formatting with `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat` in en/es/pt-BR

**Decision:** Use `Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', timeZone: participant_tz })` for the explicit-weekday case ("Saturday, June 13" in en; "sábado, 13 de junio" in es; "sábado, 13 de junho" in pt-BR). For the adjacent-three-days case ("Today" / "Tomorrow" / "Yesterday"), use a **localised string lookup keyed by ICU day-offset** rather than `Intl.RelativeTimeFormat` — RelativeTimeFormat produces "in 1 day" / "1 day ago" style strings which read awkwardly as section headers ("Em 1 dia" / "Hace 1 día" are correct grammar but don't match our UI register). Add three translation keys: `matches.today`, `matches.tomorrow`, `matches.yesterday` to each locale namespace.

**Rationale:** The "Today"/"Tomorrow"/"Yesterday" labels are *day-bucket headers*, not relative-time descriptions. UX research consistently shows direct labels ("Today", "Hoy", "Hoje") read more naturally as headers than RTF output. The three keys per locale are trivial to add, and we get full control over the wording (matters for Spanish — "Hoy" vs "Hoy es..." matter UX-wise).

**DST gotchas:** A match whose `kickoff_utc` straddles a DST boundary still day-buckets correctly because `Intl.DateTimeFormat` with `timeZone` set handles DST internally. Specifically: a kickoff of `2026-10-25T01:30:00Z` (the night Europe falls back from CEST to CET) renders correctly in either `Europe/Tallinn` (no DST in 2026 if Estonia stays on EET year-round per the EU directive — pending; the IANA db is authoritative either way) or `Europe/Madrid` (which still observes DST).

**Pure-function shape** for `lib/matches/day-bucket.ts`:

```
(kickoffUtc: Date, participantTz: string, locale: 'en'|'es'|'pt-BR', now: Date)
  → { bucketKey: 'YYYY-MM-DD-in-tz', bucketLabel: string, offsetFromToday: number }
```

`bucketKey` is the ISO date in participant TZ — used for grouping (so two matches on the same local day cluster regardless of UTC date). `bucketLabel` is the localised display string. `offsetFromToday` is `-1` / `0` / `+1` / `±N` for the three special-case days vs explicit-weekday case.

**Alternatives considered:**
- *`Intl.RelativeTimeFormat`*. Rejected — produces "in 1 day" style; awkward as header.
- *Hand-format dates without Intl*. Rejected — would have to hand-implement locale tables for weekday + month names; Intl already does this correctly across browsers + Node.
- *Day-bucket by UTC date (cheaper but participant-confusing)*. Rejected per Q11-A decision — participant TZ wins.

**Source:** Manual — `Intl.DateTimeFormat` and `Intl.RelativeTimeFormat` MDN references; common-sense UX precedent (calendar apps universally use "Today"/"Tomorrow" as headers, not "in 0 days").

---

## R-7: Concurrent sync from cron + admin click — telemetry distinction

**Decision:** The `integration_runs.action` column carries the trigger source: `'bootstrap'` (first-time import during deploy / manual setup), `'incremental-sync'` (scheduled cron — Phase 5), `'manual-resync'` (admin clicks the re-sync action). When the advisory lock blocks a caller and we write a `'skipped'` row, the `action` column still records the would-have-been action (so operators can see "cron tried but admin was already running"). The `error_message` field on a `'skipped'` row holds the ISO timestamp of the in-flight run's `started_at` for triage.

**Operational scenario coverage:**
1. *Cold start, admin runs bootstrap*: `action='bootstrap'`, no contention. `integration_runs` row with `status='success'`.
2. *Cron runs solo during tournament*: `action='incremental-sync'`, no contention. `status='success'`.
3. *Admin clicks re-sync while cron is mid-flight*: cron holds lock → admin call returns 200 with `outcome='skipped'`, `integration_runs` row with `action='manual-resync'`, `status='skipped'`, `error_message='blocked by run started at 2026-06-15T13:00:00Z'`.
4. *Two admins click within seconds*: first holds lock → second short-circuits the same way (action='manual-resync', status='skipped').
5. *Provider returns 503 mid-fetch*: Edge Function retries per R-3's exponential backoff. If all retries fail, the lock-holding caller releases the lock and writes `status='error'` with the provider's error body.
6. *Edge Function crashes*: Session-scoped advisory lock auto-releases on connection close (R-4 fail-safe); next caller succeeds.

**Rationale:** The `action` × `status` matrix gives operators a complete picture without query gymnastics. Scenario 3 in particular ("operator wonders why their re-sync didn't refresh") is one query away: `SELECT * FROM integration_runs WHERE action='manual-resync' AND status='skipped' ORDER BY started_at DESC LIMIT 10`.

**Alternatives considered:**
- *Single `action` value `'sync'` regardless of trigger.* Rejected — loses the cron-vs-admin distinction that operators care about during incidents.
- *Separate `trigger_source` column.* Rejected — `action` carries that semantically already; adding a parallel column duplicates information.
- *Skip telemetry for blocked calls.* Rejected — silent skips make "why didn't my re-sync work?" debugging impossible.

**Source:** Manual — derived from the FR-M19 + FR-M23 contract in spec.md; informed by common patterns in audit log / job queue telemetry.

---

## Summary

| R-N | Status | Touches |
|---|---|---|
| R-1 | Resolved | data-model.md (status enum), contracts/ (provider response shape) |
| R-2 | Resolved | plan.md component tree (TimezonePicker is hand-rolled), constitution-frontend.md (no new dep) |
| R-3 | Resolved | Edge Function `lib/retry.ts` design |
| R-4 | Resolved | data-model.md (acquire_match_sync_lock RPC), Edge Function structure |
| R-5 | Resolved | Server Component `revalidate` exports; cache-key design |
| R-6 | Resolved | `lib/matches/day-bucket.ts` shape, i18n namespace adds 3 keys |
| R-7 | Resolved | data-model.md (integration_runs.action enum), Edge Function telemetry write logic |

**No NEEDS CLARIFICATION items remain.** Ready for Phase 1 (data-model.md, contracts/, quickstart.md).
