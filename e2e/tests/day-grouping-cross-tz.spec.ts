/**
 * Playwright E2E test — TC-M9 (US-MB: cross-TZ day grouping) for feature 002
 * (match-catalog), task T049.
 *
 * Spec source: `specs/002-match-catalog/spec.md` — User Story MB acceptance:
 *
 *   > TC-M9: Given two participants with different stored timezones
 *   > (`Europe/Tallinn` and `America/Sao_Paulo`), when they each view the
 *   > same match (kickoff at `23:00 UTC` on a Saturday), then the Tallinn
 *   > participant sees the match under "Sunday" / next-day's bucket and the
 *   > São Paulo participant sees it under "Saturday" / same-day's bucket.
 *   > The same `kickoff_utc` lands in different day buckets because
 *   > day-grouping is computed in each participant's stored TZ
 *   > (`dayBucket()` from `lib/matches/day-bucket.ts`).
 *
 * Wires together:
 *   - `lib/matches/day-bucket.ts` — the pure derivation under test. Its
 *     contract docblock explicitly calls out this scenario as TC-M9
 *     ("same kickoffUtc must produce different bucket keys for two
 *     participants in different timezones when their local calendar dates
 *     differ"). This E2E asserts the rendered-output counterpart.
 *   - `lib/matches/__tests__/day-bucket.test.ts` — the unit-level twin
 *     (15 cases including the cross-TZ scenario this spec mirrors). The
 *     Jest test pins the calculation; this spec verifies the calculation
 *     actually flows through to two different rendered day-bucket headers
 *     when the underlying participant rows differ only in `timezone`.
 *   - `app/(participant)/matches/page.tsx` — the Server Component that
 *     calls `dayBucket()` per row and emits one `<section aria-labelledby
 *     ="day-${bucketKey}">` with an `<h2>` carrying the localised label.
 *     The `aria-labelledby` is what lets us walk from the heading to the
 *     match-card link without assuming sibling-order DOM structure.
 *   - `components/matches/MatchCard.tsx` — each rendered card is an
 *     `<a href="/matches/{id}">`, which we locate inside the bucket
 *     section by the seeded match id.
 *
 * FR-M17: `/matches` MUST group by *participant-local* day (not UTC date),
 * with a localised header per group. The contract test that two
 * participants in different stored TZs see the *same* UTC instant under
 * *different* day buckets is TC-M9.
 *
 * Why this particular kickoff timestamp:
 *   `2026-06-13T23:00:00Z` is a Saturday at 23:00 UTC. It straddles the
 *   local-day boundary in both target TZs in opposite directions, which is
 *   exactly what we need to exercise the per-participant grouping:
 *     - Europe/Tallinn is UTC+3 in summer (EU Eastern European Summer Time).
 *       23:00 UTC + 3h = 02:00 local → falls on Sunday 2026-06-14.
 *     - America/Sao_Paulo is UTC-3 year-round (Brazil dropped DST in 2019).
 *       23:00 UTC − 3h = 20:00 local → falls on Saturday 2026-06-13.
 *   The kickoff is also well in the future relative to any plausible test
 *   run, so the day-bucket label resolves via the explicit-weekday branch
 *   of `formatBucketLabel` (`Intl.DateTimeFormat`), not the adjacent-day
 *   lookup ("Today" / "Tomorrow" / "Yesterday"). For `en-US`, that yields:
 *     - Tallinn: "Sunday, June 14"
 *     - São Paulo: "Saturday, June 13"
 *   Both strings are verified deterministically by `Intl.DateTimeFormat`
 *   in the helper, so the assertions below are stable across Node runtimes
 *   that ship the standard ICU locale data.
 *
 * Why two separate browser contexts:
 *   Each participant has their own auth session (different `oid`,
 *   different cookie jar). `browser.newContext()` gives us a clean
 *   storage state per participant, which mirrors the cross-device pattern
 *   in `welcome-modal-cross-device.spec.ts`. The two contexts are scoped
 *   inside try/finally blocks so a failed assertion still releases the
 *   browser resources — leaked contexts compound under parallel runs.
 *
 * Why bypass the auto-detect TZ Client Component:
 *   The page reads `participants.timezone` server-side. In production a
 *   Client Component auto-detects the browser TZ on first visit and
 *   UPDATEs the participant row. For a deterministic E2E we skip that
 *   effect entirely and write each target TZ directly via the service-role
 *   client BEFORE navigating to `/matches`. This matches the pattern from
 *   `matches-browse.spec.ts` and the constitution's "server renders, UI
 *   reflects" principle (constitution-frontend §4.1).
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

// ---------------------------------------------------------------------------
// Fixed test data — chosen for deterministic cross-TZ day-boundary behaviour.
// See top-of-file docblock for the rationale.
// ---------------------------------------------------------------------------

/** Saturday 23:00 UTC — straddles the day boundary in both target TZs. */
const KICKOFF_UTC = '2026-06-13T23:00:00.000Z';

