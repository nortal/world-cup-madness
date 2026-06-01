import { describe, expect, it } from '@jest/globals';

import {
  derivePredictionOutcome,
  validatePrediction,
  type MatchOutcome,
} from '../validate-prediction';

/**
 * Unit tests for the FR-P06 client-side prediction validator and the
 * shared `derivePredictionOutcome` helper.
 *
 * Sister coverage:
 *   - pgTAP (`test/pgtap/`) pins the server-side CHECK constraints on
 *     the predictions table (predictions_home_range / predictions_away_range).
 *   - Playwright (`e2e/tests/`) covers the `<PredictionForm/>` flow.
 *   - These tests pin the pure-math boundaries so a regression in either
 *     helper surfaces instantly without spinning up Postgres or the UI.
 */
describe('validatePrediction', () => {
  describe('happy path', () => {
    const validCases: Array<[number, number]> = [
      [0, 0],
      [5, 3],
      [10, 10],
      [20, 20],
    ];

    it.each(validCases)('(%i, %i) → ok', (home, away) => {
      expect(validatePrediction(home, away)).toEqual({ ok: true });
    });
  });

  describe('OUT_OF_RANGE', () => {
    const outOfRangeCases: Array<[number, number]> = [
      [-1, 0],
      [0, -1],
      [21, 0],
      [0, 21],
      [100, 100],
    ];

    it.each(outOfRangeCases)('(%i, %i) → OUT_OF_RANGE', (home, away) => {
      expect(validatePrediction(home, away)).toEqual({
        ok: false,
        errorCode: 'OUT_OF_RANGE',
        message: 'Score must be between 0 and 20',
      });
    });

    it('Number.MAX_SAFE_INTEGER fails as OUT_OF_RANGE, not NOT_INTEGER', () => {
      expect(validatePrediction(Number.MAX_SAFE_INTEGER, 0)).toEqual({
        ok: false,
        errorCode: 'OUT_OF_RANGE',
        message: 'Score must be between 0 and 20',
      });
    });
  });

  describe('NOT_INTEGER', () => {
    const notIntegerCases: Array<[number, number]> = [
      [1.5, 0],
      [0, Number.NaN],
      [Number.POSITIVE_INFINITY, 0],
      [0, Number.NEGATIVE_INFINITY],
    ];

    it.each(notIntegerCases)('(%s, %s) → NOT_INTEGER', (home, away) => {
      expect(validatePrediction(home, away)).toEqual({
        ok: false,
        errorCode: 'NOT_INTEGER',
        message: 'Score must be an integer',
      });
    });
  });
});

describe('derivePredictionOutcome', () => {
  describe('home-win', () => {
    const homeWinCases: Array<[number, number]> = [
      [3, 1],
      [1, 0],
      [20, 0],
    ];

    it.each(homeWinCases)('(%i, %i) → home-win', (home, away) => {
      expect(derivePredictionOutcome(home, away)).toBe('home-win');
    });
  });

  describe('away-win', () => {
    const awayWinCases: Array<[number, number]> = [
      [0, 1],
      [1, 3],
    ];

    it.each(awayWinCases)('(%i, %i) → away-win', (home, away) => {
      expect(derivePredictionOutcome(home, away)).toBe('away-win');
    });
  });

  describe('draw', () => {
    const drawCases: Array<[number, number]> = [
      [0, 0],
      [5, 5],
      [10, 10],
    ];

    it.each(drawCases)('(%i, %i) → draw', (home, away) => {
      expect(derivePredictionOutcome(home, away)).toBe('draw');
    });
  });

  describe('contract with validatePrediction', () => {
    // For every (home, away) pair that validates ok, derivePredictionOutcome
    // must return one of the three enum values exactly — never undefined,
    // never throw. Sweeps the full legal 0..20 × 0..20 = 441 cell grid.
    it('returns one of the three enum members for every validated pair', () => {
      const allowed: ReadonlySet<MatchOutcome> = new Set(['home-win', 'away-win', 'draw']);

      for (let home = 0; home <= 20; home++) {
        for (let away = 0; away <= 20; away++) {
          const validation = validatePrediction(home, away);
          expect(validation.ok).toBe(true);

          const outcome = derivePredictionOutcome(home, away);
          expect(allowed.has(outcome)).toBe(true);
        }
      }
    });
  });
});
