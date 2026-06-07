import { describe, it, expect } from '@jest/globals';

import { computeDelta } from '../compute-delta';

describe('computeDelta', () => {
  it('returns "first" with zero magnitude when previousRank is null (initial paint)', () => {
    expect(computeDelta(null, 12)).toEqual({ direction: 'first', magnitude: 0 });
  });

  it('returns "first" with zero magnitude when previousRank is null at rank 1', () => {
    // Defensive — null check must take precedence over any rank-1 shortcut.
    expect(computeDelta(null, 1)).toEqual({ direction: 'first', magnitude: 0 });
  });

  it('returns "flat" with zero magnitude when ranks are equal', () => {
    expect(computeDelta(10, 10)).toEqual({ direction: 'flat', magnitude: 0 });
  });

  it('returns "up" with the positive delta when current rank improves', () => {
    // Rank 12 -> rank 10: climbed 2 places.
    expect(computeDelta(12, 10)).toEqual({ direction: 'up', magnitude: 2 });
  });

  it('returns "down" with the positive delta when current rank drops', () => {
    // Rank 5 -> rank 8: lost 3 places.
    expect(computeDelta(5, 8)).toEqual({ direction: 'down', magnitude: 3 });
  });

  it('handles a large-magnitude drop', () => {
    // Edge case — late-round shuffle can move a participant tens of places.
    expect(computeDelta(50, 150)).toEqual({ direction: 'down', magnitude: 100 });
  });

  it('handles a one-place improvement to rank 1', () => {
    expect(computeDelta(2, 1)).toEqual({ direction: 'up', magnitude: 1 });
  });
});
