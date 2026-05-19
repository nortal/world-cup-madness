import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';

/**
 * Supabase Auth → Microsoft Entra OAuth callback (US1 / T038).
 *
 * Invoked by the user's browser after Microsoft redirects back from the OAuth
 * consent / sign-in screen. Supabase Auth's `signInWithOAuth({ provider: 'azure', ... })`
 * is configured with `redirectTo: '${origin}/auth/callback'` (see
 * `components/auth/SignInButton.tsx`), so the inbound request carries the
 * authorization `code` query parameter that we exchange for a Supabase session.
 *
 * Happy-path flow:
 *
 *   1. Read `code` from the query string.
 *   2. Exchange it for a Supabase session via `exchangeCodeForSession(code)`.
 *      This sets the session cookie on the response via the `@supabase/ssr`
 *      cookie sink wired up in {@link createClient}.
 *   3. Call the `provision_participant_from_jwt()` SECURITY DEFINER RPC, which
 *      validates the JWT `tid` claim against `tournament_config.nortal_tenant_id`,
 *      creates or updates the participant row, and returns a discriminated
 *      `outcome` field (see `contracts/rpc-provision-participant.md`).
 *   4. Redirect based on `outcome`:
 *        - `success`  → `/dashboard`
 *        - `rejected` → `/access-denied`
 *        - `error`    → `/auth-error`
 *
 * Error-recovery for the OAuth exchange itself (try/catch around the
 * `exchangeCodeForSession` call + `record_auth_failure('auth.provider-error', ...)`
 * RPC) is intentionally NOT implemented here — it is the responsibility of
 * T051 in US3 (recoverable provider failures). For now, any error from the
 * exchange or any unexpected RPC shape is logged with structured context and
 * the user is redirected to `/auth-error` without writing an audit row.
 *
 * Why `GET` only: the Supabase `azure` provider uses the OAuth 2.0
 * authorization-code flow, which redirects the user-agent back via a GET
 * request carrying the `code` and `state` query parameters. Supabase Auth
 * does not POST to the callback URL.
 */

/** Discriminated outcome shape returned by `provision_participant_from_jwt()`.
 *  Mirrors `specs/001-authentication-and-participant/contracts/rpc-provision-participant.md`. */
type ProvisionOutcome =
  | { outcome: 'success'; participant_id: string; role: 'participant' | 'admin'; is_first_login: boolean }
  | { outcome: 'rejected'; reason: 'tenant.mismatch' }
  | { outcome: 'error'; reason: 'config.missing' };

function isProvisionOutcome(value: unknown): value is ProvisionOutcome {
  if (typeof value !== 'object' || value === null) return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === 'success' || outcome === 'rejected' || outcome === 'error';
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');

  if (code === null) {
    // No code param — Microsoft did not complete the OAuth flow. Treat as a
    // recoverable provider error. (Full audit logging lives in T051.)
    console.error('auth/callback: missing OAuth code query parameter');
    redirect('/auth-error');
  }

  const supabase = await createClient();

  // T051 (US3) will wrap this in try/catch and call `record_auth_failure`.
  // For now we surface a non-thrown error by inspecting the return value and
  // redirecting to `/auth-error` without auditing.
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError !== null) {
    console.error('auth/callback: exchangeCodeForSession failed', {
      message: exchangeError.message,
      status: exchangeError.status,
    });
    redirect('/auth-error');
  }

  const { data, error: rpcError } = await supabase.rpc('provision_participant_from_jwt');

  if (rpcError !== null) {
    console.error('auth/callback: provision_participant_from_jwt RPC failed', {
      message: rpcError.message,
      code: rpcError.code,
    });
    redirect('/auth-error');
  }

  if (!isProvisionOutcome(data)) {
    console.error('auth/callback: provision_participant_from_jwt returned unexpected shape', {
      received: typeof data,
    });
    redirect('/auth-error');
  }

  switch (data.outcome) {
    case 'success':
      redirect('/dashboard');
    case 'rejected':
      redirect('/access-denied');
    case 'error':
      redirect('/auth-error');
  }
}
