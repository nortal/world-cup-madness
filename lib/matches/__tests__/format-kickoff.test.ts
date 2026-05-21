import { describe, expect, it } from '@jest/globals';

import { formatKickoff, type Locale } from '../format-kickoff';

/**
 * Unit tests for the FR-M07 / NFR-M4 kickoff formatter.
 *
 * The helper is pure (UTC `Date` + IANA TZ + locale → display string),
 * so these tests exercise every locale branch, the TZ shift, and the
 * two edge cases (NULL kickoff, invalid TZ) without spinning up
 * Next.js or Postgres.
 *
 * Stability note: `Intl.DateTimeFormat` output is locale-data-driven and
 * can vary slightly across Node/V8 versions (NBSP vs regular space,
 * en-dash vs hyphen, etc.). We assert on substring presence via
 * `toContain(...)` rather than pinning the full string, so a benign ICU
 * data refresh doesn't break the suite.
 *
 * Sister coverage:
 *   - Playwright (`e2e/tests/match-catalog-*`) renders the column in a
 *     real browser; that covers Server Component wiring + i18n message
 *     resolution.
 *   - These tests pin the locale-conventions matrix so a regression
 *     surfaces instantly without the slower E2E run.
 */
describe('formatKickoff', () => {
  // A kickoff at 18:00 UTC on Saturday 13 June 2026 — the canonical
  // example from FR-M07. Tallinn (UTC+3 in summer, DST never applies
  // since Estonia uses EET/EEST) shifts this to 21:00 local.
  const KICKOFF = new Date('2026-06-13T18:00:00.000Z');
  const TALLINN = 'Europe/Tallinn';
  const SAO_PAULO = 'America/Sao_Paulo'; // UTC-3 year-round (no DST since 2019).

  describe('locale formatting (Tallinn = UTC+3 in June)', () => {
    it('en renders weekday + long date + 12-hour clock with AM/PM', () => {
      const out = formatKickoff(KICKOFF, TALLINN, 'en');
      expect(out).toContain('Saturday');
      expect(out).toContain('June');
      expect(out).toContain('13');
      expect(out).toContain('2026');
      // 18:00 UTC + 3h = 21:00 local → "9:00 PM" in 12-hour clock.
      expect(out).toContain('9:00');
      expect(out).toContain('PM');
    });

    it('es renders Spanish weekday/month + 24-hour clock', () => {
      const out = formatKickoff(KICKOFF, TALLINN, 'es');
      expect(out).toContain('sábado');
      expect(out).toContain('junio');
      expect(out).toContain('13');
      expect(out).toContain('2026');
      // 21:00 local in 24-hour clock — ICU may use "21:00" or "21.00"
      // depending on locale data; the hour is the stable bit.
      expect(out).toContain('21');
      // No AM/PM in Spanish 24-hour format.
      expect(out).not.toContain('PM');
      expect(out).not.toContain('AM');
    });

    it('pt-BR renders Portuguese weekday/month + 24-hour clock', () => {
      const out = formatKickoff(KICKOFF, TALLINN, 'pt-BR');
      expect(out).toContain('sábado');
      expect(out).toContain('junho');
      expect(out).toContain('13');
      expect(out).toContain('2026');
      expect(out).toContain('21');
      expect(out).not.toContain('PM');
      expect(out).not.toContain('AM');
    });
  });

  describe('timezone shifts the displayed wall-clock time', () => {
    // Sao Paulo is UTC-3, so 18:00 UTC renders as 15:00 local.
    it.each<[Locale, string, string]>([
      ['en', '3:00', 'PM'],
      ['es', '15', ''],
      ['pt-BR', '15', ''],
    ])('%s in America/Sao_Paulo shows the UTC-3 wall time', (locale, hour, suffix) => {
      const out = formatKickoff(KICKOFF, SAO_PAULO, locale);
      expect(out).toContain(hour);
      if (suffix) expect(out).toContain(suffix);
      // The date itself stays the same day because 15:00 local is still
      // on the same calendar day as 18:00 UTC.
      expect(out).toContain('2026');
    });
  });

  describe('edge cases', () => {
    it('returns an empty string when kickoffUtc is null', () => {
      // scheduled-tbd matches have NULL kickoff; the renderer wants an
      // empty cell, not "Invalid Date".
      expect(formatKickoff(null, TALLINN, 'en')).toBe('');
      expect(formatKickoff(null, TALLINN, 'es')).toBe('');
      expect(formatKickoff(null, TALLINN, 'pt-BR')).toBe('');
    });

    it('does not throw on an invalid IANA timezone and falls back to UTC', () => {
      // Silent fallback policy (spec.md §3): bad TZ → render the UTC
      // wall time rather than crash the page.
      let out = '';
      expect(() => {
        out = formatKickoff(KICKOFF, 'Invalid/Zone', 'en');
      }).not.toThrow();
      // UTC wall time for the canonical kickoff is 18:00 → "6:00 PM"
      // in the en (12-hour) format.
      expect(out).toContain('6:00');
      expect(out).toContain('PM');
      expect(out).toContain('2026');
    });

    it('is stable across repeated calls with identical args', () => {
      // Defensive: ensures we don't accidentally introduce time-dependent
      // state inside the formatter (e.g. `new Date()` lookups).
      const first = formatKickoff(KICKOFF, TALLINN, 'en');
      const second = formatKickoff(KICKOFF, TALLINN, 'en');
      expect(second).toBe(first);
    });

    it('returns distinct outputs across all three locales for the same inputs', () => {
      // Guards against a regression where the locale arg is dropped or
      // hard-coded — all three outputs must differ in at least one place.
      const en = formatKickoff(KICKOFF, TALLINN, 'en');
      const es = formatKickoff(KICKOFF, TALLINN, 'es');
      const ptBR = formatKickoff(KICKOFF, TALLINN, 'pt-BR');
      expect(en).not.toBe(es);
      expect(en).not.toBe(ptBR);
      expect(es).not.toBe(ptBR);
    });
  });
});
