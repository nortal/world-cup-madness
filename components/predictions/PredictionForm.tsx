'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { validatePrediction } from '@/lib/predictions/validate-prediction';
import { isPredictionLocked, lockCountdownMs } from '@/lib/predictions/lock-state';

/**
 * Prediction form for the participant /matches/[id] page (feature 003 US-PA).
 *
 * Server-side lock enforced by `submit_prediction()` RPC (migration 0028).
 * This client-side helper only renders the countdown and pre-disables the
 * Submit button when the lock has fired — the RPC is the authoritative source
 * of truth (BR-LOCK-001).
 *
 * Spec references:
 *   - FR-P01, FR-P02, FR-P03, FR-P05, FR-P06
 *   - contracts/rpc-submit-prediction.md (error envelope)
 *   - Constitution-frontend §IV.1 (no client-side lock calculation — see Note)
 *
 * Note on the client-side lock check: the client's `isPredictionLocked`
 * disables the Submit button as a UX cue, but the RPC ALWAYS validates again
 * server-side. If client + server disagree (clock skew), the RPC wins and
 * we surface its PREDICTION_LOCKED error.
 */

const SUCCESS_BANNER_TTL_MS = 3000;
const COUNTDOWN_TICK_MS = 1000;

type ErrorKey =
  | 'predictions.errorOutOfRange'
  | 'predictions.errorLocked'
  | 'predictions.errorMatchNotFound'
  | 'predictions.errorParticipantNotFound'
  | 'predictions.errorGeneric';

type PredictionFormProps = {
  matchId: string;
  kickoffUtc: string;
  initialPrediction: { home: number; away: number } | null;
};

