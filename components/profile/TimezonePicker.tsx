'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { IANA_TIMEZONES } from '@/lib/matches/iana-timezones';

/**
 * IANA timezone selector for the participant profile page
 * (feature 002 / T045 — FR-M15).
 *
 * Behavior contract (mirrors `DisplayNameForm.tsx` from feature 001):
 *   - Controlled input seeded from the server-rendered `initialValue` prop
 *     (the participant's stored `participants.timezone`, NOT NULL default
 *     `'UTC'`). Internal state is the canonical draft; the parent /profile
 *     page does NOT re-render after a successful save — subsequent navigations
 *     re-read from Postgres and pick up the new value.
 *   - Submit calls `update_timezone(p_timezone)` — the SECURITY DEFINER RPC
 *     defined in `supabase/migrations/0015_match_rpcs.sql` (lines 77–106).
 *     The RPC trims server-side and enforces: non-empty, ≤ 64 chars, no
 *     whitespace; raises `check_violation` on validation failure and
 *     `no_data_found` when the caller has no active participant row. We
 *     mirror the non-empty + ≤ 64 chars guards client-side so the Save
 *     button gives instant feedback without a round-trip. (The "no
 *     whitespace" rule is implicit — IANA zone names never contain spaces,
 *     so a valid pick from the listbox cannot trigger it.)
 *   - Optimistic UI: on submit we (a) advance `committedValue` to the saved
 *     value before awaiting the RPC, (b) on error revert to the snapshot.
 *     Same shape as DisplayNameForm: success message via `role="status"`,
 *     error message via `role="alert"`, both auto-clear after ~3s via a
 *     `useEffect` + `setTimeout` with cleanup so a follow-up save or
 *     unmount cancels stale timers.
 *
 * Combobox pattern (WAI-ARIA Authoring Practices — see research.md §R-2):
 *   This component is hand-rolled rather than using `react-aria-components`
 *   `<ComboBox>`. The research decision was: zero new dependencies vs ~50 KB
 *   for `react-aria` + `react-aria-components`; the WAI-ARIA combobox pattern
 *   is well-documented; and the team is already comfortable with manual ARIA
 *   wiring from `WelcomeModal.tsx` (feature 001). If the picker grows complex
 *   in a polish phase, the prop surface here is small enough to swap behind.
 *
 *   ARIA wiring:
 *     - `<input role="combobox" aria-expanded aria-controls={listboxId}
 *        aria-autocomplete="list" aria-activedescendant={...}>`
 *     - `<ul role="listbox" id={listboxId}>` of `<li role="option"
 *        id={...} aria-selected={...}>`
 *   Keyboard:
 *     - ↓ / ↑ move the highlighted option through the FILTERED list
 *       (highlighted index is RELATIVE to the currently-filtered slice,
 *       which is the slice the user actually sees). When the filter
 *       narrows the list, the highlighted index is clamped/reset so it
 *       never points past the end of `visibleOptions`.
 *     - Enter selects the highlighted option and closes the listbox.
 *     - Esc closes the listbox without changing the input value.
 *     - Tab leaves the combobox (`onBlur` closes the listbox; we use a
 *       short timeout so a mouse click on an option still fires before
 *       the blur tears the listbox down).
 *
 * Error-code mapping (PostgrestError.code from the RPC — uses the literal
 * Postgres error-name strings, consistent with DisplayNameForm; the JS
 * client surfaces these as `error.code`):
 *   - `check_violation` AND draft is empty   → `errorEmpty`
 *   - `check_violation` AND draft > 64 chars → `errorTooLong`
 *   - `no_data_found`                        → `errorNotFound`
 *   - anything else / network                → `errorGeneric` + structured
 *                                              `console.error` per
 *                                              Constitution §1.3.
 *
 * Translation namespace: `profile` (keys populated by T025).
 *
 * Visible-options cap: we render at most 50 `<li>` nodes at a time for
 * render performance. The filter input narrows the IANA list (~419 zones)
 * far below 50 after a few characters, so this rarely matters in practice;
 * the listbox is scrollable when capped.
 */

const MAX_TIMEZONE_LENGTH = 64;
const SUCCESS_BANNER_TTL_MS = 3000;
const ERROR_BANNER_TTL_MS = 3000;
const MAX_VISIBLE_OPTIONS = 50;

type ErrorKey =
  | 'timezoneErrorEmpty'
  | 'timezoneErrorTooLong'
  | 'timezoneErrorNotFound'
  | 'timezoneErrorGeneric';

type TimezonePickerProps = {
  initialValue: string;
};

