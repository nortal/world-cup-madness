import { describe, it, expect } from '@jest/globals';

import { formatStageHref, parseStage, stageMatchLabels } from '../stage-url-state';

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

describe('stageMatchLabels', () => {
  it('maps "group" to single long-form label', () => {
    expect(stageMatchLabels('group')).toEqual(['group']);
  });

  it('maps "r16" to "round-of-16"', () => {
    expect(stageMatchLabels('r16')).toEqual(['round-of-16']);
  });

  it('maps "quarter" to "quarter-final"', () => {
    expect(stageMatchLabels('quarter')).toEqual(['quarter-final']);
  });

  it('maps "semi" to "semi-final"', () => {
    expect(stageMatchLabels('semi')).toEqual(['semi-final']);
  });

  it('maps "final" to both "final" AND "third-place" (MV aggregation rule)', () => {
    // The MV's `final` stage aggregates both real-tournament stages because
    // the third-place match's points roll up under the same UI tab.
    expect(stageMatchLabels('final')).toEqual(['final', 'third-place']);
  });

  it('maps "all" to every tournament stage long-form label', () => {
    expect(stageMatchLabels('all')).toEqual([
      'group',
      'round-of-16',
      'quarter-final',
      'semi-final',
      'final',
      'third-place',
    ]);
  });
});
