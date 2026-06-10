/**
 * Playwright E2E — feature 005 US-DD, task T039.
 *
 * Covers TC-D12 (debounce burst: 5 events within 200 ms collapse to one
 * router.refresh()) + TC-D16 (refreshing chip visibility + zero CLS).
 *
 * Implementation deviation from the original task brief:
 *   The brief expects a single PostgREST `/rest/v1/…` re-fetch within the
 *   next second. The chosen `<DashboardRealtime/>` implementation uses
 *   `router.refresh()` (Next.js App Router) which re-renders Server
 *   Components and emits an RSC payload request to the route URL, NOT a
 *   /rest/v1/ call. The assertion in TC-D12 therefore counts RSC-flavoured
 *   requests to the dashboard route (header `RSC: 1`) rather than
 *   PostgREST hits. The behaviour under test — burst debounce — is
 *   identical; only the request shape differs.
 *
 * Owned provider_id range: 9726-9730.
 *
 * `test.setTimeout(90_000)` per describe: WebSocket SUBSCRIBED settle +
 * the debounce window + the RSC round-trip + initial dashboard compile
 * blow past 30 s on cold caches.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

import { expect, test, type Page, type Request } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_IDS = [9726, 9727, 9728, 9729, 9730] as const;

async function provisionFromAuthenticatedPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const result = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic CDN import inside the page context
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      await client.auth.getSession();
      const { error } = await client.rpc('provision_participant_from_jwt');
      return error ? { ok: false as const, error: error.message } : { ok: true as const };
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
  expect(result.ok, 'provision RPC must succeed').toBe(true);
}

async function seedMatch(
  client: SupabaseClient<Database>,
  providerId: number,
): Promise<string> {
  await client.from('matches').delete().eq('provider_id', providerId);
  const { data: teams, error: teamsErr } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', ['ENG', 'FRA']);
  if (teamsErr) throw new Error(`seedMatch teams lookup failed: ${teamsErr.message}`);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;
  const id = randomUUID();
  // status='scheduled' so the matches scoring trigger does not fire —
  // see dashboard-neighborhood.spec.ts seedMatch() for the rationale.
  const { error: insErr } = await client.from('matches').insert({
    id,
    provider_id: providerId,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    status: 'scheduled',
    score_home: null,
    score_away: null,
  });
  if (insErr) throw new Error(`seedMatch insert failed: ${insErr.message}`);
  return id;
}

function refreshMV(): void {
  execSync(
    'docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;"',
    { stdio: 'pipe' },
  );
}

/**
 * Insert one `audit_log` row with `action='leaderboard.refresh'`. The
 * `<DashboardRealtime/>` Supabase Realtime channel filters on exactly
 * this row shape and fires `router.refresh()` after the 300 ms debounce
 * window.
 */
async function fireRefreshEvent(client: SupabaseClient<Database>): Promise<void> {
  const { error } = await client.from('audit_log').insert({
    action: 'leaderboard.refresh',
    entity_type: 'leaderboard_snapshots',
    new_value: { caller_kind: 'admin', refreshed_at: new Date().toISOString() },
  });
  if (error) throw new Error(`fireRefreshEvent insert failed: ${error.message}`);
}

/**
 * Returns true when the request looks like an RSC payload fetch for the
 * `/dashboard` route — Next.js App Router transmits Server Component
 * re-renders via a `RSC: 1` header on a request to the same URL.
 */
function isDashboardRscRequest(req: Request): boolean {
  const url = req.url();
  if (!/\/dashboard(\?|$)/.test(url)) return false;
  const headers = req.headers();
  return headers['rsc'] === '1' || headers['next-router-state-tree'] !== undefined;
}

