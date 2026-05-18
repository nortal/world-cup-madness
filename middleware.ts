import createMiddleware from 'next-intl/middleware';
import { type NextRequest, type NextResponse } from 'next/server';

import { defaultLocale, locales, LOCALE_COOKIE } from './lib/i18n/config';
import { updateSession } from './lib/supabase/middleware';

/**
 * next-intl middleware: resolves locale from the `Accept-Language` header (and
 * existing `NEXT_LOCALE` cookie) and writes the resolved locale back to the
 * cookie. `localePrefix: 'never'` means URLs do NOT carry a locale prefix
 * (ADR-008 / FR-A8). `localeDetection: true` enables Accept-Language sniffing
 * (NFR-A5).
 */
const intlMiddleware = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'never',
  localeDetection: true,
});

/**
 * Top-level middleware that chains next-intl Accept-Language detection (T028)
 * with Supabase session refresh (T026). Both must run on every matched
 * request:
 *   - next-intl writes the `NEXT_LOCALE` cookie so Server Components load the
 *     correct message catalog.
 *   - Supabase refreshes the auth session so downstream Server Components and
 *     Route Handlers see a non-expired user.
 *
 * Merge strategy: use the Supabase response as the base (it carries the
 * rotated auth cookies AND re-builds itself after cookie sink writes — see
 * `lib/supabase/middleware.ts` lines 36–48). Then copy next-intl's
 * `NEXT_LOCALE` cookie (plus any other Set-Cookie entries it emitted) onto
 * the base. Using the supabase response as the base preserves the most
 * security-critical cookies (the auth tokens) by default.
 */
export default async function middleware(request: NextRequest): Promise<NextResponse> {
  const intlResponse = intlMiddleware(request);
  const supabaseResponse = await updateSession(request);

  // Copy every cookie next-intl set (typically just NEXT_LOCALE) onto the
  // Supabase response so the browser receives both auth and locale cookies.
  intlResponse.cookies.getAll().forEach((cookie) => {
    supabaseResponse.cookies.set(cookie.name, cookie.value);
  });

  // Defensive fallback: if next-intl did not set the locale cookie for any
  // reason, seed it with the default so Server Components have a stable read.
  if (!supabaseResponse.cookies.get(LOCALE_COOKIE)) {
    supabaseResponse.cookies.set(LOCALE_COOKIE, defaultLocale);
  }

  return supabaseResponse;
}

/**
 * Run the middleware on every route EXCEPT:
 *   - Next.js internals (`_next/static`, `_next/image`)
 *   - The favicon
 *   - Any path that contains a `.` (assumed to be a static asset)
 * Auth API callbacks under `/auth/...` are intentionally matched so the
 * Supabase session-refresh side-effect runs after OAuth completes.
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.).*)'],
};
