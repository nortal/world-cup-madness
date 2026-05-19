// Playwright E2E auth fixture for World Cup Madness.
//
// The original R-7 plan was to forge a Microsoft-shaped ID token and pass it to
// `supabase.auth.signInWithIdToken({ provider: 'azure', token })`. That does
// NOT work against the local Supabase stack: GoTrue performs real OIDC
// discovery against `auth.external.azure.url` (Microsoft) and rejects any
// forged token. See `specs/001-authentication-and-participant/research.md` §R-7
// for the updated decision.
//
// Replacement pattern:
//   1. Use the Supabase admin API (service_role) to upsert an `auth.users`
//      row with `app_metadata.{tid, oid, provider}` set directly. In production
//      these claims are written by the `before-issue-token` hook from the
//      provider's ID token; in tests we set them ourselves to bypass real
//      Microsoft entirely.
//   2. Sign in via `supabase.auth.signInWithPassword` inside the Playwright
//      page context. Session cookies land in browser storage exactly as they
//      would after a real OAuth callback, so the rest of the app (RPCs,
//      Server Components, RLS) is exercised identically.
//
// SAFETY: this fixture uses the service_role key and MUST only be imported
// from Playwright test code (Node) — never from any file that ends up in a
// browser bundle. See `.ai_project_memory/constitution-backend.md` §VI.1.
// It MUST NOT be run against a hosted Supabase project.

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { SupabaseClient, User } from '@supabase/supabase-js';

import type { Database } from '../../lib/supabase/database.types';
import { getServiceRoleClient } from './db';

/**
 * The Nortal Entra tenant UUID used by the local Supabase seed. Mirrors the
 * value seeded in `supabase/migrations/0009_seed_admin.sql`
 * (`'00000000-0000-0000-0000-000000000000'`). Override via the
 * `AUTH_AZURE_TENANT_ID` env var if your local config differs.
 */
export const ELIGIBLE_TENANT_ID: string =
  process.env.AUTH_AZURE_TENANT_ID ?? '00000000-0000-0000-0000-000000000000';

/**
 * A deliberately-bogus tenant UUID for ineligible-user tests (TC-5, TC-6, TC-7).
 * Any well-formed UUID distinct from `ELIGIBLE_TENANT_ID` works.
 */
export const INELIGIBLE_TENANT_ID = '00000000-0000-0000-0000-000000000099';

/**
 * Fixed password applied to every synthetic test user. The local Supabase
 * stack only — never used against a hosted project. Kept long enough to
 * satisfy any reasonable password-strength policy.
 */
const TEST_USER_PASSWORD = 'wcm-e2e-test-password-please-do-not-reuse';

export type SignInAsOptions = {
  tenant: 'eligible' | 'ineligible';
  oid?: string;
  role?: 'participant' | 'admin';
  email?: string;
  name?: string;
};

export type SignInAsResult = {
  oid: string;
  email: string;
  tid: string;
  displayName: string;
};

/**
 * Sign a synthetic user into the Playwright `page` context.
 *
 * - Admin API upserts the `auth.users` row keyed by email, setting
 *   `app_metadata.{tid, oid, provider}` so that downstream RPCs and RLS
 *   predicates see the right claims.
 * - The page-side Supabase client then calls `signInWithPassword`, which
 *   issues a session JWT carrying that `app_metadata` and writes cookies via
 *   `@supabase/ssr` exactly as the production OAuth callback would.
 *
 * Re-sign-in scenarios (e.g. TC-7 "tenant departure"): pass the same `oid`
 * with a different `tenant`. Email also changes (different domain), so the
 * fixture creates a fresh `auth.users` row carrying the new `tid` claim. The
 * `participants` row is keyed by `oid`, so the provisioning RPC continues to
 * see the same participant identity across the two sign-ins.
 *
 * Admin role: when `role === 'admin'`, the caller's oid is appended to
 * `tournament_config.admin_oids` BEFORE sign-in so that
 * `provision_participant_from_jwt()` promotes the new row on first insert.
 */
