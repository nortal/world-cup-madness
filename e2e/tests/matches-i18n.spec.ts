/**
 * Playwright E2E test — T042 (TC-M12) for feature 002 (match-catalog).
 *
 * Spec source: `specs/002-match-catalog/spec.md` — User Story MA acceptance:
 *
 *   > TC-M12: Given the matches catalog has 1+ scheduled matches and a
 *   > participant has signed in with a specific `Accept-Language`
 *   > (`en`, `es`, `pt-BR`), when they navigate to `/matches`,
 *   > `/matches/[id]`, and `/dashboard`, then ALL match-page UI strings
 *   > render in the requested locale.
 *
 * Requirement chain:
 *   - FR-M21 (trilingual match catalog): every match-surface UI string —
 *     page headings, dashboard widget heading, lock-status badges, and
 *     match-detail field labels — must be served from the locale catalogs
 *     in `lib/i18n/messages/{en,es,pt-BR}.json`, never hard-coded in JSX.
 *   - ADR-013 (hand-rolled Accept-Language detection): the top-level
 *     `middleware.ts` parses the incoming `Accept-Language` header itself
 *     (rather than delegating to next-intl middleware) so URLs stay
 *     locale-agnostic and the resolved locale lives in the `NEXT_LOCALE`
 *     cookie. Supported locales: `['en', 'es', 'pt-BR']`; default: `en`.
 *
 * Pattern reference:
 *   `e2e/tests/i18n-locale-detection.spec.ts` (feature 001's analogue for
 *   TC-7 / NFR-A5) is the canonical context-per-locale pattern. Each test
 *   creates its own `BrowserContext` via `browser.newContext({ locale })`
 *   so Playwright sets both `navigator.language` AND the `Accept-Language`
 *   request header on every navigation from that context — which is the
 *   ONLY signal the middleware needs (URLs carry no locale prefix). The
 *   middleware's BCP-47 matcher resolves:
 *     - `en-US` → `en`            (language-only fallback)
 *     - `es-ES` → `es`            (language-only fallback)
 *     - `pt-BR` → `pt-BR`         (exact match)
 *   We then assert the literal strings from each locale's message catalog
 *   on `/dashboard`, `/matches`, and `/matches/[id]`.
 *
 * Per-test browser contexts:
 *   Each iteration creates its own `BrowserContext` so the `locale` option
 *   can be configured independently. Contexts are closed in `finally` to
 *   avoid leaking resources across the serially-run suite (`workers: 1` in
 *   `playwright.config.ts`); leaks would still compound test-to-test.
 *
 * Why bypass the auto-detect TZ Client Component (see matches-browse.spec.ts):
 *   The page reads `participants.timezone` server-side and feeds it into
 *   `dayBucket()`. In production a Client Component auto-detects the
 *   browser TZ on first visit and UPDATEs the participant row. For a
 *   deterministic E2E we skip that effect entirely and write the target
 *   TZ (`Europe/Tallinn`) directly via the service-role client BEFORE
 *   navigating — this matches the constitution's "lock status as UI truth,
 *   server renders" pattern (constitution-frontend §4.1) and avoids racing
 *   the page render against an async client effect.
 */

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Inline matches-seed helper. Kept local to this spec on purpose:
 *   - Other tests (auth / welcome modal / a11y) do not touch `matches`,
 *     so extending the shared `e2e/fixtures/db.ts` reset / seed surface
 *     would force every test to pay the cost of a matches reset.
 *   - The seed shape here is bespoke to TC-M12 (one scheduled + one
 *     finished match, both far from the kickoff−60min lock boundary so
 *     the UPCOMING / FINISHED badge resolutions stay deterministic).
 *
 * `provider_id` values 9601 + 9602 sit well outside the migration seed
 * range (760..800 in 0017) and the live football-data.org id space the
 * bootstrap sync would touch, so re-running the test against a partially-
 * synced local stack stays collision-free.
 */
type MatchSeedSpec = {
  providerId: number;
  homeTeamId: string;
  awayTeamId: string;
  stage: 'group' | 'round-of-16' | 'quarter-final' | 'semi-final' | 'third-place' | 'final';
  groupLabel: string | null;
  kickoffUtc: string;
  status: 'scheduled' | 'scheduled-tbd' | 'live' | 'finished' | 'cancelled';
  scoreHome: number | null;
  scoreAway: number | null;
};

