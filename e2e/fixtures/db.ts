/**
 * Server-side Playwright test fixtures for direct Postgres access.
 *
 * SECURITY: This module uses the Supabase `service_role` key and MUST only be
 * imported from Playwright test code (Node) — never from any file that ends up
 * in a browser bundle. See `.ai_project_memory/constitution-backend.md` §VI.1.
 *
 * Assumes the local Supabase stack is running (`npx supabase start`). Functions
 * throw with actionable errors when env vars are missing rather than starting
 * the stack themselves.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database, Tables } from '../../lib/supabase/database.types';

// Sentinel UUID used by `resetSupabaseState` to convert a row-less DELETE into a
// "match everything" filter. PostgREST refuses unbounded DELETE; `.neq('id', X)`
// where X is a value that never appears is the documented escape hatch and is
// preferred here over adding a TRUNCATE SECURITY DEFINER migration just for tests.
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

let cachedClient: SupabaseClient<Database> | null = null;

/**
 * Returns a cached service-role Supabase client. The service role bypasses RLS,
 * so this client can TRUNCATE/UPDATE tables that have no `authenticated`-role
 * mutation policies (e.g. `participants`, `audit_log`, `tournament_config`).
 */
export function getServiceRoleClient(): SupabaseClient<Database> {
  if (cachedClient) return cachedClient;

  const supabaseUrl =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase service-role env vars. Set NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) ' +
        'and SUPABASE_SERVICE_ROLE_KEY in .env.local. ' +
        'For local development run `npx supabase start` and copy the printed keys ' +
        '(see .env.example).',
    );
  }

  cachedClient = createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

/**
 * Truncates per-test state and resets the singleton `tournament_config` admin
 * allow-list. Call from a Playwright `test.beforeEach()` — NOT `globalSetup`,
 * because global setup runs once per worker pool and tests need per-test
 * isolation.
 *
 * Order matters:
 *   1. `audit_log` — its `participant_id` FK is `ON DELETE SET NULL`, but
 *      deleting it first keeps the test trace clean and avoids stale audit rows
 *      pointing at orphaned IDs.
 *   2. `participants` — deleted second.
 *   3. `tournament_config` — preserved (migration 0009 owns the singleton);
 *      only `admin_oids` is reset to `'{}'` so admin state never leaks between
 *      tests.
 *
 * The `auth.users` table is owned by Supabase Auth; tests that create users via
 * `signInWithIdToken` should let Supabase manage that lifecycle.
 */
export async function resetSupabaseState(): Promise<void> {
  const client = getServiceRoleClient();

  const auditDelete = await client
    .from('audit_log')
    // audit_log.id is BIGSERIAL; PostgREST DELETE requires a WHERE clause, and
    // .neq on a column that can never equal -1 deletes every row.
    .delete()
    .neq('id', -1);
  if (auditDelete.error) {
    throw new Error(`Failed to reset audit_log: ${auditDelete.error.message}`);
  }

  const participantDelete = await client
    .from('participants')
    .delete()
    .neq('id', ZERO_UUID);
  if (participantDelete.error) {
    throw new Error(
      `Failed to reset participants: ${participantDelete.error.message}`,
    );
  }

  const configReset = await client
    .from('tournament_config')
    .update({ admin_oids: [] })
    .eq('id', 1);
  if (configReset.error) {
    throw new Error(
      `Failed to reset tournament_config.admin_oids: ${configReset.error.message}`,
    );
  }

  console.log('[db] reset');
}

/**
 * Appends `oid` to the singleton `tournament_config.admin_oids` array (idempotent).
 * Call before `signInAs({ role: 'admin', oid })` so that `provision_participant_from_jwt`
 * promotes the participant on first sign-in.
 */
export async function seedAdmin(oid: string): Promise<void> {
  const client = getServiceRoleClient();

  const { data, error } = await client
    .from('tournament_config')
    .select('admin_oids')
    .eq('id', 1)
    .single();

  if (error || !data) {
    throw new Error(
      `seedAdmin: failed to read tournament_config singleton: ${error?.message ?? 'no row'}`,
    );
  }

  const existing = data.admin_oids ?? [];
  if (existing.includes(oid)) return;

  const { error: updateError } = await client
    .from('tournament_config')
    .update({ admin_oids: [...existing, oid] })
    .eq('id', 1);

  if (updateError) {
    throw new Error(`seedAdmin: failed to append oid ${oid}: ${updateError.message}`);
  }
}

/**
 * Convenience read for tests that assert on a participant row created by
 * `provision_participant_from_jwt`. Returns null if the oid is not present.
 */
export async function getParticipantByOid(
  oid: string,
): Promise<Tables<'participants'> | null> {
  const client = getServiceRoleClient();
  const { data, error } = await client
    .from('participants')
    .select('*')
    .eq('oid', oid)
    .maybeSingle();

  if (error) {
    throw new Error(`getParticipantByOid(${oid}): ${error.message}`);
  }
  return data;
}

/**
 * Convenience read for tests that assert on audit events (`auth.rejected`,
 * `participant.created`, etc.). Uses the service role so it bypasses the
 * admin-only SELECT RLS policy on `audit_log`. Results are ordered most-recent
 * first to match how tests typically reason about event sequences.
 */
export async function getAuditLog(filter?: {
  action?: string;
  oid?: string;
}): Promise<Tables<'audit_log'>[]> {
  const client = getServiceRoleClient();
  let query = client.from('audit_log').select('*').order('occurred_at', { ascending: false });

  if (filter?.action) query = query.eq('action', filter.action);
  if (filter?.oid) query = query.eq('actor_oid', filter.oid);

  const { data, error } = await query;
  if (error) {
    throw new Error(`getAuditLog: ${error.message}`);
  }
  return data ?? [];
}
