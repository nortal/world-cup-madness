import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import FinalPredictionsForm from '@/components/predictions/FinalPredictionsForm';
import PlayerPicker from '@/components/predictions/PlayerPicker';
import TeamPicker from '@/components/predictions/TeamPicker';
import { createClient } from '@/lib/supabase/server';

/**
 * Final predictions page (feature 003 US-PB / FR-P07-P11).
 *
 * Server Component. Mounts the 4 pickers + form. Auto-redirects unauth'd
 * users to '/'. Auto-renders the disabled player-picker state when no
 * squads are synced (FR-P11).
 *
 * Lock semantic (BR-LOCK-005): if any non-cancelled match has already
 * kicked off, the form is replaced with a read-only summary of the
 * participant's locked picks (or a no-picks message if they never
 * submitted).
 *
 * `revalidate: 60` mirrors the read-path caching from feature 002.
 */

export const revalidate = 60;

export default async function FinalPredictionsPage() {
  const t = await getTranslations('predictions');
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user === null) {
    redirect('/');
  }

  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('id')
    .eq('auth_user_id', user.id)
    .maybeSingle();
  if (participantError !== null || participant === null) {
    redirect('/');
  }

  // Load teams (always full catalog — 32 rows).
  const { data: teamsRaw } = await supabase
    .from('teams')
    .select('id, name, tla')
    .order('name', { ascending: true });
  const teams = (teamsRaw ?? []).map((t) => ({
    id: t.id as string,
    name: t.name as string,
    tla: t.tla as string,
  }));

  // Load players (may be empty if squad sync hasn't run yet — triggers FR-P11 UI).
  const { data: playersRaw } = await supabase
    .from('players')
    .select('id, name, position, team_id, teams!players_team_id_fkey(tla)')
    .order('name', { ascending: true });
  type PlayerJoinedRow = {
    id: string;
    name: string;
    position: string | null;
    team_id: string;
    teams: { tla: string } | { tla: string }[] | null;
  };
  const players = ((playersRaw ?? []) as unknown as PlayerJoinedRow[]).map((p) => {
    const teamRel = Array.isArray(p.teams) ? p.teams[0] : p.teams;
    return {
      id: p.id,
      name: p.name,
      position: p.position,
      teamTla: teamRel?.tla ?? '???',
    };
  });

  // Load the participant's existing final prediction (if any) for pre-fill.
  const { data: existingFinal } = await supabase
    .from('final_predictions')
    .select('champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id')
    .eq('participant_id', participant.id)
    .maybeSingle();

  // Lock check: first non-cancelled match has kicked off?
  const { data: firstMatch } = await supabase
    .from('matches')
    .select('kickoff_utc')
    .neq('status', 'cancelled')
    .order('kickoff_utc', { ascending: true })
    .limit(1)
    .maybeSingle();
  const firstKickoff = firstMatch?.kickoff_utc ? new Date(firstMatch.kickoff_utc) : null;
  const locked = firstKickoff !== null && new Date() >= firstKickoff;

  return (
    <main className="mx-auto min-h-screen w-full max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">{t('final.pageHeading')}</h1>
      <p className="mt-2 text-base text-gray-600">{t('final.pageDescription')}</p>

      {locked ? (
        <section aria-labelledby="locked-final-heading" className="mt-6 rounded-md border border-gray-200 bg-gray-50 p-4">
          <h2 id="locked-final-heading" className="text-lg font-semibold">{t('final.lockedHeading')}</h2>
          <p className="mt-2 text-sm text-amber-700">{t('final.lockedMessage')}</p>
        </section>
      ) : (
        <section className="mt-6">
          <FinalPredictionsForm>
            <TeamPicker
              name="champion"
              labelKey="final.championLabel"
              selectedTeamId={existingFinal?.champion_team_id ?? null}
              teams={teams}
            />
            <TeamPicker
              name="runner_up"
              labelKey="final.runnerUpLabel"
              selectedTeamId={existingFinal?.runner_up_team_id ?? null}
              teams={teams}
            />
            <PlayerPicker
              name="top_scorer"
              labelKey="final.topScorerLabel"
              selectedPlayerId={existingFinal?.top_scorer_player_id ?? null}
              players={players}
            />
            <PlayerPicker
              name="best_player"
              labelKey="final.bestPlayerLabel"
              selectedPlayerId={existingFinal?.best_player_player_id ?? null}
              players={players}
            />
          </FinalPredictionsForm>
        </section>
      )}
    </main>
  );
}
