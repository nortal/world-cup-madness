# Quickstart — Feature 005 Dashboard Polish + Mobile UX

**Branch**: `005-phase-4-dashboard`
**Audience**: Developers + reviewers running the dashboard locally and smoke-testing each test case.

---

## 1. Prerequisites

- Node.js 20+
- Docker (Colima on macOS) + Supabase CLI
- Local Supabase stack running:
  ```bash
  cd project-repos/world-cup-madness
  npx supabase start -x vector   # vector container fails on Colima — exclude it
  npx supabase db reset
  ```
- Dev server (use prod build for stable Playwright runs — see feature 004 finding):
  ```bash
  npm run build
  npm start
  ```

## 2. Smoke test recipes by TC

Each recipe assumes the local stack is up + the dev/prod server is listening on `http://127.0.0.1:3000`.

### TC-D1 — Mobile tab navigation

1. Sign in as a participant via the existing JWT-injection helper (`e2e/fixtures/auth.ts`).
2. Set viewport to 360 × 640: `await page.setViewportSize({ width: 360, height: 640 });`.
3. `await page.goto('/dashboard');`
4. Assert: Today tab is `aria-selected="true"`; three stacked widgets visible (Upcoming, Rank, Snapshot).
5. Click the Pool tab. Assert URL contains `?tab=pool`; three different widgets render (Neighborhood, Movers, Digest).

### TC-D2 — Desktop responsive grid

1. Set viewport to 1024 × 768.
2. `await page.goto('/dashboard');`
3. Assert: no `[role="tablist"]` present; all six widgets visible simultaneously.

### TC-D3 — Inline quick-edit expand

1. Sign in + seed an upcoming match > 60 min from now.
2. `await page.goto('/dashboard');`
3. Click the Upcoming match widget header. Assert `aria-expanded="true"`; score inputs visible inline.
4. Type scores → click Save → assert toast confirms; widget collapses.

### TC-D4 — Sticky lock-countdown badge

1. Seed an upcoming match ~70 min from now.
2. Open `/dashboard`, expand the upcoming widget.
3. Assert: badge with `role="status"` is visible at the top of the expanded card; badge text updates within 1 s of waiting.

### TC-D5 — Lock-boundary inline save

1. Seed an upcoming match exactly 60 min from now (use Supabase admin to backdate by adjusting `kickoff_utc = NOW() + INTERVAL '60 minutes'`).
2. Open `/dashboard`, expand the widget, type valid scores, click Save.
3. Assert: `errorLocked` message rendered; badge transitions to "Locked"; no toast.

### TC-D6 / TC-D7 / TC-D8 — Neighborhood clamping

1. Seed ≥ 11 participants with distinct ranks via the service-role client.
2. Sign in as the relevant participant (rank 2 for TC-D6, rank 50 for TC-D7, rank N for TC-D8).
3. `await page.goto('/dashboard?tab=pool');`
4. Assert the neighborhood widget renders the expected rank range; self row has `data-self="true"`.

### TC-D9 — Biggest movers (both sections)

1. Seed initial scoring so the leaderboard has stable rankings; refresh MV.
2. Wait a moment, then fire additional score_events for some participants to create rank movements.
3. Refresh MV.
4. `await page.goto('/dashboard?tab=pool');`
5. Assert: "Top 3 in pool" sub-section shows the global top 3 climbers; "Top 3 near you" shows the neighborhood top 3.

### TC-D10 — Weekly digest

1. Seed score_events across the current calendar week (some Mon, some Wed, some Sat) for the signed-in participant.
2. `await page.goto('/dashboard?tab=pool');`
3. Assert: total points = sum; match count = N; best = max single-event points; worst = min single-event points.

### TC-D11 — Pre-tournament placeholders

1. Truncate `score_events` (defensive wholesale-clear pattern from feature 003 May 2026 fix).
2. Seed one future upcoming match.
3. Sign in + `await page.goto('/dashboard');`
4. Assert Today tab: Upcoming/Rank/Snapshot render their existing pre-tournament empty states.
5. Switch to Pool tab. Assert all three widgets render the "Awaiting the first match" placeholder.

### TC-D12 — Realtime debounce burst

