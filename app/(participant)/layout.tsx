import { redirect } from 'next/navigation';

import GlobalNav from '@/components/nav/GlobalNav';
import { createClient } from '@/lib/supabase/server';

/**
 * `(participant)` route-group layout — wraps every authenticated route
 * (`/dashboard`, `/matches`, `/leaderboard`, `/profile`, `/predictions/*`)
 * with the global navigation bar.
 *
 * Server Component. Resolves the auth session + the participant row once
 * per request, passes `displayName` + `isAdmin` down to the Client-side
 * `<GlobalNav/>`, and gates the entire route group behind authentication.
 * An unauthenticated request to any participant route redirects to `/`.
 *
 * Why this lives in the route-group layout rather than every individual
 * page: page-level redirects work but duplicate the auth read. The layout
 * caches a single Supabase call per request and pages can trust the
 * participant exists by the time they render.
 *
 * The existing per-page redirect logic on `app/(participant)/dashboard/page.tsx`
 * (and siblings) is now redundant but harmless. It can be removed in a
 * follow-up cleanup commit.
 */
export default async function ParticipantLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user === null) {
    redirect('/');
  }

  const { data: participant, error: participantError } = await supabase
    .from('participants')
    .select('display_name, role, status')
    .eq('auth_user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();

  if (participantError !== null || participant === null) {
    redirect('/');
  }

  const displayName =
    participant.display_name?.trim().length > 0
      ? participant.display_name
      : 'Participant';

  return (
    <>
      <GlobalNav displayName={displayName} isAdmin={participant.role === 'admin'} />
      {children}
    </>
  );
}
