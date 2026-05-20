import { type NextRequest, type NextResponse } from 'next/server';

import { resolveLocaleFromAcceptLanguage } from './lib/i18n/accept-language';
import { LOCALE_COOKIE } from './lib/i18n/config';
import { updateSession } from './lib/supabase/middleware';

/**
 * Locale resolution lives in `lib/i18n/accept-language.ts` as a pure helper
 * (cookie + header in, locale out) so it can be unit-tested without faking
 * a `NextRequest`. The middleware below is just the I/O glue.
 *
 * Why we hand-roll this instead of using `next-intl/middleware`:
 * `createMiddleware({ localePrefix: 'never' })` still REWRITES every request
 * internally to `/[locale]/...` so Next.js can match it from a `[locale]`
 * folder. Our pages live directly at `app/(public)/`, `app/(participant)/`,
 * `app/auth/...` with no locale segment per ADR-008 (clean URLs without a
 * locale prefix). With next-intl in charge, every non-default-locale request
 * 404'd. This handler does the detection without rewriting the URL — see
 * commit message for the NFR-A5 regression history (2026-05-19).
 */

/**
 * Top-level middleware: runs Accept-Language detection (NFR-A5 / FR-A8) and
 * Supabase session refresh (T026) on every matched request.
 *
 * Order:
 *   1. Refresh the Supabase session first — `updateSession` rotates auth
 *      cookies onto its response. We use that as the base response so the
 *      browser persists the new tokens.
 *   2. Resolve the locale from cookie + Accept-Language and stamp the
 *      `NEXT_LOCALE` cookie. `getRequestConfig` (`lib/i18n/config.ts`) reads
 *      this cookie on the same request via `next/headers#cookies()`, so the
 *      resolved locale takes effect immediately — no second-request delay.
 *
 * The cookie write uses `Path: '/'` so every Server Component sees the same
 * value regardless of route depth.
 */
export default async function middleware(request: NextRequest): Promise<NextResponse> {
  const response = await updateSession(request);
  const locale = resolveLocaleFromAcceptLanguage(
    request.headers.get('accept-language'),
    request.cookies.get(LOCALE_COOKIE)?.value ?? null,
  );
  response.cookies.set(LOCALE_COOKIE, locale, { path: '/' });
  return response;
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
