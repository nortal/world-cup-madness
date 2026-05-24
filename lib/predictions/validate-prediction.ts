/**
 * Client-side prediction validation + outcome derivation (FR-P06).
 *
 * Two pure stateless helpers that share a home/scored shape:
 *
 *   - `validatePrediction(home, away)` mirrors the server-side CHECK
 *     constraints on the `predictions` table (see
 *     specs/003-predictions-and-scoring/data-model.md §1.1):
 *       CHECK (predicted_home_score BETWEEN 0 AND 20)
 *       CHECK (predicted_away_score BETWEEN 0 AND 20)
 *     plus the implicit integer requirement of the underlying SMALLINT
 *     column. The helper is used by `<PredictionForm/>` to surface
 *     validation errors before the round-trip; the `submit_prediction`
 *     RPC re-validates server-side, so this layer is purely UX.
 *
 *   - `derivePredictionOutcome(home, away)` returns the 1×2 outcome a
 *     given score line represents. Used by the scoring engine
 *     (Phase 5 trigger: `calculate_match_points()`) AND by UI hints
 *     such as "you're predicting a home win" on the prediction form.
 *     Pure math; no validation — callers that care about validity
 *     should run `validatePrediction` first.
 *
 * Pure functions: no I/O, no side effects, no React, no Next.js.
 */

/** Discriminated error codes surfaced to callers. */
export type PredictionValidationError = 'OUT_OF_RANGE' | 'NOT_INTEGER';

/** Result of validating a (home, away) pair. */
export type PredictionValidationResult =
  | { ok: true }
  | { ok: false; errorCode: PredictionValidationError; message: string };

/** The three possible 1×2 outcomes a score line can encode. */
export type MatchOutcome = 'home-win' | 'away-win' | 'draw';

/** Mirrors the predictions_(home|away)_range CHECK: BETWEEN 0 AND 20 inclusive. */
const MIN_SCORE = 0;
const MAX_SCORE = 20;

/**
 * Returns `true` iff `value` is a finite integer (no NaN, no Infinity,
 * no fractional part). `Number.isInteger` already rejects NaN and the
 * infinities, but we name the guard explicitly so call-sites read well.
 */
function isFiniteInteger(value: number): boolean {
  return Number.isInteger(value);
}

export function validatePrediction(home: number, away: number): PredictionValidationResult {
  if (!isFiniteInteger(home) || !isFiniteInteger(away)) {
    return {
      ok: false,
      errorCode: 'NOT_INTEGER',
      message: 'Score must be an integer',
    };
  }

  if (home < MIN_SCORE || home > MAX_SCORE || away < MIN_SCORE || away > MAX_SCORE) {
    return {
      ok: false,
      errorCode: 'OUT_OF_RANGE',
      message: 'Score must be between 0 and 20',
    };
  }

  return { ok: true };
}

export function derivePredictionOutcome(home: number, away: number): MatchOutcome {
  if (home > away) return 'home-win';
  if (home < away) return 'away-win';
  return 'draw';
}