export default function PredictionForm({
  matchId,
  kickoffUtc,
  initialPrediction,
}: PredictionFormProps) {
  const t = useTranslations('predictions');

  // Form state — controlled inputs; empty string when not yet submitted so
  // the placeholder shows. The submitted score is the source of truth on
  // re-render.
  const [home, setHome] = useState<string>(
    initialPrediction ? String(initialPrediction.home) : '',
  );
  const [away, setAway] = useState<string>(
    initialPrediction ? String(initialPrediction.away) : '',
  );
  const [committed, setCommitted] = useState<{ home: number; away: number } | null>(
    initialPrediction,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  // Countdown — recomputed on a 1-second tick so the "Locks in 2h 14m"
  // text stays current.
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), COUNTDOWN_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const locked = isPredictionLocked(kickoffUtc, now);
  const countdownMs = lockCountdownMs(kickoffUtc, now);

  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (successTimeoutRef.current !== null) {
        clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  if (locked && committed === null) {
    // Locked + never submitted — show a static message (no form, no edit).
    return (
      <section aria-labelledby="prediction-form-heading" className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4">
        <h2 id="prediction-form-heading" className="text-lg font-semibold">{t('lockedHeading')}</h2>
        <p className="mt-2 text-sm text-gray-600">{t('lockedNoPredictionMessage')}</p>
      </section>
    );
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorKey(null);
    setShowSuccess(false);

    // Client-side validation mirrors the CHECK constraint.
    const homeInt = Number.parseInt(home, 10);
    const awayInt = Number.parseInt(away, 10);
    const validation = validatePrediction(homeInt, awayInt);
    if (!validation.ok) {
      setErrorKey('predictions.errorOutOfRange');
      return;
    }

    setIsSubmitting(true);
    try {
      const supabase = createClient();
      const { data, error } = await supabase.rpc('submit_prediction', {
        p_match_id: matchId,
        p_home: homeInt,
        p_away: awayInt,
      });

      if (error !== null) {
        const code = (error as { code?: string }).code;
        const message = (error as { message?: string }).message ?? '';
        if (code === '23514' && message.includes('PREDICTION_LOCKED')) {
          setErrorKey('predictions.errorLocked');
        } else if (code === '23514') {
          setErrorKey('predictions.errorOutOfRange');
        } else if (code === 'P0002' && message.includes('MATCH_NOT_FOUND')) {
          setErrorKey('predictions.errorMatchNotFound');
        } else if (code === 'P0002') {
          setErrorKey('predictions.errorParticipantNotFound');
        } else {
          // Structured logging per Constitution §1.3
          console.error('submit_prediction failed', { code, message, matchId });
          setErrorKey('predictions.errorGeneric');
        }
        return;
      }

      // Success — advance committed state and surface a brief confirmation.
      setCommitted({ home: homeInt, away: awayInt });
      setShowSuccess(true);
      if (successTimeoutRef.current !== null) {
        clearTimeout(successTimeoutRef.current);
      }
      successTimeoutRef.current = setTimeout(() => setShowSuccess(false), SUCCESS_BANNER_TTL_MS);

      // Suppress unused-data warning — the RPC's response envelope is
      // ignored here; we trust our local state. Logging the action is
      // useful for debugging but not required.
      void data;
    } catch (err) {
      console.error('submit_prediction threw', { err, matchId });
      setErrorKey('predictions.errorGeneric');
    } finally {
      setIsSubmitting(false);
    }
  }

  const submitDisabled =
    isSubmitting ||
    locked ||
    home.trim() === '' ||
    away.trim() === '' ||
    (committed !== null &&
      Number.parseInt(home, 10) === committed.home &&
      Number.parseInt(away, 10) === committed.away);

  return (
    <section aria-labelledby="prediction-form-heading" className="mt-6 rounded-md border border-gray-200 bg-white p-4 shadow-sm">
      <h2 id="prediction-form-heading" className="text-lg font-semibold">{t('formHeading')}</h2>

      <form onSubmit={onSubmit} className="mt-4 space-y-4" noValidate>
        <div className="flex items-end gap-4">
          <label className="flex flex-col">
            <span className="text-sm font-medium text-gray-700">{t('homeLabel')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={20}
              step={1}
              value={home}
              onChange={(e) => setHome(e.target.value)}
              disabled={locked || isSubmitting}
              required
              className="mt-1 w-20 rounded-md border-gray-300 px-2 py-1 text-lg disabled:bg-gray-100"
              aria-describedby={errorKey !== null ? 'prediction-form-error' : undefined}
              aria-invalid={errorKey !== null}
            />
          </label>

          <span aria-hidden="true" className="pb-2 text-xl text-gray-500">–</span>

          <label className="flex flex-col">
            <span className="text-sm font-medium text-gray-700">{t('awayLabel')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={20}
              step={1}
              value={away}
              onChange={(e) => setAway(e.target.value)}
              disabled={locked || isSubmitting}
              required
              className="mt-1 w-20 rounded-md border-gray-300 px-2 py-1 text-lg disabled:bg-gray-100"
              aria-describedby={errorKey !== null ? 'prediction-form-error' : undefined}
              aria-invalid={errorKey !== null}
            />
          </label>

          <button
            type="submit"
            disabled={submitDisabled}
            className="ml-auto rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-300"
          >
            {isSubmitting ? t('submittingButton') : t('submitButton')}
          </button>
        </div>

        {!locked && (
          <p className="text-sm text-gray-600" aria-live="polite">
            {formatCountdown(countdownMs, t)}
          </p>
        )}

        {locked && (
          <p className="text-sm font-medium text-amber-700" aria-live="polite">
            {t('lockedNowMessage')}
          </p>
        )}

        {showSuccess && (
          <p className="text-sm font-medium text-green-700" role="status">
            {t('successToast')}
          </p>
        )}

        {errorKey !== null && (
          <p id="prediction-form-error" className="text-sm font-medium text-red-700" role="alert">
            {t(errorKey.replace('predictions.', ''))}
          </p>
        )}
      </form>
    </section>
  );
}

function formatCountdown(ms: number, t: ReturnType<typeof useTranslations>): string {
  if (ms <= 0) {
    return t('lockingNow');
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return t('locksInHoursMinutes', { hours, minutes });
  }
  return t('locksInMinutes', { minutes });
}
