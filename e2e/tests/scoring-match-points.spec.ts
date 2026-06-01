/**
 * Playwright E2E — TC-P12, P13, P14, P15, P16 (US-PC: match scoring engine)
 * for feature 003, task T057.
 *
 * Exercises the match-scoring trigger end-to-end through the wire: seed a
 * match + predictions via the service-role client, then `UPDATE matches SET
 * status='finished', score_home, score_away` (the admin/provider write path
 * — there is NO match_results table; feature 002 put scores on `matches`).
 * The AFTER UPDATE trigger (migration 0030) fires calculate_match_points and
 * writes score_events, which we assert.
 *
 *   TC-P12: exact score → match-exact, 10
 *   TC-P13: correct outcome → match-outcome, 5
 *   TC-P14: wrong outcome → match-wrong, 0
 *   TC-P15: no prediction → no-prediction, 0
 *   TC-P16: cancelled match → match-cancelled, 0 for everyone
 *
 * No page navigation needed — this is a DB-trigger test driven via supabase-js
 * service role. Owned range: matches provider_id 7451-7455.
 */

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_ID = 7451;

type Seeded = { matchId: string; pExact: string; pOutcome: string; pWrong: string; pNone: string };

async function seedMatchAndParticipants(client: SupabaseClient<Database>): Promise<Seeded> {
  await client.from('matches').delete().eq('provider_id', PROVIDER_ID);

  const { data: teams } = await client.from('teams').select('id, tla').in('tla', ['ENG', 'FRA']);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;

  const matchId = randomUUID();
  await client.from('matches').insert({
    id: matchId,
    provider_id: PROVIDER_ID,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    status: 'scheduled',
  });

  // Four participants with distinct prediction outcomes.
  async function mkParticipant(label: string): Promise<string> {
    const uid = randomUUID();
    // Unique email per invocation — resetSupabaseState does NOT clear
    // auth.users, so a fixed email would collide across tests in this file.
    const email = `${label}-${uid.slice(0, 8)}@nortal.com`;
    await client.auth.admin.createUser({ id: uid, email, email_confirm: true });
    const { data } = await client
      .from('participants')
      .insert({ auth_user_id: uid, oid: randomUUID(), email, display_name: label, role: 'participant', status: 'active' })
      .select('id')
      .single();
    return data!.id;
  }

  const pExact = await mkParticipant('exact');
  const pOutcome = await mkParticipant('outcome');
  const pWrong = await mkParticipant('wrong');
  const pNone = await mkParticipant('none');

  // Official will be 2-1. exact: 2-1; outcome: 3-0 (home win); wrong: 0-2 (away win); none: no row.
  await client.from('predictions').insert([
    { participant_id: pExact, match_id: matchId, predicted_home_score: 2, predicted_away_score: 1 },
    { participant_id: pOutcome, match_id: matchId, predicted_home_score: 3, predicted_away_score: 0 },
    { participant_id: pWrong, match_id: matchId, predicted_home_score: 0, predicted_away_score: 2 },
  ]);

  return { matchId, pExact, pOutcome, pWrong, pNone };
}

async function sourcePoints(
  client: SupabaseClient<Database>,
  matchId: string,
  participantId: string,
): Promise<string> {
  const { data } = await client
    .from('score_events')
    .select('source, points')
    .eq('match_id', matchId)
    .eq('participant_id', participantId)
    .maybeSingle();
  return data ? `${data.source}:${data.points}` : 'MISSING';
}

test.describe('US-PC / TC-P12-P16 — match scoring engine', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    await client.from('matches').delete().eq('provider_id', PROVIDER_ID);
  });

  test.afterAll(async () => {
    const client = getServiceRoleClient();
    await client.from('matches').delete().eq('provider_id', PROVIDER_ID);
  });

  test('TC-P12-P15: finishing a match scores exact=10, outcome=5, wrong=0, no-prediction=0', async () => {
    const client = getServiceRoleClient();
    const s = await seedMatchAndParticipants(client);

    // Fire the trigger: finish 2-1.
    const { error } = await client.from('matches').update({ status: 'finished', score_home: 2, score_away: 1 }).eq('id', s.matchId);
    expect(error).toBeNull();

    expect(await sourcePoints(client, s.matchId, s.pExact)).toBe('match-exact:10');
    expect(await sourcePoints(client, s.matchId, s.pOutcome)).toBe('match-outcome:5');
    expect(await sourcePoints(client, s.matchId, s.pWrong)).toBe('match-wrong:0');
    expect(await sourcePoints(client, s.matchId, s.pNone)).toBe('no-prediction:0');

    // Exactly 4 rows (one per active participant).
    const { count } = await client
      .from('score_events')
      .select('*', { count: 'exact', head: true })
      .eq('match_id', s.matchId);
    expect(count).toBe(4);
  });

  test('TC-P16: cancelling a match awards match-cancelled 0 to every participant', async () => {
    const client = getServiceRoleClient();
    const s = await seedMatchAndParticipants(client);

    const { error } = await client.from('matches').update({ status: 'cancelled' }).eq('id', s.matchId);
    expect(error).toBeNull();

    expect(await sourcePoints(client, s.matchId, s.pExact)).toBe('match-cancelled:0');
    expect(await sourcePoints(client, s.matchId, s.pNone)).toBe('match-cancelled:0');

    const { count } = await client
      .from('score_events')
      .select('*', { count: 'exact', head: true })
      .eq('match_id', s.matchId)
      .eq('source', 'match-cancelled');
    expect(count).toBe(4);
  });
});
