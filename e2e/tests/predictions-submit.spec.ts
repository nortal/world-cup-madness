/**
 * Playwright E2E test — TC-P1, TC-P2, TC-P6, TC-P21 (US-PA: match prediction
 * write path) for feature 003 (predictions-and-scoring), task T031.
 *
 * Spec source: `specs/003-predictions-and-scoring/spec.md`:
 *   TC-P1: submit valid match prediction → row + audit_log
 *   TC-P2: edit existing prediction before lock → in-place update + audit row
 *   TC-P6: out-of-range score (21) → server rejection
 *   TC-P21: audit log captures every prediction edit (n edits → n+1 rows)
 *
 * Wires together:
 *   - migration 0028 submit_prediction RPC
 *   - components/predictions/PredictionForm.tsx (Client Component)
 *   - app/(participant)/matches/[id]/page.tsx (Server Component mount point)
 *   - migration 0017_seed_teams.sql for the team UUIDs
 *
 * Per-test cleanup wipes only the synthetic provider_id range this spec owns
 * (provider_id 7401-7405) so re-runs are deterministic without disturbing
 * any bootstrap-sync data or other specs' seeds.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_ID_RANGE = [7401, 7402, 7403, 7404, 7405] as const;

async function seedFutureMatch(
  client: SupabaseClient<Database>,
  providerId: number,
  hoursFromNow: number,
): Promise<string> {
  // Clear any prior match keyed by this provider_id so the test is idempotent.
  await client.from('matches').delete().eq('provider_id', providerId);

  const { data: teams, error: teamsErr } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', ['ENG', 'FRA']);
  if (teamsErr || !teams || teams.length < 2) {
    throw new Error(`seedFutureMatch: could not load ENG + FRA teams (err=${teamsErr?.message})`);
  }
  const eng = teams.find((t) => t.tla === 'ENG')!;
  const fra = teams.find((t) => t.tla === 'FRA')!;

  const kickoff = new Date(Date.now() + hoursFromNow * 60 * 60 * 1000).toISOString();
  const matchId = randomUUID();

  const { error } = await client.from('matches').insert({
    id: matchId,
    provider_id: providerId,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: kickoff,
    status: 'scheduled',
  });
  if (error) {
    throw new Error(`seedFutureMatch: insert failed (${error.message})`);
  }
  return matchId;
}

async function clearPredictionTables(client: SupabaseClient<Database>): Promise<void> {
  await client.from('predictions').delete().in('match_id', []); // no-op safety
  // Wipe all predictions + audit_log rows scoped to the provider range's matches.
  // RLS bypassed by service role; the cascade from matches.delete() in
  // afterAll wipes the predictions too, but explicit clear keeps assertions
  // stable across mid-test state.
  for (const pid of PROVIDER_ID_RANGE) {
    const { data: match } = await client.from('matches').select('id').eq('provider_id', pid).maybeSingle();
    if (match) {
      await client.from('predictions').delete().eq('match_id', match.id);
    }
  }
  await client.from('audit_log').delete().in('action', [
    'prediction.created',
    'prediction.updated',
  ]);
}

/**
 * Provision the participant row via an authenticated browser session.
 * Must be called BEFORE navigating to a page that requires the participant
 * row (otherwise the page redirects to '/'). We navigate to a known
 * authenticated route ('/dashboard'), call provision_participant_from_jwt
 * from the browser context, then return.
 */
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

