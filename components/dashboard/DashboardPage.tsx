import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import DashboardTabStrip from '@/components/dashboard/DashboardTabStrip';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import { parseTab, type DashboardTab } from '@/lib/dashboard/tab-url-state';
import { createClient } from '@/lib/supabase/server';

/**
 * `/dashboard` page composer (feature 005 US-DA T009).
 *
 * Server Component skeleton. T010 (Phase 3) fills in the Today + Pool
 * widget slots and the desktop grid layout. T011 wires this composer into
 * the existing `app/(participant)/dashboard/page.tsx` route so the
 * existing dashboard widgets (UpcomingMatchesWidget, RankWidget, admin
 * nav, predictions nav, TimezoneAutoDetect, welcome flow) move into the
 * Today-tab + desktop-grid slots — FR-D18 preservation.
 *
 * Auth gate mirrors feature 004's LeaderboardPage: unauthed / non-active
 * participants get redirected to `/`.
 *
 * URL contract (FR-D02):
 *   - `?tab=today` (or no `?tab=` at all) → Today is active.
 *   - `?tab=pool` → Pool is active.
 *   - Anything else collapses to `'today'` (per `parseTab`).
 *   - Defaults to Today on every fresh navigation without `?tab=` (no
 *     localStorage / sessionStorage persistence).
 */

type DashboardPageProps = {
  searchParams: Promise<{ tab?: string }>;
};

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps): Promise<React.ReactElement> {
  const params = await searchParams;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) {
    redirect('/');
  }

  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('id, status, timezone, display_name, role')
    .eq('auth_user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (participantError !== null) {
    console.error('dashboard: failed to load participant row', {
      authUserId: user.id,
      message: participantError.message,
      code: participantError.code,
    });
    redirect('/');
  }

  if (participant === null) {
    redirect('/');
  }

  const activeTab: DashboardTab = parseTab(params.tab ?? null);

  const rawLocale = await getLocale();
  const locale: Locale = isLocale(rawLocale) ? rawLocale : defaultLocale;

  const t = await getTranslations('dashboard');

  const tabLabels = {
    today: t('tabToday'),
    pool: t('tabPool'),
  } as const;

  // `participant` and `locale` are intentionally read here so subsequent
  // tasks (T010+) can wire widget slots without re-fetching. Referenced
  // via void-expression so TS `noUnusedLocals` (if enabled) stays quiet
  // for the skeleton phase.
  void participant;
  void locale;

  return (
    <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-6">
      <DashboardTabStrip
        activeTab={activeTab}
        labels={tabLabels}
        ariaLabel={t('tabsAriaLabel')}
      />

      {/* T010 (Phase 3 US-DA) fills these slots with the Today + Pool widgets and the desktop grid. */}
      <section
        id="today-panel"
        role="tabpanel"
        aria-labelledby="today-tab"
        hidden={activeTab !== 'today'}
        className="block md:hidden"
      >
        {/* mobile Today slots — placeholder */}
      </section>
      <section
        id="pool-panel"
        role="tabpanel"
        aria-labelledby="pool-tab"
        hidden={activeTab !== 'pool'}
        className="block md:hidden"
      >
        {/* mobile Pool slots — placeholder */}
      </section>
      <div className="hidden md:grid md:grid-cols-2 md:gap-4">
        {/* desktop grid — placeholder */}
      </div>
    </main>
  );
}
