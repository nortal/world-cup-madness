// Playwright E2E auth fixture for World Cup Madness.
//
// Implements the JWT-injection pattern documented in
// `specs/001-authentication-and-participant/research.md` §R-7:
//   - Avoids driving the real Microsoft Entra OAuth UI (slow, flaky, requires
//     a dedicated test tenant).
//   - Forges a Microsoft-shaped inner JWT carrying the `tid`, `oid`, `email`,
//     and `name` claims that our `before-issue-token` Supabase Auth hook
//     copies into the session JWT (`supabase/auth-hooks/before-issue-token.ts`).
//   - Calls `supabase.auth.signInWithIdToken({ provider: 'azure', token })`
//     inside the Playwright `page` context so the browser-side Supabase
//     client picks up real session cookies (matches what the real OAuth
//     callback would produce).
//
// SAFETY: this fixture produces JWTs WITHOUT a valid signature. The auth hook
// decodes the inner JWT payload via `atob` and does NOT verify it — for the
// local Supabase stack used by E2E this is sufficient. This fixture MUST NOT
// be used against a hosted Supabase project: hosted Supabase Auth verifies
// the provider token against the real Microsoft JWKS.

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';

/**
 * The Nortal Entra tenant UUID used by the local Supabase seed. Mirrors the
 * value seeded in `supabase/migrations/0009_seed_admin.sql`
 * (`'00000000-0000-0000-0000-000000000000'`). Override via the
 * `AUTH_AZURE_TENANT_ID` env var if your local config differs.
 */
export const ELIGIBLE_TENANT_ID: string =
  process.env.AUTH_AZURE_TENANT_ID ?? '00000000-0000-0000-0000-000000000000';

/**
 * A deliberately-bogus tenant UUID for ineligible-user tests (TC-5, TC-6).
 * Any well-formed UUID distinct from `ELIGIBLE_TENANT_ID` works.
 */
export const INELIGIBLE_TENANT_ID = '00000000-0000-0000-0000-000000000099';

/** Default audience used in the forged token. Mirrors Microsoft's `v2.0` audience pattern. */
const DEFAULT_AUDIENCE =
  process.env.AUTH_AZURE_CLIENT_ID ?? '11111111-1111-1111-1111-111111111111';

/** Base64url-encode without padding (RFC 7515 §2). */
function base64UrlEncode(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export type ForgeOptions = {
  tid: string;
  oid: string;
  email: string;
  name: string;
};

/**
 * Synthesize a Microsoft-shaped ID token (`header.payload.placeholder-sig`).
 * Signature segment is a fixed placeholder — the before-issue-token hook only
 * reads the payload segment. See module-level safety comment.
 */
export function forgeMicrosoftIdToken({ tid, oid, email, name }: ForgeOptions): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    aud: DEFAULT_AUDIENCE,
    tid,
    oid,
    email,
    name,
    preferred_username: email,
    iat: now,
    nbf: now,
    exp: now + 3600,
    sub: oid,
    ver: '2.0',
  };
  // Placeholder signature — not a real HMAC. Local Supabase + the hook do not
  // verify this. See safety note at top of file.
  const placeholderSig = 'forged-for-local-e2e-only';
  return [
    base64UrlEncode(JSON.stringify(header)),
    base64UrlEncode(JSON.stringify(payload)),
    placeholderSig,
  ].join('.');
}

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
 * Sign a synthetic user into the app via the Playwright page context.
 *
 * Implementation: the call is dispatched via `page.evaluate()` so the
 * browser-side Supabase client receives the resulting session cookies
 * directly — matching what the real OAuth callback would produce.
 *
 * `signInAs` does NOT auto-start the Supabase local stack. If
 * `signInWithIdToken` fails because the stack is down, this throws with a
 * helpful error message.
 *
 * Admin role: when `role === 'admin'`, the caller must have already added the
 * `oid` to `tournament_config.admin_oids` (see `e2e/fixtures/db.ts`
 * `seedAdmin(oid)`). This fixture imports that helper from a sibling file
 * landed by T035; the import is deferred to keep this fixture usable in
 * isolation when only T034 has been applied (the dynamic import errors
 * loudly if `db.ts` is missing at call time).
 */
export async function signInAs(page: Page, options: SignInAsOptions): Promise<SignInAsResult> {
  const tid = options.tenant === 'eligible' ? ELIGIBLE_TENANT_ID : INELIGIBLE_TENANT_ID;
  const oid = options.oid ?? randomUUID();
  const emailDomain = options.tenant === 'eligible' ? 'nortal.com' : 'example.com';
  const email = options.email ?? `${oid}@${emailDomain}`;
  const displayName = options.name ?? `Test User ${oid.slice(0, 8)}`;

  // If caller asks for admin role, seed the admin_oids list BEFORE sign-in so
  // `provision_participant_from_jwt()` picks the new role on first insert.
  if (options.role === 'admin') {
    // Deferred dynamic import: keeps this fixture usable in isolation while
    // T035 (`e2e/fixtures/db.ts`) is being authored. The import is wrapped
    // through a string-typed specifier so `tsc --noEmit` doesn't fail before
    // db.ts lands. At call time it errors loudly if db.ts is still missing.
    const dbModuleSpecifier: string = './db.js';
    const dbModule = (await import(dbModuleSpecifier)) as {
      seedAdmin: (oid: string) => Promise<void>;
    };
    await dbModule.seedAdmin(oid);
  }

  const token = forgeMicrosoftIdToken({ tid, oid, email, name: displayName });

  const result = await page.evaluate(
    async ({ token: t, supabaseUrl, supabaseAnonKey }) => {
      // Lazy-load the supabase-js bundle inside the page to avoid bundling it
      // into this Node-side fixture. The app already ships supabase-js in its
      // chunks, but for fixture isolation we use the ESM CDN build.
      const { createClient } = await import(
        // @ts-expect-error -- dynamic import of CDN bundle inside the browser context.
        'https://esm.sh/@supabase/supabase-js@2.105.4'
      );
      const client = createClient(supabaseUrl, supabaseAnonKey);
      const { data, error } = await client.auth.signInWithIdToken({
        provider: 'azure',
        token: t,
      });
      if (error) return { ok: false as const, error: error.message };
      return {
        ok: true as const,
        userId: data?.session?.user?.id ?? null,
      };
    },
    {
      token,
      supabaseUrl:
        process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321',
      supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
    },
  );

  if (!result.ok) {
    throw new Error(
      [
        `signInAs: supabase.auth.signInWithIdToken failed: ${result.error}`,
        'Hints:',
        '  - Is the local Supabase stack running? (`npx supabase start`)',
        '  - Is NEXT_PUBLIC_SUPABASE_URL set to your local stack URL?',
        '  - Is NEXT_PUBLIC_SUPABASE_ANON_KEY set?',
      ].join('\n'),
    );
  }

  return { oid, email, tid, displayName };
}
