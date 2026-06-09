import { describe, it, expect } from '@jest/globals';

import {
  computeDigestSummary,
  startOfCurrentWeekUTC,
  type WeeklyEvent,
} from '../weekly-digest';

describe('startOfCurrentWeekUTC', () => {
  it('returns the same day at 00:00 UTC when given a Monday', () => {
    /* 2026-06-08 is a Monday. */
    const monday = new Date('2026-06-08T12:00:00Z');
    const result = startOfCurrentWeekUTC(monday);
    expect(result.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('rolls back 6 days when given a Sunday (end of week)', () => {
    /* 2026-06-14 is a Sunday — previous Monday is 2026-06-08. */
    const sunday = new Date('2026-06-14T23:59:00Z');
    const result = startOfCurrentWeekUTC(sunday);
    expect(result.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('rolls back to Monday when given a midweek Wednesday', () => {
    /* 2026-06-10 is a Wednesday → 2026-06-08 Monday. */
    const wed = new Date('2026-06-10T12:00:00Z');
    const result = startOfCurrentWeekUTC(wed);
    expect(result.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('handles a Saturday at the end of the week', () => {
    /* 2026-06-13 is a Saturday → 2026-06-08 Monday. */
    const sat = new Date('2026-06-13T08:30:00Z');
    const result = startOfCurrentWeekUTC(sat);
    expect(result.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });

  it('returns a UTC midnight even when input has fractional time', () => {
    const earlyTuesday = new Date('2026-06-09T00:00:01Z');
    const result = startOfCurrentWeekUTC(earlyTuesday);
    expect(result.toISOString()).toBe('2026-06-08T00:00:00.000Z');
  });
});

describe('computeDigestSummary', () => {
  it('returns zeros and nulls for an empty event list', () => {
    expect(computeDigestSummary([])).toEqual({
      totalPoints: 0,
      matchCount: 0,
      bestSingleScore: null,
      worstSingleScore: null,
    });
  });

  it('aggregates a single match event correctly', () => {
    const events: WeeklyEvent[] = [{ points: 10, match_id: 'm1' }];
    expect(computeDigestSummary(events)).toEqual({
      totalPoints: 10,
      matchCount: 1,
      bestSingleScore: 10,
      worstSingleScore: 10,
    });
  });

  it('filters out final-prediction events (match_id === null) per FR-D13', () => {
    const events: WeeklyEvent[] = [
      { points: 10, match_id: 'm1' },
      { points: 20, match_id: null }, // final-prediction; must be excluded
    ];
    expect(computeDigestSummary(events)).toEqual({
      totalPoints: 10,
      matchCount: 1,
      bestSingleScore: 10,
      worstSingleScore: 10,
    });
  });

  it('returns all-zero / null when every event is a final-prediction', () => {
    const events: WeeklyEvent[] = [
      { points: 40, match_id: null },
      { points: 20, match_id: null },
    ];
    expect(computeDigestSummary(events)).toEqual({
      totalPoints: 0,
      matchCount: 0,
      bestSingleScore: null,
      worstSingleScore: null,
    });
  });

  it('reports equal best/worst when all scores tie', () => {
    const events: WeeklyEvent[] = [
      { points: 5, match_id: 'm1' },
      { points: 5, match_id: 'm2' },
    ];
    expect(computeDigestSummary(events)).toEqual({
      totalPoints: 10,
      matchCount: 2,
      bestSingleScore: 5,
      worstSingleScore: 5,
    });
  });

  it('reports correct best and worst for varied scores', () => {
    const events: WeeklyEvent[] = [
      { points: 10, match_id: 'm1' },
      { points: 5, match_id: 'm2' },
      { points: 0, match_id: 'm3' },
    ];
    expect(computeDigestSummary(events)).toEqual({
      totalPoints: 15,
      matchCount: 3,
      bestSingleScore: 10,
      worstSingleScore: 0,
    });
  });

  it('handles a mix of zero and positive match scores correctly', () => {
    const events: WeeklyEvent[] = [
      { points: 0, match_id: 'm1' },
      { points: 0, match_id: 'm2' },
      { points: 10, match_id: 'm3' },
    ];
    expect(computeDigestSummary(events)).toEqual({
      totalPoints: 10,
      matchCount: 3,
      bestSingleScore: 10,
      worstSingleScore: 0,
    });
  });

  it('keeps the match count accurate when mixing match-scoring and final-prediction events', () => {
    const events: WeeklyEvent[] = [
      { points: 10, match_id: 'm1' },
      { points: 50, match_id: null }, // final-prediction excluded
      { points: 5, match_id: 'm2' },
      { points: 30, match_id: null }, // final-prediction excluded
    ];
    expect(computeDigestSummary(events)).toEqual({
      totalPoints: 15,
      matchCount: 2,
      bestSingleScore: 10,
      worstSingleScore: 5,
    });
  });

  it('handles a long event list with mixed values', () => {
    const events: WeeklyEvent[] = [
      { points: 10, match_id: 'm1' },
      { points: 5, match_id: 'm2' },
      { points: 10, match_id: 'm3' },
      { points: 0, match_id: 'm4' },
      { points: 5, match_id: 'm5' },
    ];
    expect(computeDigestSummary(events)).toEqual({
      totalPoints: 30,
      matchCount: 5,
      bestSingleScore: 10,
      worstSingleScore: 0,
    });
  });
});
