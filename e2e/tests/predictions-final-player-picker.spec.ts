/**
 * Playwright E2E test — TC-P10, TC-P11 (US-PB: player-picker disabled-vs-
 * enabled state) for feature 003 (predictions-and-scoring), task T049.
 *
 * Spec source: `specs/003-predictions-and-scoring/spec.md`:
 *   TC-P10: players table empty → top-scorer + best-player pickers render
 *           disabled with the "rosters pending" notice; team pickers stay
 *           enabled; Save still works (partial team-pick submit allowed).
 *   TC-P11: after at least one player is synced → pickers auto-enable as
 *           interactive comboboxes; the notice disappears.
 *
 * The Server-Component decision lives in components/predictions/PlayerPicker.tsx:
 *   players.length === 0 → <PlayerPickerDisabled/>, else <PlayerPickerCombobox/>.
 *
 * Owned range: provider_player_id 10921-10930 (disjoint from the squad
 * fixture's 10001-10160). We wholesale-clear `players` in beforeEach so the
 * disabled-state assertion is deterministic regardless of whether a prior
 * bootstrap sync populated the squad fixture; afterAll re-clears our range.
 * (Wholesale clear is safe: players has no inbound FKs except final_predictions
 * which uses ON DELETE SET NULL.)
 */

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const MATCH_PROVIDER_ID = 7441;

async function seedScheduledMatch(client: SupabaseClient<Database>): Promise<void> {
  await client.from('matches').delete().eq('provider_id', MATCH_PROVIDER_ID);
  const { data: teams } = await client.from('teams').select('id, tla').in('tla', ['ENG', 'FRA']);
  const eng = teams!.find((t) => t.tla === 'ENG')!;
  const fra = teams!.find((t) => t.tla === 'FRA')!;
  await client.from('matches').insert({
    id: crypto.randomUUID(),
    provider_id: MATCH_PROVIDER_ID,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: new Date(Date.now() + 120 * 60 * 1000).toISOString(),
    status: 'scheduled',
  });
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

test.describe('US-PB / TC-P10+P11 — player picker disabled-vs-enabled state', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    // Wholesale clear matches: `/predictions/final` enforces BR-LOCK-005 by
    // reading the GLOBALLY first non-cancelled match. A leaked,
    // already-kicked-off match from a prior sync spec would lock the page
    // and TC-P10/P11 would never see the player-picker UI.
    await client.from('matches').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    // Wholesale clear players so the empty-state is deterministic.
    await client.from('players').delete().neq('provider_player_id', -1);
    await seedScheduledMatch(client);
  });

  test.afterAll(async () => {
    const client = getServiceRoleClient();
    await client.from('matches').delete().eq('provider_id', MATCH_PROVIDER_ID);
    // Leave players empty; the next feature-002 sync spec re-bootstraps it,
    // and other feature-003 specs seed their own.
  });

  test('TC-P10: player pickers disabled (rosters pending) when players is empty; team pickers + Save stay enabled', async ({ page }) => {
    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const resp = await page.goto('/predictions/final');
    expect(resp?.status()).toBe(200);

    // Player pickers disabled.
    await expect(page.locator('input[name="top_scorer"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('input[name="best_player"]')).toHaveAttribute('aria-disabled', 'true');

    // The "rosters pending" notice is visible (substring-resilient).
    await expect(page.getByText(/rosters? not yet announced|publishes? squad/i).first()).toBeVisible();

    // Team pickers remain enabled.
    await expect(page.locator('select[name="champion"]')).toBeEnabled();
    await expect(page.locator('select[name="runner_up"]')).toBeEnabled();

    // Save button still present (partial team-pick submit allowed).
    await expect(page.getByRole('button', { name: /save/i })).toBeEnabled();
  });

  test('TC-P11: pickers auto-enable as interactive comboboxes once a player exists', async ({ page }) => {
    const client = getServiceRoleClient();
    const { data: teams } = await client.from('teams').select('id, tla').in('tla', ['ENG']);
    const eng = teams![0];

    // Seed 2 players (our owned range).
    await client.from('players').insert([
      { provider_player_id: 10921, name: 'Roster Striker', position: 'Attacker', team_id: eng.id },
      { provider_player_id: 10922, name: 'Roster Keeper', position: 'Goalkeeper', team_id: eng.id },
    ]);

    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const resp = await page.goto('/predictions/final');
    expect(resp?.status()).toBe(200);

    // Pickers are now interactive comboboxes — the disabled placeholder is gone.
    await expect(page.getByText(/rosters? not yet announced/i)).toHaveCount(0);
    // The disabled input (data-testid player-picker-disabled-*) is no longer rendered.
    await expect(page.getByTestId('player-picker-disabled-top_scorer')).toHaveCount(0);

    // Typing into the visible combobox surfaces the listbox + option.
    const visibleCombo = page.getByTestId('player-combobox-top_scorer');
    await expect(visibleCombo).toBeVisible();
    await visibleCombo.click();
    await visibleCombo.fill('Roster');
    await expect(page.getByRole('listbox').first()).toBeVisible();
    await expect(page.getByRole('option', { name: /Roster Striker/i })).toBeVisible();
  });
});