async function seedMatch(
  client: SupabaseClient<Database>,
  spec: MatchSeedSpec,
): Promise<string> {
  // Idempotent re-seed: delete any prior row with the same synthetic
  // provider_id so re-runs against an already-seeded local stack stay
  // collision-free without truncating `matches` wholesale.
  const cleanup = await client.from('matches').delete().eq('provider_id', spec.providerId);
  if (cleanup.error) {
    throw new Error(`seedMatch(${spec.providerId}): cleanup failed: ${cleanup.error.message}`);
  }

  const id = randomUUID();
  const insert = await client.from('matches').insert({
    id,
    provider_id: spec.providerId,
    home_team_id: spec.homeTeamId,
    away_team_id: spec.awayTeamId,
    stage: spec.stage,
    group_label: spec.groupLabel,
    kickoff_utc: spec.kickoffUtc,
    status: spec.status,
    score_home: spec.scoreHome,
    score_away: spec.scoreAway,
  });
  if (insert.error) {
    throw new Error(`seedMatch(${spec.providerId}): insert failed: ${insert.error.message}`);
  }
  return id;
}

/**
 * Resolve two distinct team UUIDs from the migration 0017 seed by TLA.
 * Picks well-known qualifiers guaranteed to be in the seed (England,
 * France). We need only 2 since this spec seeds exactly 2 fixtures.
 */
async function pickTwoTeamUuids(
  client: SupabaseClient<Database>,
): Promise<readonly [string, string]> {
  const tlas = ['ENG', 'FRA'] as const;
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
  const eng = byTla.get('ENG');
  const fra = byTla.get('FRA');
  if (eng === undefined || fra === undefined) {
    throw new Error('pickTwoTeamUuids: missing ENG or FRA from seed.');
  }
  return [eng, fra] as const;
}

/**
 * Per-locale assertion bundle. Strings are copied verbatim from
 * `lib/i18n/messages/{en,es,pt-BR}.json` — diacritics (PRÓXIMO, Pontapé)
 * matter to Playwright's text matcher, so do NOT paraphrase.
 *
 * Coverage per row:
 *   - `pageHeading`        → /matches H1   (key: matches.pageHeading)
 *   - `upcoming`           → /matches body (key: matches.badge.upcoming)
 *   - `dashboardHeading`   → /dashboard H2 (key: matches.dashboardWidget.heading)
 *   - `kickoff`            → /matches/[id] (key: matches.detail.kickoff)
 */
const LOCALE_CASES = [
  {
    browserLocale: 'en-US',
    resolvedLocale: 'en' as const,
    pageHeading: 'Matches',
    upcoming: 'UPCOMING',
    dashboardHeading: 'Upcoming matches',
    kickoff: 'Kickoff',
  },
  {
    browserLocale: 'es-ES',
    resolvedLocale: 'es' as const,
    pageHeading: 'Partidos',
    upcoming: 'PRÓXIMO',
    dashboardHeading: 'Próximos partidos',
    kickoff: 'Inicio',
  },
  {
    browserLocale: 'pt-BR',
    resolvedLocale: 'pt-BR' as const,
    pageHeading: 'Jogos',
    upcoming: 'EM BREVE',
    dashboardHeading: 'Próximos jogos',
    kickoff: 'Pontapé inicial',
  },
] as const;

