/**
 * Playwright accessibility sweep — T075 (broad WCAG 2.1 AA audit).
 *
 * Task source: `specs/001-authentication-and-participant/tasks.md` T075
 *   > Run accessibility audit Playwright project against all pages:
 *   > `npx playwright test --project=accessibility` and resolve any axe-core
 *   > violations.
 *
 * Scope — every other surface in the feature that has NOT already been audited:
 *   1. `/`             (public landing)                — `app/(public)/page.tsx`
 *   2. `/access-denied`(public, post-OAuth deny)      — `app/(public)/access-denied/page.tsx`
 *   3. `/auth-error`   (public, OAuth/callback error) — `app/(public)/auth-error/page.tsx`
 *   4. `/privacy`      (public, privacy notice)       — `app/(public)/privacy/page.tsx`
 *   5. `/dashboard`    (authenticated, RETURNING user — welcome modal NOT mounted)
 *   6. `/profile`      (authenticated)                — `app/(participant)/profile/page.tsx`
 *
 * Intentionally NOT covered here:
 *   - `/dashboard` WITH the welcome modal open — already audited by
 *     `welcome-modal-a11y.spec.ts` (T061). Duplicating that surface would dilute
 *     the value of this sweep without adding signal. This file specifically
 *     adds the "returning user" dashboard state (welcome_dismissed_at populated,
 *     no dialog rendered) which is otherwise unaudited.
 *
 * Filename convention — why `-a11y.spec.ts`:
 *   `playwright.config.ts` defines an `accessibility` project with
 *   `testMatch: /.*a11y\.spec\.ts/`. CI runs `--project=accessibility` to
 *   produce a focused WCAG report; the default `chromium` project also
 *   executes this file. Naming must match the regex case-sensitively.
 *
 * Test strategy per surface:
 *   - Navigate to the page (sign-in + provision first for authenticated routes).
 *   - Assert a stable rendered marker (the h1) so the audit doesn't run against
 *     a blank / pre-hydration DOM and silently report zero violations on
 *     nothing.
 *   - Run `@axe-core/playwright` scoped to WCAG 2.0 + 2.1 A and AA tags. The
 *     2.0 tags catch the shared foundation rules (contrast, name-role-value);
 *     the 2.1 tags add the AA additions targeted by WCM's accessibility goal.
 *   - Assert zero violations, serialising the violation list into the message
 *     so a CI failure prints the actual rule IDs + node selectors.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';
import AxeBuilder from '@axe-core/playwright';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

/**
 * Invoke `provision_participant_from_jwt()` from the authenticated browser
 * context using `@supabase/ssr`'s cookie-aware client (the same SDK the app
 * uses in Server Components). Hydrates the session from cookies before the
 * RPC fires so we don't race ahead unauthenticated.
 *
 * Hoisted to a file-level helper because two tests below (dashboard +
 * profile) both need the same provisioning step; inlining would duplicate
 * the verbatim `@ts-expect-error` CDN import twice within this single file.
 * Pattern copied from `auth-eligible-new-user.spec.ts` lines 59–81.
 */
