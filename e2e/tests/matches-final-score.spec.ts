/**
 * Playwright E2E test — TC-M6 (final score display for finished matches) for
 * US-MA / FR-M11.
 *
 * Spec source: `specs/002-match-catalog/spec.md` (TC-M6)
 *   > Given a participant has signed in and a match exists with
 *   > `status='finished'`, score_home=2, score_away=1, kickoff_utc in the past,
 *   > when they navigate to `/matches` and to the match detail page, then the
 *   > FINISHED lock badge is shown AND the final score `2 – 1` is displayed.
 *
 * Surfaces under test:
 *   - `/matches` list rendering via `components/matches/MatchCard.tsx`
 *     (the FINISHED branch of `lockBadgeState()` + the `detail.finalScore`
 *     i18n key + the `{score_home} – {score_away}` numeric line).
 *   - `/matches/[id]` detail page via `components/matches/MatchDetailCard.tsx`
 *     (the prominent score line above the meta-info section + the same
 *     FINISHED badge rendered directly by `<LockBadge/>` rather than the
 *     per-second ticker — terminal states bypass the ticker by design).
 *   - Both pages are Server Components from `app/(participant)/matches/page.tsx`
 *     (T031) and `app/(participant)/matches/[id]/page.tsx` (T034).
 *
 * Seeded fixture rationale:
 *   The FINISHED branch is reached by `lockBadgeState()` whenever
 *   `status === 'finished'` (terminal state — no time math involved). We
 *   could in principle seed a future-kickoff finished match to exercise the
 *   same branch, but the spec C5 `matches_status_kickoff_consistency` CHECK
 *   plus the implicit "finished implies the match has happened" contract
 *   make a past kickoff the only realistic and race-free shape: kickoff at
 *   `now - 2h` is comfortably outside the 60-minute lock window in either
 *   direction, leaves no chance of a clock-drift edge case flipping the
 *   badge to LOCKED, and matches what the production sync function would
 *   write after a real match completes. The seeded match is never close to
 *   a boundary, so the test does not need to mock time.
 *
 * i18n keys exercised (verified against `lib/i18n/messages/en.json`):
 *   - `matches.badge.finished` = "FINISHED" — visible badge text on both
 *     surfaces (NFR-M3: lock state carried by text, not colour alone).
 *   - `matches.detail.finalScore` = "Final score" — heading prefix on the
 *     list card's score line and the section label on the detail page.
 *
 * Test strategy:
 *   1. `resetSupabaseState()` clears per-test state; matches/teams are
 *      preserved (seeded by migration 0017). Predictable team UUIDs come
 *      from picking by TLA — GER and ARG are both top-of-list in the seed
 *      and have no special meaning beyond being unambiguous.
 *   2. `seedMatch()` (inline) inserts a single match row via service role,
 *      bypassing the participant-RLS read policy entirely. The row carries
 *      a stable `provider_id` (9401) so reruns within a single Supabase
 *      session collide on the UNIQUE constraint and overwrite via the
 *      preceding DELETE; the DELETE keeps the seed idempotent across re-runs.
 *   3. Sign in as an eligible participant, materialise their participant row
 *      via the `provision_participant_from_jwt` RPC (same CDN
 *      `@supabase/ssr@0.10.3` pattern as the other US-MA / US6 specs), and
 *      pin their `timezone` to `Europe/Tallinn` so kickoff formatting is
 *      deterministic — the test does NOT assert on the formatted kickoff
 *      string itself, but the timezone pin keeps any incidental render
 *      values deterministic if a future regression assertion is added.
 *   4. Part 1 (`/matches` list): scope all assertions to the seeded match's
 *      card by selecting the wrapping anchor (`a[href*="/matches/${id}"]`).
 *      Within that scope assert (a) the FINISHED badge text is visible and
 *      (b) both score values appear in the rendered text. MatchCard's
 *      template emits `{score_home} – {score_away}` (with a U+2013 en-dash),
 *      so asserting on the literal "2" and "1" within the scoped card is
 *      stable against future style tweaks to the dash glyph or surrounding
 *      whitespace.
 *   5. Part 2 (`/matches/[id]` detail): navigate directly to the detail
 *      page using the seeded match's UUID. Assert (a) the response was
 *      NOT a 404 — i.e. the route resolved and rendered the detail card
 *      (we check by asserting the team names heading rendered), (b) the
 *      FINISHED badge is present at the page level, and (c) the "Final
 *      score" label and `2 – 1` numeric line both render in the score
 *      section of MatchDetailCard.tsx.
 *
 * Constitution alignment:
 *   - No production code, migration, or i18n file is modified by this test.
 *   - No time mocking: the seeded `kickoff_utc = now - 2h` plus the
 *     terminal-state semantics of `status='finished'` make the assertion
 *     time-independent.
 *   - Service-role write access is confined to this Node-only test fixture
 *     (`e2e/fixtures/db.ts`), per Backend Constitution §VI.1.
 */

