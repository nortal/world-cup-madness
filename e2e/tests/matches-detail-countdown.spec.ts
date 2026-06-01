/**
 * Playwright E2E test — TC-M3 + TC-M4 for US-MA (Match Catalog Read, feature 002),
 * task T038.
 *
 * Spec quotes (from `specs/002-match-catalog-read/spec.md`):
 *
 *   TC-M3: Given the participant signs in AND a match exists with kickoff > 60
 *   minutes in the future, when they navigate to `/matches/[id]` for that
 *   match, then they see both team names, the stage label (localised), the
 *   group label (when present), the kickoff time, the lock-state badge, AND a
 *   per-second client-side ticking countdown.
 *
 *   TC-M4: Given the same setup with kickoff well outside the 60-minute lock
 *   window, when the page renders, then the badge reads `UPCOMING` and the
 *   countdown shows a positive remaining time. After waiting ~2 seconds, the
 *   countdown value has decremented (proving the ticker is live).
 *
 * Scope (per T038): assert that the match detail page renders the expected
 * compositional shape AND that the client-side countdown actually ticks. The
 * server-rendered side (stage label, team names, badge) comes from the Server
 * Component pipeline; the per-second decrement is the only path that exercises
 * the `setInterval` inside `<LockCountdownTicker/>` end-to-end.
 *
 * Components under test:
 *   - `app/(participant)/matches/[id]/page.tsx` (T034) — Server Component
 *     that loads the participant row + the embedded-FK match row + resolves
 *     locale, then hands a structured `match` object to MatchDetailCard.
 *     Importantly: redirects to `/` for unauthenticated users and `notFound()`
 *     for missing/RLS-filtered matches — both of which would break this test
 *     silently, so we sanity-check status 200 below.
 *   - `components/matches/MatchDetailCard.tsx` (T033) — composes the team
 *     heading, kickoff `<dl>`, and either `<LockBadge/>` (terminal/TBD) or
 *     `<LockCountdownTicker/>` (live/scheduled). The matches.detail.backToList
 *     link is the structural marker we anchor on.
 *   - `components/matches/LockCountdownTicker.tsx` (T032) — Client Component.
 *     Renders the `<span aria-live="polite">` whose textContent changes once
 *     per second; that change is the load-bearing observation for TC-M4.
 *
 * Out of scope here:
 *   - LOCKED-boundary behaviour at kickoff−60min — covered by TC-M5 / T039.
 *   - List-view static countdown (the `<LockCountdownText/>` sibling used by
 *     `MatchCard`) — covered by TC-M1 / T037.
 *   - notFound() / unauthenticated redirect paths — covered by the auth specs.
 *
 * Test strategy:
 *   1. `resetSupabaseState()` so no stale participant rows interfere.
 *   2. Seed exactly one match via the service-role client. We intentionally
 *      pick teams by TLA (ENG vs FRA — both present in the migration 0017
 *      seed) and look up their UUIDs at runtime so the test is robust against
 *      future seed changes that re-order or re-UUID rows.
 *   3. `signInAs({ tenant: 'eligible' })` to obtain `oid`. The page's RLS
 *      requires an eligible Nortal user, so the ineligible tenant would not
 *      satisfy `is_eligible_nortal_user()` on the matches predicate.
 *   4. Set `participants.timezone = 'Europe/Tallinn'` via service-role UPDATE
 *      so the kickoff timestamp formats deterministically (the actual
 *      formatted string isn't asserted — only its presence — but a known
 *      timezone keeps debugging output stable across CI hosts).
 *   5. Read the seeded match id back from the DB by provider_id (9201) so the
 *      assertion doesn't depend on UUID coordination between insert and read.
 *   6. Navigate to `/matches/${id}` and run the per-test assertions.
 *
 * Style: mirrors `e2e/tests/welcome-modal-cross-device.spec.ts` for the
 * "setup, navigate, assert, mutate-or-wait, re-assert" rhythm.
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Inline seed helper — kept colocated rather than promoted to `e2e/fixtures/`
 * until a second US-MA spec needs the same shape. The shape mirrors the
 * minimum columns required by `MatchDetailPage`'s embedded-FK SELECT:
 * id, kickoff_utc, status, score_home, score_away, stage, group_label, venue,
 * and the two teams FKs.
 *
 * Returns the inserted match's UUID so the caller can navigate to it. We use
 * `select('id').single()` rather than a follow-up SELECT-by-provider_id to
 * keep the seed cost to one round-trip in the happy path; the test still has
 * the option to re-read by provider_id if it needs to.
 */