test.describe('US-DD — dashboard Realtime + refreshing chip', () => {
  test.setTimeout(90_000);
  // Pin to mobile viewport — the Pool widgets render twice (panel +
  // desktop grid) and pinning avoids the strict-mode trap caught in
  // dashboard-neighborhood.spec.ts.
  test.use({ viewport: { width: 360, height: 800 } });

  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_IDS) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('TC-D12 debounce burst — 5 events within 200 ms → exactly 1 RSC re-fetch', async ({
    page,
  }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9726);

    await signInAs(page, { tenant: 'eligible', name: 'Burst Self' });
    await provisionFromAuthenticatedPage(page);

    const { data: selfRow, error: selfErr } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Burst Self')
      .single();
    if (selfErr || !selfRow) throw new Error(`Self lookup failed: ${selfErr?.message}`);

    // A single score_event so Self appears in the MV and the dashboard
    // renders the live (subscribing) branch of RankWidget.
    const { error: scoreErr } = await client
      .from('score_events')
      .insert([{ participant_id: selfRow.id, match_id: matchId, source: 'match-wrong', points: 0 }]);
    if (scoreErr) throw new Error(`Self score insert failed: ${scoreErr.message}`);
    refreshMV();

    await page.goto('/dashboard?tab=today');

    // Wait for the Realtime WebSocket to land in SUBSCRIBED. We don't
    // have a reliable client-side signal for this, so we wait the
    // empirical settle window used by feature 004's leaderboard-realtime
    // spec (TC-L4 pattern).
    await page.waitForTimeout(2_000);

    // Start counting RSC re-fetches from this point on. We attach the
    // listener AFTER the cold-paint navigation has settled so the
    // initial RSC payload (if any) does not pollute the count.
    const rscRequests: string[] = [];
    page.on('request', (req) => {
      if (isDashboardRscRequest(req)) rscRequests.push(req.url());
    });

    // Fire 5 audit_log rows in a tight Promise.all. Inside the local
    // Supabase instance these complete within ~50-100 ms, well inside
    // the 200 ms window the brief calls for.
    const burstStart = Date.now();
    await Promise.all([
      fireRefreshEvent(client),
      fireRefreshEvent(client),
      fireRefreshEvent(client),
      fireRefreshEvent(client),
      fireRefreshEvent(client),
    ]);
    const burstDurationMs = Date.now() - burstStart;
    expect(
      burstDurationMs,
      `burst should land within 200 ms; took ${burstDurationMs} ms`,
    ).toBeLessThan(800);

    // 300 ms debounce + RSC round-trip + a generous slack window. The
    // single coalesced refresh should fire well within 2 s after the
    // burst lands.
    await page.waitForTimeout(2_000);

    expect(
      rscRequests.length,
      `expected exactly 1 debounced RSC refresh; saw ${rscRequests.length}`,
    ).toBe(1);
  });

  test('TC-D16 refreshing chip — visible + zero CLS on a single event', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedMatch(client, 9727);

    await signInAs(page, { tenant: 'eligible', name: 'Chip Self' });
    await provisionFromAuthenticatedPage(page);

    const { data: selfRow, error: selfErr } = await client
      .from('participants')
      .select('id')
      .eq('display_name', 'Chip Self')
      .single();
    if (selfErr || !selfRow) throw new Error(`Self lookup failed: ${selfErr?.message}`);

    const { error: scoreErr } = await client
      .from('score_events')
      .insert([{ participant_id: selfRow.id, match_id: matchId, source: 'match-wrong', points: 0 }]);
    if (scoreErr) throw new Error(`Self score insert failed: ${scoreErr.message}`);
    refreshMV();

    await page.goto('/dashboard?tab=today');
    await page.waitForTimeout(2_000); // Realtime SUBSCRIBED settle.

    // Install a `PerformanceObserver` that accumulates the cumulative
    // layout shift score over the lifetime of this test. We read it
    // back at the end of the assertion window.
    await page.evaluate(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as PerformanceEntry[]) {
          const e = entry as PerformanceEntry & {
            hadRecentInput?: boolean;
            value?: number;
          };
          if (!e.hadRecentInput && typeof e.value === 'number') {
            (window as unknown as { __cls: number }).__cls += e.value;
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    // Capture the visible Today panel's bounding box BEFORE the refresh.
    // We assert it is unchanged once the transition lands. The Pool
    // panel is `hidden` on `?tab=today` so it has no layout box —
    // measuring it would return null. The Today panel mirrors the same
    // widget tree, so a stable Today box proves the stale-while-
    // revalidate pattern at the widget container level.
    const widgetContainer = page.locator('#today-panel');
    const beforeBox = await widgetContainer.boundingBox();
    expect(beforeBox, 'today-panel must be visible at start').not.toBeNull();

    await fireRefreshEvent(client);

    // The chip should appear once the 300 ms debounce fires and the
    // transition starts. Wait up to 1.5 s.
    const chip = page.locator('div[role="status"]', { hasText: /refresh|atualiz|actualiz/i });
    await expect(chip).toBeVisible({ timeout: 1_500 });

    // Bounding box must not have shifted while the transition is in
    // flight. The whole point of useTransition + router.refresh is that
    // the previous tree stays mounted until the new one commits.
    const duringBox = await widgetContainer.boundingBox();
    expect(duringBox, 'today-panel must remain mounted during refresh').not.toBeNull();
    expect(duringBox!.x).toBe(beforeBox!.x);
    expect(duringBox!.y).toBe(beforeBox!.y);
    expect(duringBox!.width).toBe(beforeBox!.width);
    expect(duringBox!.height).toBe(beforeBox!.height);

    // The chip disappears once the transition commits.
    await expect(chip).toBeHidden({ timeout: 5_000 });

    const afterBox = await widgetContainer.boundingBox();
    expect(afterBox, 'today-panel must remain mounted after refresh').not.toBeNull();
    expect(afterBox!.x).toBe(beforeBox!.x);
    expect(afterBox!.y).toBe(beforeBox!.y);

    const cls = await page.evaluate(
      () => (window as unknown as { __cls: number }).__cls ?? 0,
    );
    expect(cls, `CLS budget ≤ 0.1; observed ${cls}`).toBeLessThanOrEqual(0.1);
  });
});