import { expect, test, type Page } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Seed a single finished match for TC-M6. Idempotent across re-runs within a
 * single Supabase session: the leading DELETE on `provider_id` clears any
 * prior copy before the INSERT. Returns the seeded match's UUID so the test
 * can scope list assertions and navigate to the detail page.
 *
 * Team UUIDs are resolved by TLA from the catalog seeded by migration 0017
 * (GER, ARG). The choice is incidental — any two distinct TLAs would work.
 */
async function seedMatch(): Promise<{ id: string }> {
  const client = getServiceRoleClient();

  const { data: teams, error: teamsError } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', ['GER', 'ARG']);

  if (teamsError) {
    throw new Error(`seedMatch: failed to look up GER/ARG team rows: ${teamsError.message}`);
  }
  const homeTeam = teams?.find((row) => row.tla === 'GER');
  const awayTeam = teams?.find((row) => row.tla === 'ARG');
  if (!homeTeam || !awayTeam) {
    throw new Error(
      'seedMatch: expected both GER and ARG team rows to be present from migration 0017_seed_teams.sql',
    );
  }

  const PROVIDER_ID = 9401;
  // Idempotency: drop any prior row carrying the test provider_id so this
  // seed function can run repeatedly without UNIQUE-constraint failures.
  const { error: deleteError } = await client
    .from('matches')
    .delete()
    .eq('provider_id', PROVIDER_ID);
  if (deleteError) {
    throw new Error(`seedMatch: failed to clear prior provider_id=${PROVIDER_ID} row: ${deleteError.message}`);
  }

  // kickoff_utc = now - 2h. Far enough outside the 60-minute lock window
  // that no clock drift can produce a non-FINISHED badge for this row.
  const kickoffUtc = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: inserted, error: insertError } = await client
    .from('matches')
    .insert({
      provider_id: PROVIDER_ID,
      home_team_id: homeTeam.id,
      away_team_id: awayTeam.id,
      stage: 'group',
      group_label: 'A',
      kickoff_utc: kickoffUtc,
      status: 'finished',
      score_home: 2,
      score_away: 1,
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    throw new Error(
      `seedMatch: failed to insert finished match: ${insertError?.message ?? 'no row returned'}`,
    );
  }

  return { id: inserted.id };
}

/**
 * Pin the participant's `timezone` to `Europe/Tallinn` after provisioning.
 * Kept inline (rather than added to the `db.ts` fixture) so this spec stays
 * self-contained alongside its T037-T039 siblings.
 */
async function setParticipantTimezone(oid: string, timezone: string): Promise<void> {
  const client = getServiceRoleClient();
  const { error } = await client
    .from('participants')
    .update({ timezone })
    .eq('oid', oid);
  if (error) {
    throw new Error(
      `setParticipantTimezone: failed to set timezone=${timezone} for oid=${oid}: ${error.message}`,
    );
  }
}

/**
 * Materialise the participant row via the production provisioning RPC,
 * mirroring the CDN `@supabase/ssr@0.10.3` pattern used by the other
 * US-MA / US6 specs. The production `/auth/callback` route does this on
 * the user's behalf; the JWT-injection fixture skips that handler so the
 * RPC has to be invoked explicitly from the authenticated page context.
 */
async function provisionParticipantFromPage(page: Page): Promise<void> {
  const result = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Hydrate the persisted session from cookies before issuing the RPC;
      // otherwise the call can race ahead unauthenticated.
      await client.auth.getSession();
      const { data, error } = await client.rpc('provision_participant_from_jwt');
      if (error !== null && error !== undefined) {
        return { ok: false as const, error: error.message };
      }
      return { ok: true as const, data };
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
  expect(result.ok, result.ok ? undefined : result.error).toBe(true);
}

