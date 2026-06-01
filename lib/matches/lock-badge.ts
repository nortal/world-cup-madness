/**
 * Lock-badge derivation for the match catalog (FR-M08).
 *
 * Returns the badge state a match should display given its kickoff time, its
 * persisted provider status, and the current trusted server time. The badge
 * has three states:
 *
 *   - `UPCOMING`  — kickoff is more than 60 minutes away AND status is not
 *                   one of (`live`, `finished`, `cancelled`).
 *   - `LOCKED`    — kickoff is at most 60 minutes away (i.e. now ≥ kickoff −
 *                   60min) OR status is `live`. Predictions for this match
 *                   are no longer editable.
 *   - `FINISHED`  — status is `finished` or `cancelled`. The match is over
 *                   (or won't happen at all — cancellations are surfaced as
 *                   the same terminal UX state because the row is no longer
 *                   actionable).
 *
 * BR-LOCK-003 (inverted): the original BR-LOCK-003 specifies that a
 * prediction MUST be rejected when `remaining_minutes ≤ 60`. The badge is
 * the read-side projection of that rule, so the boundary semantics are
 * inclusive on the LOCKED side: kickoff exactly 60 minutes in the future
 * already shows `LOCKED`. We use `≤`, not `<`, intentionally.
 *
 * Why TypeScript and not SQL: the spec's data-model.md §"Lock-badge
 * derivation" decided NOT to add a Postgres helper for this projection. The
 * badge is computed at render time so the matches table stays a 1:1 mirror
 * of provider data, with no scheduled job flipping rows at the 60-minute
 * boundary. Keeping the helper in TS also lets us unit-test the boundary
 * deterministically without a Postgres round-trip.
 *
 * `nowUtc` is injected by the caller so the function is fully deterministic
 * and unit-testable — production callers pass `new Date()` (or, ideally,
 * the trusted server time obtained from the Supabase server client).
 *
 * Pure function: no side effects, no I/O, no React, no Next.js.
 */

/** The 5 provider-reported match statuses, mirroring the DB CHECK constraint. */
export type MatchStatus = 'scheduled' | 'scheduled-tbd' | 'live' | 'finished' | 'cancelled';

/** The 3 derived badge states surfaced to the UI. */
export type LockBadge = 'UPCOMING' | 'LOCKED' | 'FINISHED';

/** 60 minutes expressed in milliseconds — the BR-LOCK-003 inclusive window. */
const LOCK_WINDOW_MS = 60 * 60 * 1000;

export function lockBadgeState(
  kickoffUtc: Date | null,
  status: MatchStatus,
  nowUtc: Date,
): LockBadge {
  // Terminal states win first. `cancelled` is mapped to FINISHED on purpose:
  // UX-wise the row is no longer actionable, and we don't want a 4th badge
  // state just for cancellations (spec FR-M08).
  if (status === 'finished' || status === 'cancelled') {
    return 'FINISHED';
  }

  // `live` always locks regardless of kickoff math — the match is in
  // progress even if our clock somehow disagrees with the provider's.
  if (status === 'live') {
    return 'LOCKED';
  }

  // Defensive: NULL kickoff is only valid alongside status='scheduled-tbd'
  // (enforced by the `matches_status_kickoff_consistency` CHECK in
  // supabase/migrations/0012_create_matches.sql). For the legal TBD case
  // there's no kickoff to lock against, so it's UPCOMING. For the illegal
  // case (NULL kickoff with any other status) we still return UPCOMING
  // rather than throwing — the DB invariant means the renderer should never
  // hit this path, but throwing here would crash a server render for what
  // is fundamentally a data-integrity bug elsewhere.
  if (kickoffUtc === null) {
    return 'UPCOMING';
  }

  // BR-LOCK-003 inverted boundary: lock activates at kickoff − 60min
  // inclusive. `remaining ≤ LOCK_WINDOW_MS` covers both "less than 60 min
  // away" and "kickoff is in the past" (negative remaining is still ≤ the
  // window, so an un-updated past kickoff stays LOCKED until the provider
  // ticks it over to 'live' or 'finished').
  const remainingMs = kickoffUtc.getTime() - nowUtc.getTime();
  return remainingMs <= LOCK_WINDOW_MS ? 'LOCKED' : 'UPCOMING';
}
