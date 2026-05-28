import { describe, it, expect } from '@jest/globals';

import {
  formatScoreSource,
  sumPoints,
  type ScoreEventSource,
  type BreakdownLocale,
} from '../scoring-display';

const ALL_SOURCES: ScoreEventSource[] = [
  'match-exact', 'match-outcome', 'match-wrong', 'no-prediction', 'match-cancelled',
  'final-champion', 'final-runner-up', 'final-top-scorer', 'final-best-player',
  'final-not-picked-champion', 'final-not-picked-runner-up',
  'final-not-picked-top-scorer', 'final-not-picked-best-player',
];

const LOCALES: BreakdownLocale[] = ['en', 'es', 'pt-BR'];

describe('formatScoreSource', () => {
  it.each(LOCALES)('returns a non-empty label for every source in %s', (locale) => {
    for (const source of ALL_SOURCES) {
      const label = formatScoreSource(source, locale);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('maps known sources to expected English labels', () => {
    expect(formatScoreSource('match-exact', 'en')).toBe('Exact score');
    expect(formatScoreSource('match-outcome', 'en')).toBe('Correct outcome');
    expect(formatScoreSource('no-prediction', 'en')).toBe('No prediction');
    expect(formatScoreSource('final-champion', 'en')).toBe('Champion');
    expect(formatScoreSource('final-not-picked-top-scorer', 'en')).toBe('Top scorer (not picked)');
  });

  it('produces distinct labels per locale for the same source', () => {
    const en = formatScoreSource('match-exact', 'en');
    const es = formatScoreSource('match-exact', 'es');
    const pt = formatScoreSource('match-exact', 'pt-BR');
    expect(new Set([en, es, pt]).size).toBe(3);
  });
});

describe('sumPoints', () => {
  it('returns 0 for an empty array', () => {
    expect(sumPoints([])).toBe(0);
  });

  it('sums a mixed set of score events', () => {
    expect(sumPoints([{ points: 10 }, { points: 5 }, { points: 0 }, { points: 20 }])).toBe(35);
  });

  it('handles a single row', () => {
    expect(sumPoints([{ points: 10 }])).toBe(10);
  });
});
