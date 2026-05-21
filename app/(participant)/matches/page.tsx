import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import MatchCard from '@/components/matches/MatchCard';
import MatchFilters from '@/components/matches/MatchFilters';
import { dayBucket } from '@/lib/matches/day-bucket';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import type { MatchStatus } from '@/lib/matches/lock-badge';
import { createClient } from '@/lib/supabase/server';

/**
 * Participant `/matches` catalog browse page (US-M / T031).
 *
 * Server Component — the authoritative browse path for the full 104-fixture
 * catalog (FC-M3). Implements:
 *
 *   - FR-M04: kickoff ordering defaults to chronological-by-day, with day
 *     buckets sorted by their participant-local offset from "today" ASC.
 *     The closest upcoming day (Today / Tomorrow / next future weekday) sits
 *     at the top; past days fall at the bottom (negative offsets, sorted
 *     reverse-chronological so the most recent past day appears first
 *     among past-day buckets — see the bucket-sort comparator below).
 *   - FR-M05: URL searchParams (`stage`, `group`, `team`) compose with AND
 *     semantics. They are validated server-side and ignored if the value
 *     is not a known enum/pattern (e.g. junk `?stage=blah` does not reach
 *     PostgREST — see `STAGES`/`GROUP_REGEX` checks).
 *   - FR-M07: kickoff display is delegated to `<MatchCard>`, which calls
 *     `formatKickoff()` with the participant's stored timezone and the UI
 *     locale. This page never formats times itself ("store UTC, shift at
 *     render" — NFR-M4).
 *   - FR-M17: matches are grouped by *participant-local* day via
 *     `dayBucket()`, with localised section headers ("Today" / "Tomorrow" /
 *     explicit weekday for other days).
 *
 * `revalidate: 60` per NFR-M6 — the read path tolerates sub-minute
 * Supabase blips. The cached HTML is regenerated at most once per minute,
 * which is finer-grained than the kickoff-lock boundary (60 min) and well
 * inside the live-leaderboard cadence. We deliberately do NOT add
 * `unstable_cache` on top of this — the page-level revalidate is sufficient
 * and adds no surprise cache layers underneath the Supabase client.
 *
 * Auth control flow (inherited from feature 001's dashboard pattern in
 * `app/(participant)/dashboard/page.tsx` — that file is the canonical
 * source of truth for this codebase):
 *   - No Supabase user OR participant-row fetch error OR null row →
 *     redirect to `/`.
 *   - The "user exists but participant-row fetch errored" branch is logged
 *     with structured context per Constitution §1.3 because that is an
 *     unexpected condition (the auth callback should have provisioned the
 *     row). The "no user" branch is normal control flow and is not logged.
 *
 * Bucket-sort approach:
 *   The DB query orders matches by `kickoff_utc ASC NULLS LAST`. We then
 *   compute one `dayBucket()` per row in the *participant's* TZ — same UTC
 *   instant can land in different local days for different participants
 *   (TC-M9), so the grouping must be redone per request, not memoised at
 *   the DB layer. Buckets are then sorted by `offsetFromToday` ASC, which
 *   naturally produces:
 *       Today (0) → Tomorrow (+1) → +2 → +3 → ... → -1 → -2 → ...
 *   That is FR-M04's "closest upcoming first, past reverse-chronological"
 *   contract: future days ascend (closest first), and past days follow in
 *   descending offset (i.e. -1 before -2), which IS reverse-chronological
 *   because -1 is the most recent past day.
 *
 *   Within a bucket, the SQL `ORDER BY kickoff_utc ASC` already produces
 *   earliest-kickoff-first, which is the desired in-day order.
 *
 * Empty vs filtered distinction:
 *   When the matches query returns zero rows we render
 *   `matches.emptyCatalog` regardless of whether filters are active. The
 *   spec does not require a dedicated key for the filtered-empty case
 *   (task brief: "keep the default emptyCatalog for simplicity"), so the
 *   single key suffices for MVP. The distinction is still represented in
 *   the URL — the active filters remain in the address bar, so users can
 *   see which filters produced the empty set, and `<MatchFilters>` retains
 *   the user's selection. A future enhancement could add a
 *   `matches.filteredEmpty` key without changing this page's shape.
 */

