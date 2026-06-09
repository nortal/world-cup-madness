'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import PredictionFormError, {
  type PredictionErrorCode,
} from '@/components/predictions/PredictionFormError';
import { validatePrediction } from '@/lib/predictions/validate-prediction';
import { createClient } from '@/lib/supabase/client';

/**
 * Inline prediction-edit form for the dashboard upcoming-match widget
 * (feature 005 US-DB / T013).
 *
 * Client Component — wraps the same `submit_prediction` RPC the standalone
 * `<PredictionForm/>` on `/matches/[id]` uses. The full five-key error
 * surface (`errorLocked` / `errorOutOfRange` / `errorMatchNotFound` /
 * `errorParticipantNotFound` / `errorGeneric`) is preserved here via the
 * shared `<PredictionFormError/>` component (T013).
 *
 * Spec references:
 *   - FR-D06, FR-D07, FR-D08, FR-D20 (form stays mounted on error)
 *   - NFR-D08: structured `console.log` JSON for every save attempt
 *     (success or failure) — payload defined in
 *     `contracts/reused-rpc-lock-prediction.md` §NFR observability.
 *
 * Server-authority note: BR-LOCK-001 / Constitution-frontend §IV.1 — the
 * Postgres RPC is the source of truth for lock state. This component
 * surfaces `errorLocked` if the RPC rejects; we do NOT compute the lock
 * boundary client-side here (the surrounding `<ExpandableMatchCard/>` may
 * disable the expand affordance as a UX cue, but the RPC always wins).
 *
 * Translation namespace: `dashboard` (button labels) + `predictions`
 * (error keys, via the shared error component).
 */

type InlinePredictionFormProps = {
  matchId: string;
  initialHomeScore: number | null;
  initialAwayScore: number | null;
  /** Parent-collapse callback invoked after a successful save. */
  onSaved: () => void;
  /** When true, the Save button is visually disabled — usually because the
   *  parent's countdown has crossed zero. RPC remains the authoritative
   *  gate; this is a UX cue only. */
  disabled?: boolean;
};

export default function InlinePredictionForm({
  matchId,
  initialHomeScore,
  initialAwayScore,
  onSaved,
  disabled = false,
}: InlinePredictionFormProps) {
  const t = useTranslations('dashboard');

  const [homeScore, setHomeScore] = useState<string>(
    initialHomeScore !== null ? String(initialHomeScore) : '',
  );
  const [awayScore, setAwayScore] = useState<string>(
    initialAwayScore !== null ? String(initialAwayScore) : '',
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<PredictionErrorCode | null>(null);

  function logEvent(payload: Record<string, unknown>) {
    // Structured logging per NFR-D08. Single-line JSON so log shippers can
    // ingest without re-parsing. `console.log` is the documented sink for
    // the inline_save event; the `no-console` rule is explicitly waived
    // for this one observability hook.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ event: 'inline_save', ...payload }));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(null);

    const homeInt = Number.parseInt(homeScore, 10);
    const awayInt = Number.parseInt(awayScore, 10);

    // Client-side validation mirrors the CHECK constraint on `predictions`.
    const validation = validatePrediction(homeInt, awayInt);
    if (!validation.ok) {
      setErrorCode('errorOutOfRange');
      logEvent({
        match_id: matchId,
        outcome: 'failed',
        error_code: 'errorOutOfRange',
        occurred_at: new Date().toISOString(),
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc('submit_prediction', {
        p_match_id: matchId,
        p_home: homeInt,
        p_away: awayInt,
      });

      if (error !== null) {
        const code = (error as { code?: string }).code;
        const message = (error as { message?: string }).message ?? '';
        let nextErrorCode: PredictionErrorCode;
        if (code === '23514' && message.includes('PREDICTION_LOCKED')) {
          nextErrorCode = 'errorLocked';
        } else if (code === '23514') {
          nextErrorCode = 'errorOutOfRange';
        } else if (code === 'P0002' && message.includes('MATCH_NOT_FOUND')) {
          nextErrorCode = 'errorMatchNotFound';
        } else if (code === 'P0002') {
          nextErrorCode = 'errorParticipantNotFound';
        } else {
          console.error('submit_prediction (inline) failed', { code, message, matchId });
          nextErrorCode = 'errorGeneric';
        }
        setErrorCode(nextErrorCode);
        logEvent({
          match_id: matchId,
          outcome: 'failed',
          error_code: nextErrorCode,
          occurred_at: new Date().toISOString(),
        });
        return;
      }

      logEvent({
        match_id: matchId,
        outcome: 'saved',
        occurred_at: new Date().toISOString(),
      });
      onSaved();
    } catch (err) {
      console.error('submit_prediction (inline) threw', { err, matchId });
      setErrorCode('errorGeneric');
      logEvent({
        match_id: matchId,
        outcome: 'failed',
        error_code: 'errorGeneric',
        occurred_at: new Date().toISOString(),
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  const saveDisabled =
    disabled ||
    isSubmitting ||
    homeScore.trim() === '' ||
    awayScore.trim() === '';

  const errorId = `inline-prediction-error-${matchId}`;

  return (
    <form onSubmit={onSubmit} className="space-y-3 p-3" noValidate>
      <div className="flex items-end gap-3">
        <label className="flex flex-col">
          <span className="text-xs font-medium text-gray-700">{t('inlineEditHomeLabel')}</span>
          <input
            type="number"
            name="homeScore"
            inputMode="numeric"
            min={0}
            max={20}
            step={1}
            value={homeScore}
            onChange={(e) => setHomeScore(e.target.value)}
            disabled={disabled || isSubmitting}
            required
            className="mt-1 w-16 rounded-md border-gray-300 px-2 py-1 text-base disabled:bg-gray-100"
            aria-describedby={errorCode !== null ? errorId : undefined}
            aria-invalid={errorCode !== null}
          />
        </label>

        <span aria-hidden="true" className="pb-2 text-lg text-gray-500">–</span>

        <label className="flex flex-col">
          <span className="text-xs font-medium text-gray-700">{t('inlineEditAwayLabel')}</span>
          <input
            type="number"
            name="awayScore"
            inputMode="numeric"
            min={0}
            max={20}
            step={1}
            value={awayScore}
            onChange={(e) => setAwayScore(e.target.value)}
            disabled={disabled || isSubmitting}
            required
            className="mt-1 w-16 rounded-md border-gray-300 px-2 py-1 text-base disabled:bg-gray-100"
            aria-describedby={errorCode !== null ? errorId : undefined}
            aria-invalid={errorCode !== null}
          />
        </label>

        <button
          type="submit"
          disabled={saveDisabled}
          className="ml-auto rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-300"
        >
          {isSubmitting ? t('inlineEditSavingButton') : t('inlineEditSaveButton')}
        </button>
      </div>

      <PredictionFormError errorCode={errorCode} id={errorId} />
    </form>
  );
}
