import { notFound, redirect } from 'next/navigation';
import { getLocale } from 'next-intl/server';

import LockedPredictionDisplay from '@/components/predictions/LockedPredictionDisplay';
import PredictionForm from '@/components/predictions/PredictionForm';
import MatchDetailCard from '@/components/matches/MatchDetailCard';
import { defaultLocale, isLocale, type Locale } from '@/lib/i18n/locales';
import type { MatchStatus } from '@/lib/matches/lock-badge';
import { isPredictionLocked } from '@/lib/predictions/lock-state';
import { createClient } from '@/lib/supabase/server';

/**
 * Per-match detail page at `/matches/[id]` (US-MA / T034).
 *
 * Server Component. Reachable from any `<MatchCard/>` in the catalog list
 * (`/matches`) or the dashboard widget. Implements FR-M06 (detail surface),
 * FR-M07 (kickoff in participant TZ, locale-aware), and FR-M10 (the ticking
 * countdown is rendered inside `<MatchDetailCard/>` via the Client Component
 * `<LockCountdownTicker/>`).
 *
 * Auth control flow mirrors `app/(participant)/matches/page.tsx` and
 * `app/(participant)/dashboard/page.tsx`:
 *   - No Supabase user OR participant-row fetch error OR null row →
 *     redirect to `/`.
 *   - 404 (via `notFound()`) when the match id is malformed OR the match is
 *     not visible under the participant's RLS predicate (the eligibility
 *     gate from `is_eligible_nortal_user()` per migration 0016). Both
 *     conditions resolve to the same UI — there's no information leak about
 *     whether the match exists for ineligible users.
 *
 * `revalidate: 60` per NFR-M6 — read-path tolerance to a sub-minute
 * Supabase blip. The page's lock-state badge stays accurate at render time
 * (lockBadgeState() is recomputed from kickoff_utc + now() per render); the
 * client-side ticker on the detail card flips the badge to LOCKED at the
 * boundary without waiting for the next revalidation.
 *
 * Date boundary: PostgREST returns timestamps as ISO strings. The
 * MatchDetailCard accepts `kickoffUtc: Date | null`, so we materialise the
 * Date object once at this page boundary and pass the structured shape down.
 * The Server-to-Client serialisation inside MatchDetailCard (passing
 * `kickoffUtc?.toISOString()` to the ticker) re-stringifies — this is the
 * standard "string at the wire, Date in the component graph" pattern.
 */

export const revalidate = 60;

type PageProps = {
  params: Promise<{ id: string }>;
};

// RFC 4122 UUID format — 8-4-4-4-12 hex with hyphens. Guards against
// junk-id requests reaching PostgREST and avoids surfacing the malformed
// id as a 500 from the supabase client.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MATCH_STATUSES: readonly MatchStatus[] = [
  'scheduled',
  'scheduled-tbd',
  'live',
  'finished',
  'cancelled',
];

function isMatchStatus(value: unknown): value is MatchStatus {
  return typeof value === 'string' && (MATCH_STATUSES as readonly string[]).includes(value);
}

const STAGES = ['group', 'round-of-16', 'quarter-final', 'semi-final', 'third-place', 'final'] as const;
type Stage = (typeof STAGES)[number];

function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/**
 * Normalise the embedded-FK shape Supabase JS returns. Depending on the
 * generated types, `home_team` / `away_team` may arrive as either a single
 * object or a single-element array — guard against both shapes so a type
 * regeneration that shifts the shape doesn't break us silently.
 */
