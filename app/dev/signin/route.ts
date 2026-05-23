import 'server-only';

import { createHash } from 'node:crypto';
import { redirect } from 'next/navigation';
import { type NextRequest, NextResponse } from 'next/server';

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

/**
 * Development-only synthetic sign-in helper.
 *
 * **Production behaviour: this route returns 404.** The
 * `process.env.NODE_ENV === 'production'` check at the top short-circuits
 * before reading any secrets or touching the database. The route is also
 * left out of the production bundle by tree-shaking the no-op return.
 *
 * Why this exists: the SignInButton on `/` calls Supabase Auth's `azure`
 * provider, which redirects to `login.microsoftonline.com` with our
 * `AUTH_AZURE_CLIENT_ID`. In local dev that client ID is a placeholder
 * (Nortal IT hasn't supplied the real Entra app registration yet —
 * tracked as OD-007 sub-condition #2), so Microsoft rejects the redirect
 * and you can't reach the dashboard for manual UI testing. The Playwright
 * fixture in `e2e/fixtures/auth.ts` solves the same problem by upserting
 * an `auth.users` row directly via the admin API and then signing in via
 * `signInWithPassword` — this route does the same thing, exposed as a
 * URL so you can drive it from a browser without writing a test.
 *
 * Usage:
 *   GET http://localhost:3000/dev/signin?email=you@nortal.com
 *   GET http://localhost:3000/dev/signin?email=admin@nortal.com&role=admin
 *
 * Query params:
 *   - `email` (required) — used as the auth.users email and as the basis
 *     for a deterministic `oid` (SHA-256 of the email, formatted as a
 *     UUID v4-ish string). Deterministic means re-signing-in with the
 *     same email matches the existing participants row by `oid` rather
 *     than creating a duplicate.
 *   - `role=admin` (optional) — seeds the derived oid into
 *     `tournament_config.admin_oids` so the provisioning RPC promotes
 *     the participant to admin on first insert (FR-A5).
 *   - `tenant=ineligible` (optional) — uses a deliberately-wrong tenant
 *     UUID so the provisioning RPC rejects you. Useful for hand-checking
 *     the `/access-denied` redirect.
 *
 * SAFETY:
 *   - `import 'server-only'` poison-pills any accidental client import.
 *   - `createAdminClient()` reads the service_role key from a non-NEXT_PUBLIC
 *     env var so it cannot leak to the browser bundle.
 *   - Hard 404 in production (regardless of NEXT_PUBLIC_* env state).
 *   - The synthetic user's password is a fixed long string — fine for a
 *     local stack, never used in any deployed context because the route
 *     itself is 404'd in production.
 */

const DEV_TEST_PASSWORD = 'wcm-dev-signin-password-please-do-not-reuse';
const INELIGIBLE_TENANT_ID = '00000000-0000-0000-0000-000000000099';

function notFound(): NextResponse {
  return new NextResponse('Not found', { status: 404 });
}

/**
 * Deterministic UUID derived from the email. Same email → same oid → same
 * participants row across repeat sign-ins (no duplicate inserts on the
 * `unique(oid)` constraint).
 */
