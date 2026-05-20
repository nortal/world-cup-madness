import { redirect } from 'next/navigation';
import type { NextRequest } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

/**
 * Supabase Auth → Microsoft Entra OAuth callback (US1 / T038, US3 / T051).
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
 * Error-recovery for the OAuth exchange itself (US3 / T051): when the
 * authorization `code` is missing OR `exchangeCodeForSession` throws or
 * returns an error, we write an `audit_log` row via the SECURITY DEFINER
 * `record_auth_failure('auth.provider-error', ...)` RPC. Because the
 * exchange has just failed there is no session yet, so the RPC is called
 * via a service-role client (see {@link createAdminClient}). The audit
 * write itself is wrapped in a try/catch so a failed audit cannot replace
 * the `/auth-error` redirect with a 500 (FR-A9 / TC-10).
 *
 * The `outcome='error'` branch from `provision_participant_from_jwt` is
 * NOT audited here — the RPC itself writes the `auth.provider-error` row
 * for the `config.missing` case (see contracts/rpc-provision-participant.md
 * §"Side effects"), so adding a callback-side audit would double-count.
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

/**
 * Writes an `auth.provider-error` audit row via the `record_auth_failure`
 * SECURITY DEFINER RPC, using a service-role client because at this point
 * in the flow no user session exists (the OAuth exchange just failed or
 * never started).
 *
 * `oid`, `email`, and `attempted_tid` are intentionally `null` — the
 * exchange failed before we obtained a JWT, so we have no verified
 * identifying info per FR-A9.
 *
 * MUST NOT throw: a failed audit must not replace the `/auth-error`
 * redirect with a 500. On audit-RPC failure we emit a structured log so
 * the operator still has log-stream evidence per Constitution §1.3.
 */
async function recordCallbackProviderError(reason: 'callback.missing-code' | 'callback.exchange-failed') {
  try {
    const admin = createAdminClient();
    const { error: rpcError } = await admin.rpc('record_auth_failure', {
      p_action: 'auth.provider-error',
      // The generated types declare these as non-nullable strings, but the
      // underlying Postgres function accepts NULL for unknown identifying
      // info (see specs/.../contracts/rpc-record-auth-failure.md). We pass
      // null via an `unknown` cast rather than a synthetic placeholder so
      // the audit row faithfully reflects "we have no oid/email/tid yet".
      p_oid: null,
      p_email: null,
      p_attempted_tid: null,
      p_reason: reason,
    } as unknown as {
      p_action: string;
      p_oid: string;
      p_email: string;
      p_attempted_tid: string;
      p_reason: string;
    });

    if (rpcError !== null) {
      console.error('auth/callback: record_auth_failure RPC returned error', {
        event: 'auth.provider-error.audit-failed',
        reason,
        rpc_message: rpcError.message,
        rpc_code: rpcError.code,
      });
    }
  } catch (auditError) {
    console.error('auth/callback: record_auth_failure threw', {
      event: 'auth.provider-error.audit-threw',
      reason,
      error_message: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');

  if (code === null) {
    // No code param — Microsoft did not complete the OAuth flow (FR-A9 / TC-10).
    console.error('auth/callback: missing OAuth code query parameter', {
      event: 'auth.provider-error',
      reason: 'callback.missing-code',
    });
    await recordCallbackProviderError('callback.missing-code');
    redirect('/auth-error');
  }

  const supabase = await createClient();

  // T051 (US3): wrap exchangeCodeForSession in try/catch + audit any failure
  // (thrown or returned-as-error) as `auth.provider-error` before redirecting.
  let exchangeFailed = false;
  let exchangeFailureDetail: { message: string; status?: number } | null = null;
  try {
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeError !== null) {
      exchangeFailed = true;
      exchangeFailureDetail = { message: exchangeError.message, status: exchangeError.status };
    }
  } catch (thrown) {
    exchangeFailed = true;
    exchangeFailureDetail = {
      message: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }

  if (exchangeFailed) {
    console.error('auth/callback: exchangeCodeForSession failed', {
      event: 'auth.provider-error',
      reason: 'callback.exchange-failed',
      ...exchangeFailureDetail,
    });
    await recordCallbackProviderError('callback.exchange-failed');
    redirect('/auth-error');
  }

  const { data, error: rpcError } = await supabase.rpc('provision_participant_from_jwt');

  if (rpcError !== null) {
    // The provision RPC handles its own auditing for the `config.missing` /
    // `outcome: 'error'` path. A transport-level RPC failure (network, 5xx)
    // is not covered by that audit, but it is also not a "provider error" in
    // the OAuth sense — we surface it as /auth-error and rely on Supabase
    // logs for observability. (Not in scope for T051.)
    console.error('auth/callback: provision_participant_from_jwt RPC failed', {
      event: 'auth.provision.rpc-failed',
      message: rpcError.message,
      code: rpcError.code,
    });
    redirect('/auth-error');
  }

  if (!isProvisionOutcome(data)) {
    console.error('auth/callback: provision_participant_from_jwt returned unexpected shape', {
      event: 'auth.provision.unexpected-shape',
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
