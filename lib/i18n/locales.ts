/**
 * Pure locale primitives — supported set, type, default, and a narrowing
 * type guard. Deliberately separated from `config.ts` (which pulls in
 * `next-intl/server` + `next/headers`) so unit tests can import these
 * helpers without spinning up the Next.js runtime.
 *
 * Trilingual launch per ADR-008 / FR-A8: English, Spanish, Brazilian
 * Portuguese. Locale selection is driven by the browser `Accept-Language`
 * header in the top-level `middleware.ts` (T032); URLs do NOT carry a
 * locale prefix.
 */

export const locales = ['en', 'es', 'pt-BR'] as const;

export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

/**
 * Locale cookie name. Written by the top-level middleware (T032) after
 * resolving the Accept-Language header; read by `getRequestConfig` so
 * server-rendered messages match the locale the middleware picked. We use
 * the same name (`NEXT_LOCALE`) that next-intl uses by convention.
 */
export const LOCALE_COOKIE = 'NEXT_LOCALE';

/**
 * Narrowing type guard. Used by the middleware to validate a cookie value
 * (which arrives as `string | undefined | null`) before relying on it, and
 * by the request-config loader to narrow the cookie read.
 */
export function isLocale(value: string | null | undefined): value is Locale {
  return value !== null && value !== undefined && (locales as readonly string[]).includes(value);
}
