/**
 * Playwright E2E — TC-P17 (US-PC: scoring idempotency) for feature 003, T058.
 *
 * Finishing a match twice with the same score must leave exactly one
 * score_events row per participant with identical points (DELETE-then-INSERT,
 * FR-P16). Driven via service-role UPDATE on `matches` (no match_results table).
 *
 * Owned range: matches provider_id 7461.
 */

import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_ID = 7461;

async function seed(client: SupabaseClient<Database>): Promise<{ matchId: string; participantId: string }> {
  await client.from('matches').delete().eq('provider_id', PROVIDER_ID);
  const { data: teams } = await client.from('teams').select('id, tla').in('tla', ['ENG', 'FRA']);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;
  const matchId = randomUUID();
  await client.from('matches').insert({
    id: matchId, provider_id: PROVIDER_ID, home_team_id: eng.id, away_team_id: fra.id,
    stage: 'group', group_label: 'A',
    kickoff_utc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), status: 'scheduled',
  });
  const uid = randomUUID();
  const email = `idem-${uid.slice(0, 8)}@nortal.com`;
  await client.auth.admin.createUser({ id: uid, email, email_confirm: true });
  const { data } = await client.from('participants')
    .insert({ auth_user_id: uid, oid: randomUUID(), email, display_name: 'Idem', role: 'participant', status: 'active' })
    .select('id').single();
  await client.from('predictions').insert({ participant_id: data!.id, match_id: matchId, predicted_home_score: 2, predicted_away_score: 1 });
  return { matchId, participantId: data!.id };
}

test.describe('US-PC / TC-P17 — scoring idempotency', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    await getServiceRoleClient().from('matches').delete().eq('provider_id', PROVIDER_ID);
  });
  test.afterAll(async () => {
    await getServiceRoleClient().from('matches').delete().eq('provider_id', PROVIDER_ID);
  });

  test('TC-P17: re-finishing a match with the same score is idempotent (1 row, same points)', async () => {
    const client = getServiceRoleClient();
    const { matchId, participantId } = await seed(client);

    // First finish.
    await client.from('matches').update({ status: 'finished', score_home: 2, score_away: 1 }).eq('id', matchId);
    const first = await client.from('score_events').select('points').eq('match_id', matchId).eq('participant_id', participantId).single();
    expect(first.data!.points).toBe(10);

    // Second finish, same score.
    await client.from('matches').update({ status: 'finished', score_home: 2, score_away: 1 }).eq('id', matchId);

    const { count } = await client.from('score_events').select('*', { count: 'exact', head: true }).eq('match_id', matchId).eq('participant_id', participantId);
    expect(count, 'exactly one score row after re-finish').toBe(1);
    const second = await client.from('score_events').select('points').eq('match_id', matchId).eq('participant_id', participantId).single();
    expect(second.data!.points, 'points unchanged').toBe(10);
  });
});
