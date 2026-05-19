import { getTranslations } from 'next-intl/server';
import SignInButton from '@/components/auth/SignInButton';

/**
 * Public landing page for World Cup Madness (US1 / T036).
 *
 * Server Component — no client-side state. Renders the project headline, a
 * one-line description, and the Microsoft sign-in CTA. The `<PrivacyLink />`
 * affordance (FR-A10) is added in US7 / T069; the footer slot below is
 * intentionally left as a placeholder so that follow-up task only edits the
 * footer area, not the page surface.
 *
 * Translation namespace: `landing` (see `lib/i18n/messages/{en,es,pt-BR}.json`).
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
        {/* Footer slot for <PrivacyLink /> — added by US7 / T069 (FR-A10). */}
        <footer className="pt-8" />
      </section>
    </main>
  );
}
