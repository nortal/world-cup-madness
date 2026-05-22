import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from './locales';

// Re-export pure primitives so existing callers can keep their import path.
// New code can import directly from `./locales` to avoid pulling next-intl
// and next/headers into a test context.
export { defaultLocale, isLocale, LOCALE_COOKIE, locales } from './locales';
export type { Locale } from './locales';

/**
 * next-intl 4.x request loader. Reads the `NEXT_LOCALE` cookie that the
 * middleware just stamped — same-request because Next.js makes Server
 * Component cookie reads see writes from the current request's middleware.
 * Falls back to `defaultLocale` if the cookie is missing or invalid.
 *
 * Why we read the cookie directly instead of using next-intl's
 * `requestLocale`: that value comes from next-intl's URL rewrite, which we
 * deliberately bypass — our pages live outside a `[locale]` folder (see
 * `middleware.ts` for the architecture note). The cookie is the contract
 * between our middleware and this loader.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(raw) ? raw : defaultLocale;

  const messages = (await import(`./messages/${locale}.json`)).default;

  return { locale, messages };
});
