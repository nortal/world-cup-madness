import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import EmptyLeaderboardState from '@/components/leaderboard/EmptyLeaderboardState';
import LeaderboardTable from '@/components/leaderboard/LeaderboardTable';
import ShowMyRankButton from '@/components/leaderboard/ShowMyRankButton';
import StageTabStrip from '@/components/leaderboard/StageTabStrip';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import { parseStage, type Stage } from '@/lib/leaderboard/stage-url-state';
import type { LeaderboardRow } from '@/lib/leaderboard/types';
import { createClient } from '@/lib/supabase/server';

/**
 * `/leaderboard` page composer (feature 004 US-LA T015).
 *
 * Server Component. Orchestrates:
 *   1. Auth gate (FR-L10 / TC-L2) — unauthed or non-active redirect to `/`.
 *   2. Stage + page parsing from URL `searchParams` (defaults: `all` / 1).
 *      Invalid `stage` collapses to `'all'`; invalid `page` collapses to 1.
 *   3. Pre-tournament short-circuit (FR-L07): if `score_events` is empty,
 *      render `<EmptyLeaderboardState/>` instead of the table. The full
 *      countdown body ships in US-LE T036.
 *   4. Primary fetch: `leaderboard_snapshots` page (25 rows, public
 *      projection only — column-level GRANT keeps the private tie-breaker
 *      columns invisible to the `authenticated` role, FR-L02 / NFR-L6).
 *   5. Self-rank fetch: `leaderboard_self` view for the participant's own
 *      rank at the active stage — used by `<ShowMyRankButton/>` to compute
 *      the target page on click.
 *   6. Compose page UI with `<h1>`, description, "Show my rank" button,
 *      table, and prev/next pagination links.
 *
 * Stage filter UI (US-LB) and Realtime subscription (US-LC) attach later;
 * this composer ships the static server-rendered page for US-LA.
 *
 * The stage validation is inline at MVP — US-LB T019 extracts it into
 * `lib/leaderboard/stage-url-state.ts` and the page picks up the helper.
 */

const ROWS_PER_PAGE = 25;

function parsePage(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return 1;
  return parsed;
}

type LeaderboardPageProps = {
  searchParams: Promise<{ stage?: string; page?: string }>;
};

export default async function LeaderboardPage({
  searchParams,
}: LeaderboardPageProps): Promise<React.ReactElement> {
  const params = await searchParams;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) {
    // Unauthed direct hit on `/leaderboard`. Normal control flow — no log.
    redirect('/');
  }

  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('id, status')
    .eq('auth_user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (participantError !== null) {
    // Unexpected: the auth callback should have provisioned this row. Log
    // structured context per Constitution §1.3 then redirect.
    console.error('leaderboard: failed to load participant row', {
      authUserId: user.id,
      message: participantError.message,
      code: participantError.code,
    });
    redirect('/');
  }

  if (participant === null) {
    // No active participant row matching this auth user — redirect to landing.
    redirect('/');
  }

  const activeStage: Stage = parseStage(params.stage ?? null);
  const currentPage = parsePage(params.page);

  const rawLocale = await getLocale();
  const locale: Locale = isLocale(rawLocale) ? rawLocale : defaultLocale;

  const t = await getTranslations('leaderboard');

  // Pre-tournament short-circuit (FR-L07). Cheaper than fetching the MV
  // page and then discovering it's empty — and the MV is intentionally
  // empty pre-tournament because `should_refresh_leaderboard()` skips the
  // refresh until the first `score_events` row lands (FR-L22).
  const { count: scoreEventsCount } = await supabase
    .from('score_events')
    .select('id', { count: 'exact', head: true });

  if ((scoreEventsCount ?? 0) === 0) {
    // No matches scored yet — render the empty-state placeholder. The
    // first-kickoff lookup feeds the future US-LE countdown body; for the
    // T012 shell it's accepted but unused.
    const { data: firstMatch } = await supabase
      .from('matches')
      .select('kickoff_utc')
      .neq('status', 'cancelled')
      .order('kickoff_utc', { ascending: true })
      .limit(1)
      .maybeSingle();

    const firstKickoffUtc =
      firstMatch?.kickoff_utc !== undefined && firstMatch?.kickoff_utc !== null
        ? new Date(firstMatch.kickoff_utc)
        : null;

    return (
      <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
        <h1 className="text-3xl font-semibold tracking-tight">{t('pageHeading')}</h1>
        <p className="mt-2 text-base text-gray-600">{t('pageDescription')}</p>
        <EmptyLeaderboardState firstKickoffUtc={firstKickoffUtc} />
      </main>
    );
  }

  // Public-projection paginated read. RLS + column-level GRANT keep this
  // to the FR-L02 minimum set (rank/name/total + identity); the private
  // tie-breaker columns are unreachable here.
  const offset = (currentPage - 1) * ROWS_PER_PAGE;
  const { data: rowsRaw } = await supabase
    .from('leaderboard_snapshots')
    .select('participant_id, stage, display_name, total_points, rank, rank_is_shared')
    .eq('stage', activeStage)
    .order('rank', { ascending: true })
    .order('display_name', { ascending: true })
    .range(offset, offset + ROWS_PER_PAGE - 1);

  const rows: LeaderboardRow[] = (rowsRaw ?? []) as LeaderboardRow[];

  // Self-row rank fetch (via the security-filtered view). Used by
  // `<ShowMyRankButton/>` to compute the target page on click.
  const { data: selfRowRaw } = await supabase
    .from('leaderboard_self')
    .select('rank')
    .eq('stage', activeStage)
    .maybeSingle();

  const selfRank = selfRowRaw?.rank ?? null;

  const hasPrevPage = currentPage > 1;
  const hasNextPage = rows.length === ROWS_PER_PAGE;

  const stageLabels = {
    all: t('stageAll'),
    group: t('stageGroup'),
    r16: t('stageR16'),
    quarter: t('stageQuarter'),
    semi: t('stageSemi'),
    final: t('stageFinal'),
  } as const;

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t('pageHeading')}</h1>
        <p className="text-base text-gray-600">{t('pageDescription')}</p>
      </header>

      <StageTabStrip
        activeStage={activeStage}
        baseHref="/leaderboard"
        labels={stageLabels}
        ariaLabel={t('stageTabsLabel')}
      />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <ShowMyRankButton
          selfRank={selfRank}
          rowsPerPage={ROWS_PER_PAGE}
          activeStage={activeStage}
          baseHref="/leaderboard"
        />
      </div>

      <LeaderboardTable
        stage={activeStage}
        page={currentPage}
        rows={rows}
        selfParticipantId={participant.id}
        locale={locale}
      />

      <nav
        className="mt-6 flex items-center justify-between gap-4"
        aria-label={t('pageHeading')}
      >
        {hasPrevPage ? (
          <Link
            href={`/leaderboard?stage=${encodeURIComponent(activeStage)}&page=${currentPage - 1}`}
            className="rounded-md border border-gray-300 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {t('previousPage')}
          </Link>
        ) : (
          <span aria-hidden="true" />
        )}
        <span className="text-sm text-gray-600 tabular-nums">
          {t('pageIndicator', { page: currentPage })}
        </span>
        {hasNextPage ? (
          <Link
            href={`/leaderboard?stage=${encodeURIComponent(activeStage)}&page=${currentPage + 1}`}
            className="rounded-md border border-gray-300 px-3 py-1 text-sm text-blue-700 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {t('nextPage')}
          </Link>
        ) : (
          <span aria-hidden="true" />
        )}
      </nav>
    </main>
  );
}
