import 'server-only';

import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

import type { Database } from './database.types';

/**
 * Creates a Supabase admin (service_role) client for server-only operations
 * that must run BEFORE a user session exists — most notably the
 * `record_auth_failure` RPC invoked from `app/auth/callback/route.ts` when
 * `exchangeCodeForSession` itself fails (T051 / US3).
 *
 * SAFETY CONSTRAINT — service_role bypasses RLS and MUST NEVER ship to a
 * client bundle:
 *   - The `'server-only'` import at the top of this file is a Next.js
 *     poison-pill module that causes the build to fail if this module is
 *     ever imported (transitively) by a Client Component.
 *   - This module uses the bare `@supabase/supabase-js` client (NOT
 *     `@supabase/ssr`) because admin RPC calls don't need cookies — there
 *     is no authenticated user yet — and we want `persistSession: false`
 *     to keep this stateless.
 *   - The key is read from `SUPABASE_SERVICE_ROLE_KEY` (a non-`NEXT_PUBLIC_`
 *     variable), so it can never be inlined into the browser bundle by
 *     Next.js.
 *
 * Use this client ONLY for narrowly-scoped privileged operations (e.g.
 * writing an `audit_log` row for an auth failure that occurred before
 * authentication completed). Normal request handling goes through the
 * anon-keyed `createClient()` in `lib/supabase/server.ts`, which preserves
 * RLS-based authorization.
 */
export function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable.',
    );
  }

  return createSupabaseJsClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
