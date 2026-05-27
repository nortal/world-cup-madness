/**
 * Playwright E2E test — TC-P20 (US-PA: cross-participant RLS isolation)
 * for feature 003 (predictions-and-scoring), task T033.
 *
 * Spec source: `specs/003-predictions-and-scoring/spec.md` TC-P20:
 *   Given participant A is signed in, when A tries to SELECT participant
 *   B's row from `predictions`, then PostgREST returns zero rows (RLS
 *   filters them out).
 *
 * pgTAP 010_rls_predictions.sql covers this at the SQL layer. This
 * Playwright test additionally exercises it end-to-end via supabase-js
 * + an authenticated browser session — verifying the wire path (anon-key
 * JWT → PostgREST → RLS policy → row filter) actually filters as expected.
 *
 * Wires together:
 *   - migration 0028 submit_prediction RPC (for B's seed)
 *   - migration 0029 predictions_select_own RLS policy
 *   - app/(participant)/dashboard/page.tsx (the authenticated entry point;
 *     /dashboard renders fine for any provisioned participant)
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_ID = 7421;

async function seedMatchAndBPrediction(
  client: SupabaseClient<Database>,
): Promise<{ matchId: string; bParticipantId: string }> {
  await client.from('matches').delete().eq('provider_id', PROVIDER_ID);

  // Seed match
  const { data: teams } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', ['ENG', 'FRA']);
  if (!teams || teams.length < 2) throw new Error('seed: missing teams');
  const eng = teams.find((t) => t.tla === 'ENG')!;
  const fra = teams.find((t) => t.tla === 'FRA')!;
  const matchId = randomUUID();
  const { error: matchErr } = await client.from('matches').insert({
    id: matchId,
    provider_id: PROVIDER_ID,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    status: 'scheduled',
  });
  if (matchErr) throw new Error(`seed match: ${matchErr.message}`);

  // Seed participant B + B's prediction via service-role (bypasses RLS)
  const bAuthUserId = randomUUID();
  await client.auth.admin.createUser({
    id: bAuthUserId,
    email: 'b@nortal.com',
    email_confirm: true,
  });

  const { data: bParticipant, error: bParticipantErr } = await client
    .from('participants')
    .insert({
      auth_user_id: bAuthUserId,
      oid: randomUUID(),
      email: 'b@nortal.com',
      display_name: 'Participant B',
      role: 'participant',
      status: 'active',
    })
    .select('id')
    .single();
  if (bParticipantErr) throw new Error(`seed B participant: ${bParticipantErr.message}`);

  await client.from('predictions').insert({
    participant_id: bParticipant.id,
    match_id: matchId,
    predicted_home_score: 3,
    predicted_away_score: 2,
  });

  return { matchId, bParticipantId: bParticipant.id };
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

test.describe('US-PA / TC-P20 — cross-participant RLS isolation on predictions', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    await client.from('matches').delete().eq('provider_id', PROVIDER_ID);
  });

  test.afterAll(async () => {
    const client = getServiceRoleClient();
    await client.from('matches').delete().eq('provider_id', PROVIDER_ID);
  });

  test('TC-P20: participant A cannot SELECT participant B\'s predictions (RLS filter returns 0 rows)', async ({ page }) => {
    const adminClient = getServiceRoleClient();
    const { matchId, bParticipantId } = await seedMatchAndBPrediction(adminClient);

    // Sanity check via service-role: B's prediction exists.
    const { data: serviceRoleSelect } = await adminClient
      .from('predictions')
      .select('id')
      .eq('participant_id', bParticipantId);
    expect(serviceRoleSelect?.length ?? 0).toBe(1);

    // Sign in as participant A and provision.
    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);

    // From A's authenticated browser session, attempt to SELECT B's row.
    const result = await page.evaluate(
      async ({ supabaseUrl, supabaseAnonKey, bParticipantId, matchId }) => {
        const { createBrowserClient } = await import(
          // @ts-expect-error -- dynamic CDN import
          'https://esm.sh/@supabase/ssr@0.10.3'
        );
        const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
        await client.auth.getSession();
        const { data, error } = await client
          .from('predictions')
          .select('id, predicted_home_score, predicted_away_score, participant_id')
          .eq('participant_id', bParticipantId)
          .eq('match_id', matchId);
        return { data, error: error ? { code: error.code, message: error.message } : null };
      },
      {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
        supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
        bParticipantId,
        matchId,
      },
    );

    expect(result.error, 'PostgREST should not return an error for an RLS-filtered SELECT').toBeNull();
    expect(result.data, 'A must see ZERO rows for B\'s predictions (RLS isolation)').toEqual([]);
  });
});
