import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

/**
 * Trilingual launch per ADR-008 / FR-A8: English, Spanish, Brazilian Portuguese.
 * Locale selection is driven by the browser `Accept-Language` header in the
 * top-level `middleware.ts` (T032); URLs do NOT carry a locale prefix.
 */
export const locales = ['en', 'es', 'pt-BR'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

/**
 * Locale cookie name. Written by the top-level middleware (T032) after
 * resolving the Accept-Language header; read here so server-rendered
 * messages match the locale the middleware picked. We use the same name
 * (`NEXT_LOCALE`) that next-intl uses by convention — Playwright tests and
 * future tooling that inspect the cookie still see the expected value.
 */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/**
 * Narrowing type guard. Exported so the middleware can validate a cookie
 * value (which arrives as `string | undefined`) before relying on it.
 */
export function isLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && (locales as readonly string[]).includes(value);
}

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
