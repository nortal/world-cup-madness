import { describe, expect, it } from '@jest/globals';

import { dayBucket } from '../day-bucket';

/**
 * Unit tests for the pure `dayBucket` helper used by the `/matches` catalog
 * browse view. The helper is pure (instant + tz + locale + now in,
 * `{bucketKey, bucketLabel, offsetFromToday}` out), so these tests exercise
 * every branch without spinning up Next.js or `Intl` polyfills.
 *
 * Sister coverage:
 *   - The cross-TZ contract is the JS-side counterpart to TC-M9 in
 *     specs/002-match-catalog-read/spec.md — the Playwright E2E for that
 *     scenario verifies the rendered headers, while these tests pin the
 *     calculation that produces them.
 *   - Lock-state badges are *not* tested here — they belong to a separate
 *     server-rendered helper, not the day-bucket grouping logic.
 */
describe('dayBucket', () => {
  describe('adjacent-day labels (offset -1 / 0 / +1)', () => {
    it('returns "Today" / "Hoy" / "Hoje" when kickoff falls on the local "today"', () => {
      // 14:00 UTC on 2026-06-15; participant in UTC; now also 12:00 UTC same day.
      const kickoff = new Date('2026-06-15T14:00:00Z');
      const now = new Date('2026-06-15T12:00:00Z');

      const en = dayBucket(kickoff, 'UTC', 'en', now);
      expect(en.offsetFromToday).toBe(0);
      expect(en.bucketLabel).toBe('Today');
      expect(en.bucketKey).toBe('2026-06-15');

      expect(dayBucket(kickoff, 'UTC', 'es', now).bucketLabel).toBe('Hoy');
      expect(dayBucket(kickoff, 'UTC', 'pt-BR', now).bucketLabel).toBe('Hoje');
    });

    it('returns "Tomorrow" / "Mañana" / "Amanhã" when kickoff is one local day after now', () => {
      const kickoff = new Date('2026-06-16T14:00:00Z');
      const now = new Date('2026-06-15T12:00:00Z');

      const en = dayBucket(kickoff, 'UTC', 'en', now);
      expect(en.offsetFromToday).toBe(1);
      expect(en.bucketLabel).toBe('Tomorrow');
      expect(en.bucketKey).toBe('2026-06-16');

      expect(dayBucket(kickoff, 'UTC', 'es', now).bucketLabel).toBe('Mañana');
      expect(dayBucket(kickoff, 'UTC', 'pt-BR', now).bucketLabel).toBe('Amanhã');
    });

    it('returns "Yesterday" / "Ayer" / "Ontem" when kickoff is one local day before now', () => {
      const kickoff = new Date('2026-06-14T14:00:00Z');
      const now = new Date('2026-06-15T12:00:00Z');

      const en = dayBucket(kickoff, 'UTC', 'en', now);
      expect(en.offsetFromToday).toBe(-1);
      expect(en.bucketLabel).toBe('Yesterday');
      expect(en.bucketKey).toBe('2026-06-14');

      expect(dayBucket(kickoff, 'UTC', 'es', now).bucketLabel).toBe('Ayer');
      expect(dayBucket(kickoff, 'UTC', 'pt-BR', now).bucketLabel).toBe('Ontem');
    });
  });

  describe('explicit-weekday labels (|offset| > 1)', () => {
    it('uses the localised long weekday + month + day for a 7-days-out kickoff (en)', () => {
      // 2026-06-15 (Mon) + 7 days = 2026-06-22 (Mon).
      const kickoff = new Date('2026-06-22T18:00:00Z');
      const now = new Date('2026-06-15T12:00:00Z');

      const bucket = dayBucket(kickoff, 'UTC', 'en', now);
      expect(bucket.offsetFromToday).toBe(7);
      expect(bucket.bucketKey).toBe('2026-06-22');
      // Format is "Monday, June 22" in en — assert weekday + numeric day are present.
      expect(bucket.bucketLabel).toMatch(/Monday/);
      expect(bucket.bucketLabel).toMatch(/22/);
    });

    it('uses the localised long weekday + month + day in es and pt-BR for a 7-days-out kickoff', () => {
      const kickoff = new Date('2026-06-22T18:00:00Z');
      const now = new Date('2026-06-15T12:00:00Z');

      const es = dayBucket(kickoff, 'UTC', 'es', now);
      // es weekday for Monday is "lunes"; numeric day "22" still appears.
      expect(es.bucketLabel.toLowerCase()).toMatch(/lunes/);
      expect(es.bucketLabel).toMatch(/22/);

      const pt = dayBucket(kickoff, 'UTC', 'pt-BR', now);
      // pt-BR weekday for Monday is "segunda-feira"; numeric day "22" appears.
      expect(pt.bucketLabel.toLowerCase()).toMatch(/segunda/);
      expect(pt.bucketLabel).toMatch(/22/);
    });
  });

  describe('cross-TZ scenario (TC-M9)', () => {
    it('produces different bucketKeys for Tallinn vs São Paulo viewing the same kickoff', () => {
      // Kickoff at 23:00 UTC on 2026-06-13.
      //  - Tallinn (UTC+3 in summer) sees it at 02:00 on 2026-06-14.
      //  - São Paulo (UTC-3) sees it at 20:00 on 2026-06-13.
      const kickoff = new Date('2026-06-13T23:00:00Z');
      const now = new Date('2026-06-13T12:00:00Z');

      const tallinn = dayBucket(kickoff, 'Europe/Tallinn', 'en', now);
      const saoPaulo = dayBucket(kickoff, 'America/Sao_Paulo', 'en', now);

      // Different local dates → different grouping keys.
      expect(tallinn.bucketKey).toBe('2026-06-14');
      expect(saoPaulo.bucketKey).toBe('2026-06-13');
      expect(tallinn.bucketKey).not.toBe(saoPaulo.bucketKey);

      // Offset math agrees with the calendar:
      //   For Tallinn, "now" (15:00 local on 2026-06-13) and kickoff
      //   (02:00 local on 2026-06-14) are 1 calendar day apart → "Tomorrow".
      //   For São Paulo, "now" (09:00 local on 2026-06-13) and kickoff
      //   (20:00 local on 2026-06-13) are the same calendar day → "Today".
      expect(tallinn.offsetFromToday).toBe(1);
      expect(tallinn.bucketLabel).toBe('Tomorrow');
      expect(saoPaulo.offsetFromToday).toBe(0);
      expect(saoPaulo.bucketLabel).toBe('Today');
    });
  });

  describe('DST boundary', () => {
    it('returns sensible adjacent-day values across a DST spring-forward in America/Los_Angeles', () => {
      // 2026 spring-forward in America/Los_Angeles is Sun 2026-03-08
      // (02:00 local jumps to 03:00). Use kickoff just after the transition
      // and "now" the day before — the clock skips an hour but the calendar
      // delta is still exactly one day.
      const kickoff = new Date('2026-03-08T18:00:00Z'); // 10:00 PST → 11:00 PDT local
      const now = new Date('2026-03-07T20:00:00Z'); // 12:00 PST local on Sat 2026-03-07

      const bucket = dayBucket(kickoff, 'America/Los_Angeles', 'en', now);
      expect(bucket.offsetFromToday).toBe(1);
      expect(bucket.bucketLabel).toBe('Tomorrow');
      expect(bucket.bucketKey).toBe('2026-03-08');
    });

    it('returns sensible adjacent-day values across a DST fall-back in America/Los_Angeles', () => {
      // 2026 fall-back is Sun 2026-11-01 (02:00 PDT → 01:00 PST). The day
      // is 25 hours long locally, but the calendar still advances by one
      // day from Saturday to Sunday.
      const kickoff = new Date('2026-11-01T20:00:00Z'); // 12:00 PST local on Sun
      const now = new Date('2026-10-31T19:00:00Z'); // 12:00 PDT local on Sat

      const bucket = dayBucket(kickoff, 'America/Los_Angeles', 'en', now);
      expect(bucket.offsetFromToday).toBe(1);
      expect(bucket.bucketLabel).toBe('Tomorrow');
      expect(bucket.bucketKey).toBe('2026-11-01');
    });
  });

  describe('bucket-key stability', () => {
    it('returns identical bucketKey for two matches on the same local day at different times', () => {
      // Two kickoffs on the same UTC calendar day at very different hours.
      const earlyKickoff = new Date('2026-06-15T06:00:00Z');
      const lateKickoff = new Date('2026-06-15T22:00:00Z');
      const now = new Date('2026-06-15T12:00:00Z');

      const early = dayBucket(earlyKickoff, 'UTC', 'en', now);
      const late = dayBucket(lateKickoff, 'UTC', 'en', now);

      expect(early.bucketKey).toBe(late.bucketKey);
      expect(early.bucketKey).toBe('2026-06-15');
      // Both also bucket as "Today" for grouping purposes.
      expect(early.offsetFromToday).toBe(0);
      expect(late.offsetFromToday).toBe(0);
    });
  });

  describe('invalid timezone fallback', () => {
    it('does not throw and falls back to UTC for an unknown IANA zone', () => {
      const kickoff = new Date('2026-06-15T14:00:00Z');
      const now = new Date('2026-06-15T12:00:00Z');

      // Helper must NOT throw — caller-side logging is policy from spec §3.
      expect(() => dayBucket(kickoff, 'Invalid/Zone', 'en', now)).not.toThrow();

      const bucket = dayBucket(kickoff, 'Invalid/Zone', 'en', now);
      // Falling back to UTC means the bucketKey matches the UTC date of the
      // kickoff exactly — `2026-06-15` in this case.
      expect(bucket.bucketKey).toBe('2026-06-15');
      expect(bucket.offsetFromToday).toBe(0);
      expect(bucket.bucketLabel).toBe('Today');
    });
  });

  describe('all locales return distinct adjacent-day labels', () => {
    it('produces three different "Today" strings across en / es / pt-BR', () => {
      const kickoff = new Date('2026-06-15T14:00:00Z');
      const now = new Date('2026-06-15T12:00:00Z');

      const en = dayBucket(kickoff, 'UTC', 'en', now).bucketLabel;
      const es = dayBucket(kickoff, 'UTC', 'es', now).bucketLabel;
      const ptBR = dayBucket(kickoff, 'UTC', 'pt-BR', now).bucketLabel;

      // Defends against accidentally using the same string for all three
      // locales (a regression that would compile and pass type checks).
      expect(en).not.toBe(es);
      expect(en).not.toBe(ptBR);
      expect(es).not.toBe(ptBR);
    });
  });
});
