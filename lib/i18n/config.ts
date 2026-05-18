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
 * Locale cookie name set by the top-level middleware (T032) after resolving
 * the Accept-Language header. Read here so server-rendered messages match the
 * locale used for routing decisions.
 */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (locales as readonly string[]).includes(value);
}

/**
 * next-intl 4.x request loader. Resolves the locale set by middleware,
 * narrows it against the supported set, falls back to `defaultLocale`, and
 * dynamically imports the matching JSON catalog.
 *
 * `requestLocale` is a Promise in 4.x — must be awaited.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale: Locale = isLocale(requested) ? requested : defaultLocale;

  const messages = (await import(`./messages/${locale}.json`)).default;

  return { locale, messages };
});
