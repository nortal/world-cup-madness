/**
 * Playwright E2E test — T074 (NFR-A5) for US8 / i18n locale detection.
 *
 * Requirement chain:
 *   - NFR-A5 (Accept-Language sniffing): supported locales (en, es, pt-BR) are
 *     detected from the browser-sent `Accept-Language` header and rendered
 *     server-side; unsupported locales fall back to the default (en).
 *   - FR-A8 (trilingual launch): the app ships with full message catalogs for
 *     English, Spanish, and Brazilian Portuguese — no per-route locale prefix.
 *   - ADR-008 (next-intl with `localePrefix: 'never'`): URLs are
 *     locale-agnostic; the resolved locale lives in the `NEXT_LOCALE` cookie
 *     set by the top-level `middleware.ts` after sniffing `Accept-Language`.
 *
 * Scope (per T074 in tasks.md):
 *   For each Accept-Language value `en`, `es`, `pt-BR`, navigate to `/`,
 *   `/access-denied`, `/auth-error`, `/privacy`, `/dashboard` (signed in), and
 *   `/profile` (signed in) and assert content matches the expected locale; then
 *   navigate with `Accept-Language: ja` and assert the English fallback.
 *
 * How `Accept-Language` reaches the server in this suite:
 *   Playwright's `browser.newContext({ locale })` option sets both
 *   `navigator.language` AND the `Accept-Language` request header on every
 *   navigation from that context. next-intl's BCP-47 matcher in
 *   `middleware.ts` then resolves the header value against
 *   `lib/i18n/config.ts#locales = ['en', 'es', 'pt-BR']`:
 *     - `en-US` → `en`            (language-only fallback)
 *     - `es-ES` → `es`            (language-only fallback)
 *     - `pt-BR` → `pt-BR`         (exact match)
 *     - `ja-JP` → `en` (default)  (no language match → defaultLocale)
 *   The resolved locale is persisted in the `NEXT_LOCALE` cookie which the
 *   `getRequestConfig` loader reads to pick the message catalog. Because URLs
 *   carry no locale prefix, the same path (e.g. `/privacy`) renders in
 *   different languages purely on the basis of the incoming header — that is
 *   exactly what this test exercises.
 *
 * Per-test browser contexts:
 *   Each test creates its own `BrowserContext` via `browser.newContext` so the
 *   `locale` option can be configured independently. Created contexts are
 *   closed in `finally` to avoid leaking resources across the serially-run
 *   suite (`playwright.config.ts` sets `workers: 1`, but leaks would still
 *   compound test-to-test).
 */

import { expect, test } from '@playwright/test';

import { signInAs } from '../fixtures/auth';
import { resetSupabaseState } from '../fixtures/db';

/**
 * One row per supported locale: the BCP-47 tag Playwright sends on the wire,
 * the next-intl-resolved locale we expect, and the literal strings we expect
 * to find on each surface. Strings are copied verbatim from
 * `lib/i18n/messages/{en,es,pt-BR}.json` — diacritics, em-dashes, and the
 * ellipsis character all matter to Playwright's accessible-name matcher.
 *
 * `greetingTemplate` is a function because `dashboard.greeting` is an ICU
 * MessageFormat string with a `{name}` placeholder — the runtime greeting
 * depends on the `displayName` returned by `signInAs`.
 */
const SUPPORTED_LOCALE_CASES = [
  {
    browserLocale: 'en-US',
    resolvedLocale: 'en' as const,
    signInLabel: 'Sign in with Microsoft',
    accessDeniedHeading: 'This pool is for Nortal collaborators',
    authErrorHeading: "Sign-in didn't complete",
    privacyHeading: 'Privacy notice',
    greetingTemplate: (name: string) => `Welcome, ${name}`,
    profileHeading: 'Your profile',
  },
  {
    browserLocale: 'es-ES',
    resolvedLocale: 'es' as const,
    signInLabel: 'Iniciar sesión con Microsoft',
    accessDeniedHeading: 'Este torneo es para colaboradores de Nortal',
    authErrorHeading: 'El inicio de sesión no se completó',
    privacyHeading: 'Aviso de privacidad',
    greetingTemplate: (name: string) => `Hola, ${name}`,
    profileHeading: 'Tu perfil',
  },
  {
    browserLocale: 'pt-BR',
    resolvedLocale: 'pt-BR' as const,
    signInLabel: 'Entrar com a Microsoft',
    accessDeniedHeading: 'Este torneio é para colaboradores da Nortal',
    authErrorHeading: 'O login não foi concluído',
    privacyHeading: 'Aviso de privacidade',
    greetingTemplate: (name: string) => `Olá, ${name}`,
    profileHeading: 'Seu perfil',
  },
] as const;

