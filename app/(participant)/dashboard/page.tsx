import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import AdminNavLink from '@/components/auth/AdminNavLink';
import DashboardClient from '@/components/auth/DashboardClient';
import TimezoneAutoDetect from '@/components/matches/TimezoneAutoDetect';
import UpcomingMatchesWidget from '@/components/matches/UpcomingMatchesWidget';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import { createClient } from '@/lib/supabase/server';

// Per NFR-M6 (feature 002): tolerate a sub-minute Supabase blip on the
// read path by caching the rendered dashboard for up to 60 seconds.
// Lock-state badges on the upcoming-matches widget are recomputed on every
// server render even when the underlying matches data is served from cache,
// so the badge state never goes stale beyond the revalidate window.
export const revalidate = 60;

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
 * Attachment points for follow-up tasks:
 *   - T054 (US4): LANDED — renders `<AdminNavLink />` inside the header when
 *     `participant.role === 'admin'` (TC-3, FR-A5). The `/admin` route is a
 *     future feature; the link is intentionally a stub for MVP.
 *   - T058 (US5): LANDED — the rendered tree is wrapped in `<DashboardClient>`
 *     (Client Component) which conditionally mounts `<WelcomeModal />` when
 *     `welcome_dismissed_at === null`. The dashboard subtree itself stays
 *     server-rendered (passed through `children`); only the modal-mounting
 *     decision crosses the client boundary.
 *   - T036 (US-MA): LANDED — replaced the feature-001 empty-state placeholder
 *     with `<UpcomingMatchesWidget />` (FR-M12). The widget reuses the
 *     `upcoming-matches-heading` id so screen-reader bookmarks survive.
 *   - T044 (US-MB): LANDED — `<TimezoneAutoDetect />` Client Component mounts
 *     conditionally when `participant.timezone === 'UTC'` (the default after
 *     provisioning). On first dashboard mount it reads
 *     `Intl.DateTimeFormat().resolvedOptions().timeZone` and calls
 *     `set_timezone()` once via the browser supabase client (FR-M14). The
 *     gate avoids an RPC round-trip when the column has already been set;
 *     the RPC itself is internally idempotent (one-shot via its
 *     `WHERE timezone='UTC'` filter), so a stale gate just costs a no-op.
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

  // Project only the columns this page (and its US4 / US5 / US-MA follow-ups)
  // need. `welcome_dismissed_at` is selected for T058 (welcome modal gate);
  // `role` for T054 (admin nav link); `timezone` for T036 (UpcomingMatchesWidget
  // day-bucketing + kickoff render). Email / oid are intentionally NOT
  // selected — they are PII and have no UI use here (FR-018).
  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('display_name, role, status, welcome_dismissed_at, timezone')
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

  // Resolve UI locale via next-intl. `getLocale()` returns `string`; narrow
  // to the supported set so the typed widget accepts it without an unsafe
  // cast. Matches the pattern used in `app/(participant)/matches/page.tsx`.
  const rawLocale = await getLocale();
  const locale: Locale = isLocale(rawLocale) ? rawLocale : defaultLocale;

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

  const isFirstLogin = participant.welcome_dismissed_at === null;

  return (
    <DashboardClient isFirstLogin={isFirstLogin}>
      <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">{greeting}</h1>
          {/* T054 (US4) — admin nav link surfaced only when the role check passes
              (TC-3 / FR-A5). The role value comes from the RLS-protected
              participants row above, so this gate is the authoritative
              server-side check. The `/admin` route is a future feature. */}
          {participant.role === 'admin' && <AdminNavLink />}
        </header>

        {/* T036 (US-MA / FR-M12) — replaced the feature-001 empty-state
            placeholder with the live upcoming-matches widget. The widget
            preserves the `upcoming-matches-heading` id so screen-reader
            bookmarks survive. Its own empty-state messaging (zero upcoming
            matches scheduled) lives inside the widget — see
            `matches.dashboardWidget.emptyState`. */}
        <UpcomingMatchesWidget participantTz={participant.timezone} locale={locale} />

        {/* T065 (US-PD) — predictions navigation. Links to the final-predictions
            form and the personal score breakdown. */}
        <nav aria-label={t('nav.predictionsAria')} className="mt-8 flex flex-wrap gap-4">
          <a
            href="/predictions/final"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {t('nav.finalPredictions')}
          </a>
          <a
            href="/predictions/breakdown"
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {t('nav.breakdown')}
          </a>
        </nav>

        {/* T044 (US-MB / FR-M14) — renderless side-effect Client Component
            that auto-detects the browser timezone on first dashboard mount.
            Gated on the participant still holding the default 'UTC' value
            so we don't fire an RPC that's guaranteed to no-op. The RPC
            itself (`set_timezone`) is internally idempotent via its
            `WHERE timezone='UTC'` filter, so a stale gate is harmless. */}
        {participant.timezone === 'UTC' && <TimezoneAutoDetect />}
      </main>
    </DashboardClient>
  );
}