/** Page-level cache cadence (NFR-M6). One-minute revalidation. */
export const revalidate = 60;

/** Valid `matches.stage` values, mirroring the DB CHECK in 0012_create_matches.sql. */
const STAGES = [
  'group',
  'round-of-16',
  'quarter-final',
  'semi-final',
  'third-place',
  'final',
] as const;
type Stage = (typeof STAGES)[number];

/** `matches.group_label` validation — single uppercase letter A–L (12 World Cup groups). */
const GROUP_REGEX = /^[A-L]$/;

type PageProps = {
  searchParams: Promise<{ stage?: string; group?: string; team?: string }>;
};

export default async function MatchesPage({ searchParams }: PageProps) {
  // Next 15 App Router: searchParams arrives as a Promise. Await once at the top.
  const params = await searchParams;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) {
    // Unauthenticated direct hit on `/matches`. Normal control flow — no log.
    redirect('/');
  }

  // Project only the participant columns this page needs. `timezone` drives
  // the day-bucket grouping and the per-card kickoff render. `display_name`
  // / email / oid / tid are intentionally NOT selected — FR-018 data
  // minimization, mirroring the dashboard contract.
  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('timezone')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (participantError !== null) {
    // Unexpected: the auth callback should have provisioned this row.
    console.error('matches: failed to load participant row', {
      authUserId: user.id,
      message: participantError.message,
      code: participantError.code,
    });
    redirect('/');
  }

  if (participant === null) {
    redirect('/');
  }

  // Resolve UI locale via next-intl. `getLocale()` returns `string`; narrow
  // to the supported set so the typed helpers (`dayBucket`, `MatchCard`)
  // accept it without an unsafe cast.
  const rawLocale = await getLocale();
  const locale: Locale = isLocale(rawLocale) ? rawLocale : defaultLocale;

  const t = await getTranslations('matches');

  // -- Filter validation --------------------------------------------------
  // Junk values are silently ignored (per task brief) so they never reach
  // PostgREST. This also keeps the URL self-describing — invalid filters
  // simply have no effect rather than producing an error page.
  const stageFilter: Stage | null =
    params.stage !== undefined && (STAGES as readonly string[]).includes(params.stage)
      ? (params.stage as Stage)
      : null;
  const groupFilter: string | null =
    params.group !== undefined && GROUP_REGEX.test(params.group) ? params.group : null;
  const teamFilter: string | null =
    params.team !== undefined && params.team.trim().length > 0 ? params.team : null;

  const hasAnyFilter =
    stageFilter !== null || groupFilter !== null || teamFilter !== null;

  // -- Resolve team filter (TLA → UUID) ----------------------------------
  // PostgREST cannot join into an `.or()` filter, so we resolve the TLA to
  // a UUID first and then `.or('home_team_id.eq.{uuid},away_team_id.eq.{uuid}')`.
  // If the TLA does not resolve, we leave the filter as a no-op and the
  // matches query proceeds without it (consistent with "ignore junk").
  let teamUuid: string | null = null;
  if (teamFilter !== null) {
    const { data: teamRow } = await supabase
      .from('teams')
      .select('id')
      .eq('tla', teamFilter)
      .maybeSingle();
    teamUuid = teamRow?.id ?? null;
  }

  // -- Matches query -----------------------------------------------------
  let matchesQuery = supabase
    .from('matches')
    .select(
      'id, kickoff_utc, status, score_home, score_away, stage, group_label, home_team_id, away_team_id, home_team:teams!matches_home_team_id_fkey(tla, name), away_team:teams!matches_away_team_id_fkey(tla, name)',
    )
    .order('kickoff_utc', { ascending: true, nullsFirst: false });

  if (stageFilter !== null) {
    matchesQuery = matchesQuery.eq('stage', stageFilter);
  }
  if (groupFilter !== null) {
    matchesQuery = matchesQuery.eq('group_label', groupFilter);
  }
  if (teamUuid !== null) {
    matchesQuery = matchesQuery.or(
      `home_team_id.eq.${teamUuid},away_team_id.eq.${teamUuid}`,
    );
  }

  const { data: matchRows, error: matchesError } = await matchesQuery;

  if (matchesError !== null) {
    console.error('matches: failed to load matches catalog', {
      authUserId: user.id,
      message: matchesError.message,
      code: matchesError.code,
    });
    redirect('/');
  }

  // -- Teams catalog (for the MatchFilters dropdown) ---------------------
  const { data: teamsCatalogRows, error: teamsError } = await supabase
    .from('teams')
    .select('tla, name')
    .order('tla');

  if (teamsError !== null) {
    console.error('matches: failed to load teams catalog', {
      authUserId: user.id,
      message: teamsError.message,
      code: teamsError.code,
    });
    redirect('/');
  }

  const teamsCatalog: Array<{ tla: string; name: string }> = teamsCatalogRows ?? [];

  // -- Derive available groups from the rendered match set ----------------
  // We derive groups from the *current* match query so the filter dropdown
  // never offers a group letter that produces an empty result for the
  // current stage filter. (For the default unfiltered view, this is the
  // full set A–H typical of the World Cup group stage.)
  const availableGroups: string[] = Array.from(
    new Set(
      (matchRows ?? [])
        .map((row) => row.group_label)
        .filter((label): label is string => label !== null && GROUP_REGEX.test(label)),
    ),
  ).sort();

  // -- Build day-bucket groups -------------------------------------------
  // `nowUtc` is captured once so the bucket math and any per-card
  // derivations (badge / countdown) share the same trusted timestamp.
  const nowUtc = new Date();
  const participantTz = participant.timezone;

  type DayGroup = {
    bucketKey: string;
    bucketLabel: string;
    offsetFromToday: number;
    matches: Array<{
      id: string;
      kickoffUtc: Date | null;
      status: MatchStatus;
      scoreHome: number | null;
      scoreAway: number | null;
      groupLabel: string | null;
      homeTeam: { tla: string; name: string };
      awayTeam: { tla: string; name: string };
    }>;
  };

  const dayGroupsByKey = new Map<string, DayGroup>();
  // A separate "no kickoff" bucket — for `scheduled-tbd` matches with NULL
  // kickoff there is no calendar day to bucket into. We surface them at the
  // bottom (offsetFromToday = +Infinity sort key) so the upcoming-first
  // ordering is preserved.
  let tbdGroup: DayGroup | null = null;

  for (const row of matchRows ?? []) {
    // Normalise the joined team relations. PostgREST returns embedded
    // 1-row relations as arrays or objects depending on cardinality
    // metadata; both shapes are safe to handle defensively.
    const homeTeam = normaliseTeam(row.home_team);
    const awayTeam = normaliseTeam(row.away_team);
    if (homeTeam === null || awayTeam === null) {
      // Malformed FK join — skip the row rather than crashing the page.
      continue;
    }

    const kickoffUtc =
      row.kickoff_utc !== null ? new Date(row.kickoff_utc) : null;

    const cardData = {
      id: row.id,
      kickoffUtc,
      status: row.status as MatchStatus,
      scoreHome: row.score_home,
      scoreAway: row.score_away,
      groupLabel: row.group_label,
      homeTeam,
      awayTeam,
    };

    if (kickoffUtc === null) {
      if (tbdGroup === null) {
        tbdGroup = {
          bucketKey: '__tbd__',
          bucketLabel: t('tbdHeader'),
          offsetFromToday: Number.POSITIVE_INFINITY,
          matches: [],
        };
      }
      tbdGroup.matches.push(cardData);
      continue;
    }

    const bucket = dayBucket(kickoffUtc, participantTz, locale, nowUtc);
    const existing = dayGroupsByKey.get(bucket.bucketKey);
    if (existing !== undefined) {
      existing.matches.push(cardData);
    } else {
      dayGroupsByKey.set(bucket.bucketKey, {
        bucketKey: bucket.bucketKey,
        bucketLabel: bucket.bucketLabel,
        offsetFromToday: bucket.offsetFromToday,
        matches: [cardData],
      });
    }
  }

  // Sort comparator: future days ascend (Today→Tomorrow→+2→...), then past
  // days descend (-1→-2→...). Implementation: split sign — non-negative
  // offsets sort ASC, negative offsets sort DESC, and all negatives come
  // after all non-negatives. See "Bucket-sort approach" in the docblock.
  const dayGroups: DayGroup[] = Array.from(dayGroupsByKey.values()).sort((a, b) => {
    const aPast = a.offsetFromToday < 0;
    const bPast = b.offsetFromToday < 0;
    if (aPast !== bPast) return aPast ? 1 : -1;
    if (aPast) return b.offsetFromToday - a.offsetFromToday; // -1 before -2
    return a.offsetFromToday - b.offsetFromToday; // 0,1,2,...
  });

  if (tbdGroup !== null) {
    dayGroups.push(tbdGroup);
  }

  const totalRendered = (matchRows ?? []).length;

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">{t('pageHeading')}</h1>
        <p className="text-base text-gray-600">{t('pageDescription')}</p>
      </header>

      <section className="mt-6">
        <MatchFilters
          searchParams={{
            stage: stageFilter ?? undefined,
            group: groupFilter ?? undefined,
            team: teamFilter ?? undefined,
          }}
          availableStages={[...STAGES]}
          availableGroups={availableGroups}
          availableTeams={teamsCatalog}
        />
      </section>

      {totalRendered === 0 ? (
        <section className="mt-10">
          {/* Empty/filtered distinction:
                - No filters AND zero rows → the schedule hasn't been
                  loaded yet (emptyCatalog).
                - Filters applied AND zero rows → the filter combination
                  yielded nothing (filteredEmpty). */}
          <p className="rounded-md border border-dashed border-gray-300 px-6 py-10 text-center text-base text-gray-600">
            {hasAnyFilter ? t('filteredEmpty') : t('emptyCatalog')}
          </p>
        </section>
      ) : (
        dayGroups.map((group) => (
          <section key={group.bucketKey} aria-labelledby={`day-${group.bucketKey}`}>
            <h2
              id={`day-${group.bucketKey}`}
              className="mt-8 text-lg font-semibold"
            >
              {group.bucketLabel}
            </h2>
            <div className="mt-3 space-y-3">
              {group.matches.map((match) => (
                <MatchCard
                  key={match.id}
                  match={match}
                  nowUtc={nowUtc}
                  participantTz={participantTz}
                  locale={locale}
                />
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}

/**
 * Normalise PostgREST's embedded-relation shape. Depending on FK cardinality
 * inference the joined row may arrive as `{ tla, name }`, `{ tla, name }[]`,
 * or `null`; we accept all three and return a plain `{ tla, name }` or null.
 */
function normaliseTeam(
  value: unknown,
): { tla: string; name: string } | null {
  if (value === null || value === undefined) return null;
  const candidate = Array.isArray(value) ? value[0] : value;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'tla' in candidate &&
    'name' in candidate &&
    typeof (candidate as { tla: unknown }).tla === 'string' &&
    typeof (candidate as { name: unknown }).name === 'string'
  ) {
    return {
      tla: (candidate as { tla: string }).tla,
      name: (candidate as { name: string }).name,
    };
  }
  return null;
}
