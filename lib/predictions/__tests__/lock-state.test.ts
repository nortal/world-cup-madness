import { describe, expect, it } from '@jest/globals';

import { isPredictionLocked, lockCountdownMs } from '../lock-state';

/**
 * Unit tests for the US-PA prediction-form lock-state helper.
 *
 * The helper mirrors the server-side comparator in `submit_prediction()`
 * RPC (supabase/migrations/0028_prediction_rpcs.sql:80). The pgTAP suite
 * (`test/pgtap/017_prediction_rpcs.sql`) pins the SQL side; these tests
 * pin the TS side. Both must agree on the −60 / −61 / −59 boundary
 * triplet (BR-LOCK-002 + BR-LOCK-003).
 *
 * The Playwright spec at T032 covers the end-to-end RPC round-trip;
 * this test isolates the helper layer so a boundary regression surfaces
 * instantly without spinning up the full stack.
 *
 * Tests are deterministic — every call passes an explicit `nowUtc`
 * Date. No fake timers needed.
 *
 * See `specs/003-predictions-and-scoring/research.md` §R-8 for the
 * shared-helper rationale.
 */
describe('isPredictionLocked', () => {
  // Fixed "now" — exact wall-clock value is irrelevant; only the offset
  // between `now` and `kickoff` drives the result.
  const NOW = new Date('2026-06-15T12:00:00.000Z');

  /** Build a kickoff `offsetMs` relative to NOW. */
  const kickoffAt = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

  describe('60-minute boundary triplet (BR-LOCK-002 + BR-LOCK-003)', () => {
    it('returns LOCKED at exactly T-60min (strict-greater-than per BR-LOCK-003)', () => {
      // The load-bearing test. At exactly kickoff - 60 min remaining,
      // the lock IS engaged. Mirrors the SQL `<= interval '60 minutes'`.
      expect(isPredictionLocked(kickoffAt(60 * 60 * 1000), NOW)).toBe(true);
    });

    it('returns LOCKED at T-60min - 1ms (1 millisecond past the boundary, still locked)', () => {
      expect(isPredictionLocked(kickoffAt(60 * 60 * 1000 - 1), NOW)).toBe(true);
    });

    it('returns EDITABLE at T-60min + 1ms (1 millisecond inside the editable window)', () => {
      expect(isPredictionLocked(kickoffAt(60 * 60 * 1000 + 1), NOW)).toBe(false);
    });

    it('returns EDITABLE at T-61min (one whole minute inside the editable window)', () => {
      expect(isPredictionLocked(kickoffAt(61 * 60 * 1000), NOW)).toBe(false);
    });

    it('returns LOCKED at T-59min (one whole minute past the boundary)', () => {
      expect(isPredictionLocked(kickoffAt(59 * 60 * 1000), NOW)).toBe(true);
    });
  });

  describe('temporal extremes', () => {
    it('returns EDITABLE for a kickoff 5 days in the future', () => {
      expect(isPredictionLocked(kickoffAt(5 * 24 * 60 * 60 * 1000), NOW)).toBe(false);
    });

    it('returns LOCKED at kickoff (T-0)', () => {
      // remaining = 0, which is <= 60min window — locked.
      expect(isPredictionLocked(NOW, NOW)).toBe(true);
    });

    it('returns LOCKED for a kickoff in the past (negative remaining is still <= window)', () => {
      expect(isPredictionLocked(kickoffAt(-3 * 60 * 60 * 1000), NOW)).toBe(true);
    });
  });

  describe('safe defaults for invalid input', () => {
    it('returns LOCKED when kickoff is null (safe default)', () => {
      expect(isPredictionLocked(null, NOW)).toBe(true);
    });

    it('returns LOCKED when kickoff is undefined (safe default)', () => {
      expect(isPredictionLocked(undefined, NOW)).toBe(true);
    });

    it('returns LOCKED when kickoff is an unparseable string (safe default)', () => {
      expect(isPredictionLocked('not-a-date', NOW)).toBe(true);
    });
  });

  describe('input shape acceptance', () => {
    it('accepts an ISO 8601 string as kickoff', () => {
      // 5 days ahead as a string — should match the Date-typed equivalent.
      const isoFiveDays = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
      expect(isPredictionLocked(isoFiveDays, NOW)).toBe(false);
    });
  });
});

describe('lockCountdownMs', () => {
  const NOW = new Date('2026-06-15T12:00:00.000Z');
  const kickoffAt = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

  it('returns 0 at exactly T-60min (lock fires now)', () => {
    expect(lockCountdownMs(kickoffAt(60 * 60 * 1000), NOW)).toBe(0);
  });

  it('returns 60_000 at T-61min (one minute until lock)', () => {
    expect(lockCountdownMs(kickoffAt(61 * 60 * 1000), NOW)).toBe(60_000);
  });

  it('returns 600_000 at T-70min (ten minutes until lock)', () => {
    expect(lockCountdownMs(kickoffAt(70 * 60 * 1000), NOW)).toBe(600_000);
  });

  it('returns 0 for a kickoff in the past', () => {
    expect(lockCountdownMs(kickoffAt(-2 * 60 * 60 * 1000), NOW)).toBe(0);
  });

  it('returns 0 for a null kickoff (safe default)', () => {
    expect(lockCountdownMs(null, NOW)).toBe(0);
  });
});
