import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { createClient } from '@/lib/supabase/server';

/**
 * Participant dashboard (US1 / T040).
 *
 * Server Component — this page is the post-sign-in landing surface for an
 * eligible Nortal participant (FR-001 / FR-003). It runs entirely on the
 * server so that:
 *
 *   1. Authentication is verified against Supabase Auth on every request (not
 *      trusted from client storage), aligning with FR-A1 per-request tenant
 *      re-validation enforced by RLS.
 *   2. The participant row is fetched with the user's own JWT, so RLS — not
 *      application code — is the authorization boundary (Frontend Constitution
 *      §IV.1, Backend Constitution §VI.2).
 *   3. No PII (email, oid, tid) is shipped to the browser; only the greeting
 *      and the empty-state placeholder are rendered (FR-018 data minimization).
 *
 * Auth control flow:
 *   - No Supabase user OR no matching participant row → redirect to `/`.
 *     The "no user" branch is normal control flow (someone hit `/dashboard`
 *     unauthenticated) and is not logged. The "user exists but participant row
 *     fetch errored" branch IS logged with structured context per
 *     Constitution §1.3 — that is an unexpected condition because the auth
 *     callback should have provisioned the row.
 *
 * Attachment points for follow-up tasks (intentionally left as comments — do
 * NOT add stub components here):
 *   - T054 (US4): render `<AdminNavLink />` when `participant.role === 'admin'`.
 *   - T058 (US5): wrap the rendered tree in `<DashboardClient>` and mount
 *     `<WelcomeModal />` gated on `participant.welcome_dismissed_at === null`.
 *     The `welcomeDismissedAt` value is already projected by the query below
 *     so T058 only needs to thread it into a client wrapper.
 *
 * Translation namespace: `dashboard` (see `lib/i18n/messages/{en,es,pt-BR}.json`).
 */
export default async function DashboardPage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) {
    // Unauthenticated direct hit on `/dashboard`. Normal control flow — no log.
    redirect('/');
  }

  // Project only the columns this page (and its US4 / US5 follow-ups) need.
  // `welcome_dismissed_at` is selected for T058 even though it is not rendered
  // yet; `role` is selected for T054. Email / oid are intentionally NOT
  // selected — they are PII and have no UI use here (FR-018).
  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('display_name, role, status, welcome_dismissed_at')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (participantError !== null) {
    // Unexpected: the auth callback (T038) should have provisioned this row.
    // Log structured context for diagnosis, then redirect to the landing page
    // rather than rendering a broken dashboard.
    console.error('dashboard: failed to load participant row', {
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

  const t = await getTranslations('dashboard');

  // `display_name` is `NOT NULL` in the schema and the provisioning function
  // already falls back to the email local-part when the JWT `name` claim is
  // absent (see specs/.../data-model.md → provision_participant_from_jwt).
  // We defensively trim and substitute a neutral fallback if the value has
  // been edited to whitespace. We cannot use the email local-part here
  // because we did not — and should not — fetch the email column on the
  // dashboard (FR-018).
  const trimmedName = participant.display_name?.trim() ?? '';
  const nameForGreeting = trimmedName.length > 0 ? trimmedName : 'Participant';
  const greeting = t('greeting', { name: nameForGreeting });

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{greeting}</h1>
        {/* T054 (US4) attachment point — <AdminNavLink /> renders here when
            participant.role === 'admin'. */}
      </header>

      <section className="mt-10" aria-labelledby="upcoming-matches-heading">
        <h2 id="upcoming-matches-heading" className="sr-only">
          {t('emptyState')}
        </h2>
        <p className="rounded-md border border-dashed border-gray-300 px-6 py-10 text-center text-base text-gray-600">
          {t('emptyState')}
        </p>
      </section>

      {/* T058 (US5) attachment point — wrap the above tree in <DashboardClient>
          and mount <WelcomeModal /> gated on welcome_dismissed_at === null. */}
    </main>
  );
}
