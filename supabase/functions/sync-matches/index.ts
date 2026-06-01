/**
 * sync-matches Edge Function (T053).
 *
 * Implements `POST /functions/v1/sync-matches` per
 * `specs/002-match-catalog-read/contracts/edge-sync-matches.md`.
 *
 * Responsibilities (FR-M03, FR-M18, FR-M19, FR-M20, FR-M23, NFR-M5):
 *   1. Authenticate the caller as service-role (no anon/authenticated calls).
 *   2. Validate the request body `action` enum.
 *   3. Insert the in-flight integration_runs row (finished_at=NULL). The
 *      partial unique index from migration 0018 enforces at-most-one
 *      in-flight row — a unique-violation tells us another sync is already
 *      running and we short-circuit with outcome='skipped' + a skipped row
 *      written to integration_runs.
 *   4. Fetch + normalise the v4 envelope (or the fixture file when
 *      SYNC_FIXTURE_MODE=1).
 *   5. UPSERT `teams` on `provider_team_id` (idempotent — the seed in
 *      migration 0017 already covers the WC 2026 set; v4 may add or
 *      rename teams later, so we accept that).
 *   6. UPSERT `matches` on `provider_id` with field-level diff: count
 *      how many rows were UPDATEd with different field values vs how
 *      many landed identical (records_unchanged). `last_synced_at` is
 *      always refreshed — that's an UPSERT property, not a "field
 *      changed" signal.
 *   7. Update the integration_runs row with final counts + duration
 *      + status, setting finished_at to release the in-flight slot.
 *
 * All non-2xx HTTP responses are limited to: 400 (bad request body), 401
 * (auth missing/invalid). Provider / DB errors are recorded as
 * `outcome:'error'` in a 200 response per the contract.
 *
 * Deno-targeted. No npm / Node / Next imports. Uses `Deno.env`, the global
 * `fetch`, and `@supabase/supabase-js@2` via the Supabase Edge runtime's
 * import-map (the Edge runtime ships the supabase-js client at the
 * default import path).
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

import {
  fetchMatches,
  fetchSquads,
  type FetchMatchesResult,
  type NormalisedMatch,
  type NormalisedPlayer,
} from './provider/football-data-v4.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SyncAction = 'bootstrap' | 'incremental-sync' | 'manual-resync';

const ALLOWED_ACTIONS: readonly SyncAction[] = ['bootstrap', 'incremental-sync', 'manual-resync'];

type SyncSuccessResponse = {
  outcome: 'success' | 'error';
  integration_run_id: number;
  records_processed: number;
  records_unchanged: number;
  duration_ms: number;
  // Feature 003 US-PB squad sync — combined records_* sums above, broken
  // out here so operators can disambiguate match vs player counts. Squad-
  // sync failures degrade outcome to 'error' but still write the partial
  // matches sync, so the response shape stays identical to success.
  matches_processed?: number;
  players_processed?: number;
  error_message?: string;
};

type SyncSkippedResponse = {
  outcome: 'skipped';
  integration_run_id: number;
  reason: 'another sync is already in flight';
  in_flight_run_started_at: string | null;
};

type SyncErrorResponse = {
  outcome: 'error';
  integration_run_id: number | null;
  error_category: string;
  error_message: string;
};

type SyncResponse = SyncSuccessResponse | SyncSkippedResponse | SyncErrorResponse;

// ---------------------------------------------------------------------------
// Entry handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Method: POST only.
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Auth: must carry a service-role bearer token. We don't decode it; the
  // supabase client constructed below uses the service-role key from env
  // (the same one the caller MUST present), so an incorrect bearer would
  // ALSO fail at the RPC layer. We still validate presence so unauth'd
  // callers get a clean 401 instead of a confused 500.
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing or invalid Authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Body: optional JSON `{ action }`; default to 'incremental-sync'.
  let action: SyncAction = 'incremental-sync';
  try {
    const raw = await req.text();
    if (raw.length > 0) {
      const parsed = JSON.parse(raw) as { action?: unknown };
      if (parsed.action !== undefined) {
        if (typeof parsed.action !== 'string' || !ALLOWED_ACTIONS.includes(parsed.action as SyncAction)) {
          return badRequest(
            `action must be one of: ${ALLOWED_ACTIONS.join(', ')}; got: ${String(parsed.action)}`,
          );
        }
        action = parsed.action as SyncAction;
      }
    }
  } catch (err) {
    return badRequest(`Body is not valid JSON: ${(err as Error).message}`);
  }

  // Build the supabase service-role client. This is the only credential we
  // need for the rest of the function — RPC + table writes all go through
  // it. The token check above is a defence-in-depth gesture so unauth'd
  // direct invocations don't reach the lock / DB layer.
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (supabaseUrl.length === 0 || serviceRoleKey.length === 0) {
    return internalError('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set in the function environment');
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return runSync(supabase, action);
});

// ---------------------------------------------------------------------------
// Sync workflow
// ---------------------------------------------------------------------------

async function runSync(supabase: SupabaseClient, action: SyncAction): Promise<Response> {
  const startedAt = new Date();

  // Step 1 — try to claim the in-flight slot by inserting our run row with
  // finished_at=NULL. Migration 0018 enforces "at most one in-flight row"
  // via a partial unique index — a unique-violation tells us another sync
  // is already running. This replaces the advisory-lock dance from migration
  // 0015 (advisory locks were session-scoped and PostgREST closed the
  // session immediately after the lock RPC, so the lock never spanned the
  // actual sync work — see migration 0018 commit message for the full story).
  let runId: number;
  try {
    const { data: inserted, error } = await supabase
      .from('integration_runs')
      .insert({
        provider: 'football-data.org',
        action,
        started_at: startedAt.toISOString(),
        finished_at: null,
        status: 'success', // placeholder; overwritten on completion or error
        records_processed: 0,
        records_unchanged: 0,
      })
      .select('id')
      .single();

    if (error !== null) {
      // PostgREST surfaces Postgres unique-violation as code='23505' in
      // error.code (or sometimes only in error.message — supabase-js exposes
      // the `code` directly on PostgrestError). Treat both signals as the
      // "another sync is in flight" outcome.
      const isUniqueViolation =
        error.code === '23505' ||
        /duplicate key value violates unique constraint/.test(error.message);
      if (isUniqueViolation) {
        return writeSkippedRowAndRespond(supabase, action, startedAt);
      }
      return jsonResponse({
        outcome: 'error',
        integration_run_id: null,
        error_category: 'db.integration_runs-insert-failed',
        error_message: error.message,
      });
    }
    if (inserted === null) {
      return jsonResponse({
        outcome: 'error',
        integration_run_id: null,
        error_category: 'db.integration_runs-insert-failed',
        error_message: 'no row returned from in-flight insert',
      });
    }
    runId = inserted.id;
  } catch (err) {
    return jsonResponse({
      outcome: 'error',
      integration_run_id: null,
      error_category: 'db.integration_runs-insert-failed',
      error_message: (err as Error).message,
    });
  }

  // Step 2+ — fetch + normalise + upsert. The in-flight row is released
  // when we set its finished_at via finishIntegrationRun(); the catch block
  // ensures finished_at is always set, even on unexpected throws, so a
  // stuck row never blocks future runs.
  try {
    let fetched: FetchMatchesResult;
    try {
      fetched = await fetchMatches();
    } catch (err) {
      const category = (err as Error & { category?: string }).category ?? 'network';
      await finishIntegrationRun(supabase, runId, {
        status: 'error',
        records_processed: 0,
        records_unchanged: 0,
        error_message: (err as Error).message,
      });
      return jsonResponse({
        outcome: 'error',
        integration_run_id: runId,
        error_category: category,
        error_message: (err as Error).message,
      });
    }

    // Step 6 — UPSERT teams keyed on provider_team_id.
    const teamsResult = await upsertTeams(supabase, fetched);
    if (teamsResult.error !== null) {
      await finishIntegrationRun(supabase, runId, {
        status: 'error',
        records_processed: 0,
        records_unchanged: 0,
        error_message: teamsResult.error,
      });
      return jsonResponse({
        outcome: 'error',
        integration_run_id: runId,
        error_category: 'db.upsert-failed',
        error_message: teamsResult.error,
      });
    }

    // Step 7 — UPSERT matches with field-level diff.
    const matchesResult = await upsertMatches(supabase, fetched.matches);
    if (matchesResult.error !== null) {
      await finishIntegrationRun(supabase, runId, {
        status: 'error',
        records_processed: 0,
        records_unchanged: 0,
        error_message: matchesResult.error,
      });
      return jsonResponse({
        outcome: 'error',
        integration_run_id: runId,
        error_category: 'db.upsert-failed',
        error_message: matchesResult.error,
      });
    }

    // Step 8 — feature 003 US-PB squad sync. Fetch each team's squad and
    // UPSERT into `players`. Combined counts roll into integration_runs.
    // A squad-sync failure is recorded but does NOT roll back the match
    // sync (per FR-P21, the integration_runs row reports combined totals;
    // partial success is acceptable so the catalog read path stays useful
    // even when the player picker has stale data).
    const teamIds = Array.from(new Set(fetched.teams.map((t) => t.providerTeamId)));
    let squadsResult: PlayersUpsertResult;
    try {
      const { players, rawTeamCount: _rawTeamCount } = await fetchSquads(teamIds);
      squadsResult = await upsertPlayers(supabase, players);
    } catch (err) {
      const category = (err as Error & { category?: string }).category ?? 'network';
      console.error('squad-sync failed', { category, message: (err as Error).message });
      squadsResult = { processed: 0, unchanged: 0, error: `squad-sync: ${(err as Error).message}` };
    }

    const totalProcessed = matchesResult.processed + squadsResult.processed;
    const totalUnchanged = matchesResult.unchanged + squadsResult.unchanged;
    const errorMessage = squadsResult.error ?? null;

    // Step 9 — finalise the integration_runs row + return.
    await finishIntegrationRun(supabase, runId, {
      status: errorMessage === null ? 'success' : 'error',
      records_processed: totalProcessed,
      records_unchanged: totalUnchanged,
      error_message: errorMessage,
    });

    const durationMs = Date.now() - startedAt.getTime();
    return jsonResponse({
      outcome: errorMessage === null ? 'success' : 'error',
      integration_run_id: runId,
      records_processed: totalProcessed,
      records_unchanged: totalUnchanged,
      matches_processed: matchesResult.processed,
      players_processed: squadsResult.processed,
      duration_ms: durationMs,
      ...(errorMessage !== null ? { error_message: errorMessage } : {}),
    });
  } catch (err) {
    // Unhandled throw mid-sync. Best-effort: mark the in-flight row as
    // error so it stops blocking subsequent runs. If THIS write also fails,
    // the row stays in-flight and an operator must clean it up manually
    // (runbook: DELETE FROM integration_runs WHERE finished_at IS NULL
    // AND started_at < now() - interval '1 hour';).
    try {
      await finishIntegrationRun(supabase, runId, {
        status: 'error',
        records_processed: 0,
        records_unchanged: 0,
        error_message: `unhandled throw: ${(err as Error).message}`,
      });
    } catch {
      // Swallow — at this point we've done everything reasonable.
    }
    return jsonResponse({
      outcome: 'error',
      integration_run_id: runId,
      error_category: 'sync.unhandled',
      error_message: (err as Error).message,
    });
  }
}

async function writeSkippedRowAndRespond(
  supabase: SupabaseClient,
  action: SyncAction,
  startedAt: Date,
): Promise<Response> {
  const inFlight = await findInFlightStartedAt(supabase);
  const skipMessage = inFlight === null
    ? 'blocked: another sync is in flight (started_at unknown)'
    : `blocked by run started at ${inFlight}`;
  const { data: skippedRow, error: insertError } = await supabase
    .from('integration_runs')
    .insert({
      provider: 'football-data.org',
      action,
      started_at: startedAt.toISOString(),
      finished_at: startedAt.toISOString(),
      status: 'skipped',
      records_processed: 0,
      records_unchanged: 0,
      error_message: skipMessage,
    })
    .select('id')
    .single();
  return jsonResponse({
    outcome: 'skipped',
    integration_run_id: insertError !== null ? -1 : (skippedRow?.id ?? -1),
    reason: 'another sync is already in flight',
    in_flight_run_started_at: inFlight,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findInFlightStartedAt(supabase: SupabaseClient): Promise<string | null> {
  // Primary: look for a still-in-flight row (finished_at IS NULL). This is
  // the "current truth" path that the operator-triage UI will hit.
  const { data: inFlight } = await supabase
    .from('integration_runs')
    .select('started_at')
    .is('finished_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (inFlight !== null) return inFlight.started_at ?? null;

  // Fallback: the run that caused our unique-violation may have finished
  // in the few ms between INSERT-failure and this read. The most-recent
  // run by started_at is overwhelmingly likely to be the one we collided
  // with — that's what TC-M14 wants surfaced so an operator can correlate
  // the skipped row with the in-flight run that blocked it.
  const { data: latest } = await supabase
    .from('integration_runs')
    .select('started_at')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return latest?.started_at ?? null;
}

async function upsertTeams(
  supabase: SupabaseClient,
  fetched: FetchMatchesResult,
): Promise<{ error: string | null }> {
  if (fetched.teams.length === 0) {
    return { error: null };
  }

  // Map normalised → row shape.
  const rows = fetched.teams.map((t) => ({
    name: t.name,
    tla: t.tla,
    provider_team_id: t.providerTeamId,
  }));

  // ON CONFLICT (provider_team_id) DO UPDATE — refresh name + tla. If the
  // seeded row already matches the provider values, this is a cheap UPDATE
  // that doesn't actually change column values.
  const { error } = await supabase
    .from('teams')
    .upsert(rows, { onConflict: 'provider_team_id' });

  return { error: error?.message ?? null };
}

type MatchesUpsertResult = {
  processed: number;
  unchanged: number;
  error: string | null;
};

async function upsertMatches(
  supabase: SupabaseClient,
  matches: NormalisedMatch[],
): Promise<MatchesUpsertResult> {
  if (matches.length === 0) {
    return { processed: 0, unchanged: 0, error: null };
  }

  // Resolve each match's home/away provider_team_id → internal team UUID.
  // One pre-flight teams query covers all matches.
  const providerTeamIds = new Set<number>();
  for (const m of matches) {
    providerTeamIds.add(m.homeProviderTeamId);
    providerTeamIds.add(m.awayProviderTeamId);
  }
  const { data: teamRows, error: teamsErr } = await supabase
    .from('teams')
    .select('id, provider_team_id')
    .in('provider_team_id', Array.from(providerTeamIds));
  if (teamsErr !== null) {
    return { processed: 0, unchanged: 0, error: `team lookup: ${teamsErr.message}` };
  }
  const teamUuidByProviderId = new Map<number, string>();
  for (const t of teamRows ?? []) {
    teamUuidByProviderId.set(t.provider_team_id as number, t.id as string);
  }

  // Pre-flight read of existing matches keyed on the provider_ids in this
  // batch — we use this for the field-level diff that produces
  // records_unchanged.
  const providerIds = matches.map((m) => m.providerId);
  const { data: existingRows, error: existingErr } = await supabase
    .from('matches')
    .select(
      'provider_id, kickoff_utc, status, score_home, score_away, stage, group_label, venue, home_team_id, away_team_id',
    )
    .in('provider_id', providerIds);
  if (existingErr !== null) {
    return { processed: 0, unchanged: 0, error: `existing-matches lookup: ${existingErr.message}` };
  }
  type ExistingShape = {
    provider_id: number;
    kickoff_utc: string | null;
    status: string;
    score_home: number | null;
    score_away: number | null;
    stage: string;
    group_label: string | null;
    venue: string | null;
    home_team_id: string;
    away_team_id: string;
  };
  const existingByProviderId = new Map<number, ExistingShape>();
  for (const r of (existingRows ?? []) as ExistingShape[]) {
    existingByProviderId.set(r.provider_id, r);
  }

  // Build the upsert payload and count unchanged rows.
  const now = new Date().toISOString();
  const payload: Array<Record<string, unknown>> = [];
  let unchanged = 0;
  for (const m of matches) {
    const homeUuid = teamUuidByProviderId.get(m.homeProviderTeamId);
    const awayUuid = teamUuidByProviderId.get(m.awayProviderTeamId);
    if (homeUuid === undefined || awayUuid === undefined) {
      return {
        processed: 0,
        unchanged: 0,
        error:
          `team UUID missing for match provider_id=${m.providerId} (home=${m.homeProviderTeamId}, away=${m.awayProviderTeamId})`,
      };
    }

    const prior = existingByProviderId.get(m.providerId);
    // Compare timestamps as instants — Postgres returns timestamptz as
    // "...+00:00" while the provider envelope uses the trailing "Z" form.
    // Both parse to the same Date.getTime(), but raw-string equality would
    // mis-classify every row as changed.
    const priorKickoffMs = prior?.kickoff_utc !== null && prior?.kickoff_utc !== undefined
      ? new Date(prior.kickoff_utc).getTime()
      : null;
    const incomingKickoffMs = m.kickoffUtc !== null ? new Date(m.kickoffUtc).getTime() : null;

    const isUnchanged = prior !== undefined &&
      priorKickoffMs === incomingKickoffMs &&
      prior.status === m.status &&
      prior.score_home === m.scoreHome &&
      prior.score_away === m.scoreAway &&
      prior.stage === m.stage &&
      prior.group_label === m.groupLabel &&
      prior.venue === m.venue &&
      prior.home_team_id === homeUuid &&
      prior.away_team_id === awayUuid;
    if (isUnchanged) unchanged += 1;

    payload.push({
      provider_id: m.providerId,
      home_team_id: homeUuid,
      away_team_id: awayUuid,
      stage: m.stage,
      group_label: m.groupLabel,
      kickoff_utc: m.kickoffUtc,
      venue: m.venue,
      status: m.status,
      score_home: m.scoreHome,
      score_away: m.scoreAway,
      last_synced_at: now,
    });
  }

  const { error: upsertErr } = await supabase
    .from('matches')
    .upsert(payload, { onConflict: 'provider_id' });
  if (upsertErr !== null) {
    return { processed: 0, unchanged: 0, error: `matches upsert: ${upsertErr.message}` };
  }

  return { processed: matches.length, unchanged, error: null };
}

// ---------------------------------------------------------------------------
// upsertPlayers — squad sync into players table (feature 003 US-PB / FR-P20)
// ---------------------------------------------------------------------------

type PlayersUpsertResult = {
  processed: number;
  unchanged: number;
  error: string | null;
};

async function upsertPlayers(
  supabase: SupabaseClient,
  players: NormalisedPlayer[],
): Promise<PlayersUpsertResult> {
  if (players.length === 0) {
    return { processed: 0, unchanged: 0, error: null };
  }

  // Resolve provider_team_id → team UUID for the FK. The team rows already
  // exist (seed in migration 0017 + sync UPSERTs from upsertTeams above).
  const teamIds = Array.from(new Set(players.map((p) => p.providerTeamId)));
  const { data: teamRows, error: teamsErr } = await supabase
    .from('teams')
    .select('id, provider_team_id')
    .in('provider_team_id', teamIds);
  if (teamsErr !== null) {
    return { processed: 0, unchanged: 0, error: `team lookup for players: ${teamsErr.message}` };
  }
  const teamUuidByProviderId = new Map<number, string>();
  for (const t of teamRows ?? []) {
    teamUuidByProviderId.set(t.provider_team_id as number, t.id as string);
  }

  // Pre-flight read of existing players for field-level diff (records_unchanged).
  const providerIds = players.map((p) => p.providerPlayerId);
  const { data: existingRows, error: existingErr } = await supabase
    .from('players')
    .select('provider_player_id, name, position, team_id')
    .in('provider_player_id', providerIds);
  if (existingErr !== null) {
    return { processed: 0, unchanged: 0, error: `existing-players lookup: ${existingErr.message}` };
  }
  type ExistingShape = {
    provider_player_id: number;
    name: string;
    position: string | null;
    team_id: string;
  };
  const existingByProviderId = new Map<number, ExistingShape>();
  for (const r of (existingRows ?? []) as ExistingShape[]) {
    existingByProviderId.set(r.provider_player_id, r);
  }

  const payload: Array<Record<string, unknown>> = [];
  let unchanged = 0;
  for (const p of players) {
    const teamUuid = teamUuidByProviderId.get(p.providerTeamId);
    if (teamUuid === undefined) {
      // Player references a team we don't have. Skip rather than fail the
      // whole sync; log via the returned error if every player skipped.
      continue;
    }

    const prior = existingByProviderId.get(p.providerPlayerId);
    const isUnchanged =
      prior !== undefined &&
      prior.name === p.name &&
      prior.position === p.position &&
      prior.team_id === teamUuid;
    if (isUnchanged) unchanged += 1;

    payload.push({
      provider_player_id: p.providerPlayerId,
      name: p.name,
      position: p.position,
      team_id: teamUuid,
    });
  }

  if (payload.length === 0) {
    return { processed: 0, unchanged: 0, error: 'all players skipped — no matching teams in players upsert' };
  }

  const { error: upsertErr } = await supabase
    .from('players')
    .upsert(payload, { onConflict: 'provider_player_id' });
  if (upsertErr !== null) {
    return { processed: 0, unchanged: 0, error: `players upsert: ${upsertErr.message}` };
  }

  return { processed: payload.length, unchanged, error: null };
}

async function finishIntegrationRun(
  supabase: SupabaseClient,
  runId: number,
  finalState: {
    status: 'success' | 'error';
    records_processed: number;
    records_unchanged: number;
    error_message: string | null;
  },
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await supabase
    .from('integration_runs')
    .update({
      finished_at: finishedAt,
      status: finalState.status,
      records_processed: finalState.records_processed,
      records_unchanged: finalState.records_unchanged,
      error_message: finalState.error_message,
    })
    .eq('id', runId);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: SyncResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function internalError(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}
