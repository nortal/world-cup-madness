import { describe, expect, it } from '@jest/globals';

import { lockBadgeState, type LockBadge, type MatchStatus } from '../lock-badge';

/**
 * Unit tests for the FR-M08 lock-badge derivation helper.
 *
 * The helper is pure (kickoff + status + now → badge), so these tests
 * exercise every branch — including the BR-LOCK-003-inverted boundary at
 * exactly kickoff − 60min — without spinning up Postgres or Next.js.
 *
 * Sister coverage:
 *   - The pgTAP suite (`test/pgtap/`) pins the DB CHECK that NULL kickoff
 *     can only co-exist with status='scheduled-tbd'.
 *   - Playwright (`e2e/tests/`) covers the rendered badge as part of the
 *     match-catalog page flow.
 *   - These tests pin the boundary semantics so a regression surfaces
 *     instantly without waiting for the slower suites.
 */
describe('lockBadgeState', () => {
  // A fixed "now" so every test is deterministic. The exact wall-clock value
  // doesn't matter — only the offset between `now` and `kickoff` drives the
  // result.
  const NOW = new Date('2026-06-15T12:00:00.000Z');

  /** Helper: build a kickoff at `nowOffsetMs` relative to NOW. */
  const kickoffAt = (nowOffsetMs: number): Date => new Date(NOW.getTime() + nowOffsetMs);

  describe('terminal statuses', () => {
    it('returns FINISHED when status is "finished", regardless of kickoff', () => {
      // Past kickoff
      expect(lockBadgeState(kickoffAt(-24 * 60 * 60 * 1000), 'finished', NOW)).toBe('FINISHED');
      // Future kickoff (nonsensical but the status still wins)
      expect(lockBadgeState(kickoffAt(24 * 60 * 60 * 1000), 'finished', NOW)).toBe('FINISHED');
    });

    it('returns FINISHED when status is "cancelled", regardless of kickoff', () => {
      expect(lockBadgeState(kickoffAt(-60 * 60 * 1000), 'cancelled', NOW)).toBe('FINISHED');
      expect(lockBadgeState(kickoffAt(7 * 24 * 60 * 60 * 1000), 'cancelled', NOW)).toBe(
        'FINISHED',
      );
    });
  });

  describe('live status', () => {
    it('returns LOCKED for status "live" regardless of kickoff offset', () => {
      // Kickoff in the future (clock skew) — still LOCKED because live wins.
      expect(lockBadgeState(kickoffAt(2 * 60 * 60 * 1000), 'live', NOW)).toBe('LOCKED');
      // Kickoff already in the past — also LOCKED.
      expect(lockBadgeState(kickoffAt(-30 * 60 * 1000), 'live', NOW)).toBe('LOCKED');
    });
  });

  describe('TBD (NULL kickoff)', () => {
    it('returns UPCOMING for status "scheduled-tbd" with NULL kickoff', () => {
      expect(lockBadgeState(null, 'scheduled-tbd', NOW)).toBe('UPCOMING');
    });

    it('defensively returns UPCOMING (without throwing) for NULL kickoff with non-TBD status', () => {
      // This is an invalid state per the DB CHECK constraint; the helper
      // must not throw because crashing a server render for a data-integrity
      // bug elsewhere would be worse than showing a slightly stale badge.
      expect(() => lockBadgeState(null, 'scheduled', NOW)).not.toThrow();
      expect(lockBadgeState(null, 'scheduled', NOW)).toBe('UPCOMING');
    });
  });

  describe('60-minute boundary (BR-LOCK-003 inverted)', () => {
    it('kickoff EXACTLY 60 minutes in the future → LOCKED (inclusive boundary)', () => {
      expect(lockBadgeState(kickoffAt(60 * 60 * 1000), 'scheduled', NOW)).toBe('LOCKED');
    });

    it('kickoff 1 second BEYOND the 60-minute window → UPCOMING', () => {
      // 60min + 1s in the future — strictly outside the lock window.
      expect(lockBadgeState(kickoffAt(60 * 60 * 1000 + 1000), 'scheduled', NOW)).toBe('UPCOMING');
    });

    it('kickoff 1 second INSIDE the 60-minute window → LOCKED', () => {
      // 60min − 1s in the future — just inside the lock window.
      expect(lockBadgeState(kickoffAt(60 * 60 * 1000 - 1000), 'scheduled', NOW)).toBe('LOCKED');
    });
  });

  describe('temporal extremes', () => {
    it('kickoff 24h in the future with status "scheduled" → UPCOMING', () => {
      expect(lockBadgeState(kickoffAt(24 * 60 * 60 * 1000), 'scheduled', NOW)).toBe('UPCOMING');
    });

    it('kickoff 7 days in the past with status "scheduled" → LOCKED (negative remaining is still ≤ window)', () => {
      // Negative `remaining` is still ≤ LOCK_WINDOW_MS, so an un-updated
      // past kickoff stays LOCKED until the provider ticks it forward.
      expect(lockBadgeState(kickoffAt(-7 * 24 * 60 * 60 * 1000), 'scheduled', NOW)).toBe('LOCKED');
    });
  });

  describe('all-paths smoke', () => {
    // Sanity sweep: every MatchStatus enum member must produce a known badge
    // for a sane kickoff (well-future for non-TBD, NULL for TBD). If a new
    // status is ever added to the enum without updating the helper, the
    // type system catches the missing branch — and this test catches any
    // silent fallback that returns the wrong badge.
    const cases: Array<{ status: MatchStatus; kickoff: Date | null; expected: LockBadge }> = [
      { status: 'scheduled', kickoff: kickoffAt(24 * 60 * 60 * 1000), expected: 'UPCOMING' },
      { status: 'scheduled-tbd', kickoff: null, expected: 'UPCOMING' },
      { status: 'live', kickoff: kickoffAt(24 * 60 * 60 * 1000), expected: 'LOCKED' },
      { status: 'finished', kickoff: kickoffAt(-24 * 60 * 60 * 1000), expected: 'FINISHED' },
      { status: 'cancelled', kickoff: kickoffAt(-24 * 60 * 60 * 1000), expected: 'FINISHED' },
    ];

    it.each(cases)('status "$status" → $expected', ({ status, kickoff, expected }) => {
      expect(lockBadgeState(kickoff, status, NOW)).toBe(expected);
    });
  });
});
