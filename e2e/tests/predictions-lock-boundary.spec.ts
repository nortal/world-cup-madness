/**
 * Playwright E2E test — TC-P3, TC-P4, TC-P5 (US-PA: the MANDATORY lock-
 * boundary triplet) for feature 003 (predictions-and-scoring), task T032.
 *
 * Spec source: `specs/003-predictions-and-scoring/spec.md` §3 + NFR-P4:
 *   TC-P3: At kickoff − 60 min sharp → PREDICTION_LOCKED (boundary inclusive)
 *   TC-P4: At kickoff − 61 min → EDITABLE
 *   TC-P5: At kickoff − 59 min → PREDICTION_LOCKED
 *
 * This is the NFR-P4 mandatory triplet. The SQL-side comparator in the
 * submit_prediction RPC (`(kickoff_utc - now()) <= interval '60 minutes'`)
 * is the authoritative source of truth; this test exercises the same rule
 * end-to-end through the RPC by hitting it directly with a service-role
 * client (bypassing the form / page). RPC-direct is intentional: the
 * boundary semantic is the comparator, not the UI; testing via the form
 * adds clock-skew + animation latency that obscures the assertion.
 *
 * Wires together:
 *   - migration 0028 submit_prediction RPC
 *   - migration 0020 predictions table (RLS scoped to participant via auth.uid())
 *   - migration 0017_seed_teams.sql for team UUIDs
 *
 * The test calls submit_prediction via the BROWSER supabase client (the
 * Client Component path), not service-role, because the RPC's lock check
 * runs against `now()` in the same DB session as the authenticated user's
 * write. Using a separate Node-side service-role client would race the
 * clock between the kickoff seed and the RPC call. Browser-direct keeps
 * everything in one session.
 */

import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { signInAs } from '../fixtures/auth';
import { getServiceRoleClient, resetSupabaseState } from '../fixtures/db';

const PROVIDER_ID_RANGE = [7411, 7412, 7413] as const;

type BoundarySpec = {
  providerId: number;
  minutesFromNow: number;
};

async function seedBoundaryMatch(
  client: SupabaseClient<Database>,
  spec: BoundarySpec,
): Promise<string> {
  await client.from('matches').delete().eq('provider_id', spec.providerId);

  const { data: teams } = await client
    .from('teams')
    .select('id, tla')
    .in('tla', ['ENG', 'FRA']);
  if (!teams || teams.length < 2) throw new Error('seedBoundaryMatch: missing ENG/FRA seed');
  const eng = teams.find((t) => t.tla === 'ENG')!;
  const fra = teams.find((t) => t.tla === 'FRA')!;

  const kickoff = new Date(Date.now() + spec.minutesFromNow * 60 * 1000).toISOString();
  const matchId = randomUUID();
  const { error } = await client.from('matches').insert({
    id: matchId,
    provider_id: spec.providerId,
    home_team_id: eng.id,
    away_team_id: fra.id,
    stage: 'group',
    group_label: 'A',
    kickoff_utc: kickoff,
    status: 'scheduled',
  });
  if (error) throw new Error(`seedBoundaryMatch: ${error.message}`);
  return matchId;
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

/**
 * Invoke submit_prediction from the browser session and return the
 * Supabase response shape. Avoids clock skew vs service-role-from-Node
 * because the RPC's now() and the kickoff seed are read in the same
 * session.
 */
async function submitFromBrowser(
  page: Page,
  matchId: string,
  home: number,
  away: number,
): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> {
  return page.evaluate(
    async ({ supabaseUrl, supabaseAnonKey, matchId, home, away }) => {
      const { createBrowserClient } = await import(
        // @ts-expect-error -- dynamic CDN import
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(supabaseUrl, supabaseAnonKey);
      await client.auth.getSession();
      const { data, error } = await client.rpc('submit_prediction', {
        p_match_id: matchId,
        p_home: home,
        p_away: away,
      });
      return { data, error: error ? { code: error.code, message: error.message } : null };
    },
    {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      matchId,
      home,
      away,
    },
  );
}

test.describe('US-PA / TC-P3+P4+P5 — NFR-P4 mandatory lock-boundary triplet', () => {
  test.beforeEach(async () => {
    await resetSupabaseState();
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_ID_RANGE) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test.afterAll(async () => {
    const client = getServiceRoleClient();
    for (const pid of PROVIDER_ID_RANGE) {
      await client.from('matches').delete().eq('provider_id', pid);
    }
  });

  test('TC-P4 (T-61 min): submit_prediction succeeds — strict-greater-than means 61 > 60 is EDITABLE', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedBoundaryMatch(client, { providerId: 7412, minutesFromNow: 61 });

    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);

    const result = await submitFromBrowser(page, matchId, 2, 1);
    expect(result.error, 'no error at T-61min').toBeNull();
    expect(result.data, 'success response envelope').not.toBeNull();
  });

  test('TC-P3 (T-60 min EXACT): submit_prediction is rejected — boundary inclusive per BR-LOCK-003', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedBoundaryMatch(client, { providerId: 7411, minutesFromNow: 60 });

    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);

    const result = await submitFromBrowser(page, matchId, 1, 0);
    expect(result.error, 'PREDICTION_LOCKED error must be raised at T-60min').not.toBeNull();
    expect(result.error!.code).toBe('23514');
    expect(result.error!.message).toContain('PREDICTION_LOCKED');
  });

  test('TC-P5 (T-59 min): submit_prediction is rejected — inside the lock window', async ({ page }) => {
    const client = getServiceRoleClient();
    const matchId = await seedBoundaryMatch(client, { providerId: 7413, minutesFromNow: 59 });

    await signInAs(page, { tenant: 'eligible' });
    await provisionFromAuthenticatedPage(page);

    const result = await submitFromBrowser(page, matchId, 1, 0);
    expect(result.error, 'PREDICTION_LOCKED error at T-59min').not.toBeNull();
    expect(result.error!.code).toBe('23514');
    expect(result.error!.message).toContain('PREDICTION_LOCKED');
  });
});