async function provisionParticipantFromPage(
  page: import('@playwright/test').Page,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      // Force the new client to hydrate the persisted session from cookies
      // before issuing the RPC. Without this the rpc call may race ahead
      // unauthenticated, since `createBrowserClient` returns synchronously
      // but the auth state hydrates asynchronously.
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

// ---------------------------------------------------------------------------
// Feature-002 a11y helpers — inlined per the matches-browse spec convention.
//
// `matches-browse.spec.ts` documents the choice explicitly: only matches-aware
// specs touch the `matches` table, so extending the shared `e2e/fixtures/db.ts`
// reset surface would force every test in the suite to pay the cost of a
// matches reset. The same reasoning applies here — these helpers are the same
// shape (lightly trimmed) as the ones in `matches-browse.spec.ts`.
//
// `provider_id` range — 8201..8210 — is intentionally non-overlapping with
// every other spec's range (matches-browse: 9101..9105; timezone-profile-
// override: 9701; the migration seed: 760..800). Anchoring this file in 8201+
// means re-runs against a partially-seeded local stack stay deterministic and
// the per-test cleanup below scopes safely to just this file's rows.
// ---------------------------------------------------------------------------

/** Lower bound of the synthetic `provider_id` range owned by this spec. */
const A11Y_PROVIDER_ID_MIN = 8201;
/** Upper bound (inclusive) of the synthetic `provider_id` range owned by this spec. */
const A11Y_PROVIDER_ID_MAX = 8210;

type MatchSeedSpec = {
  providerId: number;
  homeTeamId: string;
  awayTeamId: string;
  stage: 'group' | 'round-of-16' | 'quarter-final' | 'semi-final' | 'third-place' | 'final';
  groupLabel: string | null;
  kickoffUtc: string;
  status: 'scheduled' | 'scheduled-tbd' | 'live' | 'finished' | 'cancelled';
};

type SeededMatch = MatchSeedSpec & { id: string };

/**
 * Seed a batch of matches keyed by `provider_id`s in this file's owned range.
 * Mirrors `seedMatches` in `matches-browse.spec.ts` — scoped delete first
 * (idempotent re-runs against an already-seeded local stack) then bulk insert.
 */
async function seedA11yMatches(
  client: SupabaseClient<Database>,
  specs: readonly MatchSeedSpec[],
): Promise<readonly SeededMatch[]> {
  const providerIds = specs.map((s) => s.providerId);
  const cleanup = await client.from('matches').delete().in('provider_id', providerIds);
  if (cleanup.error) {
    throw new Error(`seedA11yMatches: cleanup failed: ${cleanup.error.message}`);
  }

  const rows = specs.map((s) => ({
    id: randomUUID(),
    provider_id: s.providerId,
    home_team_id: s.homeTeamId,
    away_team_id: s.awayTeamId,
    stage: s.stage,
    group_label: s.groupLabel,
    kickoff_utc: s.kickoffUtc,
    status: s.status,
  }));

  const insert = await client.from('matches').insert(rows);
  if (insert.error) {
    throw new Error(`seedA11yMatches: insert failed: ${insert.error.message}`);
  }

  return specs.map((s, i) => ({ ...s, id: rows[i]!.id }));
}

/**
 * Resolve five distinct team UUIDs from the migration 0017 seed by TLA. Same
 * picks (and rationale) as `pickFiveTeamUuids` in `matches-browse.spec.ts` —
 * five UEFA top-of-table sides guaranteed to be in the seed.
 */
async function pickFiveTeamUuids(
  client: SupabaseClient<Database>,
): Promise<readonly [string, string, string, string, string]> {
  const tlas = ['ENG', 'FRA', 'GER', 'ITA', 'ESP'] as const;
  const { data, error } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', [...tlas]);

  if (error) {
    throw new Error(`pickFiveTeamUuids: ${error.message}`);
  }
  if (data === null || data.length < 5) {
    throw new Error(
      `pickFiveTeamUuids: expected 5 seeded teams (${tlas.join(', ')}), got ${data?.length ?? 0}. ` +
        'Has migration 0017_seed_teams.sql been applied?',
    );
  }

  const byTla = new Map(data.map((row) => [row.tla, row.id]));
  const uuids = tlas.map((t) => {
    const id = byTla.get(t);
    if (id === undefined) {
      throw new Error(`pickFiveTeamUuids: missing team for TLA ${t}`);
    }
    return id;
  });
  return [uuids[0]!, uuids[1]!, uuids[2]!, uuids[3]!, uuids[4]!] as const;
}

/**
 * Sign in + provision + pin a deterministic TZ on the participant row. Same
 * shape as `signInAndPrepare` in `matches-browse.spec.ts`. Pinning the TZ
 * server-side keeps the rendered day-bucket headers (and per-card kickoff
 * strings) stable across CI environments that may report different browser
 * TZs from the `TimezoneAutoDetect` client effect.
 */
async function signInProvisionAndPinTz(page: Page): Promise<string> {
  const { oid } = await signInAs(page, { tenant: 'eligible' });

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
  expect(provision.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

  const serviceRole = getServiceRoleClient();
  const { error: tzError } = await serviceRole
    .from('participants')
    .update({ timezone: 'Europe/Tallinn' })
    .eq('oid', oid);
  if (tzError) {
    throw new Error(`signInProvisionAndPinTz: TZ update failed: ${tzError.message}`);
  }

  return oid;
}

test.describe('all pages — WCAG 2.1 AA axe-core sweep', () => {
  // Reset before EVERY test, including public-only ones. Public pages don't
  // touch DB state, but the authenticated tests do; running the reset
  // unconditionally keeps the suite order-independent (Playwright workers can
  // shuffle tests within a file).
  //
  // Additionally clean up any matches keyed to THIS file's provider_id range
  // (8201..8210). `resetSupabaseState()` clears `participants` + `audit_log`
  // only — `matches` is intentionally not touched there, mirroring the
  // matches-browse spec's per-spec cleanup convention. Scoping the delete to
  // our own range keeps any bootstrap-sync fixtures or other specs' seeded
  // matches intact while still guaranteeing a clean slate for the three
  // feature-002 a11y tests below.
  test.beforeEach(async () => {
    await resetSupabaseState();

    const serviceRole = getServiceRoleClient();
    const cleanup = await serviceRole
      .from('matches')
      .delete()
      .gte('provider_id', A11Y_PROVIDER_ID_MIN)
      .lte('provider_id', A11Y_PROVIDER_ID_MAX);
    if (cleanup.error) {
      throw new Error(
        `a11y-spec beforeEach: matches cleanup (provider_id ${A11Y_PROVIDER_ID_MIN}..${A11Y_PROVIDER_ID_MAX}) failed: ${cleanup.error.message}`,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // Public surfaces — no auth, no DB seeding required.
  // ---------------------------------------------------------------------------

  test('/ landing has no a11y violations', async ({ page }) => {
    await page.goto('/');
    // Heading text comes from `lib/i18n/messages/en.json` -> `landing.headline`.
    // Asserting on the h1 (rather than `waitForLoadState`) guarantees the
    // React tree has actually rendered before axe runs — otherwise the audit
    // would scan an empty document and report a misleading clean result.
    await expect(
      page.getByRole('heading', { level: 1, name: 'World Cup Madness' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/access-denied has no a11y violations', async ({ page }) => {
    await page.goto('/access-denied');
    // `accessDenied.heading` from en.json.
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'This pool is for Nortal collaborators',
      }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/auth-error has no a11y violations', async ({ page }) => {
    await page.goto('/auth-error');
    // `authError.heading` from en.json.
    await expect(
      page.getByRole('heading', { level: 1, name: "Sign-in didn't complete" }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/privacy has no a11y violations', async ({ page }) => {
    await page.goto('/privacy');
    // `privacy.heading` from en.json.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Privacy notice' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Authenticated surfaces — sign in + provision, then audit.
  // ---------------------------------------------------------------------------

  test('/dashboard (returning user, no welcome modal) has no a11y violations', async ({
    page,
  }) => {
    // Step 1: sign in as a fresh eligible user. We'll immediately pre-mark
    // the resulting participant row as "welcome already dismissed" so the
    // dashboard renders WITHOUT the modal — the dashboard-with-modal-open
    // surface is already covered by `welcome-modal-a11y.spec.ts` and is
    // intentionally not duplicated here.
    const { oid, displayName } = await signInAs(page, { tenant: 'eligible' });

    const provisionResult = await provisionParticipantFromPage(page);
    expect(provisionResult.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

    // Step 2: pre-mark welcome as dismissed via the service-role client (RLS
    // bypass — participants cannot UPDATE this column directly, only via the
    // `dismiss_welcome` RPC; for test fixturing the service role is the
    // intended escape hatch). `.select()` forces PostgREST to return the
    // updated row so we can assert the write succeeded before navigating.
    const dismissedAt = new Date().toISOString();
    const serviceRole = getServiceRoleClient();
    const { data: updated, error: updateError } = await serviceRole
      .from('participants')
      .update({ welcome_dismissed_at: dismissedAt })
      .eq('oid', oid)
      .select('oid, welcome_dismissed_at');
    expect(updateError, updateError?.message).toBeNull();
    expect(
      updated,
      `welcome_dismissed_at pre-mark must update exactly one participant row (oid=${oid})`,
    ).toHaveLength(1);

    // Step 3: navigate and assert the returning-user state.
    await page.goto('/dashboard');
    await expect(
      page.getByRole('heading', { level: 1, name: `Welcome, ${displayName}` }),
    ).toBeVisible();
    // Sanity: confirm we are auditing the modal-free dashboard. Without this
    // a regression that re-mounts the modal would silently shift this test's
    // coverage onto the surface T061 already covers.
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/profile has no a11y violations', async ({ page }) => {
    // Same provisioning flow as the dashboard test. The welcome-dismissal
    // pre-mark is intentionally skipped: only the dashboard renders the
    // welcome modal (gated by `DashboardClient`), so the profile page is
    // unaffected by `welcome_dismissed_at` and the extra DB write would be
    // dead weight on this test.
    await signInAs(page, { tenant: 'eligible' });

    const provisionResult = await provisionParticipantFromPage(page);
    expect(provisionResult.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);

    await page.goto('/profile');
    // `profile.heading` from en.json.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Feature 002 surfaces — matches catalog, match detail, expanded TZ picker.
  // ---------------------------------------------------------------------------

  /**
   * Spec source: `specs/002-match-catalog/spec.md` — US-MA (catalog browse).
   *
   * Scope: `/matches` rendered against a 5-row seed that spans two stages
   * (`group` x3, `round-of-16` x2) and three group letters. This guarantees
   * `<MatchFilters>` renders the full chip surface (stage select with
   * multiple options, group select with multiple options, team select) — the
   * filter chips are the highest-value new a11y surface introduced by feature
   * 002 and are not exercised by the existing returning-user dashboard test.
   *
   * The participant TZ is pinned to `Europe/Tallinn` (matches the matches-
   * browse spec) so the day-bucket headers render in a known locale-stable
   * shape; the kickoffs are spaced across three calendar days so multiple
   * `<h2>` day-section headings are mounted (a11y-relevant: heading order +
   * `section[aria-labelledby]` wiring).
   */
  test('/matches (seeded catalog with filter chips) has no a11y violations', async ({
    page,
  }) => {
    const serviceRole = getServiceRoleClient();
    const [eng, fra, ger, ita, esp] = await pickFiveTeamUuids(serviceRole);

    // Kickoffs anchored relative to NOW so the seed stays stable regardless
    // of when the suite runs. Five matches across three distinct days so the
    // page mounts ≥ 3 day-bucket `<h2>` headings.
    const now = new Date();
    const atUtc = (daysFromNow: number, hours: number, minutes: number): string => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + daysFromNow);
      d.setUTCHours(hours, minutes, 0, 0);
      return d.toISOString();
    };

    await seedA11yMatches(serviceRole, [
      {
        providerId: 8201,
        homeTeamId: eng,
        awayTeamId: fra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: atUtc(5, 18, 0),
        status: 'scheduled',
      },
      {
        providerId: 8202,
        homeTeamId: ger,
        awayTeamId: ita,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: atUtc(5, 21, 0),
        status: 'scheduled',
      },
      {
        providerId: 8203,
        homeTeamId: esp,
        awayTeamId: eng,
        stage: 'group',
        groupLabel: 'B',
        kickoffUtc: atUtc(6, 15, 0),
        status: 'scheduled',
      },
      {
        providerId: 8204,
        homeTeamId: fra,
        awayTeamId: ger,
        stage: 'round-of-16',
        groupLabel: null,
        kickoffUtc: atUtc(10, 18, 0),
        status: 'scheduled',
      },
      {
        providerId: 8205,
        homeTeamId: ita,
        awayTeamId: esp,
        stage: 'round-of-16',
        groupLabel: null,
        kickoffUtc: atUtc(11, 18, 0),
        status: 'scheduled',
      },
    ]);

    await signInProvisionAndPinTz(page);

    await page.goto('/matches');
    // `matches.pageHeading` from en.json — same assertion shape as the other
    // tests in this file (heading visibility, not loadstate).
    await expect(
      page.getByRole('heading', { level: 1, name: 'Matches' }),
    ).toBeVisible();
    // Sanity: confirm the filter surface AND at least one match card mounted
    // before axe runs, otherwise the audit would silently scan an unfiltered
    // empty-state page and report a misleading clean result.
    await expect(page.locator('main a[href^="/matches/"]').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  /**
   * Spec source: `specs/002-match-catalog/spec.md` — US-MA (catalog detail) +
   * FR-M10 (ticking countdown on `/matches/[id]`).
   *
   * Scope: `/matches/[id]` for a single seeded `scheduled` match whose
   * kickoff sits well in the future (T+5 days). Picking `scheduled` is
   * deliberate — `MatchDetailCard` branches on status and ONLY mounts the
   * `<LockCountdownTicker>` (Client Component, `setInterval`) for non-
   * terminal, non-TBD matches. Terminal (`finished` / `cancelled`) and `tbd`
   * matches bypass the ticker, so a test against those statuses would miss
   * the live-region/countdown a11y surface entirely.
   *
   * The match detail page has no `<h1>`; the back-link is the most stable
   * post-hydration marker and is also the only interactive footer element on
   * the page, so asserting on it doubles as a render-completion gate.
   */
  test('/matches/[id] (scheduled match with live countdown) has no a11y violations', async ({
    page,
  }) => {
    const serviceRole = getServiceRoleClient();
    const [eng, fra] = await pickFiveTeamUuids(serviceRole);

    // Single match, T+5 days at 18:00 UTC, status='scheduled'. T+5d is far
    // enough past the 60-min lock window that the ticker mounts in the
    // UPCOMING state (badge text + countdown both rendered) — that's the
    // richest a11y surface the detail page offers.
    const kickoff = new Date();
    kickoff.setUTCDate(kickoff.getUTCDate() + 5);
    kickoff.setUTCHours(18, 0, 0, 0);

    const [seeded] = await seedA11yMatches(serviceRole, [
      {
        providerId: 8206,
        homeTeamId: eng,
        awayTeamId: fra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: kickoff.toISOString(),
        status: 'scheduled',
      },
    ]);

    await signInProvisionAndPinTz(page);

    await page.goto(`/matches/${seeded!.id}`);
    // No <h1> on the detail page; the back-link is the canonical stable
    // marker (rendered last in `MatchDetailCard`, so its presence proves the
    // whole article — header, score, dl, badge/ticker — has mounted).
    await expect(
      page.getByRole('link', { name: 'Back to matches' }),
    ).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  /**
   * Spec source: `specs/002-match-catalog/spec.md` — FR-M15 (TimezonePicker
   * on `/profile`).
   *
   * Scope: `/profile` with the TimezonePicker's listbox EXPANDED. The
   * already-present `/profile has no a11y violations` test above covers the
   * default (closed) state of the picker; the WAI-ARIA combobox carries the
   * bulk of its a11y surface in the OPEN state — `<ul role="listbox">` with
   * `<li role="option">` children, `aria-expanded="true"` on the input,
   * `aria-activedescendant` wiring to the highlighted option, and the
   * `aria-label` on the listbox. This test is the value-add for that
   * expanded surface.
   *
   * How the picker is opened: `TimezonePicker.handleInputFocus` opens the
   * listbox on input focus (verified in TimezonePicker.tsx — `openListbox()`
   * fires inside the focus handler). A single `combobox.click()` focuses the
   * input AND fires the focus handler, so the listbox opens without any
   * additional keypress. We then wait for `aria-expanded="true"` to flip on
   * the combobox AND for the `role="listbox"` element to be visible before
   * running axe — both checks together guarantee the open-state DOM has
   * settled (the picker uses a deferred-blur teardown, so asserting on just
   * one of these would race the close path).
   */
  test('/profile (TimezonePicker open, listbox expanded) has no a11y violations', async ({
    page,
  }) => {
    await signInProvisionAndPinTz(page);

    await page.goto('/profile');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Your profile' }),
    ).toBeVisible();

    // Open the listbox by focusing the combobox. The picker opens on focus
    // (TimezonePicker.tsx `handleInputFocus` → `openListbox()`), so a plain
    // click is enough — no keypress / typing needed. Asserting expanded ARIA
    // state AND listbox visibility before scanning rules out the closed-state
    // race the picker's deferred-blur teardown would otherwise allow.
    const combobox = page.getByRole('combobox');
    await expect(combobox).toBeVisible();
    await combobox.click();
    await expect(combobox).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('listbox')).toBeVisible();
    // Confirm the listbox actually has option children mounted — otherwise
    // we'd be scanning an empty listbox shell and missing the per-option
    // aria-selected / id wiring that's the whole point of the open-state
    // audit.
    await expect(page.getByRole('option').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
