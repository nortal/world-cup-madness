import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import type { Database } from './database.types';

/**
 * Refreshes the Supabase auth session on every request and propagates the
 * rotated cookies to both the downstream request (so Server Components see
 * the new token) and the outgoing response (so the browser stores it).
 *
 * Consumed by the top-level `middleware.ts` (T032), which chains this helper
 * with next-intl Accept-Language detection.
 *
 * IMPORTANT: do NOT add logic between `createServerClient(...)` and
 * `supabase.auth.getUser()` — the `getUser()` call is what actually triggers
 * the refresh side-effect on the cookie sink. Omitting it silently drops
 * sessions.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable.',
    );
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // 1. Forward refreshed cookies onto the inbound request so downstream
        //    handlers (Server Components, Route Handlers) read the new token.
        cookiesToSet.forEach(({ name, value }) => {
          request.cookies.set(name, value);
        });
        // 2. Re-create the response so it inherits the updated request cookies.
        response = NextResponse.next({ request });
        // 3. Mirror the same cookies onto the outgoing response so the browser
        //    persists the rotated session.
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  // Force the refresh side-effect. The returned user is intentionally
  // unused here — gating decisions belong in Server Components / route
  // handlers that re-read with the freshly-rotated cookies.
  await supabase.auth.getUser();

  return response;
}
