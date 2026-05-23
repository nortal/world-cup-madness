import { getTranslations } from 'next-intl/server';
import PrivacyLink from '@/components/auth/PrivacyLink';
import SignInButton from '@/components/auth/SignInButton';

/**
 * Public landing page for World Cup Madness (US1 / T036, US7 / T069).
 *
 * Server Component — no client-side state. Renders the project headline, a
 * one-line description, the Microsoft sign-in CTA, and a footer-slot
 * `<PrivacyLink />` (FR-A10 placement A — the unauthenticated entry point for
 * the privacy notice; the second placement is inside the welcome modal per
 * T070).
 *
 * Translation namespace: `landing` for the page surface; `<PrivacyLink />`
 * owns its own `privacy.linkLabel` lookup.
 */
export default async function Page() {
  const t = await getTranslations('landing');

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <section className="w-full max-w-md space-y-6 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{t('headline')}</h1>
        <p className="text-base text-gray-600">{t('description')}</p>
        <div className="flex justify-center pt-2">
          <SignInButton />
        </div>
        <footer className="pt-8">
          <PrivacyLink />
        </footer>
      </section>
    </main>
  );
}