/** Synthetic provider id outside the 0017 seed range (760..800) and the
 *  per-test synthetic ranges used elsewhere (9101..9105 in matches-browse). */
const PROVIDER_ID = 9801;

/**
 * Expected localised day-bucket headers under `en-US`. These are the exact
 * outputs of `Intl.DateTimeFormat('en-US', {weekday:'long', month:'long',
 * day:'numeric', timeZone})` applied to `KICKOFF_UTC` in each TZ; the
 * `dayBucket()` helper uses that same formatter for non-adjacent days.
 */
const EXPECTED_TALLINN_HEADER = 'Sunday, June 14';
const EXPECTED_SAO_PAULO_HEADER = 'Saturday, June 13';

/**
 * Expected bucket keys (ISO `YYYY-MM-DD` in the participant TZ). The page
 * emits `<section aria-labelledby="day-${bucketKey}">`, so we use these to
 * scope the match-card assertion to the correct day bucket via the
 * section's id'd heading.
 */
const EXPECTED_TALLINN_KEY = '2026-06-14';
const EXPECTED_SAO_PAULO_KEY = '2026-06-13';

// ---------------------------------------------------------------------------
// Inline helpers. Kept local for the same reasons articulated in
// `matches-browse.spec.ts`: other specs don't touch matches, and the seed
// shape here is bespoke to TC-M9 (exactly one match at a precisely-chosen
// UTC instant).
// ---------------------------------------------------------------------------

type SeededMatch = { id: string; providerId: number };

/**
 * Seed exactly one match keyed by the synthetic `PROVIDER_ID`. Returns
 * the assigned UUID so callers can scope card-locator selectors to that
 * id rather than relying on DOM position.
 *
 * Idempotent on re-run: deletes any prior row with the same provider_id
 * before inserting, mirroring the `seedMatches` pattern in
 * `matches-browse.spec.ts`.
 */
async function seedMatch(
  client: SupabaseClient<Database>,
  homeTeamId: string,
  awayTeamId: string,
): Promise<SeededMatch> {
  const cleanup = await client
    .from('matches')
    .delete()
    .eq('provider_id', PROVIDER_ID);
  if (cleanup.error) {
    throw new Error(`seedMatch: cleanup failed: ${cleanup.error.message}`);
  }

  const id = randomUUID();
  const insert = await client.from('matches').insert({
    id,
    provider_id: PROVIDER_ID,
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: KICKOFF_UTC,
    status: 'scheduled',
  });
  if (insert.error) {
    throw new Error(`seedMatch: insert failed: ${insert.error.message}`);
  }
  return { id, providerId: PROVIDER_ID };
}

/**
 * Resolve two team UUIDs from the migration 0017 seed by TLA. Brazil + Germany
 * are well-known qualifiers guaranteed to be in the seed (migration 0017
 * carries the full 32-team World Cup catalog).
 */
async function pickTwoTeamUuids(
  client: SupabaseClient<Database>,
): Promise<readonly [string, string]> {
  const tlas = ['BRA', 'GER'] as const;
  const { data, error } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', [...tlas]);

  if (error) {
    throw new Error(`pickTwoTeamUuids: ${error.message}`);
  }
  if (data === null || data.length < 2) {
    throw new Error(
      `pickTwoTeamUuids: expected 2 seeded teams (${tlas.join(', ')}), got ${data?.length ?? 0}. ` +
        'Has migration 0017_seed_teams.sql been applied?',
    );
  }

  const byTla = new Map(data.map((row) => [row.tla, row.id]));
  const bra = byTla.get('BRA');
  const ger = byTla.get('GER');
  if (bra === undefined || ger === undefined) {
    throw new Error('pickTwoTeamUuids: BRA or GER missing from teams seed');
  }
  return [bra, ger] as const;
}

/**
 * Invoke `provision_participant_from_jwt()` from the authenticated browser
 * context using `@supabase/ssr`'s cookie-aware client (same SDK the app
 * uses in Server Components). Hydrates the session from cookies before the
 * RPC fires so we don't race ahead unauthenticated.
 *
 * Inlined per the comment in `welcome-modal-cross-device.spec.ts` — once a
 * fifth spec adopts it, promote to `e2e/fixtures/rpc.ts`. This is the
 * fourth (auth-eligible-new-user / auth-role-downgrade / welcome-modal-
 * cross-device / matches-browse already inline it).
 */