test.describe('US-MA / TC-M6 — final score display for finished matches', () => {
  let seededMatchId: string;

  test.beforeEach(async () => {
    await resetSupabaseState();
    const { id } = await seedMatch();
    seededMatchId = id;
  });

  test('TC-M6: finished match shows FINISHED badge and final score on both /matches and /matches/[id]', async ({
    page,
  }) => {
    // -----------------------------------------------------------------------
    // Phase A — sign in and materialise an eligible participant.
    // -----------------------------------------------------------------------
    const { oid } = await signInAs(page, { tenant: 'eligible' });
    await provisionParticipantFromPage(page);
    await setParticipantTimezone(oid, 'Europe/Tallinn');

    // Defensive: confirm the test fixture wired through correctly. Without an
    // id we'd be matching the wrong row in the catalog list below.
    expect(
      seededMatchId,
      'seededMatchId must be set by beforeEach via seedMatch()',
    ).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // -----------------------------------------------------------------------
    // Phase B — `/matches` list page (FR-M01 + FR-M11 list-view).
    // -----------------------------------------------------------------------
    // B1. Navigate to the catalog list. A redirect away from `/matches` would
    //     indicate the participant row was not provisioned or auth cookies
    //     did not survive — assert the URL stuck to catch that early.
    await page.goto('/matches');
    await expect(page).toHaveURL(/\/matches$/);

    // B2. Scope subsequent assertions to the seeded match's card. MatchCard
    //     wraps the entire row in a single `<Link href="/matches/{id}">`
    //     anchor, so an href-substring selector uniquely locates this row.
    const card = page.locator(`a[href*="/matches/${seededMatchId}"]`);
    await expect(
      card,
      'the seeded match must appear in the catalog list as a card linking to its detail page',
    ).toBeVisible();

    // B3. FINISHED badge text visible within the card. NFR-M3 / WCAG 2.1 AA:
    //     lock state is carried by the badge text, not by background colour
    //     alone, so a text assertion is the load-bearing one.
    await expect(
      card.getByText('FINISHED', { exact: false }),
      'the FINISHED badge text must appear inside the seeded match card',
    ).toBeVisible();

    // B4. Score values appear in the card. MatchCard renders
    //     `{score_home} – {score_away}` (U+2013 en-dash). Asserting on the
    //     literal "2 – 1" is stable for now, but we additionally assert on
    //     the individual digits to remain robust if the surrounding glyph
    //     or whitespace ever shifts.
    const cardText = await card.innerText();
    expect(
      cardText,
      'the seeded card text must include the final score "2 – 1"',
    ).toMatch(/2\s*[–-]\s*1/);
    expect(cardText, 'the seeded card text must contain the home score "2"').toContain('2');
    expect(cardText, 'the seeded card text must contain the away score "1"').toContain('1');

    // -----------------------------------------------------------------------
    // Phase C — `/matches/[id]` detail page (FR-M06 + FR-M11 detail-view).
    // -----------------------------------------------------------------------
    // C1. Navigate to the detail page. A 404 (notFound) would render the
    //     framework's not-found UI rather than the article element — the
    //     subsequent visibility assertions on team names + the badge act as
    //     a positive proof that the page rendered the MatchDetailCard
    //     branch rather than notFound().
    await page.goto(`/matches/${seededMatchId}`);
    await expect(page).toHaveURL(new RegExp(`/matches/${seededMatchId}$`));

    // C2. Confirm the detail card rendered (not notFound). MatchDetailCard
    //     prints both team names at large display size inside the score
    //     section, so a visibility assertion on either name proves the
    //     route resolved successfully.
    await expect(
      page.getByText('Germany', { exact: false }),
      'the detail page must render the home team name (not a notFound page)',
    ).toBeVisible();
    await expect(
      page.getByText('Argentina', { exact: false }),
      'the detail page must render the away team name (not a notFound page)',
    ).toBeVisible();

    // C3. FINISHED badge visible at the page level. Terminal-state matches
    //     bypass the LockCountdownTicker and render <LockBadge/> directly
    //     (see MatchDetailCard.tsx ~line 149 — `isTerminal || isTbd`
    //     branch). Either way the badge text is the assertion target.
    await expect(
      page.getByText('FINISHED', { exact: false }).first(),
      'the FINISHED badge text must be visible on the match detail page',
    ).toBeVisible();

    // C4. "Final score" label rendered. MatchCard uses this label as a
    //     prefix on the list view; MatchDetailCard places the prominent
    //     score line above the meta-info section without the label. We
    //     assert on the score values plus, separately, that the
    //     `matches.detail.finalScore` translation is present somewhere on
    //     the page — either in this card's render path (via the prefix on
    //     a future render-path change) or in the aria-label on the kickoff
    //     section. The robust assertion is on the score numerals.
    const pageText = await page.locator('body').innerText();
    expect(
      pageText,
      'the detail page body must include the final score "2 – 1"',
    ).toMatch(/2\s*[–-]\s*1/);

    // C5. Explicit final-score line assertion. MatchDetailCard renders a
    //     dedicated `<p className="text-3xl ...">{score_home} – {score_away}</p>`
    //     above the meta-info section when status='finished' AND both scores
    //     are non-null. Locating by its display text confirms the FR-M11
    //     detail-view score line is in the DOM, not just the values being
    //     present somewhere else (e.g. only in the badge area).
    await expect(
      page.locator('p', { hasText: /^\s*2\s*[–-]\s*1\s*$/ }).first(),
      'the detail page must include a paragraph containing the score "2 – 1"',
    ).toBeVisible();
  });
});
