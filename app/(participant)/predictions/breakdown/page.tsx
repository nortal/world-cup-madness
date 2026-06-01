import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';

import BreakdownTable, { type BreakdownRow } from '@/components/predictions/BreakdownTable';
import { defaultLocale, isLocale } from '@/lib/i18n/locales';
import { sumPoints, type ScoreEventSource, type BreakdownLocale } from '@/lib/predictions/scoring-display';
import { createClient } from '@/lib/supabase/server';

/**
 * Personal score breakdown page (feature 003 US-PD / FR-P27).
 *
 * Server Component. Reads the participant's own score_events (RLS-filtered to
 * their rows), joins to matches for a "ENG vs FRA" label, and renders the
 * BreakdownTable with a total. No client-side scoring computation.
 *
 * revalidate: 60 mirrors the feature-002 read-path caching.
 */

export const revalidate = 60;

type ScoreEventJoinRow = {
  id: string;
  source: string;
  points: number;
  match_id: string | null;
  matches: { home_team: { tla: string } | { tla: string }[] | null; away_team: { tla: string } | { tla: string }[] | null } | null;
};

function tla(rel: { tla: string } | { tla: string }[] | null | undefined): string {
  const r = Array.isArray(rel) ? rel[0] : rel;
  return r?.tla ?? '???';
}

export default async function BreakdownPage() {
  const t = await getTranslations('predictions');
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (user === null) redirect('/');

  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (participantError !== null || participant === null) redirect('/');

  const rawLocale = await getLocale();
  const locale: BreakdownLocale = (isLocale(rawLocale) ? rawLocale : defaultLocale) as BreakdownLocale;

  // RLS scopes this to the participant's own rows. Join matches for the label.
  const { data: eventsRaw } = await supabase
    .from('score_events')
    .select(
      'id, source, points, match_id, ' +
        'matches:matches!score_events_match_id_fkey(' +
        'home_team:teams!matches_home_team_id_fkey(tla), ' +
        'away_team:teams!matches_away_team_id_fkey(tla))',
    )
    .eq('participant_id', participant.id)
    .order('awarded_at', { ascending: false });

  const events = (eventsRaw ?? []) as unknown as ScoreEventJoinRow[];

  const rows: BreakdownRow[] = events.map((e) => ({
    id: e.id,
    source: e.source as ScoreEventSource,
    points: e.points,
    matchLabel: e.match_id && e.matches
      ? `${tla(e.matches.home_team)} ${t('vsSeparator')} ${tla(e.matches.away_team)}`
      : null,
  }));

  const total = sumPoints(rows);

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{t('breakdown.pageHeading')}</h1>
      <p className="mt-2 text-base text-gray-600">{t('breakdown.pageDescription')}</p>
      <BreakdownTable rows={rows} totalPoints={total} locale={locale} />
    </main>
  );
}