test.describe('NFR-A5: locale detection via Accept-Language', () => {
  for (const localeCase of SUPPORTED_LOCALE_CASES) {
    test(`Accept-Language: ${localeCase.browserLocale} → resolves to ${localeCase.resolvedLocale} across all surfaces`, async ({
      browser,
    }) => {
      // Reset DB state inside the test body (not just the suite-wide
      // `beforeEach`) because each iteration creates its own BrowserContext
      // and provisions its own participant row; the default `page` fixture's
      // beforeEach reset doesn't apply to contexts we open ourselves.
      await resetSupabaseState();

      // Setting `locale` on the context drives Playwright to send the BCP-47
      // tag in the `Accept-Language` header on every navigation — which is
      // the only signal next-intl needs to pick the right message catalog
      // (URLs carry no locale prefix under ADR-008).
      const context = await browser.newContext({ locale: localeCase.browserLocale });
      const page = await context.newPage();

      try {
        // --- Public surfaces (no auth required) -----------------------------
        // The landing page renders the sign-in button with the localized
        // label from `signIn.label` — a stable role-based selector that
        // survives styling refactors.
        await page.goto('/');
        await expect(
          page.getByRole('button', { name: localeCase.signInLabel }),
          `landing sign-in button must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();

        // `/access-denied` is the redirect target for ineligible-tenant
        // sign-ins (TC-5) — asserting its h1 confirms the redirect target
        // also honours Accept-Language sniffing.
        await page.goto('/access-denied');
        await expect(
          page.getByRole('heading', { level: 1, name: localeCase.accessDeniedHeading }),
          `/access-denied h1 must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();

        // `/auth-error` is the redirect target for OAuth callback failures
        // (TC-7). The English string uses a curly-free ASCII apostrophe
        // ("didn't") — keep the literal byte-for-byte match.
        await page.goto('/auth-error');
        await expect(
          page.getByRole('heading', { level: 1, name: localeCase.authErrorHeading }),
          `/auth-error h1 must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();

        // `/privacy` is the public privacy-notice surface reachable before
        // sign-in (US7 / FR-A7). It's intentionally locale-aware too.
        await page.goto('/privacy');
        await expect(
          page.getByRole('heading', { level: 1, name: localeCase.privacyHeading }),
          `/privacy h1 must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();

        // --- Authenticated surfaces -----------------------------------------
        // Sign in as a fresh eligible user inside this context so the
        // resulting Supabase session cookies live alongside the NEXT_LOCALE
        // cookie next-intl wrote during the public-surface navigations
        // above.
        const { displayName } = await signInAs(page, { tenant: 'eligible' });

        // Provision the participant row via the same RPC the production
        // `/auth/callback` Route Handler invokes — JWT injection bypasses
        // the callback, so we trigger the RPC explicitly. Pattern copied
        // verbatim from `auth-eligible-new-user.spec.ts` lines 59–81 (the
        // `@ts-expect-error` annotation is required because the CDN dynamic
        // import has no TS types in this context).
        const provisionResult = await page.evaluate(
          async ({ supabaseUrl, supabaseAnonKey }) => {
            const { createBrowserClient } = await import(
              // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
              'https://esm.sh/@supabase/ssr@0.10.3'
            );
            const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
            // Force the new client to hydrate the persisted session from
            // cookies before issuing the RPC. Without this the rpc call may
            // race ahead unauthenticated, since `createBrowserClient`
            // returns synchronously but the auth state hydrates
            // asynchronously.
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
        expect(
          provisionResult.ok,
          'provision_participant_from_jwt RPC must succeed before asserting authenticated surfaces',
        ).toBe(true);

        // The dashboard greeting uses next-intl's ICU MessageFormat
        // (`"Welcome, {name}"` etc.) — substitute the displayName at
        // runtime so the assertion matches the rendered heading exactly.
        await page.goto('/dashboard');
        await expect(
          page.getByRole('heading', { level: 1, name: localeCase.greetingTemplate(displayName) }),
          `dashboard greeting must render in ${localeCase.resolvedLocale} for ${displayName}`,
        ).toBeVisible();

        // `/profile` (US3) is a participant-only surface — verifying its h1
        // here confirms i18n flows through every authenticated route, not
        // just the dashboard landing page.
        await page.goto('/profile');
        await expect(
          page.getByRole('heading', { level: 1, name: localeCase.profileHeading }),
          `/profile h1 must render in ${localeCase.resolvedLocale}`,
        ).toBeVisible();
      } finally {
        // Always close the context — leaking contexts across the serial
        // suite would accumulate browser-process pressure across all
        // locale iterations.
        await context.close();
      }
    });
  }

  test('Accept-Language: ja-JP → falls back to English', async ({ browser }) => {
    // Per-test DB reset for the same reason as the supported-locale loop:
    // we create our own context and want the same isolation contract.
    await resetSupabaseState();

    // Japanese has no overlap with `locales = ['en', 'es', 'pt-BR']`, so
    // next-intl's BCP-47 matcher cannot resolve a supported tag and falls
    // back to `defaultLocale = 'en'`. The middleware writes `en` into
    // `NEXT_LOCALE`, and every downstream render uses the English catalog.
    const context = await browser.newContext({ locale: 'ja-JP' });
    const page = await context.newPage();

    try {
      // Two surfaces are enough to prove the fallback — the behavior is
      // uniform across all routes (it's the single `defaultLocale` branch
      // in `lib/i18n/config.ts`), so re-running the full 6-surface scan
      // would be redundant. Picking one public-button and one heading
      // surface covers both selector styles used in the supported-locale
      // tests.
      await page.goto('/');
      await expect(
        page.getByRole('button', { name: 'Sign in with Microsoft' }),
        'unsupported locale (ja-JP) must fall back to English on the landing page',
      ).toBeVisible();

      await page.goto('/privacy');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Privacy notice' }),
        'unsupported locale (ja-JP) must fall back to English on /privacy (not Aviso de privacidad / Aviso de privacidade)',
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
