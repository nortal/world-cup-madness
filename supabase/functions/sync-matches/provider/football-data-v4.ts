/**
 * football-data.org v4 provider abstraction (T052 / FR-M03).
 *
 * Single entry point: `fetchMatches()` returns a normalised
 * `{ teams: NormalisedTeam[]; matches: NormalisedMatch[]; rawCount: number }`
 * tuple. The Edge Function consumes the normalised shape and does NOT need
 * to know anything about v4 envelope mechanics. Future providers slot in
 * by implementing the same return contract.
 *
 * Endpoint pinned per ADR + research.md §R-1:
 *   GET https://api.football-data.org/v4/competitions/WC/matches
 *
 * Fixture mode (research.md §R-1, contracts/edge-sync-matches.md):
 *   When `Deno.env.get('SYNC_FIXTURE_MODE') === '1'` we read the frozen
 *   sample at `__fixtures__/v4-sample.json` instead of issuing an HTTP
 *   call. This lets local dev + CI exercise the full sync end-to-end
 *   without a `FOOTBALL_DATA_API_KEY` and without hitting the provider's
 *   10 req/min free-tier ceiling.
 *
 * Status + stage + group normalisation tables (research.md §R-1):
 *
 *   provider status        →  our `matches.status`
 *   ---------------------     -----------------------
 *   SCHEDULED  (no kickoff)→  'scheduled-tbd'
 *   TIMED                  →  'scheduled'
 *   IN_PLAY, PAUSED        →  'live'
 *   FINISHED, AWARDED      →  'finished'
 *   SUSPENDED, POSTPONED,
 *   CANCELLED              →  'cancelled'
 *
 *   provider stage         →  our `matches.stage`
 *   ---------------------     -----------------------
 *   GROUP_STAGE            →  'group'
 *   ROUND_OF_16            →  'round-of-16'
 *   QUARTER_FINALS         →  'quarter-final'
 *   SEMI_FINALS            →  'semi-final'
 *   THIRD_PLACE            →  'third-place'
 *   FINAL                  →  'final'
 *
 *   provider group         →  our `matches.group_label`
 *   ---------------------     -----------------------
 *   "GROUP_A"              →  'A'  (strip the "GROUP_" prefix)
 *   null                   →  null (knockout matches have no group)
 *
 * Edge cases:
 *   - When provider returns `status='SCHEDULED'` with `utcDate=null` (pre-
 *     draw matches), we map to our `'scheduled-tbd'` and set kickoff_utc
 *     to null. The matches table's CHECK constraint
 *     `matches_status_kickoff_consistency` enforces this pairing.
 *   - When provider returns `status='SCHEDULED'` WITH a kickoff date, that
 *     IS a contradiction in v4's own enum (TIMED would be the right tag).
 *     We treat it as `'scheduled'` so the kickoff is preserved.
 *   - Unrecognised status / stage values throw — the upstream sync wraps
 *     in a try/catch and writes `integration_runs.error_category =
 *     'normalisation.invalid-status'` so operators can spot a v4 schema
 *     change quickly.
 *
 * Deno-targeted: uses `Deno.env`, `Deno.readTextFile`, `fetch`. Zero npm
 * / Node / Next imports. Type definitions for the v4 envelope are inline
 * (no external schema package).
 */

import { fetchWithRetry, type RetryableError } from '../lib/retry.ts';
// Statically imported so the Supabase Edge runtime bundles the JSON into the
// compiled function output. `Deno.readTextFile()` of a sibling file does NOT
// survive the bundling step (the runtime copies `.ts` files to
// /var/tmp/sb-compile-edge-runtime/.../ and leaves loose JSON behind).
import sampleEnvelope from '../__fixtures__/v4-sample.json' with { type: 'json' };
import squadsFixture from '../__fixtures__/v4-squads-sample.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// Wire-shape types (football-data.org v4)
// ---------------------------------------------------------------------------

type ProviderTeamRef = {
  id: number;
  name: string;
  tla: string;
  crest?: string | null;
};

