/**
 * Pure helpers for the Weekly Digest widget (feature 005 US-DC,
 * FR-D11 / FR-D12 / FR-D13).
 *
 * Two functions:
 *   - `startOfCurrentWeekUTC(now)` — anchors the digest window to
 *     Monday 00:00:00 UTC of the ISO week containing `now`. UTC-based
 *     to match the spec's Round 1 "calendar Mon-Sun UTC" decision.
 *   - `computeDigestSummary(events)` — aggregates the caller's
 *     match-scoring `score_events` rows into total / count / best /
 *     worst. Final-prediction events (`match_id === null`) are excluded
 *     per FR-D13.
 *
 * See `contracts/query-weekly-digest.md` for the verbatim spec body.
 */

import type { DigestSummary } from '@/lib/dashboard/types';

/**
 * Returns the UTC `Date` for Monday 00:00:00 of the current ISO week
 * (the week containing `now`).
 *
 * Default argument intentionally creates a fresh `new Date()` at call
 * time — *not* at module load — so server-side rendering reflects the
 * actual request time.
 */
export function startOfCurrentWeekUTC(now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayOfWeek = d.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  const daysSinceMonday = (dayOfWeek + 6) % 7; // 0 if Monday, 6 if Sunday
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}

export type WeeklyEvent = {
  points: number;
  match_id: string | null;
};

/**
 * Aggregate the caller's `score_events` rows for the current week into
 * the digest summary. Final-prediction events (`match_id === null`) are
 * excluded — only per-match scores count toward the weekly digest
 * (FR-D13).
 *
 * Returns `{0, 0, null, null}` when there are no eligible events.
 */
export function computeDigestSummary(events: WeeklyEvent[]): DigestSummary {
  const matchEvents = events.filter((e) => e.match_id !== null);
  if (matchEvents.length === 0) {
    return { totalPoints: 0, matchCount: 0, bestSingleScore: null, worstSingleScore: null };
  }
  const scores = matchEvents.map((e) => e.points);
  return {
    totalPoints: scores.reduce((sum, p) => sum + p, 0),
    matchCount: matchEvents.length,
    bestSingleScore: Math.max(...scores),
    worstSingleScore: Math.min(...scores),
  };
}
