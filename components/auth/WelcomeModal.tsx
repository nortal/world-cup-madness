'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';

/**
 * First-login welcome modal (US5 / T057 — FR-A3, NFR-A4, TC-12).
 *
 * Behavior contract:
 *   - Renders an open dialog on mount. Parent decides WHEN to mount it; this
 *     component does NOT query `welcome_dismissed_at` itself. T058 wires the
 *     dashboard page to mount this only when `welcome_dismissed_at === null`.
 *   - "Got it" button and the Esc key both invoke `dismiss_welcome` (the
 *     SECURITY DEFINER RPC defined in supabase/migrations/0007_profile_functions.sql)
 *     and then close the dialog locally. Backdrop clicks do NOT dismiss — per
 *     the FR-A3 dismissal contract we want an intentional gesture, not an
 *     easy mis-tap.
 *   - The RPC writes `welcome_dismissed_at` so dismissal persists cross-device
 *     (NFR-A4 / TC-12). Per accessibility convention (WAI-ARIA Authoring
 *     Practices) Esc is the primary dismiss gesture for dialogs, so it MUST
 *     write the timestamp too — otherwise Esc-dismissers would see the modal
 *     again on every sign-in.
 *   - Error handling: if the RPC fails we still close locally so the user is
 *     not blocked, and we log structured context via console.error (Constitution
 *     §1.3 — no silent failures). Next sign-in will re-trigger the modal,
 *     which is acceptable degradation.
 *   - Focus management: focus moves to the "Got it" button on mount, and a
 *     keydown listener traps Tab / Shift+Tab within the dialog. The trap is
 *     degenerate today (only one focusable element) but is structured so that
 *     T070, which adds a "Learn more" privacy Link, gets a working trap for
 *     free.
 *
 * Translation namespace: `welcome` (T059 owns the message JSON).
 *
 * Spec references:
 *   - specs/001-authentication-and-participant/spec.md FR-A3 (line 114) —
 *     dismissible welcome screen on first login.
 *   - specs/001-authentication-and-participant/spec.md NFR-A4 (line 128) —
 *     dismissal persisted server-side, cross-device.
 *   - specs/001-authentication-and-participant/spec.md TC-12 (line 85) —
 *     primary "Got it" path persists `welcome_dismissed_at`.
 */

// Empty-object props today; declared explicitly so T058 has a stable
// extension point if it ever needs to pass callbacks or initial state.
type WelcomeModalProps = Record<string, never>;

export default function WelcomeModal(_props: WelcomeModalProps = {} as WelcomeModalProps) {
  const t = useTranslations('welcome');
  const [isOpen, setIsOpen] = useState(true);
  const [isDismissing, setIsDismissing] = useState(false);

  // Refs into the dialog subtree so the focus trap can query focusable
  // children on every Tab keypress (T070 will add a Link, and we want the
  // trap to pick it up without further changes here).
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const gotItButtonRef = useRef<HTMLButtonElement | null>(null);

  const dismiss = useCallback(async () => {
    if (isDismissing) return;
    setIsDismissing(true);

    const supabase = createClient();
    const { error } = await supabase.rpc('dismiss_welcome');

    if (error) {
      // Constitution §1.3: structured context, no silent failure. We still
      // close locally — blocking the dashboard behind a failed RPC would be
      // worse UX than re-showing the modal on next sign-in.
      console.error('dismiss_welcome RPC failed', {
        operation: 'WelcomeModal.dismiss',
        code: error.code,
        message: error.message,
      });
    }

    setIsOpen(false);
  }, [isDismissing]);

  // Mount-time effects: focus the primary CTA and attach the keydown listener
  // for Esc + Tab trapping. Document-level listener (not dialog-level) because
  // Esc must dismiss even when focus has somehow escaped the dialog subtree.
  useEffect(() => {
    if (!isOpen) return;

    gotItButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        void dismiss();
        return;
      }

      if (event.key === 'Tab') {
        // Query focusable descendants on each press so the trap auto-picks-up
        // future additions (T070's privacy Link).
        const root = dialogRef.current;
        if (!root) return;

        const focusable = root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (event.shiftKey) {
          if (active === first || !root.contains(active)) {
            event.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !root.contains(active)) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, dismiss]);

  if (!isOpen) return null;

  return (
    <div
      // Backdrop: semi-transparent overlay. No onClick handler — per the
      // FR-A3 contract, only Esc or the explicit CTA dismiss this dialog.
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      aria-hidden="false"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-modal-title"
        className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl"
      >
        <h2
          id="welcome-modal-title"
          className="text-2xl font-semibold tracking-tight text-gray-900"
        >
          {t('title')}
        </h2>

        <p className="mt-4 text-base text-gray-700">{t('intro')}</p>

        <ul className="mt-4 list-disc space-y-1 pl-6 text-sm text-gray-700">
          <li>{t('scoringExact')}</li>
          <li>{t('scoringOutcome')}</li>
          <li>{t('scoringWrong')}</li>
          <li>{t('scoringFinal')}</li>
        </ul>

        <p className="mt-4 text-sm text-gray-700">{t('lockWindow')}</p>
        <p className="mt-2 text-sm text-gray-700">{t('deadline')}</p>

        {/* T070 (US7) attachment point — insert "Learn more" privacy Link here.
            The focus trap above queries focusable descendants on each Tab
            press, so a Link added here will be trapped automatically without
            further changes to this component. */}

        <div className="mt-6 flex justify-end">
          <button
            ref={gotItButtonRef}
            type="button"
            onClick={() => {
              void dismiss();
            }}
            disabled={isDismissing}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50"
          >
            {t('gotIt')}
          </button>
        </div>
      </div>
    </div>
  );
}
