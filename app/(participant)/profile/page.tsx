import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import DisplayNameForm from '@/components/profile/DisplayNameForm';
import TimezonePicker from '@/components/profile/TimezonePicker';
import { createClient } from '@/lib/supabase/server';

/**
 * Participant profile page (US6 / T062 — FR-A6, TC-4).
 *
 * Server Component — this page renders the participant's editable profile
 * surface (display name) and a read-only echo of their corporate email. It
 * runs entirely on the server so that:
 *
 *   1. Authentication is verified against Supabase Auth on every request (not
 *      trusted from client storage), aligning with FR-A1 per-request tenant
 *      re-validation enforced by RLS.
 *   2. The participant row is fetched with the user's own JWT, so RLS — not
 *      application code — is the authorization boundary (Frontend Constitution
 *      §IV.1, Backend Constitution §VI.2).
 *   3. Only the columns rendered by this page are projected from the
 *      participants row (`display_name`, `email`). `oid`, `tid`, and other
 *      identity claims are NOT selected — they have no UI use here, and
 *      FR-018 calls for data minimization on the wire.
 *
 * Auth control flow (mirrors `app/(participant)/dashboard/page.tsx`, which is
 * the canonical source-of-truth for this pattern in this codebase):
 *   - No Supabase user OR no matching participant row → redirect to `/`.
 *     The "no user" branch is normal control flow (someone hit `/profile`
 *     unauthenticated) and is not logged. The "user exists but participant row
 *     fetch errored" branch IS logged with structured context per
 *     Constitution §1.3 — that is an unexpected condition because the auth
 *     callback should have provisioned the row.
 *
 * Email handling:
 *   - `participants.email` is `citext` in Postgres; it renders as a plain
 *     string via the generated types. We display it verbatim inside a
 *     `<dl>/<dt>/<dd>` block so screen readers announce the label/value
 *     relationship without requiring a form input (the email is not editable
 *     on this page — corporate identity owns it).
 *
 * Display name handling:
 *   - The editable field is owned by `<DisplayNameForm>` (T063, Client
 *     Component). We pass the raw `display_name` value as `initialValue`; the
 *     form trims and validates on submit and calls the `update_display_name`
 *     RPC. Any whitespace-only value is the user's own draft — we deliberately
 *     do NOT apply the dashboard's "Participant" fallback here because the
 *     user needs to see the literal stored value in order to edit it.
 *
 * Timezone handling (T046 / US-MB / FR-M15):
 *   - The editable selector is owned by `<TimezonePicker>` (T045, Client
 *     Component) — a hand-rolled WAI-ARIA combobox over the static IANA list
 *     (`lib/matches/iana-timezones.ts`). On Save it calls `update_timezone`
 *     RPC; success / error UX mirrors `DisplayNameForm`. The initialValue
 *     is the participant's currently-stored `timezone` (NOT NULL with
 *     default `'UTC'`).
 *
 * Translation namespace: `profile` (see `lib/i18n/messages/{en,es,pt-BR}.json`).
 * The form's own keys (`displayNameLabel`, `saveButton`, etc.) are consumed
 * by `<DisplayNameForm>` via `useTranslations('profile')` — they are already
 * loaded into `NextIntlClientProvider` by the root layout, so no additional
 * plumbing is needed here.
 */
export default async function ProfilePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) {
    // Unauthenticated direct hit on `/profile`. Normal control flow — no log.
    redirect('/');
  }

  // Project only the columns this page renders. `display_name` is the editable
  // field (handed off to <DisplayNameForm>), `email` is the read-only row,
  // `timezone` is the editable selector (handed off to <TimezonePicker>).
  // `oid` / `tid` / `role` / `status` are intentionally NOT selected — they
  // have no UI use here (FR-018 data minimization).
  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('display_name, email, timezone')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (participantError !== null) {
    // Unexpected: the auth callback (T038) should have provisioned this row.
    // Log structured context for diagnosis, then redirect to the landing page
    // rather than rendering a broken profile.
    console.error('profile: failed to load participant row', {
      authUserId: user.id,
      message: participantError.message,
      code: participantError.code,
    });
    redirect('/');
  }

  if (participant === null) {
    // No participant row for an authenticated user — either provisioning was
    // skipped or the row was deleted. Redirect to landing.
    redirect('/');
  }

  const t = await getTranslations('profile');

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t('heading')}</h1>
      </header>

      <section className="mt-10" aria-labelledby="profile-email-heading">
        <h2 id="profile-email-heading" className="sr-only">
          {t('emailLabel')}
        </h2>
        <dl className="rounded-md border border-gray-200 px-4 py-3">
          <dt className="text-sm font-medium text-gray-900">{t('emailLabel')}</dt>
          <dd className="mt-1 text-base text-gray-700">{participant.email}</dd>
        </dl>
      </section>

      <section className="mt-10">
        <DisplayNameForm initialValue={participant.display_name} />
      </section>

      {/* T046 (US-MB / FR-M15) — TimezonePicker hand-rolled WAI-ARIA combobox
          over the static IANA list (lib/matches/iana-timezones.ts). Calls
          update_timezone RPC; success / error UX mirrors DisplayNameForm. */}
      <section className="mt-10">
        <TimezonePicker initialValue={participant.timezone} />
      </section>
    </main>
  );
}
