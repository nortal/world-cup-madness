/**
 * mock-teams-receiver Edge Function (T006).
 *
 * DEV-ONLY mock for Microsoft Teams incoming webhooks. Used by the feature 006
 * Playwright E2E tests to verify the `notification.teams.sent` / `.failed`
 * pipeline end-to-end without an actual Teams tenant.
 *
 * Per `specs/006-phase-5-operational/research.md` § R-4 + data-model.md § 3:
 *
 *   1. Accepts POSTs only — anything else gets a 405.
 *   2. Captures the JSON body verbatim into `_test_mock_teams_inbox.body`.
 *      If JSON parsing fails the request is still persisted as
 *      `{"_parse_error": "<text>"}` so the test sees what arrived.
 *   3. Reads `?respond_with=<status>` (default 200; out-of-range → 200) and
 *      returns that exact status code with an empty JSON body.
 *   4. Records all incoming headers (lowercased keys) into
 *      `_test_mock_teams_inbox.headers` so tests can assert on Content-Type.
 *   5. Writes via service-role; the URL itself is the test secret — there is
 *      no auth on the receiver.
 *
 * Migration 0040 creates `_test_mock_teams_inbox` only when
 * `current_setting('app.env')='development'`. In any non-dev environment the
 * table is absent — we log a structured warning and still return the
 * configured status so callers can't tell the receiver is half-disabled.
 *
 * Deno-targeted. No npm / Node imports. Style matches
 * `supabase/functions/sync-matches/index.ts`.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

// ---------------------------------------------------------------------------
// Entry handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  // Method: POST only. Teams webhooks are POSTs in production, so anything
  // else is a misconfigured test — surface it loudly.
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Determine the configured response status BEFORE body parsing — even a
  // parse failure must respond with the test-configured code so the test can
  // exercise 4xx/5xx paths against malformed payloads.
  const respondWith = parseRespondWith(req.url);

  // Capture every incoming header into a flat object. Header names are
  // already lowercased by the Fetch API headers iterator — guarantee it here
  // too so the assertion shape never depends on runtime quirks.
  const headersObj: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) {
    headersObj[key.toLowerCase()] = value;
  }

  // Body. Failure to parse is recorded — NOT propagated as a 4xx — because
  // the test author controls the response code via respond_with and wants to
  // see exactly what bytes arrived.
  let bodyToStore: unknown;
  try {
    const raw = await req.text();
    if (raw.length === 0) {
      bodyToStore = {};
    } else {
      bodyToStore = JSON.parse(raw);
    }
  } catch (err) {
    bodyToStore = { _parse_error: (err as Error).message };
  }

  // Service-role client for the inbox write. SUPABASE_URL +
  // SUPABASE_SERVICE_ROLE_KEY are auto-injected by the Supabase Edge runtime.
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (supabaseUrl.length === 0 || serviceRoleKey.length === 0) {
    console.warn('mock-teams-receiver: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — skipping inbox write', {
      respond_with: respondWith,
    });
    return buildResponse(respondWith);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  await persistInboxRow(supabase, bodyToStore, headersObj, respondWith);

  return buildResponse(respondWith);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRespondWith(rawUrl: string): number {
  try {
    const url = new URL(rawUrl);
    const param = url.searchParams.get('respond_with');
    if (param === null) return 200;
    const parsed = Number.parseInt(param, 10);
    if (!Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
      return 200;
    }
    return parsed;
  } catch {
    // URL parsing should never throw for a Deno-served request, but stay
    // defensive — the test infrastructure must never crash on bad input.
    return 200;
  }
}

async function persistInboxRow(
  supabase: SupabaseClient,
  body: unknown,
  headers: Record<string, string>,
  statusSent: number,
): Promise<void> {
  const { error } = await supabase
    .from('_test_mock_teams_inbox')
    .insert({
      body,
      headers,
      status_sent: statusSent,
      received_at: new Date().toISOString(),
    });

  if (error !== null) {
    // The most likely cause is that migration 0040 did not run because
    // `app.env != 'development'`. Log structured context so the operator can
    // see the receiver is being hit but has nowhere to land the payload.
    console.warn('mock-teams-receiver: inbox insert failed', {
      message: error.message,
      code: (error as { code?: string }).code ?? null,
      status_sent: statusSent,
      hint:
        'is migration 0040 applied? table _test_mock_teams_inbox is only created when app.env=\'development\'',
    });
  }
}

function buildResponse(status: number): Response {
  // Empty JSON body — Teams webhook contract returns nothing meaningful, so
  // tests should only inspect the status code + the persisted inbox row.
  // Content-Type is set defensively so any downstream parser (curl -i, the
  // pg_net reconciler) has a sensible default.
  return new Response('{}', {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