type ProviderScore = {
  winner?: 'HOME_TEAM' | 'AWAY_TEAM' | 'DRAW' | null;
  duration?: string;
  fullTime?: { home: number | null; away: number | null };
  halfTime?: { home: number | null; away: number | null };
};

type ProviderStatus =
  | 'SCHEDULED'
  | 'TIMED'
  | 'IN_PLAY'
  | 'PAUSED'
  | 'FINISHED'
  | 'AWARDED'
  | 'SUSPENDED'
  | 'POSTPONED'
  | 'CANCELLED';

type ProviderStage =
  | 'GROUP_STAGE'
  | 'ROUND_OF_16'
  | 'QUARTER_FINALS'
  | 'SEMI_FINALS'
  | 'THIRD_PLACE'
  | 'FINAL';

type ProviderMatch = {
  id: number;
  utcDate: string | null;
  status: ProviderStatus;
  stage: ProviderStage;
  group: string | null;
  homeTeam: ProviderTeamRef;
  awayTeam: ProviderTeamRef;
  venue?: string | null;
  score?: ProviderScore;
};

type ProviderEnvelope = {
  filters?: Record<string, unknown>;
  resultSet?: { count?: number };
  competition?: { id: number; name: string; code: string };
  matches: ProviderMatch[];
};

// ---------------------------------------------------------------------------
// Normalised shapes (the contract this module exposes upstream)
// ---------------------------------------------------------------------------

export type MatchStatus =
  | 'scheduled'
  | 'scheduled-tbd'
  | 'live'
  | 'finished'
  | 'cancelled';

export type MatchStage =
  | 'group'
  | 'round-of-16'
  | 'quarter-final'
  | 'semi-final'
  | 'third-place'
  | 'final';

export type NormalisedTeam = {
  providerTeamId: number;
  name: string;
  tla: string;
};

export type NormalisedMatch = {
  providerId: number;
  homeProviderTeamId: number;
  awayProviderTeamId: number;
  stage: MatchStage;
  groupLabel: string | null;
  kickoffUtc: string | null; // ISO 8601 string or null for scheduled-tbd
  venue: string | null;
  status: MatchStatus;
  scoreHome: number | null;
  scoreAway: number | null;
};

export type FetchMatchesResult = {
  teams: NormalisedTeam[];
  matches: NormalisedMatch[];
  rawCount: number;
};

export type NormalisedPlayer = {
  providerPlayerId: number;
  providerTeamId: number;
  name: string;
  position: 'Goalkeeper' | 'Defender' | 'Midfielder' | 'Attacker' | null;
};

export type FetchSquadsResult = {
  players: NormalisedPlayer[];
  rawTeamCount: number;
};

