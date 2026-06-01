import { describe, expect, it } from '@jest/globals';

import { resolveLocaleFromAcceptLanguage } from '../accept-language';

/**
 * Unit tests for the Accept-Language + cookie resolver used by the top-level
 * middleware. The resolver is pure (string in, locale out), so these tests
 * exercise every branch without spinning up Next.js.
 *
 * Sister coverage:
 *   - `e2e/tests/i18n-locale-detection.spec.ts` validates the end-to-end
 *     contract through Playwright by setting the browser's locale option.
 *   - These tests pin the matcher logic so a regression here surfaces
 *     instantly without waiting for the slower Playwright run.
 */
describe('resolveLocaleFromAcceptLanguage', () => {
  describe('cookie precedence', () => {
    it('returns the cookie value when it is a supported locale (no header lookup)', () => {
      expect(resolveLocaleFromAcceptLanguage(null, 'es')).toBe('es');
      expect(resolveLocaleFromAcceptLanguage('en-US,en;q=0.9', 'pt-BR')).toBe('pt-BR');
    });

    it('ignores an unsupported cookie value and falls through to the header', () => {
      expect(resolveLocaleFromAcceptLanguage('es-ES,es;q=0.9', 'fr')).toBe('es');
      expect(resolveLocaleFromAcceptLanguage('es-ES,es;q=0.9', 'pt-br')).toBe('es');
    });

    it('falls back to defaultLocale when both cookie and header are absent', () => {
      expect(resolveLocaleFromAcceptLanguage(null, null)).toBe('en');
    });
  });

  describe('Accept-Language matching', () => {
    it('exact match wins (pt-BR → pt-BR)', () => {
      expect(resolveLocaleFromAcceptLanguage('pt-BR', null)).toBe('pt-BR');
    });

    it('is case-insensitive on tags (PT-br → pt-BR)', () => {
      expect(resolveLocaleFromAcceptLanguage('PT-br', null)).toBe('pt-BR');
    });

    it('falls back to base language (es-ES → es, en-US → en)', () => {
      expect(resolveLocaleFromAcceptLanguage('es-ES', null)).toBe('es');
      expect(resolveLocaleFromAcceptLanguage('en-US', null)).toBe('en');
    });

    it('maps bare pt (no region) to pt-BR', () => {
      expect(resolveLocaleFromAcceptLanguage('pt', null)).toBe('pt-BR');
    });

    it('returns defaultLocale for fully unsupported languages', () => {
      expect(resolveLocaleFromAcceptLanguage('ja-JP', null)).toBe('en');
      expect(resolveLocaleFromAcceptLanguage('de,fr;q=0.5', null)).toBe('en');
    });
  });

  describe('q-value precedence', () => {
    it('picks the highest q-value match, not the first listed', () => {
      // ja first but q=1 default; es appears with q=0.9, still wins because
      // ja is unsupported and the resolver scans tags in q-order.
      expect(resolveLocaleFromAcceptLanguage('ja-JP,es;q=0.9,en;q=0.8', null)).toBe('es');
    });

    it('treats missing q as 1 (highest)', () => {
      // Both "en" and "es" present; "en" has no q (defaults to 1), "es" q=0.9.
      // "en" should win.
      expect(resolveLocaleFromAcceptLanguage('en,es;q=0.9', null)).toBe('en');
    });

    it('handles malformed q gracefully (treats as q=0)', () => {
      // The `es;q=not-a-number` entry should sink to the bottom, so the
      // valid en;q=0.5 entry wins.
      expect(resolveLocaleFromAcceptLanguage('es;q=not-a-number,en;q=0.5', null)).toBe('en');
    });

    it('skips empty and whitespace-only tags', () => {
      expect(resolveLocaleFromAcceptLanguage(',  ,en-US', null)).toBe('en');
    });
  });

  describe('cookie + header combined edge cases', () => {
    it('cookie wins even when the header would resolve to a different locale', () => {
      expect(resolveLocaleFromAcceptLanguage('es-ES', 'en')).toBe('en');
    });

    it('unsupported cookie + unsupported header → defaultLocale', () => {
      expect(resolveLocaleFromAcceptLanguage('ja-JP', 'fr')).toBe('en');
    });

    it('empty cookie string is treated as no cookie (falls through to header)', () => {
      expect(resolveLocaleFromAcceptLanguage('pt-BR', '')).toBe('pt-BR');
    });
  });
});
