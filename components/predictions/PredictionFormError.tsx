'use client';

import { useTranslations } from 'next-intl';

/**
 * Shared error-message renderer for prediction-save forms (feature 005 T013).
 *
 * Used by:
 *   - `components/predictions/PredictionForm.tsx` — the standalone form on
 *     `/matches/[id]` (feature 003 US-PA).
 *   - `components/matches/InlinePredictionForm.tsx` — the inline form inside
 *     `ExpandableMatchCard` on `/dashboard` (feature 005 US-DB).
 *
 * Single source of UI truth for the five `predictions.*` error keys defined
 * in feature 003: `errorLocked`, `errorOutOfRange`, `errorMatchNotFound`,
 * `errorParticipantNotFound`, `errorGeneric`. Returns `null` when
 * `errorCode === null` so callers can render the component unconditionally.
 *
 * Translation namespace: `predictions`.
 */

export type PredictionErrorCode =
  | 'errorLocked'
  | 'errorOutOfRange'
  | 'errorMatchNotFound'
  | 'errorParticipantNotFound'
  | 'errorGeneric';

type PredictionFormErrorProps = {
  errorCode: PredictionErrorCode | null;
  /** Optional id passed through to the rendered <p> for aria-describedby
   *  wiring on the form inputs. */
  id?: string;
};

export default function PredictionFormError({ errorCode, id }: PredictionFormErrorProps) {
  const t = useTranslations('predictions');

  if (errorCode === null) {
    return null;
  }

  return (
    <p
      id={id}
      className="text-sm font-medium text-red-700"
      role="alert"
    >
      {t(errorCode)}
    </p>
  );
}