1. Open `/dashboard`; wait 2 s for channel SUBSCRIBED.
2. Fire 5 `audit_log` inserts within 200 ms via the service-role client (`action='leaderboard.refresh'`).
3. Capture network requests via `page.on('request')`.
4. Assert: exactly ONE PostgREST `/rest/v1/leaderboard_snapshots*` fetch fires (not 5).

### TC-D13 — Performance budget

1. Seed a 200-participant + 20-finished-match dataset.
2. Run `npx lighthouse http://127.0.0.1:3000/dashboard --emulated-form-factor=mobile --throttling-method=simulate`.
3. Assert: LCP ≤ 2.5 s; server-render p95 ≤ 1 s (capture via `performance.timing.responseEnd - requestStart`).

### TC-D14 — Accessibility (axe-core sweep)

1. Open `/dashboard` on mobile viewport. Run axe-core via `@axe-core/playwright`.
2. Assert zero violations at WCAG 2.0/2.1 A + AA.
3. Repeat for desktop viewport.
4. Repeat with `?tab=pool`.

### TC-D15 — i18n parity

1. Set `NEXT_LOCALE` cookie to `es`. `await page.goto('/dashboard');`. Assert no hardcoded English visible.
2. Repeat for `pt-BR`.

### TC-D16 — Refreshing chip during re-fetch

1. Open `/dashboard`; wait for channel SUBSCRIBED.
2. Fire one `audit_log` `leaderboard.refresh` insert.
3. Assert: within 300 ms, a chip with `role="status"` appears in the page header.
4. Assert: chip disappears once the widget data updates (within ~500 ms total).
5. Measure CLS via `PerformanceObserver`. Assert CLS ≤ 0.1.

### TC-D17 — Inline edit out-of-range error

1. Open `/dashboard`, expand the upcoming match widget.
2. Type `99` in the home-score input. Click Save.
3. Assert: `errorOutOfRange` message visible inside the card; card stays expanded.

---

## 3. Local dev commands

```bash
# Run dashboard widget unit tests
npm test -- --testPathPatterns='lib/dashboard'

# Run dashboard Playwright specs
npx playwright test e2e/tests/dashboard-*.spec.ts --project=chromium --reporter=list

# Force a leaderboard refresh manually (admin path)
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "SELECT refresh_leaderboard();"

# Inspect cron-tick state (feature 004 — verify the schedule fires)
docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "SELECT jobname, schedule FROM cron.job WHERE jobname='leaderboard-refresh-tick';"

# Type-check + lint
npx tsc --noEmit
npm run lint
```

## 4. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard always shows pre-tournament placeholders | `is_pre_tournament()` RPC returning true → `score_events` globally empty | Seed at least one `score_events` row via service-role |
| Today tab shows nothing in Snapshot "next" card | No upcoming match in DB | Seed a future match (`status='scheduled'`, `kickoff_utc > NOW()`) |
| Refreshing chip never appears on scoring event | Realtime channel didn't subscribe before the event fired | Add `await page.waitForTimeout(2000)` after `goto` (matches feature 004 fix) |
| Mobile tabs not visible on 360 px viewport | Tailwind didn't pick up `block md:hidden` — likely a build-cache issue | `rm -rf .next && npm run build` |
| Inline save returns `errorLocked` immediately | Match is within 60 min of kickoff | Seed a match further out (test boundary at exactly −60 min for TC-D5) |
| Global movers widget always empty | Migration `0038_movers_24h_rpc.sql` not applied (Option A) OR scope reduced to Option B | Check `data-model.md §2.5` ratification; apply migration if Option A chosen |

---

## 5. Cross-references

- Spec: [spec.md](./spec.md)
- Plan: [plan.md](./plan.md)
- Research: [research.md](./research.md)
- Data model: [data-model.md](./data-model.md)
- Contracts: [contracts/README.md](./contracts/README.md)
- Feature 004 leaderboard quickstart: `specs/004-leaderboard/quickstart.md` (Realtime + MV patterns reused)
- Feature 003 predictions quickstart: `specs/003-predictions-and-scoring/quickstart.md` (`lock_prediction` RPC reused)
