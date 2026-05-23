import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import type { Database } from './database.types';

/**
 * Creates a Supabase client for Server Components, Route Handlers, and Server
 * Actions. Uses the anon key — RLS performs authorization. The service_role key
 * MUST NEVER be used here (it would bypass RLS).
 *
 * Always create a new client per request — never share across requests.
 */
export async function createClient() {
  const cookieStore = await cookies();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable.',
    );
  }

  return createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // setAll throws in read-only Server Component contexts; ignore there
        // because middleware (T026) refreshes the session on every request.
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // No-op: invoked from a Server Component without a writable cookie store.
        }
      },
    },
  });
}
