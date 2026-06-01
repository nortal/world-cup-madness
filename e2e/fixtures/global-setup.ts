// Playwright globalSetup — runs ONCE before the whole suite.
//
// Why this exists: the match-sync specs write the fixture's 15 matches +
// ~150 players + an integration_runs row, then clean up in `afterAll`.
// That cleanup runs fine on a normal suite finish, but if a previous run
// was interrupted (Ctrl-C, dev-server crash, hook failure) those rows are
// left behind. Subsequent runs of individual specs that read the matches
// catalog (e.g. `/predictions/final` enforces BR-LOCK-005 via the GLOBALLY
// first non-cancelled match) then read leaked, already-kicked-off matches
// and render in their locked state.
//
// Per-spec `beforeEach` cleanups are the primary defence; this hook is a
// belt-and-suspenders safety net so the suite is self-healing against
// interrupted prior runs without every new spec author having to remember.
//
// SAFETY: uses the service_role key. Local Supabase only — must never run
// against a hosted project. Guarded by the standard env var pattern (the
// hook is a no-op if SUPABASE_SERVICE_ROLE_KEY is missing).

import { loadEnvConfig } from '@next/env';

import { getServiceRoleClient } from './db';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export default async function globalSetup(): Promise<void> {
  // Mirror the env loading in playwright.config.ts so the service-role client
  // can resolve its config regardless of invocation context.
  loadEnvConfig(process.cwd());

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    // Tests will fail loudly elsewhere; nothing to clean.
    return;
  }

  const client = getServiceRoleClient();

  // integration_runs first (no FK to matches; clearing telemetry first keeps
  // any partial-cleanup trace clean). BIGSERIAL id → never -1.
  const runsDelete = await client.from('integration_runs').delete().neq('id', -1);
  if (runsDelete.error) {
    throw new Error(`globalSetup: integration_runs clear failed: ${runsDelete.error.message}`);
  }

  // matches: UUID id → use zero-UUID sentinel. predictions / score_events FK
  // onto matches with ON DELETE CASCADE / SET NULL respectively (see feature
  // 003 migrations), so this is safe.
  const matchesDelete = await client.from('matches').delete().neq('id', ZERO_UUID);
  if (matchesDelete.error) {
    throw new Error(`globalSetup: matches clear failed: ${matchesDelete.error.message}`);
  }

  // players: also UUID. final_predictions FK uses ON DELETE SET NULL.
  const playersDelete = await client.from('players').delete().neq('id', ZERO_UUID);
  if (playersDelete.error) {
    throw new Error(`globalSetup: players clear failed: ${playersDelete.error.message}`);
  }
}
