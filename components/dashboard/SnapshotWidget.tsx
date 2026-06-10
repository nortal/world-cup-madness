import { getTranslations } from 'next-intl/server';

import type { SnapshotData } from '@/lib/dashboard/types';
import { createClient } from '@/lib/supabase/server';

/**
 * `<SnapshotWidget/>` — Today-tab split card (feature 005 US-DC T026 / FR-D09).
 *
 * Server Component. Renders two side-by-side `<article>` cards (stacked on
 * mobile via the responsive Tailwind grid):
 *
 *   1. "Last finished match" — the caller's most-recent prediction on a
 *      finished match, with the team names, prediction, actual score, and
 *      points awarded.
 *   2. "Next upcoming match" — the next not-yet-kicked match the caller
 *      is eligible to predict, with the caller's current pick (or a
 *      "No pick yet" prompt if they haven't submitted one).
 *
 * Both sides may be `null` independently:
 *   - `lastFinished === null` → left card renders "No predictions on
 *     finished matches yet".
 *   - `nextUpcoming === null` → right card renders "No upcoming matches".
 *   - When BOTH are null we still render TWO empty articles (per FR-D09's
 *     two-card layout commitment) rather than collapsing to one message.
 *
 * Data fetching uses PostgREST embedded resource selection (one round-trip
 * per side) — see `contracts/query-last-finished-prediction.md` and
 * `contracts/query-upcoming-prediction.md`. The two queries are fired in
 * parallel via `Promise.all` to keep TTFB tight.
 */

type SnapshotWidgetProps = {
  selfParticipantId: string;
  locale: string;
  userTz: string;
};

// Shapes derived from the embed contracts. The Supabase generated types
// don't infer the join shapes deep enough, so we keep a local shape that
// mirrors the contract result exactly — runtime data is validated by the
// PostgREST query and the contract test (e2e/tests/dashboard-mobile-tabs).
//
// The query starts FROM `matches` and reverse-embeds both `predictions`
// and `score_events` (both have an FK to `matches.id`). The original
// shape started from `predictions` and tried to embed `score_events` —
// but PostgREST cannot resolve a relationship between `predictions` and
// `score_events` (no FK between them; they share only `matches.id` /
// `participants.id`), so the embed failed with PGRST200 and `lastRes`
// always returned `data: null` post-feature-005.
type LastFinishedRow = {
  id: string;
  kickoff_utc: string;
  status: string;
  score_home: number | null;
  score_away: number | null;
  home_team: { name: string } | null;
  away_team: { name: string } | null;
  predictions: Array<{
    predicted_home_score: number;
    predicted_away_score: number;
  }>;
  score_events: Array<{ points: number }>;
};

type UpcomingRow = {
  id: string;
  kickoff_utc: string;
  status: string;
  home_team: { name: string } | null;
  away_team: { name: string } | null;
  predictions: Array<{
    predicted_home_score: number | null;
    predicted_away_score: number | null;
  }>;
};