function normaliseTeam(value: unknown): { tla: string; name: string } | null {
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

export default async function MatchDetailPage({ params }: PageProps) {
  // Next 15 App Router: dynamic-route params arrive as a Promise.
  const { id } = await params;

  // Bail before touching the DB if the id isn't a syntactically valid UUID.
  // (Malformed values would otherwise reach PostgREST and surface as a 500
  // rather than a clean 404.)
  if (!UUID_REGEX.test(id)) {
    notFound();
  }

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) {
    redirect('/');
  }

  // Project only the participant columns this page needs (timezone + id for
  // the prediction lookup).
  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('id, timezone')
    .eq('auth_user_id', user.id)
    .maybeSingle();

  if (participantError !== null) {
    console.error('match-detail: failed to load participant row', {
      authUserId: user.id,
      message: participantError.message,
      code: participantError.code,
    });
    redirect('/');
  }

  if (participant === null) {
    redirect('/');
  }

  const rawLocale = await getLocale();
  const locale: Locale = isLocale(rawLocale) ? rawLocale : defaultLocale;

  // Fetch the single match with embedded team names. `maybeSingle()` returns
  // null without an error when no row matches OR when RLS filters everything
  // out — same UI outcome (notFound) so we don't leak existence info to
  // ineligible callers.
  //
  // Supabase-js + embedded-FK type narrowing: `maybeSingle()` with a
  // comma-separated select string + embedded relationships sometimes
  // produces a `Row | GenericStringError | null` union that TypeScript
  // can't narrow past the null check. The raw shape is correct at runtime
  // (PostgREST returns the columns named above); we cast through `unknown`
  // after the null + error checks below. The runtime safety still comes
  // from RLS + the normaliseTeam guard + isMatchStatus/isStage validation.
  type MatchDetailRow = {
    id: string;
    kickoff_utc: string | null;
    status: string;
    score_home: number | null;
    score_away: number | null;
    stage: string;
    group_label: string | null;
    venue: string | null;
    home_team: unknown;
    away_team: unknown;
  };

  const { data: matchRowRaw, error: matchError } = await supabase
    .from('matches')
    .select(
      'id, kickoff_utc, status, score_home, score_away, stage, group_label, venue, ' +
        'home_team:teams!matches_home_team_id_fkey(tla, name), ' +
        'away_team:teams!matches_away_team_id_fkey(tla, name)',
    )
    .eq('id', id)
    .maybeSingle();

  if (matchError !== null) {
    console.error('match-detail: failed to load match', {
      matchId: id,
      message: matchError.message,
      code: matchError.code,
    });
    notFound();
  }

  if (matchRowRaw === null) {
    notFound();
  }

  // Cast to our structural row type. Safe because:
  //   1. PostgREST returns exactly the columns named in the select string.
  //   2. The migration 0012 schema defines the column types.
  //   3. The isMatchStatus / isStage / normaliseTeam guards below validate
  //      the narrowed values before they reach the rendered component.
  const matchRow = matchRowRaw as unknown as MatchDetailRow;

  const homeTeam = normaliseTeam(matchRow.home_team);
  const awayTeam = normaliseTeam(matchRow.away_team);

  // Defensive — every match has exactly one home + away per FK constraints.
  // If the embedded shape can't be normalised, treat as a missing match
  // rather than crashing the render.
  if (homeTeam === null || awayTeam === null) {
    console.error('match-detail: failed to normalise team embedding', {
      matchId: id,
      home: matchRow.home_team,
      away: matchRow.away_team,
    });
    notFound();
  }

  if (!isMatchStatus(matchRow.status) || !isStage(matchRow.stage)) {
    console.error('match-detail: invalid stage or status enum from DB', {
      matchId: id,
      stage: matchRow.stage,
      status: matchRow.status,
    });
    notFound();
  }

  const match = {
    id: matchRow.id,
    kickoffUtc: matchRow.kickoff_utc ? new Date(matchRow.kickoff_utc) : null,
    status: matchRow.status,
    scoreHome: matchRow.score_home,
    scoreAway: matchRow.score_away,
    stage: matchRow.stage,
    groupLabel: matchRow.group_label,
    venue: matchRow.venue,
    homeTeam,
    awayTeam,
  };

  const nowUtc = new Date();

  // Fetch the participant's existing prediction for this match (if any) so
  // the form pre-fills + the locked-state renders the right values.
  // RLS scopes this to the participant's own rows.
  const { data: existingPrediction } = await supabase
    .from('predictions')
    .select('predicted_home_score, predicted_away_score')
    .eq('participant_id', participant.id)
    .eq('match_id', match.id)
    .maybeSingle();

  const predictionForUi = existingPrediction
    ? {
        home: existingPrediction.predicted_home_score,
        away: existingPrediction.predicted_away_score,
      }
    : null;

  // Server-side lock decision (BR-LOCK-001 trusted-time). The RPC re-checks
  // on submit; this gate decides which sub-component to mount.
  const lockedNow = match.kickoffUtc
    ? isPredictionLocked(match.kickoffUtc, nowUtc)
    : true;

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
      <MatchDetailCard
        match={match}
        nowUtc={nowUtc}
        participantTz={participant.timezone}
        locale={locale}
      />

      {/*
        Feature 003 US-PA mount point:
          - Locked + existing prediction → readonly display.
          - Locked + no prediction → form renders a "no prediction submitted" message internally.
          - Editable → form (with optional pre-fill).
      */}
      {lockedNow && predictionForUi !== null ? (
        <LockedPredictionDisplay prediction={predictionForUi} />
      ) : match.kickoffUtc ? (
        <PredictionForm
          matchId={match.id}
          kickoffUtc={match.kickoffUtc.toISOString()}
          initialPrediction={predictionForUi}
        />
      ) : null}
    </main>
  );
}
