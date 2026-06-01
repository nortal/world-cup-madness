import { describe, expect, it } from '@jest/globals';

import { defaultLocale, isLocale, locales } from '../locales';

/**
 * Unit tests for the narrowing type guard that the middleware uses to
 * validate cookie values before trusting them. Pure function — no
 * dependencies on `NextRequest`, `next/headers`, etc.
 */
describe('isLocale', () => {
  it('accepts every supported locale verbatim', () => {
    for (const locale of locales) {
      expect(isLocale(locale)).toBe(true);
    }
  });

  it('accepts the defaultLocale', () => {
    expect(isLocale(defaultLocale)).toBe(true);
  });

  it.each([
    ['unknown locale', 'fr'],
    ['English variant we do not list', 'en-GB'],
    ['Spanish variant we do not list', 'es-MX'],
    ['empty string', ''],
    ['cookie noise', 'cookie-was-corrupted'],
  ])('rejects %s (%s)', (_label, value) => {
    expect(isLocale(value)).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isLocale(value)).toBe(false);
  });

  it('is case-sensitive (matches Locale union exactly)', () => {
    // `Locale` is `'en' | 'es' | 'pt-BR'` — `pt-br` is NOT a member, so the
    // guard must reject it. The middleware normalizes case before testing
    // against locales; isLocale itself should not do that normalization.
    expect(isLocale('pt-br')).toBe(false);
    expect(isLocale('EN')).toBe(false);
  });
});
