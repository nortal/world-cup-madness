import { describe, it, expect } from '@jest/globals';

import { computeNeighborhoodWindow } from '../neighborhood-window';

describe('computeNeighborhoodWindow', () => {
  describe('small-pool clamp (totalParticipants < 11)', () => {
    it('returns the whole pool for a 5-participant pool with self mid-pool', () => {
      expect(computeNeighborhoodWindow(3, 5)).toEqual({
        startRank: 1,
        endRank: 5,
        sliceCount: 5,
        clampMode: 'small-pool',
      });
    });

    it('returns the whole pool at the 10-participant boundary (< 11)', () => {
      expect(computeNeighborhoodWindow(5, 10)).toEqual({
        startRank: 1,
        endRank: 10,
        sliceCount: 10,
        clampMode: 'small-pool',
      });
    });

    it('flips to top-clamp at exactly 11 participants (the boundary)', () => {
      expect(computeNeighborhoodWindow(5, 11)).toEqual({
        startRank: 1,
        endRank: 11,
        sliceCount: 11,
        clampMode: 'top',
      });
    });
  });

  describe('top clamp (selfRank ≤ 6)', () => {
    it('top-clamps when caller is rank 1 of a large pool', () => {
      expect(computeNeighborhoodWindow(1, 100)).toEqual({
        startRank: 1,
        endRank: 11,
        sliceCount: 11,
        clampMode: 'top',
      });
    });

    it('top-clamps at the upper boundary selfRank=6', () => {
      expect(computeNeighborhoodWindow(6, 20)).toEqual({
        startRank: 1,
        endRank: 11,
        sliceCount: 11,
        clampMode: 'top',
      });
    });
  });

  describe('centre window (default)', () => {
    it('returns the centre window at the lower boundary selfRank=7', () => {
      expect(computeNeighborhoodWindow(7, 20)).toEqual({
        startRank: 2,
        endRank: 12,
        sliceCount: 11,
        clampMode: 'centre',
      });
    });

    it('returns a centred window for a normal mid-pool case', () => {
      expect(computeNeighborhoodWindow(10, 30)).toEqual({
        startRank: 5,
        endRank: 15,
        sliceCount: 11,
        clampMode: 'centre',
      });
    });
  });

  describe('bottom clamp (selfRank + 5 ≥ totalParticipants)', () => {
    it('bottom-clamps at the exact boundary selfRank + 5 === totalParticipants', () => {
      expect(computeNeighborhoodWindow(15, 20)).toEqual({
        startRank: 10,
        endRank: 20,
        sliceCount: 11,
        clampMode: 'bottom',
      });
    });

    it('bottom-clamps at the last rank', () => {
      expect(computeNeighborhoodWindow(20, 20)).toEqual({
        startRank: 10,
        endRank: 20,
        sliceCount: 11,
        clampMode: 'bottom',
      });
    });

    it('bottom-clamps near the end of a large pool', () => {
      expect(computeNeighborhoodWindow(95, 100)).toEqual({
        startRank: 90,
        endRank: 100,
        sliceCount: 11,
        clampMode: 'bottom',
      });
    });
  });
});