export async function signInAs(page: Page, options: SignInAsOptions): Promise<SignInAsResult> {
  const tid = options.tenant === 'eligible' ? ELIGIBLE_TENANT_ID : INELIGIBLE_TENANT_ID;
  const oid = options.oid ?? randomUUID();
  const emailDomain = options.tenant === 'eligible' ? 'nortal.com' : 'example.com';
  const email = options.email ?? `${oid}@${emailDomain}`;
  const displayName = options.name ?? `Test User ${oid.slice(0, 8)}`;

  if (options.role === 'admin') {
    // Defer import to keep module-init lean; db.ts itself does not depend on
    // auth.ts so no cycle.
    const { seedAdmin } = await import('./db');
    await seedAdmin(oid);
  }

  const adminClient = getServiceRoleClient();

  const appMetadata = {
    tid,
    oid,
    provider: 'azure',
    providers: ['azure'],
  };
  const userMetadata = {
    name: displayName,
    full_name: displayName,
    email,
  };

  const existing = await findAuthUserByEmail(adminClient, email);
  if (existing) {
    const { error } = await adminClient.auth.admin.updateUserById(existing.id, {
      email_confirm: true,
      password: TEST_USER_PASSWORD,
      app_metadata: appMetadata,
      user_metadata: userMetadata,
    });
    if (error) {
      throw new Error(`signInAs: admin.updateUserById failed for ${email}: ${error.message}`);
    }
  } else {
    const { error } = await adminClient.auth.admin.createUser({
      email,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
      app_metadata: appMetadata,
      user_metadata: userMetadata,
    });
    if (error) {
      throw new Error(`signInAs: admin.createUser failed for ${email}: ${error.message}`);
    }
  }

  // Ensure the page is on the app's origin before writing localStorage. If a
  // test calls signInAs without first navigating, the page sits at
  // `about:blank`, whose localStorage is scoped to that origin — subsequent
  // operations on the app origin would not see the persisted session, and
  // RPCs would race ahead unauthenticated.
  if (page.url() === 'about:blank') {
    await page.goto('/');
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

  const result = await page.evaluate(
    async ({ email: e, password, supabaseUrl: u, supabaseAnonKey: a }) => {
      // Lazy-load `@supabase/ssr`'s browser client inside the page. We use
      // `@supabase/ssr` rather than vanilla `@supabase/supabase-js` so the
      // session persists in cookies — the storage mechanism the app's Server
      // Components and middleware read. Vanilla supabase-js stores sessions
      // in localStorage only, which the Next.js server side cannot see.
      const { createBrowserClient } = await import(
        // @ts-expect-error -- CDN ESM dynamic import inside the browser context.
        'https://esm.sh/@supabase/ssr@0.10.3'
      );
      const client = createBrowserClient(u, a);
      const { data, error } = await client.auth.signInWithPassword({
        email: e,
        password,
      });
      if (error) return { ok: false as const, error: error.message };
      return {
        ok: true as const,
        userId: data?.session?.user?.id ?? null,
      };
    },
    {
      email,
      password: TEST_USER_PASSWORD,
      supabaseUrl,
      supabaseAnonKey,
    },
  );

  if (!result.ok) {
    throw new Error(
      [
        `signInAs: supabase.auth.signInWithPassword failed for ${email}: ${result.error}`,
        'Hints:',
        '  - Is the local Supabase stack running? (`npx supabase start`)',
        '  - Is NEXT_PUBLIC_SUPABASE_URL set to your local stack URL?',
        '  - Is NEXT_PUBLIC_SUPABASE_ANON_KEY set?',
        '  - Is SUPABASE_SERVICE_ROLE_KEY set? (the fixture upserts the auth user via the admin API)',
      ].join('\n'),
    );
  }

  return { oid, email, tid, displayName };
}

/**
 * Find an `auth.users` row by email. The admin API exposes `listUsers` with
 * pagination; we cap at five 100-row pages, which is plenty for a local stack
 * accumulating test users across runs.
 */
async function findAuthUserByEmail(
  client: SupabaseClient<Database>,
  email: string,
): Promise<User | null> {
  const target = email.toLowerCase();
  for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page: pageNumber,
      perPage: 100,
    });
    if (error) {
      throw new Error(`findAuthUserByEmail: listUsers failed: ${error.message}`);
    }
    const found = data.users.find((u) => u.email?.toLowerCase() === target);
    if (found) return found;
    if (data.users.length < 100) return null;
  }
  return null;
}
