import { describe, it, expect } from '@jest/globals';

import { formatRank } from '../format-rank';

describe('formatRank', () => {
  it('renders a unique rank as the plain number', () => {
    expect(formatRank(1, false)).toBe('1');
  });

  it('renders a shared rank with a trailing `=` suffix', () => {
    expect(formatRank(1, true)).toBe('1=');
  });

  it('handles two-digit shared ranks', () => {
    expect(formatRank(99, true)).toBe('99=');
  });

  it('handles a unique mid-range rank', () => {
    expect(formatRank(42, false)).toBe('42');
  });

  it('handles rank 0 defensively (no negative-sign quirks)', () => {
    // The MV's RANK() starts at 1 so 0 should never appear in production,
    // but the helper must be total — no throws, no special-casing.
    expect(formatRank(0, false)).toBe('0');
  });

  it('handles a shared rank with a 3-digit value', () => {
    expect(formatRank(150, true)).toBe('150=');
  });
});