test.describe('US-MA / TC-M12 — match-page UI translated in en / es / pt-BR', () => {
  test.beforeEach(async () => {
    // Per-test reset + seed. `resetSupabaseState()` clears `participants`
    // + `audit_log` but does NOT touch `teams` or `matches`, so we seed
    // our fixture matches explicitly. Per-test seeding (rather than
    // `beforeAll`) is the safer pattern even with `workers: 1`: it keeps
    // every test self-contained and trivially re-runnable in isolation.
    await resetSupabaseState();

    const client = getServiceRoleClient();
    const [eng, fra] = await pickTwoTeamUuids(client);

    // Kickoff timestamps relative to NOW so the test stays stable
    // regardless of when it runs. The scheduled match sits +5 days out
    // (well past the kickoff−60min lock boundary), so its LockBadge
    // resolves to `UPCOMING` (not `LOCKED`) — this is the locale string
    // the /matches assertion below depends on. The finished match sits
    // 2 days in the past with a final 2-1 score.
    const now = new Date();
    const atUtc = (daysFromNow: number, hours: number, minutes: number): string => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + daysFromNow);
      d.setUTCHours(hours, minutes, 0, 0);
      return d.toISOString();
    };

    // Scheduled fixture (provider_id 9601) — drives the UPCOMING badge
    // assertion AND the /matches/[id] kickoff-label assertion.
    await seedMatch(client, {
      providerId: 9601,
      homeTeamId: eng,
      awayTeamId: fra,
      stage: 'group',
      groupLabel: 'A',
      kickoffUtc: atUtc(5, 18, 0),
      status: 'scheduled',
      scoreHome: null,
      scoreAway: null,
    });

    // Finished fixture (provider_id 9602) — exercises a non-scheduled
    // status alongside the scheduled one so the /matches list renders
    // a mixed status set, matching the spec's "1+ scheduled matches"
    // wording with realistic neighbouring data.
    await seedMatch(client, {
      providerId: 9602,
      homeTeamId: fra,
      awayTeamId: eng,
      stage: 'group',
      groupLabel: 'A',
      kickoffUtc: atUtc(-2, 18, 0),
      status: 'finished',
      scoreHome: 2,
      scoreAway: 1,
    });
  });

  for (const localeCase of LOCALE_CASES) {
    test(`Accept-Language: ${localeCase.browserLocale} → ${localeCase.resolvedLocale} translates /matches + dashboard widget + detail page`, async ({
      browser,
    }) => {
      // Setting `locale` on the context drives Playwright to send the
      // BCP-47 tag in the `Accept-Language` header on every navigation —
      // the hand-rolled middleware (ADR-013) reads that header to pick
      // the message catalog (URLs carry no locale prefix). This is the
      // same context-per-locale shape used in
      // `e2e/tests/i18n-locale-detection.spec.ts`.
      const context = await browser.newContext({ locale: localeCase.browserLocale });
      const page = await context.newPage();

      try {
        // Sign in inside this fresh context so the Supabase session
        // cookies live alongside the NEXT_LOCALE cookie the middleware
        // wrote during the first navigation.
        const { oid } = await signInAs(page, { tenant: 'eligible' });

        // Provision the participant row — `signInAs` only installs the
        // auth session; production code calls
        // `provision_participant_from_jwt()` from the OAuth callback.
        // Pattern copied from matches-browse.spec.ts:170-191.
        const provision = await page.evaluate(
          async ({ supabaseUrl, supabaseAnonKey }) => {
            const { createBrowserClient } = await import(
              // @ts-expect-error -- dynamic CDN import inside the browser context.
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
        expect(
          provision.ok,
          'provision_participant_from_jwt RPC must succeed before asserting authenticated surfaces',
        ).toBe(true);

        // Pin the TZ server-side via the service-role client so the
        // /matches day-bucket render is deterministic across CI envs.
        // The page-level Client Component that would otherwise UPDATE
        // this column on first visit is harmlessly idempotent here.
        const tzUpdate = await getServiceRoleClient()
          .from('participants')
          .update({ timezone: 'Europe/Tallinn' })
          .eq('oid', oid);
        expect(tzUpdate.error, 'setting participant.timezone must succeed').toBeNull();

        // --- /dashboard ----------------------------------------------------
        // The widget renders an h2 with key `matches.dashboardWidget.heading`
        // (UpcomingMatchesWidget.tsx:99-104). Using `getByRole('heading')`
        // pins the assertion to the semantic element, not a brittle text
        // search that could match unrelated body copy.
        await page.goto('/dashboard');
        await expect(
          page.getByRole('heading', { level: 2, name: localeCase.dashboardHeading }),
          `dashboard widget heading must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();

        // --- /matches ------------------------------------------------------
        await page.goto('/matches');
        await expect(page).toHaveURL(/\/matches$/);
        await expect(
          page.getByRole('heading', { level: 1, name: localeCase.pageHeading }),
          `/matches h1 must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();

        // The scheduled fixture (kickoff +5d) is well past the
        // kickoff−60min lock boundary so its LockBadge resolves to
        // `UPCOMING` — assert the locale-specific badge label is on
        // screen. `.first()` because multiple cards may share the badge
        // (only the scheduled match qualifies, but defensive `.first()`
        // also tolerates the dashboard widget rendering nothing.)
        await expect(
          page.getByText(localeCase.upcoming).first(),
          `/matches UPCOMING badge must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();

        // --- /matches/[id] -------------------------------------------------
        // Resolve the scheduled match's UUID via provider_id (9601) so
        // we navigate to a known-good detail page. The detail card
        // surfaces a `<dt>` with key `matches.detail.kickoff` (see
        // MatchDetailCard.tsx:132-134) — assert the locale-specific
        // label is on screen.
        const { data: scheduled, error: matchErr } = await getServiceRoleClient()
          .from('matches')
          .select('id')
          .eq('provider_id', 9601)
          .single();
        expect(matchErr, 'lookup of provider_id=9601 match must succeed').toBeNull();
        expect(scheduled, 'provider_id=9601 match row must exist after seeding').not.toBeNull();
        const matchId = scheduled?.id;
        expect(matchId, 'seeded match must have a UUID').toBeTruthy();

        await page.goto(`/matches/${matchId}`);
        await expect(
          page.getByText(localeCase.kickoff).first(),
          `/matches/[id] kickoff label must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();
      } finally {
        // Always close the context — leaking contexts across the serial
        // suite would accumulate browser-process pressure across all
        // three locale iterations.
        await context.close();
      }
    });
  }
});
