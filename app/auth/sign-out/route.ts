import { redirect } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';

/**
 * Sign-out Route Handler.
 *
 * Clears the local Supabase session and redirects to the landing page.
 *
 * - `POST` is used by `<form>`-based sign-out buttons (CSRF-safe).
 * - `GET` is used by simple `<Link href="/auth/sign-out">` affordances (e.g.,
 *   "Sign in with a different account" on `/access-denied` per FR-A7).
 *
 * `signOut()` is idempotent — safe to call without first checking session.
 * `scope: 'local'` clears only this device's session, which matches user
 * expectations for a per-device sign-out (rather than revoking all sessions
 * globally).
 */
async function handle() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: 'local' });
  redirect('/');
}

export async function POST() {
  await handle();
}

export async function GET() {
  await handle();
}
