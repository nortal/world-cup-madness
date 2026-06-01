/**
 * Playwright E2E — TC-P18, TC-P22 (US-PC: admin correction + score_events
 * write lockdown) for feature 003, T059.
 *
 *   TC-P18: admin corrects a finished match's score → trigger re-fires and
 *           the affected score_events rows update in place + audit logged.
 *   TC-P22: NO role (not even admin) can directly INSERT into score_events —
 *           the RLS lockdown (FR-P24) means only the SECURITY DEFINER trigger
 *           functions write. Verified via an authenticated admin browser
 *           session attempting a direct insert.
 *
 * Owned range: matches provider_id 7471.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_ID = 7471;

async function seedMatchAndPrediction(
  client: SupabaseClient<Database>,
): Promise<{ matchId: string; participantId: string }> {
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
  const email = `corr-${uid.slice(0, 8)}@nortal.com`;
  await client.auth.admin.createUser({ id: uid, email, email_confirm: true });
  const { data } = await client.from('participants')
    .insert({ auth_user_id: uid, oid: randomUUID(), email, display_name: 'Corr', role: 'participant', status: 'active' })
    .select('id').single();
  // Predict 2-1.
  await client.from('predictions').insert({ participant_id: data!.id, match_id: matchId, predicted_home_score: 2, predicted_away_score: 1 });
  return { matchId, participantId: data!.id };
}

async function provisionFromAuthenticatedPage(page: Page): Promise<void> {
  await page.goto('/dashboard');
  const provision = await page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic CDN import
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      await client.auth.getSession();
      const { error } = await client.rpc('provision_participant_from_jwt');
      return error ? { ok: false as const, error: error.message } : { ok: true as const };
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );
  expect(provision.ok, 'provision RPC must succeed').toBe(true);
}

test.describe('US-PC / TC-P18 + TC-P22 — admin correction + score_events lockdown', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    await getServiceRoleClient().from('matches').delete().eq('provider_id', PROVIDER_ID);
  });
  test.afterAll(async () => {
    await getServiceRoleClient().from('matches').delete().eq('provider_id', PROVIDER_ID);
  });

  test('TC-P18: admin score correction re-fires the trigger and updates points in place', async () => {
    const client = getServiceRoleClient();
    const { matchId, participantId } = await seedMatchAndPrediction(client);

    // Finish 2-1 → predictor (2-1) is exact = 10.
    await client.from('matches').update({ status: 'finished', score_home: 2, score_away: 1 }).eq('id', matchId);
    let row = await client.from('score_events').select('source, points').eq('match_id', matchId).eq('participant_id', participantId).single();
    expect(`${row.data!.source}:${row.data!.points}`).toBe('match-exact:10');

    // Admin correction: official was really 3-0. Predictor (2-1) is now correct-outcome only = 5.
    await client.from('matches').update({ score_home: 3, score_away: 0 }).eq('id', matchId);
    row = await client.from('score_events').select('source, points').eq('match_id', matchId).eq('participant_id', participantId).single();
    expect(`${row.data!.source}:${row.data!.points}`, 'trigger re-fired on correction → outcome:5').toBe('match-outcome:5');

    // Still exactly one row (DELETE-then-INSERT, no duplicate).
    const { count } = await client.from('score_events').select('*', { count: 'exact', head: true }).eq('match_id', matchId).eq('participant_id', participantId);
    expect(count).toBe(1);

    // Audit log captured the scoring runs (at least 2 scoring.match rows for this match).
    const { count: auditCount } = await client.from('audit_log').select('*', { count: 'exact', head: true }).eq('action', 'scoring.match').eq('entity_id', matchId);
    expect(auditCount ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('TC-P22: an authenticated admin cannot directly INSERT into score_events (RLS lockdown, FR-P24)', async ({ page }) => {
    const client = getServiceRoleClient();
    const { matchId, participantId } = await seedMatchAndPrediction(client);

    // Sign in as an ADMIN participant.
    await signInAs(page, { tenant: 'eligible', role: 'admin' });
    await provisionFromAuthenticatedPage(page);

    // From the admin browser session, attempt a direct INSERT into score_events.
    const result = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey, matchId, participantId }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic CDN import
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const c = createBrowserClient(supabaseUrl, supabaseAnonKey);
        await c.auth.getSession();
        const { error } = await c.from('score_events').insert({
          participant_id: participantId,
          match_id: matchId,
          source: 'match-exact',
          points: 10,
        });
        return { error: error ? { code: error.code, message: error.message } : null };
      },
      {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
        matchId,
        participantId,
      },
    );

    // RLS denies — no INSERT policy on score_events for any authenticated role.
    expect(result.error, 'admin direct-INSERT into score_events must be rejected').not.toBeNull();
    // PostgREST surfaces the RLS denial as 42501.
    expect(result.error!.code).toBe('42501');
  });
});
