import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

/**
 * Admin navigation link (US4 / T054 — TC-3, FR-A5).
 *
 * Server Component — renders a static `<Link>` to the (future) admin console.
 * The dashboard page (`app/(participant)/dashboard/page.tsx`) gates this
 * component on `participant.role === 'admin'`, so by the time it renders the
 * caller has already confirmed admin eligibility against the RLS-protected
 * participants row. This component itself does NOT re-check the role — its
 * sole responsibility is the link surface.
 *
 * The `/admin` route does not exist yet; T054 is intentionally a stub that
 * makes the admin role *visible* on the dashboard so TC-3 ("admin navigation
 * is visible on the dashboard") can pass end-to-end. The real admin console
 * is a future feature; clicking the link before that lands will 404, which
 * is acceptable for the stub.
 *
 * Styling matches the other primary CTAs in this feature (SignInButton,
 * access-denied / auth-error retry links) for visual consistency. The visible
 * text from the `dashboard.adminNavLabel` translation key is descriptive
 * enough on its own, so no extra `aria-label` is needed (Frontend
 * Constitution §VII — accessibility: don't duplicate the visible label).
 *
 * Translation namespace: `dashboard` (key: `adminNavLabel`).
 */
export default async function AdminNavLink() {
  const t = await getTranslations('dashboard');

  return (
    <Link
      href="/admin"
      className="inline-block rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
    >
      {t('adminNavLabel')}
    </Link>
  );
}
