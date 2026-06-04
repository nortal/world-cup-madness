import { describe, it, expect } from '@jest/globals';

import { formatStageHref, parseStage } from '../stage-url-state';

describe('parseStage', () => {
  it('returns "all" for null', () => {
    expect(parseStage(null)).toBe('all');
  });

  it('returns "all" for undefined', () => {
    expect(parseStage(undefined)).toBe('all');
  });

  it('returns "all" for empty string', () => {
    expect(parseStage('')).toBe('all');
  });

  it('returns "group" for "group"', () => {
    expect(parseStage('group')).toBe('group');
  });

  it('returns "all" for uppercase (case-sensitive)', () => {
    expect(parseStage('GROUP')).toBe('all');
  });

  it('returns "all" for unknown value', () => {
    expect(parseStage('invalid')).toBe('all');
  });

  it('returns "final" for "final"', () => {
    expect(parseStage('final')).toBe('final');
  });

  it('returns "r16" for "r16"', () => {
    expect(parseStage('r16')).toBe('r16');
  });

  it('returns "quarter" for "quarter"', () => {
    expect(parseStage('quarter')).toBe('quarter');
  });

  it('returns "semi" for "semi"', () => {
    expect(parseStage('semi')).toBe('semi');
  });
});

describe('formatStageHref', () => {
  it('produces base href without page when undefined', () => {
    expect(formatStageHref('all')).toBe('/leaderboard?stage=all');
  });

  it('omits page=1', () => {
    expect(formatStageHref('quarter', 1)).toBe('/leaderboard?stage=quarter');
  });

  it('appends page=N when N > 1', () => {
    expect(formatStageHref('group', 2)).toBe('/leaderboard?stage=group&page=2');
  });

  it('appends page=99 for late pages', () => {
    expect(formatStageHref('final', 99)).toBe('/leaderboard?stage=final&page=99');
  });
});
