import { createBrowserClient } from '@supabase/ssr';

import type { Database } from './database.types';

/**
 * Creates a Supabase client for Client Components. Uses the anon key — RLS
 * performs authorization. The service_role key MUST NEVER be used here (it
 * would bypass RLS and ship a secret to the browser bundle).
 *
 * Cookies are handled automatically via document.cookie.
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable.',
    );
  }

  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
}
