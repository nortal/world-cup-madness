/**
 * Shared helpers for feature 004 leaderboard Playwright specs.
 *
 * `refreshLeaderboardMV` short-cuts past the admin-gated
 * `refresh_leaderboard()` RPC by issuing `REFRESH MATERIALIZED VIEW
 * CONCURRENTLY` directly against the local Postgres container. The
 * service-role client cannot reach the RPC — the function gates on
 * `is_admin_user(auth.uid())` and the service-role session carries no
 * JWT, so the gate denies it. In production the cron schedule and the
 * scoring triggers do the refreshing; only test code needs this escape
 * hatch.
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';

const SUPABASE_DB_CONTAINER = 'supabase_db_world-cup-madness';

export function refreshLeaderboardMV(): void {
  execSync(
    `docker exec ${SUPABASE_DB_CONTAINER} psql -U postgres -d postgres -c "REFRESH MATERIALIZED VIEW CONCURRENTLY leaderboard_snapshots;"`,
    { stdio: 'pipe' },
  );
}

/**
 * Insert a participants row directly via the service-role client.
 * Returns the new participant id. Throws on insert error so failing
 * specs surface the constraint that blocked them.
 */
export async function seedActiveParticipant(
  client: SupabaseClient<Database>,
  displayName: string,
): Promise<string> {
  const oid = randomUUID();
  const email = `${oid}@nortal.com`;
  const { data: user, error: userErr } = await client.auth.admin.createUser({
    email,
    password: 'wcm-test-password-123',
    email_confirm: true,
    app_metadata: { tid: '00000000-0000-0000-0000-000000000000', oid, provider: 'azure' },
    user_metadata: { name: displayName, email },
  });
  if (userErr || !user?.user?.id) {
    throw new Error(`seedActiveParticipant auth.users insert failed: ${userErr?.message}`);
  }
  const { data: participant, error: pErr } = await client
    .from('participants')
    .insert({
      auth_user_id: user.user.id,
      oid,
      email,
      display_name: displayName,
      status: 'active',
    })
    .select('id')
    .single();
  if (pErr || !participant) {
    throw new Error(`seedActiveParticipant participants insert failed: ${pErr?.message}`);
  }
  return participant.id;
}