function emailToOid(email: string): string {
  const hex = createHash('sha256').update(email.toLowerCase()).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (process.env.NODE_ENV === 'production') {
    return notFound();
  }

  const url = new URL(request.url);
  const email = url.searchParams.get('email')?.trim().toLowerCase();
  const roleParam = url.searchParams.get('role');
  const tenantParam = url.searchParams.get('tenant');

  if (!email || !email.includes('@')) {
    return new NextResponse(
      'Missing or invalid `email` query parameter. Usage: /dev/signin?email=you@nortal.com',
      { status: 400 },
    );
  }

  const isAdmin = roleParam === 'admin';
  const isIneligible = tenantParam === 'ineligible';
  const oid = emailToOid(email);

  const admin = createAdminClient();

  // Resolve the tenant ID to embed in the synthetic JWT's app_metadata.
  // For the eligible path, mirror whatever the seeded `tournament_config`
  // singleton holds — so the RPC's tenant check passes. For the
  // ineligible path, use a known-bad UUID so the RPC rejects.
  let tid: string;
  if (isIneligible) {
    tid = INELIGIBLE_TENANT_ID;
  } else {
    const { data: tournamentConfig, error: tournamentConfigError } = await admin
      .from('tournament_config')
      .select('nortal_tenant_id, admin_oids')
      .eq('id', 1)
      .maybeSingle();

    if (tournamentConfigError || !tournamentConfig) {
      return new NextResponse(
        `Failed to read tournament_config singleton: ${tournamentConfigError?.message ?? 'no row'}. ` +
          'Did you run `npx supabase db reset`?',
        { status: 500 },
      );
    }
    tid = tournamentConfig.nortal_tenant_id;

    if (isAdmin && !tournamentConfig.admin_oids.includes(oid)) {
      const { error: updateError } = await admin
        .from('tournament_config')
        .update({ admin_oids: [...tournamentConfig.admin_oids, oid] })
        .eq('id', 1);
      if (updateError) {
        return new NextResponse(
          `Failed to append oid to admin_oids: ${updateError.message}`,
          { status: 500 },
        );
      }
    }
  }

  const displayName = email.split('@')[0];
  const appMetadata = { tid, oid, provider: 'azure', providers: ['azure'] };
  const userMetadata = { name: displayName, full_name: displayName, email };

  // Upsert auth.users keyed by email. The admin API doesn't expose a true
  // upsert, so we look up first then branch. `listUsers` is paginated;
  // five 100-row pages is plenty for a local stack with synthetic users.
  let userId: string | null = null;
  for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
    const { data, error } = await admin.auth.admin.listUsers({
      page: pageNumber,
      perPage: 100,
    });
    if (error) {
      return new NextResponse(`admin.listUsers failed: ${error.message}`, { status: 500 });
    }
    const found = data.users.find((u) => u.email?.toLowerCase() === email);
    if (found) {
      userId = found.id;
      break;
    }
    if (data.users.length < 100) break;
  }

  if (userId) {
    const { error } = await admin.auth.admin.updateUserById(userId, {
      email_confirm: true,
      password: DEV_TEST_PASSWORD,
      app_metadata: appMetadata,
      user_metadata: userMetadata,
    });
    if (error) {
      return new NextResponse(`admin.updateUserById failed: ${error.message}`, { status: 500 });
    }
  } else {
    const { error } = await admin.auth.admin.createUser({
      email,
      password: DEV_TEST_PASSWORD,
      email_confirm: true,
      app_metadata: appMetadata,
      user_metadata: userMetadata,
    });
    if (error) {
      return new NextResponse(`admin.createUser failed: ${error.message}`, { status: 500 });
    }
  }

  // Now sign in via the @supabase/ssr server client so the session lands
  // in cookies that Server Components + middleware see. This mirrors what
  // the OAuth callback does after `exchangeCodeForSession` — except the
  // synthetic password swap replaces the OAuth code exchange.
  const supabase = await createClient();
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email,
    password: DEV_TEST_PASSWORD,
  });
  if (signInError) {
    return new NextResponse(`signInWithPassword failed: ${signInError.message}`, {
      status: 500,
    });
  }

  // Trigger the production provisioning RPC the same way the OAuth callback
  // does. The RPC returns `{ outcome: 'success' | 'rejected' | 'error', ... }`;
  // we route by outcome to the same destination pages the callback uses, so
  // this dev route exercises the same control flow.
  const { data: provisionData, error: provisionError } = await supabase.rpc(
    'provision_participant_from_jwt',
  );
  if (provisionError) {
    return new NextResponse(`provision_participant_from_jwt failed: ${provisionError.message}`, {
      status: 500,
    });
  }

  const outcome = (provisionData as { outcome?: string } | null)?.outcome;
  switch (outcome) {
    case 'success':
      redirect('/dashboard');
    case 'rejected':
      redirect('/access-denied');
    case 'error':
    default:
      redirect('/auth-error');
  }
}
