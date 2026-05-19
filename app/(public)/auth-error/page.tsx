import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * `/auth-error` page (US3 / T050 — TC-10).
 *
 * Rendered when the OAuth callback could NOT complete because of a transient
 * problem on our side or the identity provider's side — for example a
 * Microsoft Entra 5xx, a state-cookie mismatch, a token-exchange error, or an
 * unexpected RPC failure inside `provision_participant_from_jwt()`. Distinct
 * from `/access-denied`, which is reserved for the eligibility-rejected
 * outcome (tenant mismatch).
 *
 * This is the redirect target when either:
 *   - `app/auth/callback/route.ts` (US1 / T038) hits its early-return paths
 *     (missing `code`, exchange failure, RPC error, unexpected shape, or the
 *     discriminated `outcome === 'error'` branch — `config.missing`); or
 *   - T051 (US3) adds a try/catch around `exchangeCodeForSession` and the
 *     `record_auth_failure('auth.provider-error', ...)` RPC, both of which
 *     also terminate at `/auth-error`.
 *
 * Because the OAuth exchange failed BEFORE we obtained the Supabase session
 * and JWT, we do not know who the user is — this page MUST render no PII and
 * MUST NOT imply user fault. The wording frames the problem as ours (TC-10)
 * and offers a single Retry CTA that re-initiates sign-in from the landing
 * page.
 *
 * Also reachable directly without authentication: renders as a generic
 * informational page without revealing any error state.
 *
 * Server Component — no `'use client'`, no client-side auth checks. Lock and
 * eligibility status always come from the server (constitution §IV.1
 * Frontend).
 *
 * Translation namespace: `authError` (keys: `heading`, `body`, `retryLabel`,
 * `contact`, `statusLinkLabel`). The message keys themselves are added by
 * US3 / T052 (parallel task); this file references them by name only.
 *
 * Service-status link slot: the `statusLinkLabel` placeholder anchor below
 * is intentionally rendered with `href="#"` so the team can wire it to a
 * real status page later without touching translation keys. If the team
 * decides not to expose a status page, the anchor can be removed in a
 * follow-up without breaking the surrounding layout.
 *
 * The `<PrivacyLink />` affordance (FR-A10) is added by US7 / T069; the
 * footer slot below is intentionally left as a placeholder comment so the
 * follow-up task only edits the footer area.
 */
export default async function Page() {
  const t = await getTranslations('authError');

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="w-full max-w-md space-y-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-base text-gray-600">{t('body')}</p>
        <div className="flex justify-center pt-2">
          <Link
            href="/"
            aria-label={t('retryLabel')}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            {t('retryLabel')}
          </Link>
        </div>
        <p className="pt-2 text-sm text-gray-500">{t('contact')}</p>
        {/*
         * Optional service-status link slot. The href is a placeholder (`#`)
         * until the team chooses a status page URL; only the localized label
         * is wired up today.
         */}
        <p className="text-sm text-gray-500">
          <a
            href="#"
            className="underline hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            {t('statusLinkLabel')}
          </a>
        </p>
        {/* Footer slot for <PrivacyLink /> — added by US7 / T069 (FR-A10). */}
        <footer className="pt-8" />
      </section>
    </main>
  );
}
