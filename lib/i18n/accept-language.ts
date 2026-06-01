import { defaultLocale, isLocale, locales, type Locale } from './locales';

/**
 * Resolve the best supported locale from a cookie value + an Accept-Language
 * header, in that order of precedence.
 *
 * Precedence rules:
 *   1. If `cookieLocale` is already one of our supported locales, return it
 *      verbatim. This makes the user's resolved locale "sticky" across
 *      requests — once set, we don't re-run Accept-Language detection on
 *      every navigation.
 *   2. Otherwise parse `acceptLanguage` (the raw HTTP header value),
 *      q-sort the tags, and return the first supported match:
 *        - Exact case-insensitive match (`pt-BR` → `pt-BR`).
 *        - Base-language fallback (`es-ES` → `es`, `en-US` → `en`).
 *        - Special case: bare `pt` (no region subtag) → `pt-BR`, since
 *          `pt-BR` is our only Portuguese variant.
 *   3. Fall back to `defaultLocale` (English) for missing or unsupported
 *      input — covers NFR-A5's "unsupported language falls back to
 *      English" requirement.
 *
 * Pure function: no side effects, no I/O, no `NextRequest` dependency.
 * Extracted from `middleware.ts` so it can be unit-tested directly.
 */
export function resolveLocaleFromAcceptLanguage(
  acceptLanguage: string | null,
  cookieLocale: string | null,
): Locale {
  if (isLocale(cookieLocale)) return cookieLocale;
  if (!acceptLanguage) return defaultLocale;

  // Parse `en-US,en;q=0.9,es;q=0.8` into a q-ordered list of language tags.
  // Tags with no explicit q-value default to q=1 per RFC 7231.
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

    // Exact match first — case-insensitive against our supported tags.
    const exact = locales.find((l) => l.toLowerCase() === normalized);
    if (exact) return exact;

    // Base-language fallback: take everything before the first `-`.
    const base = normalized.split('-')[0];
    const baseMatch = locales.find((l) => l.toLowerCase() === base);
    if (baseMatch) return baseMatch;

    // Special case: bare `pt` → `pt-BR` (our only Portuguese variant).
    if (base === 'pt') return 'pt-BR';
  }

  return defaultLocale;
}