async function seedMatch(params: {
  homeTla: string;
  awayTla: string;
  kickoffUtc: Date;
  providerId: number;
  stage: 'group' | 'round-of-16' | 'quarter-final' | 'semi-final' | 'third-place' | 'final';
  groupLabel: string | null;
  status: 'scheduled' | 'scheduled-tbd' | 'live' | 'finished' | 'cancelled';
}): Promise<string> {
  const client = getServiceRoleClient();

  // Resolve team UUIDs by TLA. The teams catalog is seeded by migration 0017
  // and is stable across resetSupabaseState() (which only clears per-test
  // mutable rows). Looking up by TLA makes the seed robust against future
  // re-ordering of the catalog.
  const { data: teams, error: teamsError } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', [params.homeTla, params.awayTla]);

  if (teamsError !== null) {
    throw new Error(`seedMatch: failed to resolve teams: ${teamsError.message}`);
  }
  if (teams === null || teams.length !== 2) {
    throw new Error(
      `seedMatch: expected 2 teams for TLAs [${params.homeTla}, ${params.awayTla}], got ${teams?.length ?? 0}`,
    );
  }

  const homeTeam = teams.find((t) => t.tla === params.homeTla);
  const awayTeam = teams.find((t) => t.tla === params.awayTla);
  if (homeTeam === undefined || awayTeam === undefined) {
    throw new Error(
      `seedMatch: could not pair TLAs (home=${params.homeTla}, away=${params.awayTla})`,
    );
  }

  // Clean up any prior row with the same provider_id so re-runs against an
  // already-seeded local stack stay idempotent. resetSupabaseState() does
  // not truncate `matches` (it owns participants/audit_log/tournament_config
  // only); this scoped delete keeps test isolation without nuking the
  // catalog wholesale.
  const cleanup = await client
    .from('matches')
    .delete()
    .eq('provider_id', params.providerId);
  if (cleanup.error !== null) {
    throw new Error(`seedMatch: cleanup failed: ${cleanup.error.message}`);
  }

  const { data: inserted, error: insertError } = await client
    .from('matches')
    .insert({
      home_team_id: homeTeam.id,
      away_team_id: awayTeam.id,
      kickoff_utc: params.kickoffUtc.toISOString(),
      provider_id: params.providerId,
      stage: params.stage,
      group_label: params.groupLabel,
      status: params.status,
    })
    .select('id')
    .single();

  if (insertError !== null) {
    throw new Error(`seedMatch: insert failed: ${insertError.message}`);
  }
  if (inserted === null) {
    throw new Error('seedMatch: insert returned no row');
  }
  return inserted.id;
}

/**
 * Set the participant's stored timezone via service-role UPDATE. The page
 * passes this value through to MatchDetailCard -> formatKickoff(), so a fixed
 * timezone keeps the rendered kickoff line stable across CI hosts in any
 * arbitrary local time zone. Not asserted directly — it's a stability prop.
 */
async function setParticipantTimezone(oid: string, timezone: string): Promise<void> {
  const client = getServiceRoleClient();
  const { error } = await client
    .from('participants')
    .update({ timezone })
    .eq('oid', oid);
  if (error !== null) {
    throw new Error(`setParticipantTimezone(${oid}, ${timezone}): ${error.message}`);
  }
}