async function provisionParticipantFromPage(
  page: Page,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
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
}

/**
 * Set the signed-in participant's stored timezone via the service-role
 * client. Bypasses the auto-detect Client Component so the `/matches`
 * Server Component render is deterministic for this spec.
 */
async function setParticipantTimezone(
  oid: string,
  timezone: string,
): Promise<void> {
  const client = getServiceRoleClient();
  const { error } = await client
    .from('participants')
    .update({ timezone })
    .eq('oid', oid);
  if (error) {
    throw new Error(
      `setParticipantTimezone(${oid}, ${timezone}): ${error.message}`,
    );
  }
}

test.describe('US-MB / TC-M9 — same kickoff_utc lands in different day buckets per participant TZ', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
  });

  test('TC-M9: a kickoff at 23:00 UTC Saturday is under Sunday for Tallinn and Saturday for São Paulo', async ({
    browser,
  }) => {
    // -----------------------------------------------------------------------
    // Seed the single shared match. Both participants will see this same row
    // — by provider_id and by the returned UUID — under different day-bucket
    // sections. The match id flows into the per-participant card-locator
    // selectors (`a[href*="/matches/${matchId}"]`) so DOM-ordering can't
    // accidentally satisfy the assertion.
    // -----------------------------------------------------------------------
    const adminClient = getServiceRoleClient();
    const [bra, ger] = await pickTwoTeamUuids(adminClient);
    const seeded = await seedMatch(adminClient, bra, ger);
    const matchHrefSelector = `main a[href*="/matches/${seeded.id}"]`;

    // -----------------------------------------------------------------------
    // Participant A — Europe/Tallinn (UTC+3 in summer → kickoff falls on Sun).
    // -----------------------------------------------------------------------
    // `en-US` locale chosen so the rendered weekday + month names match the
    // expected English strings derived from Intl.DateTimeFormat (the same
    // formatter `dayBucket()` uses internally).
    const tallinnContext = await browser.newContext({ locale: 'en-US' });
    const tallinnPage = await tallinnContext.newPage();
    try {
      // A1. Sign in. The custom email keeps the two synthetic identities
      //     visually distinct in test logs and avoids any chance of an oid
      //     collision between the two contexts. `signInAs` returns the oid
      //     used by the auth.users row we'll match for the TZ UPDATE.
      const tallinnSession = await signInAs(tallinnPage, {
        tenant: 'eligible',
        email: 'tallinn@nortal.com',
      });

      // A2. Provision the participant row server-side so the row exists for
      //     the subsequent TZ UPDATE and for the page's `auth_user_id`
      //     lookup. Mirrors the OAuth-callback flow from production.
      const tallinnProvision = await provisionParticipantFromPage(tallinnPage);
      expect(
        tallinnProvision.ok,
        tallinnProvision.ok ? undefined : tallinnProvision.error,
      ).toBe(true);

      // A3. Pin the participant's stored TZ. The Server Component reads
      //     `participants.timezone` and feeds it into `dayBucket()`; this
      //     UPDATE is the load-bearing precondition for the per-TZ bucket
      //     header below.
      await setParticipantTimezone(tallinnSession.oid, 'Europe/Tallinn');

      // A4. Render the catalog. The match query order + the per-row
      //     `dayBucket()` call together produce one `<section>` per local
      //     day. Page heading text mirrors `matches.pageHeading` from the
      //     `en` messages bundle ("Matches").
      const tallinnResponse = await tallinnPage.goto('/matches');
      expect(
        tallinnResponse?.status(),
        'Tallinn /matches must return 200',
      ).toBe(200);
      await expect(tallinnPage).toHaveURL(/\/matches$/);
      await expect(
        tallinnPage.getByRole('heading', { level: 1, name: 'Matches' }),
      ).toBeVisible();

      // A5. The Tallinn-local day bucket header must read "Sunday, June 14"
      //     (verified offline via `Intl.DateTimeFormat('en-US', {weekday:
      //     'long', month:'long', day:'numeric', timeZone:'Europe/Tallinn'})
      //     .format(new Date('2026-06-13T23:00:00Z'))`). Asserting on
      //     `getByRole('heading', { level: 2, name })` selects on the h2's
      //     accessible name, which is the most stable handle in
      //     `app/(participant)/matches/page.tsx`:374.
      const tallinnHeading = tallinnPage.getByRole('heading', {
        level: 2,
        name: EXPECTED_TALLINN_HEADER,
      });
      await expect(
        tallinnHeading,
        `Tallinn participant must see day-bucket header "${EXPECTED_TALLINN_HEADER}" (kickoff falls on Sunday in their TZ)`,
      ).toBeVisible();

      // A6. The seeded match card must live UNDER that bucket — not merely
      //     anywhere on the page. The page wraps each bucket in `<section
      //     aria-labelledby="day-${bucketKey}">`, so scoping by that section
      //     gives us a deterministic "card inside Sunday bucket" assertion
      //     that survives any future re-ordering of buckets on the page.
      const tallinnSundaySection = tallinnPage.locator(
        `section[aria-labelledby="day-${EXPECTED_TALLINN_KEY}"]`,
      );
      await expect(
        tallinnSundaySection,
        'Tallinn page must render exactly one Sunday (2026-06-14) section',
      ).toHaveCount(1);
      await expect(
        tallinnSundaySection.locator(`a[href*="/matches/${seeded.id}"]`),
        `seeded match ${seeded.id} must appear inside the Tallinn Sunday section`,
      ).toHaveCount(1);

      // A7. Cross-check: the match must NOT appear under a Saturday bucket
      //     for Tallinn. This is the negative side of TC-M9 — if both
      //     buckets render the same card we have a bug.
      await expect(
        tallinnPage.locator(
          `section[aria-labelledby="day-${EXPECTED_SAO_PAULO_KEY}"] ${matchHrefSelector}`,
        ),
        'seeded match must NOT appear under the Saturday bucket for Tallinn',
      ).toHaveCount(0);
    } finally {
      await tallinnContext.close();
    }

    // -----------------------------------------------------------------------
    // Participant B — America/Sao_Paulo (UTC-3 year-round → kickoff falls
    // on the SAME Saturday in local time).
    // -----------------------------------------------------------------------
    const saoPauloContext = await browser.newContext({ locale: 'en-US' });
    const saoPauloPage = await saoPauloContext.newPage();
    try {
      // B1. Distinct email → distinct synthetic oid → distinct participant
      //     row. Same eligible tenant so the auth + provisioning flow
      //     mirrors Phase A exactly aside from the stored TZ.
      const saoPauloSession = await signInAs(saoPauloPage, {
        tenant: 'eligible',
        email: 'saopaulo@nortal.com',
      });
      expect(
        saoPauloSession.oid,
        'São Paulo participant must have a distinct oid from the Tallinn participant',
      ).not.toBe('tallinn@nortal.com');

      const saoPauloProvision = await provisionParticipantFromPage(saoPauloPage);
      expect(
        saoPauloProvision.ok,
        saoPauloProvision.ok ? undefined : saoPauloProvision.error,
      ).toBe(true);

      await setParticipantTimezone(saoPauloSession.oid, 'America/Sao_Paulo');

      const saoPauloResponse = await saoPauloPage.goto('/matches');
      expect(
        saoPauloResponse?.status(),
        'São Paulo /matches must return 200',
      ).toBe(200);
      await expect(saoPauloPage).toHaveURL(/\/matches$/);
      await expect(
        saoPauloPage.getByRole('heading', { level: 1, name: 'Matches' }),
      ).toBeVisible();

      // B5. The São Paulo-local day bucket header must read "Saturday,
      //     June 13" — same kickoff_utc, different participant TZ, so the
      //     calendar day is one earlier than Tallinn's.
      const saoPauloHeading = saoPauloPage.getByRole('heading', {
        level: 2,
        name: EXPECTED_SAO_PAULO_HEADER,
      });
      await expect(
        saoPauloHeading,
        `São Paulo participant must see day-bucket header "${EXPECTED_SAO_PAULO_HEADER}" (kickoff falls on Saturday in their TZ)`,
      ).toBeVisible();

      const saoPauloSaturdaySection = saoPauloPage.locator(
        `section[aria-labelledby="day-${EXPECTED_SAO_PAULO_KEY}"]`,
      );
      await expect(
        saoPauloSaturdaySection,
        'São Paulo page must render exactly one Saturday (2026-06-13) section',
      ).toHaveCount(1);
      await expect(
        saoPauloSaturdaySection.locator(`a[href*="/matches/${seeded.id}"]`),
        `seeded match ${seeded.id} must appear inside the São Paulo Saturday section`,
      ).toHaveCount(1);

      // B7. Negative cross-check: the match must NOT appear under a Sunday
      //     bucket for São Paulo.
      await expect(
        saoPauloPage.locator(
          `section[aria-labelledby="day-${EXPECTED_TALLINN_KEY}"] ${matchHrefSelector}`,
        ),
        'seeded match must NOT appear under the Sunday bucket for São Paulo',
      ).toHaveCount(0);
    } finally {
      await saoPauloContext.close();
    }
  });
});
