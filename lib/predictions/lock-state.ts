/**
 * Lock-state helper for the prediction form (US-PA).
 *
 * MIRRORS the server-side comparator in `submit_prediction()` RPC
 * (supabase/migrations/0028_prediction_rpcs.sql, line 80):
 *
 *   IF v_kickoff_utc IS NULL OR (v_kickoff_utc - now()) <= interval '60 minutes' THEN
 *     RAISE EXCEPTION 'PREDICTION_LOCKED' ...
 *
 * This is a UI hint only — the RPC is authoritative (BR-LOCK-001:
 * trusted server time, server-side enforcement). If this helper says
 * EDITABLE but the RPC returns PREDICTION_LOCKED on submit, the RPC wins
 * and the UI must surface its error.
 *
 * Strict semantic (BR-LOCK-002 + BR-LOCK-003): at EXACTLY T-60min the
 * prediction IS locked. We use `<=`, not `<`. The "strict-greater-than"
 * shorthand refers to the editable side: editable iff
 * `(kickoff - now) > 60min`. The Postgres RPC, this helper, and feature
 * 002's `lib/matches/lock-badge.ts` MUST all agree on this boundary —
 * pgTAP `017_prediction_rpcs.sql` and Jest tests at `__tests__/` pin it.
 *
 * Why a separate file from `lib/matches/lock-badge.ts`:
 *   - `lock-badge.ts` is the catalog read-side projection — kickoff +
 *     status → UPCOMING | LOCKED | FINISHED (3-state badge).
 *   - `lock-state.ts` is the prediction-form's submit-readiness check +
 *     countdown display — kickoff → boolean + ms-until-lock.
 * Both share the same underlying boundary rule. See
 * `specs/003-predictions-and-scoring/research.md` §R-8 for the rationale
 * behind keeping these as two purpose-named helpers rather than one
 * conflated module.
 *
 * The boundary comparator below is duplicated from `lock-badge.ts:83`
 * with this pointer comment (Constitution §1.1: "prefer duplication
 * over wrong abstraction"). `lock-badge.ts` does not export a
 * standalone `isLocked(kickoff, now)` function — the comparator is
 * inlined inside `lockBadgeState`. Rather than refactor a shipped
 * feature-002 helper to extract a one-liner, we mirror the comparator
 * here with this explicit cross-reference. Both call sites must move
 * together if the boundary rule ever changes.
 */

/** 60 minutes expressed in milliseconds — the BR-LOCK-002/003 lock window. */
const LOCK_WINDOW_MS = 60 * 60 * 1000;

/**
 * Coerce the caller's `kickoffUtc` (ISO string or Date) into a Date, or
 * `null` if the input is null/undefined/invalid. Invalid inputs collapse
 * to the safe-default-locked path in the public helpers below.
 */
function coerceKickoff(kickoffUtc: string | Date | null | undefined): Date | null {
  if (kickoffUtc === null || kickoffUtc === undefined) {
    return null;
  }
  const d = kickoffUtc instanceof Date ? kickoffUtc : new Date(kickoffUtc);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d;
}

/**
 * Returns `true` when the prediction window for this match is closed.
 *
 * The comparator: `(kickoffMs - nowMs) <= LOCK_WINDOW_MS`. At EXACTLY
 * 60 minutes remaining, returns `true` (LOCKED). At 60min + 1ms,
 * returns `false` (EDITABLE).
 *
 * Safe defaults: if `kickoffUtc` is null, undefined, or unparseable,
 * returns `true` (locked) — better to block a submit on bad data than
 * let an unbounded prediction sneak through. The RPC will reject it
 * regardless.
 *
 * @param kickoffUtc - ISO 8601 string, Date, null, or undefined.
 * @param nowUtc - Trusted "now" (defaults to `new Date()`). Tests pass
 *                 a fixed Date for determinism.
 */
export function isPredictionLocked(
  kickoffUtc: string | Date | null | undefined,
  nowUtc: Date = new Date(),
): boolean {
  const kickoff = coerceKickoff(kickoffUtc);
  if (kickoff === null) {
    return true; // safe default: locked
  }
  const remainingMs = kickoff.getTime() - nowUtc.getTime();
  return remainingMs <= LOCK_WINDOW_MS;
}

/**
 * Milliseconds remaining until the lock fires. Returns `0` once the
 * lock is engaged (or kickoff is in the past). Drives the countdown UI
 * ("Locks in {hours}h {minutes}m").
 *
 * Formula: `max(0, kickoffMs - LOCK_WINDOW_MS - nowMs)`. When kickoff
 * is exactly 60 min away, this is `0` — the lock fires now. When
 * kickoff is 61 min away, this is `60_000` — one minute until lock.
 *
 * Safe defaults: null/undefined/invalid kickoff returns `0`.
 *
 * @param kickoffUtc - ISO 8601 string, Date, null, or undefined.
 * @param nowUtc - Trusted "now" (defaults to `new Date()`).
 */
export function lockCountdownMs(
  kickoffUtc: string | Date | null | undefined,
  nowUtc: Date = new Date(),
): number {
  const kickoff = coerceKickoff(kickoffUtc);
  if (kickoff === null) {
    return 0;
  }
  return Math.max(0, kickoff.getTime() - LOCK_WINDOW_MS - nowUtc.getTime());
}
