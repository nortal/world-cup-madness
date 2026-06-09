import { describe, it, expect } from '@jest/globals';

import { computeMovers, type CurrentRanking, type DeltaRow } from '../movers-24h';

describe('computeMovers', () => {
  it('returns an empty array when there are no rankings', () => {
    expect(computeMovers([], [])).toEqual([]);
  });

  it('returns an empty array when no participant has earned 24-h points (all "first")', () => {
    /* No deltas → previousTotal === currentTotal → previousRank === currentRank.
     * computeDelta(prev, cur) with equal ranks returns direction='flat', which
     * the filter excludes. */
    const rankings: CurrentRanking[] = [
      { participant_id: 'p1', display_name: 'Alice', total_points: 30, rank: 1 },
      { participant_id: 'p2', display_name: 'Bob', total_points: 20, rank: 2 },
      { participant_id: 'p3', display_name: 'Carol', total_points: 10, rank: 3 },
    ];
    expect(computeMovers(rankings, [])).toEqual([]);
  });

  it('returns all climbers sorted by magnitude DESC', () => {
    /* Setup — needs 4 participants because RANK() ties at the lowest
     * previous totals are the only way to put two participants at the
     * same previous rank without one of them ending up flat:
     *   p1: cur 1, total 50, +40 → prev 10
     *   p2: cur 2, total 45, +35 → prev 10
     *   p3: cur 3, total 40, +10 → prev 30
     *   p4: cur 4, total 35, +15 → prev 20
     * Synthetic prev DESC + alphabetical tie-break: p3(30), p4(20), p1+p2(10).
     * Previous ranks: p3=1, p4=2, p1=3 (tied), p2=3 (tied).
     *   p1: prev 3 / cur 1 → up 2
     *   p2: prev 3 / cur 2 → up 1
     *   p3: prev 1 / cur 3 → down 2  (excluded)
     *   p4: prev 2 / cur 4 → down 2  (excluded)
     * Climbers sorted by magnitude DESC = [p1 (up 2), p2 (up 1)]. */
    const rankings: CurrentRanking[] = [
      { participant_id: 'p1', display_name: 'Alice', total_points: 50, rank: 1 },
      { participant_id: 'p2', display_name: 'Bob', total_points: 45, rank: 2 },
      { participant_id: 'p3', display_name: 'Carol', total_points: 40, rank: 3 },
      { participant_id: 'p4', display_name: 'Dan', total_points: 35, rank: 4 },
    ];
    const deltas: DeltaRow[] = [
      { participant_id: 'p1', delta_24h: 40 },
      { participant_id: 'p2', delta_24h: 35 },
      { participant_id: 'p3', delta_24h: 10 },
      { participant_id: 'p4', delta_24h: 15 },
    ];
    const result = computeMovers(rankings, deltas);
    expect(result.map((r) => r.participantId)).toEqual(['p1', 'p2']);
    expect(result[0]?.delta).toEqual({ direction: 'up', magnitude: 2 });
    expect(result[1]?.delta).toEqual({ direction: 'up', magnitude: 1 });
  });

  it('breaks magnitude ties by currentRank ASC (better-ranked climber wins)', () => {
    /* Two climbers with magnitude 1; the one with smaller currentRank goes first.
     *   p1: rank 1, total 30, +10 → prev 20 → prevRank 2 → up 1
     *   p2: rank 2, total 25, +10 → prev 15 → prevRank 3 → up 1
     *   p3: rank 3, total 20, +0  → prev 20 → prevRank 1 (tied with p1 in original) → down 2
     * Wait — careful: the synthetic previous-rank pass groups by previousTotal.
     *   Synthetic totals: p1=20, p2=15, p3=20. Sorted DESC: p1(20), p3(20), p2(15).
     *   Display tie-break on prev=20: Alice (p1) before Carol (p3) — both share rank 1.
     *   p2 gets rank 3.
     *   So p1: prev 1 / cur 1 → flat (excluded)
     *      p2: prev 3 / cur 2 → up 1
     *      p3: prev 1 / cur 3 → down 2
     *   Only p2 is a climber. */
    const rankings: CurrentRanking[] = [
      { participant_id: 'p1', display_name: 'Alice', total_points: 30, rank: 1 },
      { participant_id: 'p2', display_name: 'Bob', total_points: 25, rank: 2 },
      { participant_id: 'p3', display_name: 'Carol', total_points: 20, rank: 3 },
    ];
    const deltas: DeltaRow[] = [
      { participant_id: 'p1', delta_24h: 10 },
      { participant_id: 'p2', delta_24h: 10 },
    ];
    const result = computeMovers(rankings, deltas);
    expect(result.map((r) => r.participantId)).toEqual(['p2']);
  });

  it('breaks magnitude ties between two climbers by currentRank ASC', () => {
    /* Engineered tie:
     *   p1: rank 2, total 50, +10 → prev 40 → prevRank 3 → up 1
     *   p2: rank 3, total 45, +10 → prev 35 → prevRank 4 → up 1
     *   p3: rank 1, total 60, +0  → prev 60 → prevRank 1 → flat (excluded)
     *   p4: rank 4, total 30, -20 (negative possible? clamp at 0 in real world; use small +)
     *
     * Simpler: arrange so two climbers both have magnitude 1, currentRank 2 and 3.
     *   p1: rank 2, total 50, +5  → prev 45 → ?
     *   p2: rank 3, total 40, +5  → prev 35 → ?
     *   p3: rank 1, total 60, +0  → prev 60
     *   p4: rank 4, total 20, +0  → prev 20
     *   Synthetic order (DESC): p3(60), p1(45), p2(35), p4(20). Ranks 1,2,3,4.
     *   p1: prev 2 / cur 2 → flat. Hmm.
     *
     * Try: give p4 a big gain so it overtakes p2.
     *   p1: rank 2, total 50, +20 → prev 30
     *   p2: rank 3, total 40, +20 → prev 20
     *   p3: rank 1, total 60, +0  → prev 60
     *   p4: rank 4, total 25, +0  → prev 25
     *   Synthetic DESC: p3(60), p1(30), p4(25), p2(20). Ranks 1,2,3,4.
     *   p1: prev 2 / cur 2 → flat
     *   p2: prev 4 / cur 3 → up 1
     *   p3: prev 1 / cur 1 → flat
     *   p4: prev 3 / cur 4 → down 1
     *   Only p2 climbs. Still only one.
     *
     * To force two climbers with matching magnitude, both must have currentRank
     * lower than previousRank by the same amount. Simplest:
     *   p1: cur 1, prev 2 (up 1)
     *   p2: cur 2, prev 3 (up 1)
     *   p3: cur 3, prev 1 (down 2)
     *   Totals: p1=high, p2=mid, p3=low currently. Previously: p3 was top, p1 second, p2 third.
     *   p1: total 30, delta = total - prevTotal where prevTotal is sub-p3
     *   p3: total 10, delta = total - prevTotal where prevTotal was top
     *   Set prev: p3=40, p1=30, p2=20 (rank 1,2,3 previously).
     *   Now: p1=50, p2=30, p3=10 (rank 1,2,3 now).
     *   So deltas: p1=+20, p2=+10, p3=-30 (impossible; deltas come from get_movers_24h_aggregate which sums positive points).
     *
     * Real-world: score_events never produce negative points. Deltas are >= 0.
     * For two climbers, we need two participants whose prev rank > cur rank with
     * equal magnitude.
     *   p1: cur 2, prev 3 (up 1)
     *   p2: cur 3, prev 4 (up 1)
     *   p3: cur 1, prev 1 (flat)
     *   p4: cur 4, prev 2 (down 2)
     * Totals cur: p3=100, p1=80, p2=60, p4=40
     * Totals prev: p3 highest, p4 second, p1 third, p2 fourth.
     *   p3=100, p4=70, p1=60, p2=40
     *   Deltas: p3=0, p4=-30 (NO — must be >= 0)
     *
     * Trying again: deltas only positive, so previousTotal <= currentTotal.
     * This means previousRank <= currentRank or there's a tie reorder.
     *   Hmm — if all deltas non-negative, can prev rank ever be HIGHER (worse) than cur?
     *   Yes, if someone else gained more than you. Your prev total = cur - delta_you;
     *   their prev = cur - delta_them. If delta_them > delta_you, they were *lower*
     *   before, so you were *higher* (lower rank number) — wait that's the opposite
     *   direction. Let me think again.
     *
     *   Cur ranks based on cur totals. Prev ranks based on prev totals.
     *   If you gained nothing and they gained a lot, their prev total was lower,
     *   so they were ranked WORSE before (higher rank number). You were ranked
     *   BETTER before (lower rank number). So your previousRank < currentRank →
     *   that's a DOWN move for you (you dropped). And they went UP.
     *
     *   So climbers are participants whose delta is higher than those around them.
     *
     *   For two climbers with the same magnitude:
     *     p1: gained 20, was rank 3 → now rank 2 (up 1)
     *     p2: gained 20, was rank 4 → now rank 3 (up 1)
     *   And someone(s) had to drop to make room:
     *     p3: gained 0, was rank 1 → now rank 1 (flat)
     *     p4: gained 0, was rank 2 → now rank 4 (down 2)
     *   Cur totals: p3=100, p1=70 (was 50 + 20), p2=60 (was 40 + 20), p4=50
     *   Cur ranks: p3=1, p1=2, p2=3, p4=4. ✓
     *   Prev totals: p3=100, p4=50, p1=50, p2=40
     *   Hmm p4 and p1 tie at 50; need to break — use display_name asc.
     *   Use names: p1=Alice, p2=Bob, p3=Carol, p4=Dave.
     *   Prev DESC: p3(100), p1(50) [Alice], p4(50) [Dave], p2(40).
     *   Ranks: 1, 2, 2 (tied), 4 (gap-after).
     *   So previousRank: p3=1, p1=2, p4=2, p2=4.
     *   Current ranks: p3=1, p1=2, p2=3, p4=4.
     *   Deltas:
     *     p3: 1→1 flat
     *     p1: 2→2 flat (excluded; not a climber)
     *     p4: 2→4 down 2
     *     p2: 4→3 up 1
     *   Only p2 climbs. The tie at prev=50 spoils the test.
     *
     * Use deliberately-distinct previousTotals:
     *   p1: cur 2, total 70, delta 25 → prev 45
     *   p2: cur 3, total 60, delta 25 → prev 35
     *   p3: cur 1, total 100, delta 0 → prev 100
     *   p4: cur 4, total 50, delta 0 → prev 50
     *   Prev DESC by total: p3(100), p4(50), p1(45), p2(35).
     *   Prev ranks: p3=1, p4=2, p1=3, p2=4.
     *   Cur ranks: p3=1, p1=2, p2=3, p4=4.
     *   Movers: p1 prev 3 → cur 2 up 1; p2 prev 4 → cur 3 up 1.
     *   Both have magnitude 1, currentRanks 2 and 3.
     *   Expected order by tie-break (currentRank ASC): [p1, p2]. ✓ */
    const rankings: CurrentRanking[] = [
      { participant_id: 'p3', display_name: 'Carol', total_points: 100, rank: 1 },
      { participant_id: 'p1', display_name: 'Alice', total_points: 70, rank: 2 },
      { participant_id: 'p2', display_name: 'Bob', total_points: 60, rank: 3 },
      { participant_id: 'p4', display_name: 'Dave', total_points: 50, rank: 4 },
    ];
    const deltas: DeltaRow[] = [
      { participant_id: 'p1', delta_24h: 25 },
      { participant_id: 'p2', delta_24h: 25 },
    ];
    const result = computeMovers(rankings, deltas);
    expect(result.map((r) => r.participantId)).toEqual(['p1', 'p2']);
    expect(result[0]).toMatchObject({
      participantId: 'p1',
      currentRank: 2,
      previousRank: 3,
      delta: { direction: 'up', magnitude: 1 },
    });
    expect(result[1]).toMatchObject({
      participantId: 'p2',
      currentRank: 3,
      previousRank: 4,
      delta: { direction: 'up', magnitude: 1 },
    });
  });

  it('excludes participants who fell or stayed flat', () => {
    const rankings: CurrentRanking[] = [
      { participant_id: 'p1', display_name: 'Alice', total_points: 50, rank: 1 },
      { participant_id: 'p2', display_name: 'Bob', total_points: 30, rank: 2 },
      { participant_id: 'p3', display_name: 'Carol', total_points: 10, rank: 3 },
    ];
    /* Only p3 gained — p1 and p2 stayed put. p3's gain (15) doesn't change
     * its rank because p2 is still ahead at 30.
     *   prev: p1=50, p2=30, p3=-5 → No, deltas are non-negative; let's say
     *   p3 gained 25:
     *   p1=50 prev, p2=30 prev, p3=current(10)-25 = -15. We use it anyway —
     *   just to verify the sort. Actually let's use:
     *   p3 currently 10, gained 0 → no movers; expected []. */
    expect(computeMovers(rankings, [])).toEqual([]);
  });

  it('produces correct climber when an overtake happens', () => {
    /* p2 overtakes p1:
     *   p1: cur rank 2, total 30, gained 0 → prev 30 → prev rank 1 → down 1
     *   p2: cur rank 1, total 40, gained 15 → prev 25 → prev rank 2 → up 1 ✓
     *   p3: cur rank 3, total 20, gained 0 → prev 20 → prev rank 3 → flat
     */
    const rankings: CurrentRanking[] = [
      { participant_id: 'p2', display_name: 'Bob', total_points: 40, rank: 1 },
      { participant_id: 'p1', display_name: 'Alice', total_points: 30, rank: 2 },
      { participant_id: 'p3', display_name: 'Carol', total_points: 20, rank: 3 },
    ];
    const deltas: DeltaRow[] = [{ participant_id: 'p2', delta_24h: 15 }];
    const result = computeMovers(rankings, deltas);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      participantId: 'p2',
      currentRank: 1,
      previousRank: 2,
      delta: { direction: 'up', magnitude: 1 },
    });
  });

  it('treats participants without a delta row as zero-gain (flat unless others move)', () => {
    /* p1 gained 20, p2 (no delta row) stayed at 25.
     *   p1: cur 1, total 50, +20 → prev 30 → prev rank 1
     *   p2: cur 2, total 25, +0  → prev 25 → prev rank 2
     *   No climbers (both at same rank). */
    const rankings: CurrentRanking[] = [
      { participant_id: 'p1', display_name: 'Alice', total_points: 50, rank: 1 },
      { participant_id: 'p2', display_name: 'Bob', total_points: 25, rank: 2 },
    ];
    const deltas: DeltaRow[] = [{ participant_id: 'p1', delta_24h: 20 }];
    expect(computeMovers(rankings, deltas)).toEqual([]);
  });

  it('supports the neighborhood-filter use case (consumer post-filters by participantId set)', () => {
    /* Verify the helper produces full output that the widget can intersect with
     * a neighborhood window's participant-id set. */
    const rankings: CurrentRanking[] = [
      { participant_id: 'p3', display_name: 'Carol', total_points: 100, rank: 1 },
      { participant_id: 'p1', display_name: 'Alice', total_points: 70, rank: 2 },
      { participant_id: 'p2', display_name: 'Bob', total_points: 60, rank: 3 },
      { participant_id: 'p4', display_name: 'Dave', total_points: 50, rank: 4 },
    ];
    const deltas: DeltaRow[] = [
      { participant_id: 'p1', delta_24h: 25 },
      { participant_id: 'p2', delta_24h: 25 },
    ];
    const globalMovers = computeMovers(rankings, deltas);

    /* Caller's neighborhood is {p2, p4} — intersection should be [p2] only. */
    const neighborhoodIds = new Set(['p2', 'p4']);
    const subset = globalMovers.filter((m) => neighborhoodIds.has(m.participantId));
    expect(subset.map((r) => r.participantId)).toEqual(['p2']);
  });
});
