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

  /**
   * Feature 003 US-PB — `/predictions/final` with the top-scorer player
   * combobox OPEN. Mirrors the TimezonePicker open-state audit above: the
   * WAI-ARIA combobox carries its a11y surface (listbox + options +
   * aria-activedescendant) in the expanded state. We seed a couple of players
   * so the picker renders as the interactive combobox (not the disabled
   * placeholder), open it, and scan. The two team <select>s + the form are
   * scanned at the same time.
   */
  test('/predictions/final (player combobox open) has no a11y violations', async ({ page }) => {
    const serviceRole = getServiceRoleClient();
    const [eng] = await pickFiveTeamUuids(serviceRole);

    // Wholesale clear matches: `/predictions/final` enforces BR-LOCK-005 by
    // reading the GLOBALLY first non-cancelled match. A leaked,
    // already-kicked-off match from a prior sync spec would lock the page
    // and the combobox-open audit would never get to render the form.
    const matchesClear = await serviceRole
      .from('matches')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    if (matchesClear.error) {
      throw new Error(`predictions/final a11y test: matches clear failed: ${matchesClear.error.message}`);
    }

    // Seed a future match so the final-predictions window is OPEN (not locked).
    const kickoff = new Date();
    kickoff.setUTCDate(kickoff.getUTCDate() + 5);
    await seedA11yMatches(serviceRole, [
      { providerId: 8207, homeTeamId: eng, awayTeamId: eng, stage: 'group', groupLabel: null, kickoffUtc: kickoff.toISOString(), status: 'scheduled' },
    ]);
    // Seed players so the picker is interactive (FR-P11 active state).
    await serviceRole.from('players').delete().in('provider_player_id', [8801, 8802]);
    await serviceRole.from('players').insert([
      { provider_player_id: 8801, name: 'A11y Striker', position: 'Attacker', team_id: eng },
      { provider_player_id: 8802, name: 'A11y Keeper', position: 'Goalkeeper', team_id: eng },
    ]);

    await signInProvisionAndPinTz(page);
    await page.goto('/predictions/final');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Open the top-scorer combobox (data-testid from PlayerPickerCombobox).
    const combo = page.getByTestId('player-combobox-top_scorer');
    await expect(combo).toBeVisible();
    await combo.click();
    await combo.fill('A11y');
    // Scope the option lookup to the combobox's own listbox — the team
    // <select> elements also expose native <option>s (role=option) which would
    // otherwise match (and resolve to a hidden select option).
    const listbox = page.getByRole('listbox').first();
    await expect(listbox).toBeVisible();
    await expect(listbox.getByRole('option').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);

    // Cleanup the seeded players (matches cleaned by seedA11yMatches range reuse).
    await serviceRole.from('players').delete().in('provider_player_id', [8801, 8802]);
  });

  /**
   * Feature 003 US-PD — `/predictions/breakdown` with seeded score events.
   * Scans the breakdown <table> (caption, scope headers, <output> total).
   */
  test('/predictions/breakdown (with score events) has no a11y violations', async ({ page }) => {
    const serviceRole = getServiceRoleClient();
    const [eng, fra] = await pickFiveTeamUuids(serviceRole);

    const kickoff = new Date();
    kickoff.setUTCDate(kickoff.getUTCDate() + 5);
    const [seeded] = await seedA11yMatches(serviceRole, [
      { providerId: 8208, homeTeamId: eng, awayTeamId: fra, stage: 'group', groupLabel: 'A', kickoffUtc: kickoff.toISOString(), status: 'scheduled' },
    ]);

    const oid = await signInProvisionAndPinTz(page);
    const { data: participant } = await serviceRole.from('participants').select('id').eq('oid', oid).maybeSingle();

    // Predict + finish so a score_events row exists for the breakdown table.
    await serviceRole.from('predictions').insert({
      participant_id: participant!.id, match_id: seeded!.id, predicted_home_score: 2, predicted_away_score: 1,
    });
    await serviceRole.from('matches').update({ status: 'finished', score_home: 2, score_away: 1 }).eq('id', seeded!.id);

    await page.goto('/predictions/breakdown');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('table')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Feature 004 surfaces — `/leaderboard` (TC-L16 a11y sweep across states).
  //
  // Spec source: `specs/004-leaderboard/tasks.md` T041 + `acceptance-criteria.md`
  // TC-L16. The leaderboard has three structurally distinct render branches
  // (populated table + stage tabs + Show-my-rank button; pre-tournament empty
  // state with semantic <time> countdown and no tab strip; per-stage empty
  // state with the StageTabStrip mounted but the EmptyLeaderboardState body).
  // Each branch carries different a11y-relevant DOM, so all three need their
  // own scan; running axe against just one branch would silently miss the
  // others.
  //
  // The signed-in participant from `signInProvisionAndPinTz` appears as an
  // extra row in the populated branch (rank-of-1 with 0 pts after MV refresh)
  // — same pattern as `leaderboard-page.spec.ts:169` (expects 5 seeded + 1
  // self-row). That row is a11y-relevant: it renders the `data-self="true"`
  // marker and the screen-reader-only "Your rank" label that the Show-my-rank
  // button targets.
  // ---------------------------------------------------------------------------

  /**
   * TC-L16 (a) — `/leaderboard` POPULATED state.
   *
   * Seeds five participants with descending scores against one finished
   * group-stage match (8209), refreshes the MV, then audits the page with
   * the StageTabStrip + ranking table + Show-my-rank button + self-row all
   * mounted. This is the richest a11y surface the page offers.
   */
  test('/leaderboard (populated, 5 seeded participants) has no a11y violations', async ({
    page,
  }) => {
    const serviceRole = getServiceRoleClient();
    const [eng, fra] = await pickFiveTeamUuids(serviceRole);

    // Finished group-stage match in the past so the MV's stage CTE picks it up.
    const kickoff = new Date();
    kickoff.setUTCDate(kickoff.getUTCDate() - 1);
    const [seeded] = await seedA11yMatches(serviceRole, [
      {
        providerId: 8209,
        homeTeamId: eng,
        awayTeamId: fra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: kickoff.toISOString(),
        status: 'scheduled',
      },
    ]);
    // Originally this test promoted the match to `status='finished'`
    // with scores set. That trips the `matches_trigger_scoring` AFTER
    // UPDATE trigger (feature 003 migration 0030), which inserts
    // `no-prediction` 0-pt score_events for every active participant on
    // this match — colliding with the explicit score_events bypass-
    // inserts below on the partial unique index
    // `score_events_one_per_participant_match`. The collision left the
    // leaderboard MV empty and the populated branch never rendered.
    // Keep the match `scheduled` so the trigger doesn't fire; the MV
    // builds purely from `score_events` aggregations and doesn't care
    // about match status.

    // Seed 5 participants directly via the service role (RLS bypass) — same
    // shape as `leaderboard-page.spec.ts:seedParticipant`. The signed-in
    // participant added by `signInProvisionAndPinTz` below appears as a 6th
    // row at the bottom of the ranking (0 pts) — also a11y-scanned.
    const names = ['A11y Alice', 'A11y Bob', 'A11y Carol', 'A11y Dave', 'A11y Eve'];
    const points = [50, 40, 30, 20, 10];
    const seededIds: string[] = [];
    for (const name of names) {
      const oid = randomUUID();
      const email = `${oid}@nortal.com`;
      const { data: user } = await serviceRole.auth.admin.createUser({
        email,
        password: 'wcm-test-password-123',
        email_confirm: true,
        app_metadata: { tid: '00000000-0000-0000-0000-000000000000', oid, provider: 'azure' },
        user_metadata: { name, email },
      });
      const { data: participant } = await serviceRole
        .from('participants')
        .insert({
          auth_user_id: user!.user!.id,
          oid,
          email,
          display_name: name,
          status: 'active',
        })
        .select('id')
        .single();
      seededIds.push(participant!.id);
    }
    for (let i = 0; i < seededIds.length; i += 1) {
      await serviceRole.from('score_events').insert({
        participant_id: seededIds[i]!,
        match_id: seeded!.id,
        source: 'match-exact',
        points: points[i]!,
      });
    }
    // Admin-context refresh (caller_kind='admin' route — no gating predicate).
    await serviceRole.rpc('refresh_leaderboard' as never);

    await signInProvisionAndPinTz(page);

    await page.goto('/leaderboard');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Leaderboard' }),
    ).toBeVisible();
    // Sanity: confirm the ranking table mounted before axe runs (the other
    // two leaderboard branches do NOT mount a <table>, so this guard
    // discriminates the populated branch from a silent fall-through into the
    // empty state).
    await expect(page.locator('table')).toBeVisible();
    await expect(page.locator('table tbody tr').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  /**
   * TC-L16 (b) — `/leaderboard` PRE-TOURNAMENT empty state.
   *
   * No `score_events` rows exist anywhere (FR-L07 global short-circuit), and
   * one future scheduled match is seeded so the EmptyLeaderboardState renders
   * its semantic `<time dateTime="...">` countdown — that's the a11y-relevant
   * surface (date/time semantics + countdown live region) that the populated
   * branch does NOT exercise.
   *
   * The score_events wholesale clear mirrors the pattern from
   * `leaderboard-pre-tournament.spec.ts:clearAllScoreEvents` — `beforeEach`
   * already truncates participants/audit, but score_events has its own
   * lifecycle.
   */
  test('/leaderboard (pre-tournament empty state) has no a11y violations', async ({
    page,
  }) => {
    const serviceRole = getServiceRoleClient();
    const [eng, fra] = await pickFiveTeamUuids(serviceRole);

    // Wholesale clear score_events — the global pre-tournament short-circuit
    // (FR-L07) only fires when score_events is empty.
    const clear = await serviceRole
      .from('score_events')
      .delete()
      .neq('participant_id', '00000000-0000-0000-0000-000000000000');
    if (clear.error) {
      throw new Error(`pre-tournament a11y test: score_events clear failed: ${clear.error.message}`);
    }

    // One future scheduled match so the countdown body has a target. T+5d.
    const kickoff = new Date();
    kickoff.setUTCDate(kickoff.getUTCDate() + 5);
    kickoff.setUTCHours(18, 0, 0, 0);
    await seedA11yMatches(serviceRole, [
      {
        providerId: 8210,
        homeTeamId: eng,
        awayTeamId: fra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: kickoff.toISOString(),
        status: 'scheduled',
      },
    ]);

    await signInProvisionAndPinTz(page);

    await page.goto('/leaderboard');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Leaderboard' }),
    ).toBeVisible();
    // Sanity: confirm we're auditing the empty branch — no <table>, and the
    // semantic <time dateTime="..."> countdown element rendered.
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.locator('time[datetime]').first()).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  /**
   * TC-L16 (c) — `/leaderboard?stage=quarter` STAGE-FILTERED empty state.
   *
   * In-flight tournament with some finished group matches (so score_events
   * is non-empty and the GLOBAL pre-tournament short-circuit does NOT fire)
   * BUT the requested `stage=quarter` filter has no finished quarter-final
   * matches yet — so the PER-STAGE empty branch fires (LeaderboardPage.tsx
   * lines 166–215). That branch mounts the StageTabStrip + per-stage empty
   * countdown together; neither (a) nor (b) above exercises that DOM combo.
   *
   * Provider_id range owned by this test: 8210 is already taken by case (b)
   * in another test run, but `beforeEach` cleans the 8201..8210 range so the
   * reuse here is safe within this single test's scope. We use 8210 (group,
   * finished) + a quarter-final scheduled match at provider_id 8210's twin
   * by reusing the same id — wait, the range is exhausted. Use a fresh
   * non-overlapping pair by extending into the existing 8201..8210 ceiling:
   * 8209 (group, finished, scored) + 8210 (quarter-final, scheduled).
   */
  test('/leaderboard?stage=quarter (stage-filtered, no quarter matches yet) has no a11y violations', async ({
    page,
  }) => {
    const serviceRole = getServiceRoleClient();
    const [eng, fra, ger, ita] = await pickFiveTeamUuids(serviceRole);

    // Group match in the past — finished and scored so score_events is
    // non-empty (defeats the global pre-tournament short-circuit).
    const groupKickoff = new Date();
    groupKickoff.setUTCDate(groupKickoff.getUTCDate() - 1);
    // Quarter-final scheduled in the future so the per-stage empty branch
    // can render its `<EmptyLeaderboardState/>` countdown for the quarter.
    const quarterKickoff = new Date();
    quarterKickoff.setUTCDate(quarterKickoff.getUTCDate() + 14);
    quarterKickoff.setUTCHours(18, 0, 0, 0);

    const seeded = await seedA11yMatches(serviceRole, [
      {
        providerId: 8209,
        homeTeamId: eng,
        awayTeamId: fra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: groupKickoff.toISOString(),
        status: 'scheduled',
      },
      {
        providerId: 8210,
        homeTeamId: ger,
        awayTeamId: ita,
        stage: 'quarter-final',
        groupLabel: null,
        kickoffUtc: quarterKickoff.toISOString(),
        status: 'scheduled',
      },
    ]);
    const groupMatch = seeded[0]!;
    // Promote the group match to `finished` so the per-stage empty guard
    // sees that the tournament is in flight (not pre-tournament).
    await serviceRole
      .from('matches')
      .update({ status: 'finished', score_home: 1, score_away: 0 })
      .eq('id', groupMatch.id);

    // One participant + one score_event so score_events is non-empty
    // (global short-circuit defeated) but the `quarter` MV stage has zero
    // rows — the per-stage empty branch fires.
    const oid = randomUUID();
    const email = `${oid}@nortal.com`;
    const { data: user } = await serviceRole.auth.admin.createUser({
      email,
      password: 'wcm-test-password-123',
      email_confirm: true,
      app_metadata: { tid: '00000000-0000-0000-0000-000000000000', oid, provider: 'azure' },
      user_metadata: { name: 'A11y QF Seeder', email },
    });
    const { data: participant } = await serviceRole
      .from('participants')
      .insert({
        auth_user_id: user!.user!.id,
        oid,
        email,
        display_name: 'A11y QF Seeder',
        status: 'active',
      })
      .select('id')
      .single();
    await serviceRole.from('score_events').insert({
      participant_id: participant!.id,
      match_id: groupMatch.id,
      source: 'match-exact',
      points: 10,
    });
    await serviceRole.rpc('refresh_leaderboard' as never);

    await signInProvisionAndPinTz(page);

    await page.goto('/leaderboard?stage=quarter');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Leaderboard' }),
    ).toBeVisible();
    // Sanity: per-stage empty branch DOES render the StageTabStrip (unlike
    // the global pre-tournament branch) but does NOT render the <table>.
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByRole('tablist')).toBeVisible();
    // Quarter tab is the active one (aria-selected="true" via StageTabStrip).
    await expect(page.getByRole('tab', { selected: true })).toContainText(
      /Quarter/i,
    );

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Feature 005 US-DE T044 / TC-D14 — dashboard a11y sweep across 4 surfaces.
  // ---------------------------------------------------------------------------

  /**
   * Pre-mark welcome dismissed + give Self one 0-pt score_event so the
   * populated dashboard renders the live (rank-bearing) widget set.
   * Returns the Self participant_id for any follow-up seeding.
   */
  async function prepareDashboardParticipantWithScore(
    page: Page,
    providerId: number,
  ): Promise<string> {
    const oid = await signInProvisionAndPinTz(page);
    const serviceRole = getServiceRoleClient();
    const dismissedAt = new Date().toISOString();
    const { error: dismissErr } = await serviceRole
      .from('participants')
      .update({ welcome_dismissed_at: dismissedAt })
      .eq('oid', oid);
    if (dismissErr) throw new Error(`welcome dismiss failed: ${dismissErr.message}`);
    const { data: selfRow, error: selfErr } = await serviceRole
      .from('participants')
      .select('id')
      .eq('oid', oid)
      .single();
    if (selfErr || !selfRow) throw new Error(`Self lookup failed: ${selfErr?.message}`);
    const [eng, fra] = await pickFiveTeamUuids(getServiceRoleClient());
    const [seeded] = await seedA11yMatches(serviceRole, [
      {
        providerId,
        homeTeamId: eng,
        awayTeamId: fra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        status: 'scheduled',
      },
    ]);
    const { error: scoreErr } = await serviceRole.from('score_events').insert([
      { participant_id: selfRow.id, match_id: seeded.id, source: 'match-wrong', points: 0 },
    ]);
    if (scoreErr) throw new Error(`Self score insert failed: ${scoreErr.message}`);
    // Refresh MV so Self appears in leaderboard_snapshots — without this
    // the live widgets fall back to their empty branches even though
    // is_pre_tournament() correctly returns false.
    const { execSync } = await import('node:child_process');
    execSync(
      'docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;"',
      { stdio: 'pipe' },
    );
    return selfRow.id;
  }

  test('/dashboard (mobile, populated, tab=today) has no a11y violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await prepareDashboardParticipantWithScore(page, 8207);
    await page.goto('/dashboard?tab=today');
    await expect(page.getByRole('tablist')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/dashboard (mobile, populated, tab=pool) has no a11y violations', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await prepareDashboardParticipantWithScore(page, 8208);
    await page.goto('/dashboard?tab=pool');
    await expect(
      page.locator('#pool-panel section[aria-labelledby="neighborhood-heading"]'),
    ).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/dashboard (desktop, populated) has no a11y violations', async ({ page }) => {
    // Default chromium viewport ≈ 1280×720 → desktop grid renders both
    // Today + Pool widget sets simultaneously per the FR-D02 contract.
    await prepareDashboardParticipantWithScore(page, 8209);
    await page.goto('/dashboard');
    // Wait on the always-rendered greeting heading — the widget sections
    // each render twice (mobile panel + desktop grid) and only the
    // desktop copy is visible at this viewport; `.first()` would pick
    // the hidden mobile one.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });

  test('/dashboard (mobile, pre-tournament) has no a11y violations', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    const oid = await signInProvisionAndPinTz(page);
    const serviceRole = getServiceRoleClient();
    await serviceRole
      .from('participants')
      .update({ welcome_dismissed_at: new Date().toISOString() })
      .eq('oid', oid);
    // Seed only an upcoming match — no score_events → is_pre_tournament=true
    // → Pool widgets swap to PreTournamentPlaceholder. The beforeEach
    // already truncates score_events for us, but we belt-and-brace via
    // a wholesale clear inline.
    const { execSync } = await import('node:child_process');
    execSync(
      'docker exec supabase_db_world-cup-madness psql -U postgres -d postgres -c "TRUNCATE TABLE score_events RESTART IDENTITY CASCADE; REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;"',
      { stdio: 'pipe' },
    );
    const [eng, fra] = await pickFiveTeamUuids(serviceRole);
    await seedA11yMatches(serviceRole, [
      {
        providerId: 8210,
        homeTeamId: eng,
        awayTeamId: fra,
        stage: 'group',
        groupLabel: 'A',
        kickoffUtc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        status: 'scheduled',
      },
    ]);
    await page.goto('/dashboard?tab=pool');
    await expect(
      page
        .locator('#pool-panel section[aria-labelledby="neighborhood-heading"]')
        .getByText(/Awaiting the first match/i),
    ).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
});