test.describe('US-PA / TC-P1+P2+P6+P21 — submit + edit match prediction', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    await clearPredictionTables(client);
    // Wipe any leftover matches in our range so each test starts fresh.
    for (const pid of PROVIDER_ID_RANGE) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test.afterAll(async () => {
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_ID_RANGE) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
    await client.from('audit_log').delete().in('action', [
      'prediction.created',
      'prediction.updated',
    ]);
  });

  test('TC-P1 + TC-P21: submit a valid prediction → row inserted + audit row tagged prediction.created', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedFutureMatch(client, 7401, 2);

    const { oid } = await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const resp = await page.goto(`/matches/${matchId}`);
    expect(resp?.status(), 'match-detail page should render 200').toBe(200);

    await page.getByLabel(/home/i).fill('2');
    await page.getByLabel(/away/i).fill('1');
    await page.getByRole('button', { name: /save/i }).click();

    await expect(page.getByText(/prediction saved/i)).toBeVisible();

    // Verify the row + audit via service role.
    const { data: pred } = await client
      .from('predictions')
      .select('predicted_home_score, predicted_away_score, participant_id')
      .eq('match_id', matchId)
      .maybeSingle();
    expect(pred).not.toBeNull();
    expect(pred!.predicted_home_score).toBe(2);
    expect(pred!.predicted_away_score).toBe(1);

    const { data: participant } = await client
      .from('participants')
      .select('id')
      .eq('oid', oid)
      .maybeSingle();
    expect(pred!.participant_id).toBe(participant!.id);

    const { data: auditRows } = await client
      .from('audit_log')
      .select('action, new_value')
      .eq('participant_id', participant!.id)
      .eq('action', 'prediction.created');
    expect(auditRows?.length).toBe(1);
    expect((auditRows![0].new_value as { predicted_home_score: number }).predicted_home_score).toBe(2);
  });

  test('TC-P2: edit existing prediction before lock → in-place update + prediction.updated audit row', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedFutureMatch(client, 7402, 2);

    const { oid } = await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const resp = await page.goto(`/matches/${matchId}`);
    expect(resp?.status(), 'match-detail page should render 200').toBe(200);

    // First save (creates).
    await page.getByLabel(/home/i).fill('2');
    await page.getByLabel(/away/i).fill('1');
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/prediction saved/i)).toBeVisible();

    // Second save (updates).
    await page.getByLabel(/home/i).fill('3');
    await page.getByLabel(/away/i).fill('1');
    await page.getByRole('button', { name: /save/i }).click();
    await expect(page.getByText(/prediction saved/i)).toBeVisible();

    const { data: pred } = await client
      .from('predictions')
      .select('predicted_home_score, predicted_away_score')
      .eq('match_id', matchId)
      .maybeSingle();
    expect(pred!.predicted_home_score).toBe(3);

    const { data: participant } = await client
      .from('participants')
      .select('id')
      .eq('oid', oid)
      .maybeSingle();

    // TC-P21: 1 created + 1 updated audit row = 2 total for this participant×match
    const { data: createdRows } = await client
      .from('audit_log')
      .select('id')
      .eq('participant_id', participant!.id)
      .eq('action', 'prediction.created');
    const { data: updatedRows } = await client
      .from('audit_log')
      .select('id')
      .eq('participant_id', participant!.id)
      .eq('action', 'prediction.updated');
    expect(createdRows?.length).toBe(1);
    expect(updatedRows?.length).toBe(1);
  });

  test('TC-P6: out-of-range score (21) is rejected client-side before the RPC is called', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedFutureMatch(client, 7403, 2);

    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);
    const resp = await page.goto(`/matches/${matchId}`);
    expect(resp?.status(), 'match-detail page should render 200').toBe(200);

    await page.getByLabel(/home/i).fill('21');
    await page.getByLabel(/away/i).fill('0');
    await page.getByRole('button', { name: /save/i }).click();

    // The client-side validation fires before the RPC, so the form error
    // text becomes visible (errorOutOfRange) and no prediction row lands.
    // Scope to the form's #prediction-form-error element (Next.js renders
    // a sibling role=alert for its route announcer that we must not match).
    await expect(page.locator('#prediction-form-error')).toBeVisible();

    const { data: pred } = await client
      .from('predictions')
      .select('id')
      .eq('match_id', matchId);
    expect(pred?.length ?? 0).toBe(0);
  });
});
