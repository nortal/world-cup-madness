'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';

/**
 * Tournament-wide predictions form (feature 003 US-PB / FR-P07-P11).
 *
 * Client Component. Wraps the 4 pickers (champion + runner_up as
 * `<TeamPicker/>`s, top_scorer + best_player as `<PlayerPicker/>`s which
 * conditionally render disabled vs combobox). On submit, reads the IDs
 * from FormData and calls `submit_final_prediction` RPC.
 *
 * Partial submissions are first-class: each picker can be left at the
 * empty option ("No pick" for teams, blank for players). The RPC accepts
 * NULL for any of the 4 args.
 *
 * Lock semantic: BR-LOCK-005. The page that mounts this form decides at
 * render time whether to mount it at all (locked = readonly view instead).
 * On submit, the RPC re-checks server-side; if a locked state slipped
 * through (clock skew), we surface FINAL_PREDICTIONS_LOCKED.
 */

const SUCCESS_BANNER_TTL_MS = 3000;

type ErrorKey =
  | 'final.errorLocked'
  | 'final.errorChampionEqualsRunnerUp'
  | 'final.errorParticipantNotFound'
  | 'final.errorGeneric';

type FinalPredictionsFormProps = {
  // Pickers are passed in as children so the Server Component composition
  // (which knows the teams + players lists) controls what to render.
  children: React.ReactNode;
};

export default function FinalPredictionsForm({ children }: FinalPredictionsFormProps) {
  const t = useTranslations('predictions');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorKey(null);
    setShowSuccess(false);

    const formData = new FormData(event.currentTarget);
    const champion = (formData.get('champion') as string | null)?.trim() || null;
    const runnerUp = (formData.get('runner_up') as string | null)?.trim() || null;
    const topScorer = (formData.get('top_scorer') as string | null)?.trim() || null;
    const bestPlayer = (formData.get('best_player') as string | null)?.trim() || null;

    setIsSubmitting(true);
    try {
      const supabase = createClient();
      // The RPC's typed args are `string | undefined`; the form gives us
      // `string | null` from FormData. Convert nulls to undefined so the
      // params object matches the generated type without lying about runtime
      // (Supabase serialises absent keys as JSON `null`, same as explicit null).
      const { error } = await supabase.rpc('submit_final_prediction', {
        p_champion: champion ?? undefined,
        p_runner_up: runnerUp ?? undefined,
        p_top_scorer: topScorer ?? undefined,
        p_best_player: bestPlayer ?? undefined,
      });

      if (error !== null) {
        const code = (error as { code?: string }).code;
        const message = (error as { message?: string }).message ?? '';
        if (code === '23514' && message.includes('FINAL_PREDICTIONS_LOCKED')) {
          setErrorKey('final.errorLocked');
        } else if (code === '23514' && message.includes('final_predictions_champion_distinct_runner_up')) {
          setErrorKey('final.errorChampionEqualsRunnerUp');
        } else if (code === 'P0002') {
          setErrorKey('final.errorParticipantNotFound');
        } else {
          console.error('submit_final_prediction failed', { code, message });
          setErrorKey('final.errorGeneric');
        }
        return;
      }

      setShowSuccess(true);
      if (successTimerRef.current !== null) clearTimeout(successTimerRef.current);
      successTimerRef.current = setTimeout(() => setShowSuccess(false), SUCCESS_BANNER_TTL_MS);
    } catch (err) {
      console.error('submit_final_prediction threw', err);
      setErrorKey('final.errorGeneric');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <div className="grid gap-6 sm:grid-cols-2">{children}</div>

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={isSubmitting}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-300"
        >
          {isSubmitting ? t('final.savingButton') : t('final.saveButton')}
        </button>

        {showSuccess && (
          <p className="text-sm font-medium text-green-700" role="status">
            {t('final.successToast')}
          </p>
        )}

        {errorKey !== null && (
          <p id="final-form-error" className="text-sm font-medium text-red-700" role="alert">
            {t(errorKey.replace('final.', 'final.'))}
          </p>
        )}
      </div>
    </form>
  );
}
