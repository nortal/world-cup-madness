/**
 * Shared TypeScript types for feature 004 leaderboard surfaces.
 *
 * `LeaderboardRow` projects only the PUBLIC columns of `leaderboard_snapshots`
 * (per contracts/mv-leaderboard-snapshots.md). The private tie-breaker
 * columns (`exact_hits`, `outcome_hits`, `final_points`) are not selectable
 * by the `authenticated` role on the underlying MV (column-level GRANT) —
 * they are only reachable via the `leaderboard_self` view restricted to the
 * caller's own row. Keeping the type narrow ensures Server Components can't
 * accidentally request a column that RLS will reject.
 *
 * Note: the generated MV row type marks every column nullable (Supabase's
 * view-type generator can't infer NOT NULL across the materialised view's
 * `UNION ALL` of CTEs even though the MV definition is NOT NULL on every
 * column). We use the generated row type as the structural shape; the
 * runtime data is always populated.
 */

import type { Database } from '@/lib/supabase/database.types';

export type LeaderboardRow = Pick<
  Database['public']['Views']['leaderboard_snapshots']['Row'],
  'participant_id' | 'stage' | 'display_name' | 'total_points' | 'rank' | 'rank_is_shared'
>;
