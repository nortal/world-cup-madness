import { type NextRequest, type NextResponse } from 'next/server';

import { defaultLocale, isLocale, LOCALE_COOKIE, locales, type Locale } from './lib/i18n/config';
import { updateSession } from './lib/supabase/middleware';

/**
 * Resolve the best locale for this request from cookie + Accept-Language.
 *
 * Precedence:
 *   1. An existing valid `NEXT_LOCALE` cookie (sticky once the user lands on
 *      a locale — they keep it across requests without re-running detection).
 *   2. The first Accept-Language tag whose primary subtag matches one of our
 *      supported locales. Exact match wins (`pt-BR` → `pt-BR`); otherwise
 *      base-language match (`es-ES` → `es`); special case `pt` (with no
 *      region subtag) → `pt-BR` since that is our only Portuguese variant.
 *   3. `defaultLocale` (English) as the fallback for any unsupported or
 *      missing input (NFR-A5).
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
function resolveLocale(request: NextRequest): Locale {
  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) return cookieLocale;

  const acceptLanguage = request.headers.get('accept-language');
  if (!acceptLanguage) return defaultLocale;

  // Parse `en-US,en;q=0.9,es;q=0.8` into a q-ordered list of language tags.
  const tags = acceptLanguage
    .split(',')
    .map((entry) => {
      const [rawTag, ...params] = entry.trim().split(';');
      const tag = rawTag.trim();
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number.parseFloat(qParam.split('=')[1]) : 1;
      return { tag, q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of tags) {
    const normalized = tag.toLowerCase();

    // Exact match first — `pt-BR` matches our `pt-BR` (case-insensitive).
    const exact = locales.find((l) => l.toLowerCase() === normalized);
    if (exact) return exact;

    // Base-language fallback: `es-ES` → `es`, `en-US` → `en`. Take the part
    // before the first `-`.
    const base = normalized.split('-')[0];
    const baseMatch = locales.find((l) => l.toLowerCase() === base);
    if (baseMatch) return baseMatch;

    // Special case: bare `pt` (no region) → `pt-BR` (our only PT variant).
    if (base === 'pt') return 'pt-BR';
  }

  return defaultLocale;
}

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
  const locale = resolveLocale(request);
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
