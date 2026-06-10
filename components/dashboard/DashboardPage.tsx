import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import AdminNavLink from '@/components/auth/AdminNavLink';
import DashboardClient from '@/components/auth/DashboardClient';
import DashboardRealtime from '@/components/dashboard/DashboardRealtime';
import DashboardTabStrip from '@/components/dashboard/DashboardTabStrip';
import DigestWidget from '@/components/dashboard/DigestWidget';
import MoversWidget from '@/components/dashboard/MoversWidget';
import NeighborhoodWidget from '@/components/dashboard/NeighborhoodWidget';
import PreTournamentPlaceholder from '@/components/dashboard/PreTournamentPlaceholder';
import RankWidget from '@/components/dashboard/RankWidget';
import RefreshingChip from '@/components/dashboard/RefreshingChip';
import SnapshotWidget from '@/components/dashboard/SnapshotWidget';
import TimezoneAutoDetect from '@/components/matches/TimezoneAutoDetect';
import UpcomingMatchesWidget from '@/components/matches/UpcomingMatchesWidget';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import { computeNeighborhoodWindow } from '@/lib/dashboard/neighborhood-window';
import { parseTab, type DashboardTab } from '@/lib/dashboard/tab-url-state';
import { createClient } from '@/lib/supabase/server';

/**
 * `/dashboard` page composer (feature 005 US-DA T009 + T010).
 *
 * Server Component. Renders the full participant dashboard:
 *
 *   - A persistent page header (greeting + admin nav + predictions nav +
 *     `<TimezoneAutoDetect/>`) that is tab-agnostic and sits ABOVE the tab
 *     strip on every viewport.
 *   - On mobile (≤ 768 px): `<DashboardTabStrip/>` followed by two
 *     `role="tabpanel"` sections — one for Today (Upcoming + Rank +
 *     Snapshot-slot) and one for Pool (Neighborhood-slot + Movers-slot +
 *     Digest-slot). The inactive panel is `hidden`.
 *   - On desktop (> 768 px): both tab sets render simultaneously in a
 *     2-column grid; the tab strip itself is CSS-hidden via `md:hidden`
 *     inside the strip component.
 *
 * Per research §R-3 the same JSX is server-rendered twice (mobile + desktop
 * variants) with CSS toggling visibility — no JS media-query listener.
 *
 * FR-D18: every existing dashboard surface from features 002-004 is
 * preserved. The widgets MOVED from `app/(participant)/dashboard/page.tsx`
 * into this composer; the route itself is now a thin wrapper (T011).
 *
 * Auth gate mirrors feature 004's LeaderboardPage: unauthed / missing
 * participant row → redirect to `/`.
 *
 * URL contract (FR-D02):
 *   - `?tab=today` (or no `?tab=` at all) → Today is active.
 *   - `?tab=pool` → Pool is active.
 *   - Anything else collapses to `'today'` (per `parseTab`).
 *
 * SnapshotWidget / NeighborhoodWidget / MoversWidget / DigestWidget ship in
 * US-DC (T026-T030). Their slots are placeholder comments here so the
 * layout shape lands first.
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

  // Project only the columns this composer needs. `welcome_dismissed_at`
  // gates the first-login modal; `role` gates the admin nav link;
  // `timezone` is consumed by `<UpcomingMatchesWidget/>` and by the
  // `<TimezoneAutoDetect/>` Client Component gate. Email / oid are
  // intentionally NOT selected — they are PII and have no UI use here
  // (FR-018).
  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('id, display_name, role, status, welcome_dismissed_at, timezone')
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

  const tabLabels: Record<DashboardTab, string> = {
    today: t('tabToday'),
    pool: t('tabPool'),
  };

  // Greeting fallback mirrors the existing dashboard route: trim, then
  // substitute a neutral fallback if whitespace-only. We cannot reach for
  // the email local-part here because the email column is not — and should
  // not be — selected on the dashboard (FR-018).
  const trimmedName = participant.display_name?.trim() ?? '';
  const nameForGreeting = trimmedName.length > 0 ? trimmedName : 'Participant';
  const greeting = t('greeting', { name: nameForGreeting });

  const isFirstLogin = participant.welcome_dismissed_at === null;

  // US-LD initial-data fetch for `<RankWidget/>`. Both reads tolerate a
  // missing row (pre-tournament has no `leaderboard_self` row, and the
  // matches table is empty in the seed-only phase). The widget itself
  // decides what to show — see feature 004 RankWidget contract.
  const { data: selfRank } = await supabase
    .from('leaderboard_self')
    .select('rank')
    .eq('stage', 'all')
    .maybeSingle();

  const { data: firstKickoffRow } = await supabase
    .from('matches')
    .select('kickoff_utc')
    .neq('status', 'cancelled')
    .order('kickoff_utc', { ascending: true })
    .limit(1)
    .maybeSingle();

  // US-DE T041 / FR-D14 — pre-tournament gate. The Postgres helper
  // returns true while no match has reached a scored terminal state
  // (no rows in score_events). When true we swap the three Pool
  // widgets for `<PreTournamentPlaceholder/>` so participants who
  // navigate to the Pool tab before the first kickoff see a coherent
  // "awaiting first match" surface instead of three empty widgets.
  // Today widgets render unchanged — RankWidget / UpcomingMatches /
  // Snapshot each carry their own pre-tournament branch.
  const { data: isPreTournament } = await supabase.rpc('is_pre_tournament');

  // Pre-fetch the neighborhood participant IDs for `<MoversWidget/>` so it
  // can render the "Top 3 near you" sub-section without re-issuing the
  // total-participant-count query. Mirrors `<NeighborhoodWidget/>`'s slice
  // query (contracts/query-neighborhood.md).
  const { count: totalParticipants } = await supabase
    .from('leaderboard_snapshots')
    .select('participant_id', { count: 'exact', head: true })
    .eq('stage', 'all');

  let neighborhoodParticipantIds: string[] = [];
  if (selfRank?.rank !== undefined && selfRank.rank !== null && (totalParticipants ?? 0) > 0) {
    const window = computeNeighborhoodWindow(selfRank.rank, totalParticipants ?? 0);
    const { data: windowRows } = await supabase
      .from('leaderboard_snapshots')
      .select('participant_id')
      .eq('stage', 'all')
      .order('rank', { ascending: true })
      .order('display_name', { ascending: true })
      .range(window.startRank - 1, window.endRank - 1);
    neighborhoodParticipantIds = (windowRows ?? []).map((r) => r.participant_id ?? '').filter(Boolean);
  }

  // The Today-tab widget group is rendered twice — once inside the mobile
  // tab panel and once inside the desktop grid (research §R-3: same JSX,
  // CSS-toggled visibility, no JS media-query listener). The Server
  // Components inside (`<UpcomingMatchesWidget/>`, `<RankWidget/>`) are
  // idempotent on the data they fetch / receive as props, so duplicating
  // the JSX is safe; the duplicate render cost is negligible.
  const todayWidgets = (
    <>
      {/* T036 (US-MA / FR-M12) — live upcoming-matches widget. Preserves
          the `upcoming-matches-heading` id so screen-reader bookmarks
          survive. US-DB (T015) will wrap the row in `<ExpandableMatchCard/>`
          for inline quick-edit. */}
      <UpcomingMatchesWidget participantTz={participant.timezone} locale={locale} />

      {/* T033 (US-LD / FR-L08) — compact rank widget. Pre-tournament
          (null rank + known first kickoff) the widget renders a countdown
          anchor; once scoring starts it shows the live rank + delta. */}
      <RankWidget
        initialRank={selfRank?.rank ?? null}
        initialFirstKickoffUtc={firstKickoffRow?.kickoff_utc ?? null}
        locale={locale}
      />

      {/* US-DC T026 / FR-D09 — split snapshot card: latest finished
          prediction + next upcoming prediction. */}
      <SnapshotWidget
        selfParticipantId={participant.id}
        locale={locale}
        userTz={participant.timezone}
      />
    </>
  );

  const poolWidgets = isPreTournament ? (
    <>
      {/* US-DE T041 / FR-D14 — pre-tournament placeholders preserve the
          same `aria-labelledby` ids as the live widgets so any downstream
          SR bookmarks or test locators keep working through the swap. */}
      <PreTournamentPlaceholder widgetType="neighborhood" locale={locale} />
      <PreTournamentPlaceholder widgetType="movers" locale={locale} />
      <PreTournamentPlaceholder widgetType="digest" locale={locale} />
    </>
  ) : (
    <>
      {/* US-DC T027 / FR-D10 — hybrid-clamped ±5 neighborhood slice. */}
      <NeighborhoodWidget
        selfParticipantId={participant.id}
        selfRank={selfRank?.rank ?? null}
        locale={locale}
      />
      {/* US-DC T028 / FR-D11 — global + neighborhood top-3 climbers. */}
      <MoversWidget
        selfParticipantId={participant.id}
        neighborhoodParticipantIds={neighborhoodParticipantIds}
        locale={locale}
      />
      {/* US-DC T029 / FR-D13 — current-week digest (Mon-Sun UTC). */}
      <DigestWidget selfParticipantId={participant.id} locale={locale} />
    </>
  );

  return (
    <DashboardClient isFirstLogin={isFirstLogin}>
      <main className="mx-auto min-h-screen w-full max-w-5xl px-4 py-6">
        {/* US-DD T037 — Client wrapper that owns the Realtime channel +
            transition state. Provides `DashboardRefreshContext` to all
            descendants so `<RefreshingChip/>` (below) can announce
            in-flight re-fetches without lifting state into this Server
            Component. */}
        <DashboardRealtime activeTab={activeTab}>
        <header className="space-y-2">
          {/* US-DD T035 — fixed-position polite-live status chip;
              renders only while `isRefetching` is true. Mounted inside
              the header so it sits above the tab strip in the visual
              hierarchy. */}
          <RefreshingChip />
          <h1 className="text-3xl font-semibold tracking-tight">{greeting}</h1>
          {/* T054 (US4 / FR-A5) — admin nav link, role-gated server-side. */}
          {participant.role === 'admin' && <AdminNavLink />}

          {/* T065 (US-PD) — predictions navigation. Final predictions form
              + personal breakdown links. Tab-agnostic; lives in the page
              header so it is reachable from both tabs and from desktop. */}
          <nav aria-label={t('nav.predictionsAria')} className="mt-4 flex flex-wrap gap-4">
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
        </header>

        {/* Mobile tab strip — the component itself wraps in `md:hidden`,
            so the strip vanishes on desktop where the 2-col grid is shown
            instead. */}
        <DashboardTabStrip
          activeTab={activeTab}
          labels={tabLabels}
          ariaLabel={t('tabsAriaLabel')}
        />

        {/* Mobile Today panel. The `hidden` attribute (HTML, not Tailwind)
            toggles visibility based on activeTab so the inactive panel is
            also hidden from the accessibility tree. */}
        <section
          id="today-panel"
          role="tabpanel"
          aria-labelledby="today-tab"
          hidden={activeTab !== 'today'}
          className="block md:hidden"
        >
          {todayWidgets}
        </section>

        {/* Mobile Pool panel. */}
        <section
          id="pool-panel"
          role="tabpanel"
          aria-labelledby="pool-tab"
          hidden={activeTab !== 'pool'}
          className="block md:hidden"
        >
          {poolWidgets}
        </section>

        {/* Desktop grid (> 768 px). Both tab sets render simultaneously.
            The grid auto-collapses to one column on tablets via the
            responsive grid-cols utilities. */}
        <div className="hidden md:grid md:grid-cols-2 md:gap-4 mt-4">
          {todayWidgets}
          {poolWidgets}
        </div>

        {/* T044 (US-MB / FR-M14) — renderless side-effect Client Component
            that auto-detects the browser timezone on first dashboard mount.
            Gated on the participant still holding the default 'UTC' value
            so we don't fire an RPC that's guaranteed to no-op. The RPC
            itself (`set_timezone`) is internally idempotent via its
            `WHERE timezone='UTC'` filter, so a stale gate is harmless. */}
        {participant.timezone === 'UTC' && <TimezoneAutoDetect />}
        </DashboardRealtime>
      </main>
    </DashboardClient>
  );
}
