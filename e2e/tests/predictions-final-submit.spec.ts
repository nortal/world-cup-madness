/**
 * Playwright E2E test — TC-P7, TC-P8, TC-P9 (US-PB: final predictions write
 * path) for feature 003 (predictions-and-scoring), task T048.
 *
 * Spec source: `specs/003-predictions-and-scoring/spec.md`:
 *   TC-P7: submit all 4 final picks → final_predictions row with all columns
 *   TC-P8: partial submit (champion + runner_up only) → players NULL
 *   TC-P9: lock at first kickoff → page renders locked state, no form
 *
 * Wires together:
 *   - migration 0028 submit_final_prediction RPC
 *   - app/(participant)/predictions/final/page.tsx
 *   - components/predictions/FinalPredictionsForm.tsx + the 4 pickers
 *
 * Player-pick selection: the picker is a hand-rolled combobox whose UX is
 * covered separately by T049 (predictions-final-player-picker). Here we set
 * the hidden form inputs directly via page.evaluate — the test's purpose is
 * the RPC contract (all-4 vs partial), not the combobox interaction.
 *
 * Owned ranges (disjoint from other specs): matches 7431-7440, players
 * 10901-10920.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const MATCH_PROVIDER_IDS = [7431, 7432] as const;
const PLAYER_PROVIDER_IDS = [10901, 10902] as const;

async function seedScheduledMatch(
  client: SupabaseClient<Database>,
  providerId: number,
  minutesFromNow: number,
): Promise<string> {
  await client.from('matches').delete().eq('provider_id', providerId);
  const { data: teams } = await client.from('teams').select('id, tla').in('tla', ['ENG', 'FRA']);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;
  const id = randomUUID();
  await client.from('matches').insert({
    id,
    provider_id: providerId,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: new Date(Date.now() + minutesFromNow * 60 * 1000).toISOString(),
    status: 'scheduled',
  });
  return id;
}

async function seedTwoPlayers(client: SupabaseClient<Database>): Promise<{ topScorerId: string; bestPlayerId: string }> {
  for (const pid of PLAYER_PROVIDER_IDS) {
    await client.from('players').delete().eq('provider_player_id', pid);
  }
  const { data: teams } = await client.from('teams').select('id, tla').in('tla', ['ENG', 'FRA']);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;
  const { data: inserted } = await client
    .from('players')
    .insert([
      { provider_player_id: 10901, name: 'Test Striker ENG', position: 'Attacker', team_id: eng.id },
      { provider_player_id: 10902, name: 'Test Playmaker FRA', position: 'Midfielder', team_id: fra.id },
    ])
    .select('id, provider_player_id');
  const topScorer = inserted!.find((p) => p.provider_player_id === 10901)!;
  const bestPlayer = inserted!.find((p) => p.provider_player_id === 10902)!;
  return { topScorerId: topScorer.id, bestPlayerId: bestPlayer.id };
}

async function teamUuid(client: SupabaseClient<Database>, tla: string): Promise<string> {
  const { data } = await client.from('teams').select('id').eq('tla', tla).single();
  return data!.id;
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
  expect(provision.ok, 'provision_participant_from_jwt RPC must succeed').toBe(true);
}

/** Set a hidden picker input's value directly (bypasses the combobox UX). */
async function setHiddenPickerValue(page: Page, name: string, value: string): Promise<void> {
  await page.evaluate(
    ([n, v]) => {
      const el = document.querySelector(`input[name="${n}"]`) as HTMLInputElement | null;
      if (el) {
        el.value = v;
      }
    },
    [name, value],
  );
}

test.describe('US-PB / TC-P7+P8+P9 — final predictions submit + lock', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    // Wholesale clear matches: `/predictions/final` enforces BR-LOCK-005 by
    // looking at the GLOBALLY first non-cancelled match (`ORDER BY
    // kickoff_utc ASC LIMIT 1`). A leaked, already-kicked-off match from a
    // prior sync spec (or an interrupted suite run) would render the page
    // locked, and TC-P7/P8 would never see `<select name="champion">`.
    await client.from('matches').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    for (const pid of PLAYER_PROVIDER_IDS) await client.from('players').delete().eq('provider_player_id', pid);
  });

  test.afterAll(async () => {
    const client = getServiceRoleClient();
    for (const pid of MATCH_PROVIDER_IDS) await client.from('matches').delete().eq('provider_id', pid);
    for (const pid of PLAYER_PROVIDER_IDS) await client.from('players').delete().eq('provider_player_id', pid);
  });

  test('TC-P7: submit all 4 picks → final_predictions row fully populated', async ({ page }) => {
    const client = getServiceRoleClient();
    await seedScheduledMatch(client, 7431, 120); // future kickoff → editable
    const { topScorerId, bestPlayerId } = await seedTwoPlayers(client);
    const engId = await teamUuid(client, 'ENG');
    const fraId = await teamUuid(client, 'FRA');

    const { oid } = await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const resp = await page.goto('/predictions/final');
    expect(resp?.status()).toBe(200);

    await page.locator('select[name="champion"]').selectOption(engId);
    await page.locator('select[name="runner_up"]').selectOption(fraId);
    await setHiddenPickerValue(page, 'top_scorer', topScorerId);
    await setHiddenPickerValue(page, 'best_player', bestPlayerId);

    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();

    const { data: participant } = await client.from('participants').select('id').eq('oid', oid).maybeSingle();
    const { data: row } = await client
      .from('final_predictions')
      .select('champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id')
      .eq('participant_id', participant!.id)
      .maybeSingle();
    expect(row).not.toBeNull();
    expect(row!.champion_team_id).toBe(engId);
    expect(row!.runner_up_team_id).toBe(fraId);
    expect(row!.top_scorer_player_id).toBe(topScorerId);
    expect(row!.best_player_player_id).toBe(bestPlayerId);
  });

  test('TC-P8: partial submit (champion + runner_up only) → player columns NULL', async ({ page }) => {
    const client = getServiceRoleClient();
    await seedScheduledMatch(client, 7432, 120);
    await seedTwoPlayers(client); // players exist so pickers are enabled, but we leave them blank
    const engId = await teamUuid(client, 'ENG');
    const fraId = await teamUuid(client, 'FRA');

    const { oid } = await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    await page.goto('/predictions/final');

    await page.locator('select[name="champion"]').selectOption(engId);
    await page.locator('select[name="runner_up"]').selectOption(fraId);
    // Leave player pickers blank.

    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/saved/i)).toBeVisible();

    const { data: participant } = await client.from('participants').select('id').eq('oid', oid).maybeSingle();
    const { data: row } = await client
      .from('final_predictions')
      .select('champion_team_id, runner_up_team_id, top_scorer_player_id, best_player_player_id')
      .eq('participant_id', participant!.id)
      .maybeSingle();
    expect(row!.champion_team_id).toBe(engId);
    expect(row!.runner_up_team_id).toBe(fraId);
    expect(row!.top_scorer_player_id).toBeNull();
    expect(row!.best_player_player_id).toBeNull();
  });

  test('TC-P9: page renders locked state when first match has kicked off', async ({ page }) => {
    const client = getServiceRoleClient();
    // First non-cancelled match kicked off 1h ago → final predictions locked.
    await seedScheduledMatch(client, 7431, -60);

    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const resp = await page.goto('/predictions/final');
    expect(resp?.status()).toBe(200);

    // Locked message visible; Save button absent.
    await expect(page.getByText(/first tournament match|no longer be edited|locked/i).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /save/i })).toHaveCount(0);
  });
});