export default function TimezonePicker({ initialValue }: TimezonePickerProps) {
  const t = useTranslations('profile');

  // Stable IDs for the combobox/listbox/option ARIA wiring. `useId` keeps
  // them unique across SSR + multiple instances on a page.
  const reactId = useId();
  const inputId = `tz-input-${reactId}`;
  const listboxId = `tz-listbox-${reactId}`;
  const helperId = `tz-helper-${reactId}`;
  const errorId = `tz-error-${reactId}`;
  const optionId = (index: number) => `tz-option-${reactId}-${index}`;

  // `committedValue` is what we believe the server has stored. Seeded from
  // the prop, advanced optimistically on submit, reverted on error.
  const [committedValue, setCommittedValue] = useState<string>(initialValue);
  const [draftValue, setDraftValue] = useState<string>(initialValue);
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [showSuccess, setShowSuccess] = useState<boolean>(false);

  // Cancellable timeouts for the auto-clearing banners.
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Short delay on blur-close so a click on a listbox option still registers
  // before the listbox is torn down by the blur handler.
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for keyboard-driven scroll-into-view of the highlighted option.
  const listboxRef = useRef<HTMLUListElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const trimmedDraft = draftValue.trim();
  const isEmpty = trimmedDraft.length === 0;
  const isTooLong = trimmedDraft.length > MAX_TIMEZONE_LENGTH;
  const isNoOp = trimmedDraft === committedValue;
  const isSaveDisabled = isSubmitting || isEmpty || isTooLong || isNoOp;

  // Filter the IANA list by case-insensitive substring on the trimmed draft.
  // Capped at MAX_VISIBLE_OPTIONS for render perf; the listbox is scrollable.
  const visibleOptions = useMemo(() => {
    const needle = draftValue.trim().toLowerCase();
    const source = IANA_TIMEZONES;
    if (needle.length === 0) {
      return source.slice(0, MAX_VISIBLE_OPTIONS);
    }
    const matches: string[] = [];
    for (const zone of source) {
      if (zone.toLowerCase().includes(needle)) {
        matches.push(zone);
        if (matches.length >= MAX_VISIBLE_OPTIONS) break;
      }
    }
    return matches;
  }, [draftValue]);

  // No standalone clamp effect: `handleInputChange` already resets
  // `highlightedIndex` to 0 on every keystroke, which is the only path
  // that can shrink `visibleOptions` out from under a stale index. A
  // separate useEffect+setState clamp would trip the react-hooks/
  // set-state-in-effect lint rule for a scenario this component can't
  // actually reach.

  // Auto-clear the success banner.
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

  // Auto-clear the error banner.
  useEffect(() => {
    if (errorKey === null) return;
    errorTimeoutRef.current = setTimeout(() => {
      setErrorKey(null);
      errorTimeoutRef.current = null;
    }, ERROR_BANNER_TTL_MS);
    return () => {
      if (errorTimeoutRef.current !== null) {
        clearTimeout(errorTimeoutRef.current);
        errorTimeoutRef.current = null;
      }
    };
  }, [errorKey]);

  // Clean up blur timeout on unmount.
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current !== null) {
        clearTimeout(blurTimeoutRef.current);
        blurTimeoutRef.current = null;
      }
    };
  }, []);

  // Keep the highlighted option scrolled into view inside the listbox.
  useEffect(() => {
    if (!isOpen || highlightedIndex < 0) return;
    const listEl = listboxRef.current;
    if (listEl === null) return;
    const optionEl = listEl.querySelector<HTMLLIElement>(
      `#${CSS.escape(optionId(highlightedIndex))}`,
    );
    if (optionEl !== null) {
      optionEl.scrollIntoView({ block: 'nearest' });
    }
    // optionId is stable per reactId; safe to omit from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, highlightedIndex]);

  function openListbox() {
    setIsOpen(true);
    if (highlightedIndex < 0 && visibleOptions.length > 0) {
      // Seed highlight on the currently-selected value if it's in view,
      // otherwise on the first option.
      const matchIndex = visibleOptions.indexOf(draftValue);
      setHighlightedIndex(matchIndex >= 0 ? matchIndex : 0);
    }
  }

  function closeListbox() {
    setIsOpen(false);
    setHighlightedIndex(-1);
  }

  function selectOption(zone: string) {
    setDraftValue(zone);
    closeListbox();
    if (errorKey !== null) setErrorKey(null);
    if (showSuccess) setShowSuccess(false);
    // Return focus to the input so keyboard users can immediately Tab to Save.
    inputRef.current?.focus();
  }

  function handleInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    setDraftValue(event.target.value);
    if (!isOpen) setIsOpen(true);
    // Reset highlight to the top of the freshly-filtered list so ↓ from a
    // typed query starts at the first visible match (not at a stale index).
    setHighlightedIndex(0);
    if (errorKey !== null) setErrorKey(null);
    if (showSuccess) setShowSuccess(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        if (!isOpen) {
          openListbox();
          return;
        }
        if (visibleOptions.length === 0) return;
        setHighlightedIndex((prev) => {
          const next = prev + 1;
          return next >= visibleOptions.length ? visibleOptions.length - 1 : next;
        });
        return;
      }
      case 'ArrowUp': {
        event.preventDefault();
        if (!isOpen) {
          openListbox();
          return;
        }
        if (visibleOptions.length === 0) return;
        setHighlightedIndex((prev) => {
          const next = prev - 1;
          return next < 0 ? 0 : next;
        });
        return;
      }
      case 'Enter': {
        if (!isOpen) return; // Let the form's submit handle Enter when closed.
        event.preventDefault();
        if (highlightedIndex >= 0 && highlightedIndex < visibleOptions.length) {
          selectOption(visibleOptions[highlightedIndex]!);
        }
        return;
      }
      case 'Escape': {
        if (!isOpen) return;
        event.preventDefault();
        closeListbox();
        return;
      }
      case 'Tab': {
        // Allow default Tab behavior; just close so the listbox doesn't
        // linger after focus moves to the Save button.
        if (isOpen) closeListbox();
        return;
      }
      default:
        return;
    }
  }

  function handleInputBlur() {
    // Defer close so a mousedown→mouseup→click on an option completes first.
    blurTimeoutRef.current = setTimeout(() => {
      closeListbox();
      blurTimeoutRef.current = null;
    }, 120);
  }

  function handleInputFocus() {
    if (blurTimeoutRef.current !== null) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = null;
    }
    openListbox();
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isEmpty) {
      setErrorKey('timezoneErrorEmpty');
      return;
    }
    if (isTooLong) {
      setErrorKey('timezoneErrorTooLong');
      return;
    }
    if (isNoOp) return;

    setErrorKey(null);
    setShowSuccess(false);
    setIsSubmitting(true);

    // Optimistic step: advance the committed value before awaiting the RPC.
    const previousCommitted = committedValue;
    setCommittedValue(trimmedDraft);
    setDraftValue(trimmedDraft);

    const supabase = createClient();
    const { error } = await supabase.rpc('update_timezone', { p_timezone: trimmedDraft });

    if (error) {
      // Constitution §1.3: structured context, no silent failure.
      console.error('update_timezone RPC failed', {
        operation: 'TimezonePicker.handleSubmit',
        code: error.code,
        message: error.message,
      });

      // Revert the optimistic commit so the no-op disable stays consistent
      // with what the server actually stores.
      setCommittedValue(previousCommitted);

      if (error.code === 'check_violation') {
        // Server raises one ERRCODE for both bounds (empty + > 64); we
        // disambiguate using the same client-side check.
        setErrorKey(
          trimmedDraft.length > MAX_TIMEZONE_LENGTH
            ? 'timezoneErrorTooLong'
            : 'timezoneErrorEmpty',
        );
      } else if (error.code === 'no_data_found') {
        setErrorKey('timezoneErrorNotFound');
      } else {
        setErrorKey('timezoneErrorGeneric');
      }

      setIsSubmitting(false);
      return;
    }

    setShowSuccess(true);
    setIsSubmitting(false);
  }

  const hasError = errorKey !== null;
  const submitLabel = isSubmitting ? t('timezoneSavingButton') : t('timezoneSaveButton');
  const activeDescendantId =
    isOpen && highlightedIndex >= 0 && highlightedIndex < visibleOptions.length
      ? optionId(highlightedIndex)
      : undefined;

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label
        htmlFor={inputId}
        className="block text-sm font-medium text-gray-900"
      >
        {t('timezoneLabel')}
      </label>

      <div className="relative mt-1">
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeDescendantId}
          aria-invalid={hasError ? 'true' : 'false'}
          aria-describedby={hasError ? `${helperId} ${errorId}` : helperId}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('timezonePlaceholder')}
          value={draftValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={handleInputFocus}
          onBlur={handleInputBlur}
          disabled={isSubmitting}
          maxLength={MAX_TIMEZONE_LENGTH}
          className="block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
        />

        {isOpen && (
          <ul
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-label={t('timezoneLabel')}
            className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white shadow-lg ring-1 ring-black ring-opacity-5"
          >
            {visibleOptions.length === 0 ? (
              <li
                role="option"
                aria-selected="false"
                aria-disabled="true"
                className="cursor-default select-none px-3 py-2 text-sm text-gray-500"
              >
                {/* No-matches row is intentionally not focusable; it shares the
                    `role="option"` only so the listbox always has at least one
                    child for screen readers. */}
                —
              </li>
            ) : (
              visibleOptions.map((zone, index) => {
                const isHighlighted = index === highlightedIndex;
                const isSelected = zone === draftValue;
                return (
                  <li
                    key={zone}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    // `onMouseDown` instead of `onClick` so we beat the input's
                    // blur handler — clicking an option must select it before
                    // the input loses focus and tears the listbox down.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectOption(zone);
                    }}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    className={
                      'cursor-pointer select-none px-3 py-2 text-sm ' +
                      (isHighlighted
                        ? 'bg-blue-100 text-blue-900'
                        : 'text-gray-900 hover:bg-gray-50')
                    }
                  >
                    {zone}
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      <p id={helperId} className="mt-2 text-sm text-gray-600">
        {t('timezoneHelper')}
      </p>

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
          id={errorId}
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {t(errorKey)}
        </p>
      )}

      {showSuccess && !hasError && (
        <p
          role="status"
          className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {t('timezoneSuccessToast')}
        </p>
      )}
    </form>
  );
}