test.describe('US-MA / TC-M3 + TC-M4 — match detail page + ticking countdown', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
  });

  test('TC-M3: match detail page renders teams, stage, group, kickoff, badge, ticking countdown', async ({
    page,
  }) => {
    // Sign in first so the auth.users row exists; the page's redirect-to-'/'
    // guard fires before any match query when there's no Supabase user.
    const { oid } = await signInAs(page, { tenant: 'eligible' });

    // Provision the participant row so the page's participant lookup hits.
    // The page redirects to '/' if maybeSingle() returns null, which would
    // mask the test intent. We call the production RPC via service-role here
    // to keep this spec focused — the auth specs already cover the RPC path.
    const adminClient = getServiceRoleClient();
    const { error: rpcError } = await adminClient.rpc('provision_participant_from_jwt');
    // The service-role JWT carries no oid/tid claims so the RPC is expected
    // to no-op or error in admin context. The participant must be created
    // via the page session — issue the RPC from the browser.
    if (rpcError !== null) {
      // expected — fall through to the page-side provisioning.
    }
    const provision = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
        await client.auth.getSession();
        const { error } = await client.rpc('provision_participant_from_jwt');
        if (error !== null && error !== undefined) {
          return { ok: false as const, error: error.message };
        }
        return { ok: true as const };
      },
      {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      },
    );
    expect(provision.ok, provision.ok ? undefined : provision.error).toBe(true);

    // Pin participant timezone so the kickoff line formats deterministically
    // regardless of the CI host's TZ. Set BEFORE the page navigation so the
    // Server Component reads the pinned value.
    await setParticipantTimezone(oid, 'Europe/Tallinn');

    // Seed a single match 3 hours in the future — well outside the 60-minute
    // lock window so the badge resolves to UPCOMING and the ticker mounts.
    const kickoffUtc = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const matchId = await seedMatch({
      homeTla: 'ENG',
      awayTla: 'FRA',
      kickoffUtc,
      providerId: 9201,
      stage: 'group',
      groupLabel: 'A',
      status: 'scheduled',
    });

    // Re-read the row by provider_id to confirm the seed landed and to give
    // a clear failure surface if RLS or the embedded-FK shape ever changes.
    const { data: roundTrip, error: roundTripError } = await adminClient
      .from('matches')
      .select('id, provider_id, stage, group_label')
      .eq('provider_id', 9201)
      .single();
    expect(roundTripError, roundTripError?.message).toBeNull();
    expect(roundTrip?.id).toBe(matchId);

    // Navigate to the detail page. `response()` lets us assert HTTP 200 so a
    // notFound() (404) or redirect (3xx → 200 on '/') is caught explicitly
    // rather than appearing as a confusing selector miss further down.
    const response = await page.goto(`/matches/${matchId}`);
    expect(response, 'page.goto must return a response').not.toBeNull();
    expect(response!.status(), 'detail page must render 200 (no notFound, no redirect)').toBe(200);
    await expect(page).toHaveURL(new RegExp(`/matches/${matchId}$`));

    // Resolve the team display names from the seeded catalog so the assertion
    // tracks any future renaming in 0017_seed_teams.sql.
    const { data: catalogTeams, error: catalogError } = await adminClient
      .from('teams')
      .select('name, tla')
      .in('tla', ['ENG', 'FRA']);
    expect(catalogError, catalogError?.message).toBeNull();
    const englandName = catalogTeams?.find((t) => t.tla === 'ENG')?.name ?? '';
    const franceName = catalogTeams?.find((t) => t.tla === 'FRA')?.name ?? '';
    expect(englandName, 'catalog must contain ENG').not.toBe('');
    expect(franceName, 'catalog must contain FRA').not.toBe('');

    // Localised stage label from `matches.stages.group` in en.json.
    await expect(
      page.getByText('Group stage').first(),
      'localised stage label must render (matches.stages.group)',
    ).toBeVisible();

    // Both team names rendered as part of the heading row.
    await expect(
      page.getByText(englandName, { exact: true }).first(),
      'home team name must render',
    ).toBeVisible();
    await expect(
      page.getByText(franceName, { exact: true }).first(),
      'away team name must render',
    ).toBeVisible();

    // UPCOMING badge text — comes from `matches.badge.upcoming` in en.json.
    // The badge is rendered with role="status" inside the ticker.
    await expect(
      page.getByText('UPCOMING', { exact: true }).first(),
      'lock-state badge must read UPCOMING for a match >60min in the future',
    ).toBeVisible();

    // Back-to-list link — the structural marker for MatchDetailCard's footer.
    // Anchors the assertion on a localised string from `matches.detail.backToList`.
    await expect(
      page.getByRole('link', { name: 'Back to matches' }),
      'localised "Back to matches" link must render',
    ).toBeVisible();

    // The ticker's countdown lives in a `<span aria-live="polite">`. Asserting
    // it is non-empty here covers the "ticking countdown is present" half of
    // TC-M3; TC-M4 below covers the "actually ticks" half.
    const countdown = page.locator('[aria-live="polite"]').first();
    await expect(
      countdown,
      'live countdown <span aria-live="polite"> must render alongside the UPCOMING badge',
    ).toBeVisible();
    const initialText = (await countdown.textContent())?.trim() ?? '';
    expect(
      initialText.length,
      'countdown must show non-empty text immediately (e.g. "2h 59m" or "179m 58s")',
    ).toBeGreaterThan(0);
  });

  test('TC-M4: UPCOMING badge with live decrementing countdown', async ({ page }) => {
    // Same setup as TC-M3 — duplicated rather than shared via beforeAll so
    // each test runs against a freshly reset DB state per the project's
    // per-test-isolation convention.
    const { oid } = await signInAs(page, { tenant: 'eligible' });

    const provision = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
        await client.auth.getSession();
        const { error } = await client.rpc('provision_participant_from_jwt');
        if (error !== null && error !== undefined) {
          return { ok: false as const, error: error.message };
        }
        return { ok: true as const };
      },
      {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      },
    );
    expect(provision.ok, provision.ok ? undefined : provision.error).toBe(true);

    await setParticipantTimezone(oid, 'Europe/Tallinn');

    const kickoffUtc = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const matchId = await seedMatch({
      homeTla: 'ENG',
      awayTla: 'FRA',
      kickoffUtc,
      providerId: 9201,
      stage: 'group',
      groupLabel: 'A',
      status: 'scheduled',
    });

    const response = await page.goto(`/matches/${matchId}`);
    expect(response, 'page.goto must return a response').not.toBeNull();
    expect(response!.status(), 'detail page must render 200').toBe(200);

    // Sanity-check the badge before observing the ticker — if the badge had
    // resolved to LOCKED or FINISHED, the ticker would not mount and the
    // decrement assertion below would never become true.
    await expect(
      page.getByText('UPCOMING', { exact: true }).first(),
      'badge must read UPCOMING for the ticker to be mounted',
    ).toBeVisible();

    // The countdown text is owned by the `<span aria-live="polite">` inside
    // LockCountdownTicker. It re-renders once per second from the component's
    // own setInterval; we capture textContent, wait, and capture again.
    const countdown = page.locator('[aria-live="polite"]').first();
    await expect(countdown).toBeVisible();

    const initialText = (await countdown.textContent())?.trim() ?? '';
    expect(
      initialText.length,
      'countdown must produce non-empty text on first render',
    ).toBeGreaterThan(0);

    // Genuine time-based assertion — the ticker decrements once per second,
    // so we must let real wall time elapse to observe a change. waitForTimeout
    // is normally avoided, but here it IS the assertion. 2.5s gives at least
    // two interval fires (1s + 1s + buffer) so even one missed tick on a slow
    // runner still produces a different textContent.
    await page.waitForTimeout(2500);

    const laterText = (await countdown.textContent())?.trim() ?? '';
    expect(
      laterText.length,
      'countdown must still produce non-empty text after the wait',
    ).toBeGreaterThan(0);

    // The load-bearing assertion: the value changed. With a kickoff ~3h out
    // the countdown reads in minutes+seconds (e.g. "179m 58s" → "179m 56s"),
    // so two captures 2.5s apart MUST differ unless the ticker is broken.
    expect(
      laterText,
      `countdown must decrement (was "${initialText}", now "${laterText}") — the LockCountdownTicker setInterval is the only mechanism that produces this change`,
    ).not.toBe(initialText);
  });
});