export default async function SnapshotWidget({
  selfParticipantId,
  // `locale` and `userTz` are part of the props contract for future
  // formatting needs (localised kickoff timestamps, etc.); kept on the
  // signature so the parent composer doesn't churn when those wire up.
  locale: _locale,
  userTz: _userTz,
}: SnapshotWidgetProps): Promise<React.ReactElement> {
  const t = await getTranslations('dashboard');
  const supabase = await createClient();

  const nowIso = new Date().toISOString();

  // Two PostgREST round-trips in parallel. Each query corresponds to one
  // of the snapshot cards; they share no rows so a single composite query
  // would not help. See the contracts referenced above for the exact
  // embed shape and RLS guarantees.
  const [lastRes, nextRes] = await Promise.all([
    supabase
      .from('matches')
      .select(
        `
          id,
          kickoff_utc,
          status,
          score_home,
          score_away,
          home_team:home_team_id ( name ),
          away_team:away_team_id ( name ),
          predictions!inner ( predicted_home_score, predicted_away_score ),
          score_events ( points )
        `,
      )
      .eq('status', 'finished')
      .eq('predictions.participant_id', selfParticipantId)
      .eq('score_events.participant_id', selfParticipantId)
      .order('kickoff_utc', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('matches')
      .select(
        `
          id,
          kickoff_utc,
          status,
          home_team:home_team_id ( name ),
          away_team:away_team_id ( name ),
          predictions ( predicted_home_score, predicted_away_score )
        `,
      )
      .neq('status', 'cancelled')
      .gt('kickoff_utc', nowIso)
      .eq('predictions.participant_id', selfParticipantId)
      .order('kickoff_utc', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  if (lastRes.error !== null) {
    console.error('SnapshotWidget: last-finished query failed', {
      code: lastRes.error.code,
      message: lastRes.error.message,
    });
  }
  if (nextRes.error !== null) {
    console.error('SnapshotWidget: next-upcoming query failed', {
      code: nextRes.error.code,
      message: nextRes.error.message,
    });
  }

  const lastRow = (lastRes.data as unknown as LastFinishedRow | null) ?? null;
  const nextRow = (nextRes.data as unknown as UpcomingRow | null) ?? null;

  const snapshot: SnapshotData = {
    lastFinished:
      lastRow !== null && lastRow.predictions[0] !== undefined
        ? {
            matchId: lastRow.id,
            homeTeamName: lastRow.home_team?.name ?? '',
            awayTeamName: lastRow.away_team?.name ?? '',
            kickoffUtc: lastRow.kickoff_utc,
            predictedHomeScore: lastRow.predictions[0].predicted_home_score,
            predictedAwayScore: lastRow.predictions[0].predicted_away_score,
            actualHomeScore: lastRow.score_home,
            actualAwayScore: lastRow.score_away,
            pointsAwarded: lastRow.score_events[0]?.points ?? 0,
          }
        : null,
    nextUpcoming:
      nextRow !== null
        ? {
            matchId: nextRow.id,
            homeTeamName: nextRow.home_team?.name ?? '',
            awayTeamName: nextRow.away_team?.name ?? '',
            kickoffUtc: nextRow.kickoff_utc,
            predictedHomeScore: nextRow.predictions[0]?.predicted_home_score ?? null,
            predictedAwayScore: nextRow.predictions[0]?.predicted_away_score ?? null,
          }
        : null,
  };

  return (
    <section
      className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2"
      aria-labelledby="snapshot-heading"
    >
      <h2 id="snapshot-heading" className="sr-only">
        {t('snapshotHeading')}
      </h2>

      {/* Left card — last finished prediction */}
      <article className="rounded-md border border-gray-200 bg-white p-3 shadow-sm">
        <h3 className="text-sm font-medium text-gray-600">{t('snapshotLastHeading')}</h3>
        {snapshot.lastFinished === null ? (
          <p className="mt-2 text-sm text-gray-500">{t('snapshotLastEmpty')}</p>
        ) : (
          <div className="mt-2 space-y-1 text-sm text-gray-900">
            <p className="font-medium">
              {snapshot.lastFinished.homeTeamName} v {snapshot.lastFinished.awayTeamName}
            </p>
            <p className="text-gray-700">
              <span className="text-xs text-gray-500">{t('snapshotPredictionLabel')}:</span>{' '}
              <span className="tabular-nums">
                {snapshot.lastFinished.predictedHomeScore ?? '—'}
                {' – '}
                {snapshot.lastFinished.predictedAwayScore ?? '—'}
              </span>
            </p>
            <p className="text-gray-700">
              <span className="text-xs text-gray-500">{t('snapshotActualLabel')}:</span>{' '}
              <span className="tabular-nums">
                {snapshot.lastFinished.actualHomeScore ?? '—'}
                {' – '}
                {snapshot.lastFinished.actualAwayScore ?? '—'}
              </span>
            </p>
            <p className="text-gray-700">
              <span className="text-xs text-gray-500">{t('snapshotPointsLabel')}:</span>{' '}
              <span className="tabular-nums font-semibold">{snapshot.lastFinished.pointsAwarded}</span>
            </p>
          </div>
        )}
      </article>

      {/* Right card — next upcoming match + caller's pick */}
      <article className="rounded-md border border-gray-200 bg-white p-3 shadow-sm">
        <h3 className="text-sm font-medium text-gray-600">{t('snapshotNextHeading')}</h3>
        {snapshot.nextUpcoming === null ? (
          <p className="mt-2 text-sm text-gray-500">{t('snapshotNextEmpty')}</p>
        ) : (
          <div className="mt-2 space-y-1 text-sm text-gray-900">
            <p className="font-medium">
              {snapshot.nextUpcoming.homeTeamName} v {snapshot.nextUpcoming.awayTeamName}
            </p>
            {snapshot.nextUpcoming.predictedHomeScore === null ||
            snapshot.nextUpcoming.predictedAwayScore === null ? (
              <p className="text-sm text-amber-700">{t('snapshotNoPickYet')}</p>
            ) : (
              <p className="text-gray-700">
                <span className="text-xs text-gray-500">{t('snapshotPredictionLabel')}:</span>{' '}
                <span className="tabular-nums">
                  {snapshot.nextUpcoming.predictedHomeScore}
                  {' – '}
                  {snapshot.nextUpcoming.predictedAwayScore}
                </span>
              </p>
            )}
          </div>
        )}
      </article>
    </section>
  );
}
