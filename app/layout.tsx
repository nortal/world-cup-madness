import './globals.css';
import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';

export const metadata: Metadata = {
  title: 'World Cup Madness',
  description: 'Internal Nortal prediction pool for FIFA World Cup 2026',
};

/**
 * Root layout. Wraps the app in `NextIntlClientProvider` so Client Components
 * (e.g. `<SignInButton />`) can call `useTranslations()` — the provider reads
 * the locale + messages from the request config wired by `next.config.ts` /
 * `lib/i18n/config.ts` (T028). The `<html lang>` attribute is set from the
 * locale resolved by the chained middleware (T032).
 */
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();

  return (
    <html lang={locale}>
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
