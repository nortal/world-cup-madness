import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * `/access-denied` page (US2 / T045 — FR-002, FR-A7).
 *
 * Rendered after the OAuth callback determines the signed-in Microsoft
 * identity is NOT in the configured Nortal Entra tenant. By that point the
 * callback has already written the `auth.rejected` audit entry and cleared
 * any partial session, so this page is purely informational and contains
 * NO PII — it knows nothing about who the rejected user was.
 *
 * Also reachable directly without authentication (FR-A7 / TC-edge case
 * "user navigates directly to /access-denied"): renders as a generic
 * informational page without revealing any error state.
 *
 * Server Component — no `'use client'`, no client-side auth checks.
 * Lock / eligibility status always comes from the server (constitution
 * §IV.1 Frontend).
 *
 * The "Sign in with a different account" CTA points at `/auth/sign-out`,
 * which clears the local Supabase session and redirects to `/` so the user
 * can re-initiate OAuth with a different Microsoft account. Implemented as a
 * `<Link>` GET because the sign-out route handler accepts GET specifically
 * for this affordance (see `app/auth/sign-out/route.ts`); no CSRF concern,
 * because sign-out is idempotent and unauthenticated requests are a no-op.
 *
 * Translation namespace: `accessDenied` (keys: `heading`, `body`,
 * `retryLabel`, `contact`). The message keys themselves are added by US2 /
 * T046 (parallel task); this file references them by name only.
 *
 * The `<PrivacyLink />` affordance (FR-A10) is added by US7 / T069; the
 * footer slot below is intentionally left as a placeholder comment so the
 * follow-up task only edits the footer area.
 */
export default async function Page() {
  const t = await getTranslations('accessDenied');

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="w-full max-w-md space-y-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-base text-gray-600">{t('body')}</p>
        <div className="flex justify-center pt-2">
          <Link
            href="/auth/sign-out"
            aria-label={t('retryLabel')}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            {t('retryLabel')}
          </Link>
        </div>
        <p className="pt-2 text-sm text-gray-500">{t('contact')}</p>
        {/* Footer slot for <PrivacyLink /> — added by US7 / T069 (FR-A10). */}
        <footer className="pt-8" />
      </section>
    </main>
  );
}