export type ProviderFetchError = {
  category: 'provider.4xx' | 'provider.5xx' | 'provider.rate-limit' | 'network' | 'fixture' | 'normalisation';
  message: string;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const PROVIDER_URL = 'https://api.football-data.org/v4/competitions/WC/matches';

/**
 * Fetch each team's squad (feature 003 US-PB / FR-P20).
 *
 * For every team in `providerTeamIds`, calls `/v4/teams/{id}/squad` (or
 * reads the squad from the bundled fixture when SYNC_FIXTURE_MODE=1) and
 * returns a flat NormalisedPlayer[] for the Edge Function to UPSERT into
 * `players`.
 *
 * Fixture mode: reads `__fixtures__/v4-squads-sample.json` (32 teams × 5
 * players seeded for local dev). Live mode: sequential per-team requests
 * honouring the 10 req/min rate limit via the existing retry helper.
 */
export async function fetchSquads(providerTeamIds: number[]): Promise<FetchSquadsResult> {
  const fixture = (Deno.env.get('SYNC_FIXTURE_MODE') ?? '') === '1';
  if (fixture) {
    return readSquadsFromFixture(providerTeamIds);
  }
  return fetchSquadsFromProvider(providerTeamIds);
}

type ProviderSquadMember = {
  id: number;
  name: string;
  position?: string | null;
};

type ProviderSquadResponse = {
  id: number;
  name: string;
  tla: string;
  squad?: ProviderSquadMember[];
};

type SquadsFixtureShape = {
  squadsByTeamId: Record<string, ProviderSquadResponse>;
};

function readSquadsFromFixture(providerTeamIds: number[]): FetchSquadsResult {
  const fixture = squadsFixture as SquadsFixtureShape;
  if (!fixture || typeof fixture.squadsByTeamId !== 'object') {
    throw makeError('fixture', 'Bundled squads fixture is malformed (expected {squadsByTeamId: {...}})');
  }

  const players: NormalisedPlayer[] = [];
  let rawTeamCount = 0;

  for (const tid of providerTeamIds) {
    const team = fixture.squadsByTeamId[String(tid)];
    if (!team) continue; // fixture covers most teams; tolerate gaps
    rawTeamCount += 1;
    for (const member of team.squad ?? []) {
      players.push(normalisePlayer(member, tid));
    }
  }

  return { players, rawTeamCount };
}

async function fetchSquadsFromProvider(providerTeamIds: number[]): Promise<FetchSquadsResult> {
  const apiKey = Deno.env.get('FOOTBALL_DATA_API_KEY') ?? '';
  if (apiKey.length === 0) {
    throw makeError('provider.4xx', 'FOOTBALL_DATA_API_KEY is not set (and SYNC_FIXTURE_MODE is not "1")');
  }

  const players: NormalisedPlayer[] = [];
  let rawTeamCount = 0;

  // Sequential per-team requests so the existing retry helper's Retry-After
  // handling keeps us inside the 10 req/min ceiling. Parallel would race
  // the budget.
  for (const tid of providerTeamIds) {
    let response: Response;
    try {
      response = await fetchWithRetry(`https://api.football-data.org/v4/teams/${tid}`, {
        method: 'GET',
        headers: { 'X-Auth-Token': apiKey, Accept: 'application/json' },
      });
    } catch (err) {
      const re = err as Error & Partial<RetryableError>;
      throw makeError(
        mapRetryCategory(re.category ?? 'network'),
        truncateMessage(re.message ?? 'fetchWithRetry threw without a message'),
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw makeError('provider.5xx', `Failed to parse squad JSON for team ${tid}: ${(err as Error).message}`);
    }
    if (!isSquadShape(json)) {
      throw makeError('normalisation', `Squad response for team ${tid} did not match v4 shape`);
    }
    rawTeamCount += 1;
    for (const member of (json as ProviderSquadResponse).squad ?? []) {
      players.push(normalisePlayer(member, tid));
    }
  }

  return { players, rawTeamCount };
}

function normalisePlayer(member: ProviderSquadMember, providerTeamId: number): NormalisedPlayer {
  // football-data.org returns positions like "Goalkeeper", "Centre-Back",
  // "Left-Back", "Defensive Midfield", "Right Winger", etc. We coarsen them
  // to the four-bucket enum the players table allows (Goalkeeper / Defender
  // / Midfielder / Attacker) so the picker UI can show clean filters and
  // the seed fixture stays simple.
  const raw = (member.position ?? '').toLowerCase();
  let coarsened: NormalisedPlayer['position'] = null;
  if (raw === '') coarsened = null;
  else if (raw.includes('keeper')) coarsened = 'Goalkeeper';
  else if (raw.includes('back') || raw.includes('defender') || raw.includes('defence') || raw === 'defender') coarsened = 'Defender';
  else if (raw.includes('mid')) coarsened = 'Midfielder';
  else if (raw.includes('forward') || raw.includes('striker') || raw.includes('winger') || raw.includes('attack')) coarsened = 'Attacker';
  else if (raw === 'goalkeeper' || raw === 'defender' || raw === 'midfielder' || raw === 'attacker') coarsened = raw.charAt(0).toUpperCase() + raw.slice(1) as NormalisedPlayer['position'];

  return {
    providerPlayerId: member.id,
    providerTeamId,
    name: member.name,
    position: coarsened,
  };
}

function isSquadShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { id?: unknown; squad?: unknown };
  return typeof v.id === 'number' && (v.squad === undefined || Array.isArray(v.squad));
}

/**
 * Fetch the WC 2026 fixture envelope and normalise it. Honours
 * `SYNC_FIXTURE_MODE=1` for offline-friendly local dev / CI.
 */
export async function fetchMatches(): Promise<FetchMatchesResult> {
  const envelope = (Deno.env.get('SYNC_FIXTURE_MODE') ?? '') === '1'
    ? readFixture()
    : await fetchFromProvider();

  return normaliseEnvelope(envelope);
}

// ---------------------------------------------------------------------------
// Live provider fetch
// ---------------------------------------------------------------------------

async function fetchFromProvider(): Promise<ProviderEnvelope> {
  const apiKey = Deno.env.get('FOOTBALL_DATA_API_KEY') ?? '';
  if (apiKey.length === 0) {
    throw makeError('provider.4xx', 'FOOTBALL_DATA_API_KEY is not set (and SYNC_FIXTURE_MODE is not "1")');
  }

  let response: Response;
  try {
    response = await fetchWithRetry(PROVIDER_URL, {
      method: 'GET',
      headers: {
        'X-Auth-Token': apiKey,
        'Accept': 'application/json',
      },
    });
  } catch (err) {
    // fetchWithRetry throws a structured `RetryableError`-shaped Error after
    // retry exhaustion or on a non-retryable failure. Surface the category
    // so the upstream Edge Function can record it on integration_runs.
    const re = err as Error & Partial<RetryableError>;
    throw makeError(
      mapRetryCategory(re.category ?? 'network'),
      truncateMessage(re.message ?? 'fetchWithRetry threw without a message'),
    );
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw makeError('provider.5xx', `Failed to parse JSON envelope: ${(err as Error).message}`);
  }

  if (!isEnvelopeShape(json)) {
    throw makeError('normalisation', 'Provider response did not match the expected v4 envelope shape');
  }

  return json;
}

// ---------------------------------------------------------------------------
// Fixture file fetch
// ---------------------------------------------------------------------------

function readFixture(): ProviderEnvelope {
  // The JSON is statically imported above; the static import line is what
  // makes the bundler pull it into the deployed artifact. We still validate
  // the shape at runtime so a future fixture edit that drifts from the v4
  // envelope surfaces here rather than in a downstream null-deref.
  if (!isEnvelopeShape(sampleEnvelope)) {
    throw makeError('fixture', 'Bundled fixture JSON does not match the expected v4 envelope shape');
  }
  return sampleEnvelope;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const STATUS_MAP: Record<ProviderStatus, MatchStatus> = {
  SCHEDULED: 'scheduled-tbd',
  TIMED: 'scheduled',
  IN_PLAY: 'live',
  PAUSED: 'live',
  FINISHED: 'finished',
  AWARDED: 'finished',
  SUSPENDED: 'cancelled',
  POSTPONED: 'cancelled',
  CANCELLED: 'cancelled',
};

const STAGE_MAP: Record<ProviderStage, MatchStage> = {
  GROUP_STAGE: 'group',
  ROUND_OF_16: 'round-of-16',
  QUARTER_FINALS: 'quarter-final',
  SEMI_FINALS: 'semi-final',
  THIRD_PLACE: 'third-place',
  FINAL: 'final',
};

function normaliseEnvelope(env: ProviderEnvelope): FetchMatchesResult {
  const teamsById = new Map<number, NormalisedTeam>();
  const matches: NormalisedMatch[] = [];

  for (const m of env.matches) {
    // Validate status + stage up front; throw with the unknown literal so an
    // operator triaging `integration_runs.error_message` can immediately see
    // which provider enum drifted.
    if (!(m.status in STATUS_MAP)) {
      throw makeError('normalisation', `Unknown provider status: ${String(m.status)}`);
    }
    if (!(m.stage in STAGE_MAP)) {
      throw makeError('normalisation', `Unknown provider stage: ${String(m.stage)}`);
    }

    // Resolve status — with the SCHEDULED-with-kickoff carve-out.
    let mappedStatus: MatchStatus = STATUS_MAP[m.status];
    if (m.status === 'SCHEDULED' && typeof m.utcDate === 'string' && m.utcDate.length > 0) {
      mappedStatus = 'scheduled';
    }

    // Resolve kickoff to honour the matches_status_kickoff_consistency
    // CHECK constraint: scheduled-tbd ↔ null kickoff; everything else
    // requires a non-null kickoff.
    const kickoffUtc: string | null = mappedStatus === 'scheduled-tbd' ? null : (m.utcDate ?? null);
    if (mappedStatus !== 'scheduled-tbd' && kickoffUtc === null) {
      throw makeError(
        'normalisation',
        `Match id=${m.id} has status=${m.status} but no utcDate; cannot satisfy schema check`,
      );
    }

    // Normalise group label: strip the "GROUP_" prefix; null for knockouts.
    let groupLabel: string | null = null;
    if (typeof m.group === 'string' && m.group.length > 0) {
      const stripped = m.group.startsWith('GROUP_') ? m.group.slice('GROUP_'.length) : m.group;
      // Schema CHECK constrains to A-L; reject anything else so a v4 enum
      // expansion surfaces visibly rather than silently writing junk.
      if (!/^[A-L]$/.test(stripped)) {
        throw makeError('normalisation', `Unrecognised group label: ${m.group}`);
      }
      groupLabel = stripped;
    }

    // Score fields: present only when the score envelope carries a fullTime
    // block with numeric values. v4 reports nulls during in-progress matches;
    // we honour that for the live status (FR-A2 §Out of Scope: no live score
    // tracking) by emitting null score columns even for status='live'.
    const score = m.score?.fullTime;
    const scoreHome = typeof score?.home === 'number' ? score.home : null;
    const scoreAway = typeof score?.away === 'number' ? score.away : null;

    // Capture both teams into the dedup map. The Edge Function will UPSERT
    // teams keyed on provider_team_id; any team already in the migration
    // 0017 seed gets a no-op UPDATE (name + tla unchanged from v4 stability).
    teamsById.set(m.homeTeam.id, {
      providerTeamId: m.homeTeam.id,
      name: m.homeTeam.name,
      tla: m.homeTeam.tla.toUpperCase(),
    });
    teamsById.set(m.awayTeam.id, {
      providerTeamId: m.awayTeam.id,
      name: m.awayTeam.name,
      tla: m.awayTeam.tla.toUpperCase(),
    });

    matches.push({
      providerId: m.id,
      homeProviderTeamId: m.homeTeam.id,
      awayProviderTeamId: m.awayTeam.id,
      stage: STAGE_MAP[m.stage],
      groupLabel,
      kickoffUtc,
      venue: typeof m.venue === 'string' && m.venue.length > 0 ? m.venue : null,
      status: mappedStatus,
      scoreHome,
      scoreAway,
    });
  }

  return {
    teams: Array.from(teamsById.values()),
    matches,
    rawCount: env.resultSet?.count ?? env.matches.length,
  };
}

// ---------------------------------------------------------------------------
// Shape guards + small utilities
// ---------------------------------------------------------------------------

function isEnvelopeShape(value: unknown): value is ProviderEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const env = value as { matches?: unknown };
  return Array.isArray(env.matches);
}

function mapRetryCategory(c: string): ProviderFetchError['category'] {
  switch (c) {
    case 'provider.4xx':
    case 'provider.5xx':
    case 'provider.rate-limit':
    case 'network':
      return c;
    default:
      return 'network';
  }
}

function truncateMessage(s: string): string {
  return s.length > 1024 ? `${s.slice(0, 1024)}…` : s;
}

function makeError(category: ProviderFetchError['category'], message: string): Error {
  const err = new Error(message) as Error & ProviderFetchError;
  err.category = category;
  err.message = message;
  return err;
}
