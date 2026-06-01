/**
 * Playwright E2E — TC-P19 (US-PC: final-prediction scoring via the admin
 * set_tournament_winner RPC) for feature 003, T060.
 *
 *   TC-P19: admin sets tournament_config.champion_team_id via the
 *           set_tournament_winner RPC; the full-sweep trigger fires and a
 *           participant who picked that champion gets final-champion, 20.
 *           A participant who picked a different champion gets 0.
 *
 * Owned range: matches provider_id 7481 (one scheduled match so the final-
 * predictions window is open while we seed picks; the winner is set via RPC).
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_ID = 7481;

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

async function mkParticipantWithChampionPick(
  client: SupabaseClient<Database>,
  championTla: string,
): Promise<string> {
  const uid = randomUUID();
  const email = `fin-${uid.slice(0, 8)}@nortal.com`;
  await client.auth.admin.createUser({ id: uid, email, email_confirm: true });
  const { data: p } = await client.from('participants')
    .insert({ auth_user_id: uid, oid: randomUUID(), email, display_name: 'Fin', role: 'participant', status: 'active' })
    .select('id').single();
  const { data: team } = await client.from('teams').select('id').eq('tla', championTla).single();
  await client.from('final_predictions').insert({ participant_id: p!.id, champion_team_id: team!.id });
  return p!.id;
}

test.describe('US-PC / TC-P19 — final-prediction scoring via set_tournament_winner', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    await client.from('matches').delete().eq('provider_id', PROVIDER_ID);
    // Reset winners so a prior run's champion doesn't pre-score.
    await client.from('tournament_config').update({
      champion_team_id: null, runner_up_team_id: null,
      top_scorer_player_id: null, best_player_player_id: null,
    }).eq('id', 1);
  });
  test.afterAll(async () => {
    const client = getServiceRoleClient();
    await client.from('matches').delete().eq('provider_id', PROVIDER_ID);
    await client.from('tournament_config').update({ champion_team_id: null }).eq('id', 1);
  });

  test('TC-P19: admin sets champion → matching participant gets final-champion 20, non-matching gets 0', async ({ page }) => {
    const client = getServiceRoleClient();

    // Two participants: one picks ENG (will be correct), one picks FRA (wrong).
    const pCorrect = await mkParticipantWithChampionPick(client, 'ENG');
    const pWrong = await mkParticipantWithChampionPick(client, 'FRA');

    // Admin signs in + provisions, then calls set_tournament_winner('champion', ENG).
    await signInAs(page, { tenant: 'eligible', role: 'admin' });
    await provisionFromAuthenticatedPage(page);

    const engId = (await client.from('teams').select('id').eq('tla', 'ENG').single()).data!.id;
    const rpcResult = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey, engId }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic CDN import
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const c = createBrowserClient(supabaseUrl, supabaseAnonKey);
        await c.auth.getSession();
        const { data, error } = await c.rpc('set_tournament_winner', { p_item: 'champion', p_id: engId });
        return { data, error: error ? { code: error.code, message: error.message } : null };
      },
      {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
        engId,
      },
    );
    expect(rpcResult.error, 'set_tournament_winner should succeed for an admin').toBeNull();

    // The matching participant gets final-champion 20.
    const correctRow = await client.from('score_events').select('source, points')
      .eq('participant_id', pCorrect).eq('source', 'final-champion').single();
    expect(`${correctRow.data!.source}:${correctRow.data!.points}`).toBe('final-champion:20');

    // The non-matching participant gets final-champion 0.
    const wrongRow = await client.from('score_events').select('source, points')
      .eq('participant_id', pWrong).eq('source', 'final-champion').single();
    expect(`${wrongRow.data!.source}:${wrongRow.data!.points}`).toBe('final-champion:0');
  });
});
