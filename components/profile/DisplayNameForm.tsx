'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';

/**
 * Display-name editor for the participant profile page (US6 / T063 — FR-A6, TC-4).
 *
 * Behavior contract:
 *   - Controlled `<input>` seeded from the server-rendered `initialValue` prop.
 *     The internal state is the canonical draft; the parent page does NOT need
 *     to re-render after a successful save (the dashboard greeting picks up the
 *     new name on the next navigation — acceptable per the T063 spec).
 *   - Submit calls `update_display_name(new_name)` — the SECURITY DEFINER RPC
 *     defined in `supabase/migrations/0007_profile_functions.sql` (lines 3–32).
 *     The RPC trims server-side and enforces the 1..100 char window via
 *     `check_violation`, and raises `no_data_found` when the caller has no
 *     active participant row. We mirror the same 1..100 trimmed length window
 *     client-side so the disabled-state of the Save button gives instant
 *     feedback without a round-trip.
 *   - Optimistic UI: on submit we (a) trim the value, (b) snapshot the
 *     previous "committed" value, (c) advance the committed value to the
 *     trimmed draft BEFORE awaiting the RPC, so the input reflects what the
 *     user submitted while the RPC is in flight. On error we revert the
 *     committed value to the snapshot. This matches the FR-A6 expectation that
 *     "Save" feels instantaneous while still being reconciled with the server.
 *   - The Save button is disabled when the trimmed draft is empty, exceeds
 *     100 chars, equals the committed value (no-op), or an RPC is in flight.
 *     The committed-value check uses post-RPC state, so after a successful
 *     save the button correctly disables until the user edits again.
 *   - Success banner auto-clears after ~3s; we keep a ref to the timeout so a
 *     subsequent save or unmount cancels the previous timer (no stale clears).
 *
 * Error-code mapping (PostgrestError.code from the RPC):
 *   - `check_violation`  → `profile.errorEmpty` or `profile.errorTooLong`
 *                          based on the client-side length check (server uses
 *                          one ERRCODE for both bounds; we disambiguate by
 *                          re-inspecting the trimmed draft).
 *   - `no_data_found`    → `profile.errorNotFound` (sign out / back in).
 *   - anything else / network → `profile.errorGeneric`.
 *
 * Translation namespace: `profile` (T064 owns the message JSON).
 *
 * Spec references:
 *   - specs/001-authentication-and-participant/spec.md FR-A6 — participant can
 *     edit their display name from the profile page.
 *   - specs/001-authentication-and-participant/spec.md TC-4 — display-name
 *     edit happy-path + boundary validation.
 *   - supabase/migrations/0007_profile_functions.sql lines 3–32 — RPC contract.
 *   - Constitution §1.3 — no silent failures; structured `console.error` on
 *     RPC failure with operation + error code.
 */

const MAX_DISPLAY_NAME_LENGTH = 100;
const SUCCESS_BANNER_TTL_MS = 3000;

type ErrorKey =
  | 'profile.errorEmpty'
  | 'profile.errorTooLong'
  | 'profile.errorNotFound'
  | 'profile.errorGeneric';

export default function DisplayNameForm({ initialValue }: { initialValue: string }) {
  const t = useTranslations('profile');

  // `committedValue` represents what we believe the server has stored. It is
  // seeded from the prop and advanced optimistically on submit; reverted on
  // error. The Save button's "no-op" disable check compares the trimmed draft
  // against this value (NOT against the original prop), so a second edit
  // after a successful save behaves correctly without a parent re-render.
  const [committedValue, setCommittedValue] = useState<string>(initialValue);
  const [draftValue, setDraftValue] = useState<string>(initialValue);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [showSuccess, setShowSuccess] = useState<boolean>(false);

  // Hold the active success-banner timeout so we can clear it on (a) a new
  // save that re-fires the banner and (b) component unmount.
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!showSuccess) return;

    successTimeoutRef.current = setTimeout(() => {
      setShowSuccess(false);
      successTimeoutRef.current = null;
    }, SUCCESS_BANNER_TTL_MS);

    return () => {
      if (successTimeoutRef.current !== null) {
        clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = null;
      }
    };
  }, [showSuccess]);

  const trimmedDraft = draftValue.trim();
  const isEmpty = trimmedDraft.length === 0;
  const isTooLong = trimmedDraft.length > MAX_DISPLAY_NAME_LENGTH;
  const isNoOp = trimmedDraft === committedValue;
  const isSaveDisabled = isSubmitting || isEmpty || isTooLong || isNoOp;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    // Re-validate at submit time. The disabled button is the first line of
    // defense, but a determined user (or a keyboard Enter on a stale value)
    // can still get here, and we want the error banner rather than a silent
    // no-op.
    if (isEmpty) {
      setErrorKey('profile.errorEmpty');
      return;
    }
    if (isTooLong) {
      setErrorKey('profile.errorTooLong');
      return;
    }
    if (isNoOp) {
      return;
    }

    setErrorKey(null);
    setShowSuccess(false);
    setIsSubmitting(true);

    // Optimistic step: advance the committed value before awaiting. The input
    // is already showing `trimmedDraft` (the user typed it), but we also
    // normalize the visible draft to its trimmed form so trailing whitespace
    // doesn't linger in the input after a save.
    const previousCommitted = committedValue;
    setCommittedValue(trimmedDraft);
    setDraftValue(trimmedDraft);

    const supabase = createClient();
    const { error } = await supabase.rpc('update_display_name', { new_name: trimmedDraft });

    if (error) {
      // Constitution §1.3: structured context, no silent failure.
      console.error('update_display_name RPC failed', {
        operation: 'DisplayNameForm.handleSubmit',
        code: error.code,
        message: error.message,
      });

      // Revert the optimistic commit so the disable-on-no-op logic stays
      // consistent with what the server actually stores.
      setCommittedValue(previousCommitted);

      if (error.code === 'check_violation') {
        // The server uses one ERRCODE for both bounds; disambiguate using the
        // same trimmed-draft check we just performed.
        setErrorKey(trimmedDraft.length > MAX_DISPLAY_NAME_LENGTH
          ? 'profile.errorTooLong'
          : 'profile.errorEmpty');
      } else if (error.code === 'no_data_found') {
        setErrorKey('profile.errorNotFound');
      } else {
        setErrorKey('profile.errorGeneric');
      }

      setIsSubmitting(false);
      return;
    }

    setShowSuccess(true);
    setIsSubmitting(false);
  }

  const hasError = errorKey !== null;
  const submitLabel = isSubmitting ? t('savingButton') : t('saveButton');

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label
        htmlFor="display-name"
        className="block text-sm font-medium text-gray-900"
      >
        {t('displayNameLabel')}
      </label>

      <input
        id="display-name"
        type="text"
        value={draftValue}
        onChange={(event) => {
          setDraftValue(event.target.value);
          // Clear any stale error/success banner as soon as the user edits;
          // the new draft hasn't been submitted yet so old feedback is moot.
          if (errorKey !== null) setErrorKey(null);
          if (showSuccess) setShowSuccess(false);
        }}
        disabled={isSubmitting}
        maxLength={MAX_DISPLAY_NAME_LENGTH}
        aria-invalid={hasError ? 'true' : 'false'}
        aria-describedby={hasError ? 'display-name-error' : undefined}
        className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
      />

      <div className="mt-3 flex items-center gap-3">
        <button
          type="submit"
          disabled={isSaveDisabled}
          className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>

      {hasError && (
        <p
          id="display-name-error"
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {t(errorKey.replace(/^profile\./, '') as
            | 'errorEmpty'
            | 'errorTooLong'
            | 'errorNotFound'
            | 'errorGeneric')}
        </p>
      )}

      {showSuccess && !hasError && (
        <p
          role="status"
          className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {t('successToast')}
        </p>
      )}
    </form>
  );
}
