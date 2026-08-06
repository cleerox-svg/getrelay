// The club bag for the Golf driving-range mode, as pure data. Each club is
// a launch profile the range physics (lib/golf/rangeSim.ts) reads at swing
// time: loft sets the launch angle, baseSpeed the ball speed at full power,
// rollFactor how much forward speed survives the first bounce into roll,
// and backspin how hard the ball then bites (kills roll).
//
// The ladder is tuned against rangeSim's forgiving ballistic model
// (GRAVITY=16, AIR_DRAG=0.996, POWER_FLOOR=0.35), MEASURED end-to-end by the
// headless harness (rangeSim.test.ts) which drives the real swing()+flight+roll
// integration to rest on the grass fairway causeway (rangeTargets FAIRWAY_HALF_W)
// at neutral spin. FULL-POWER (power=1) carry/total (yд):
//   Driver 291/348, 3-Wood 260/305, Hybrid 243/279, 5-Iron 217/245,
//   7-Iron 191/218, 9-Iron 165/186, PW 137/153, SW 109/121.
// The bag was bumped so a full-power driver bombs ~290 carry / ~350 total (was
// ~271/325): online shots now land on the fairway and RUN OUT rather than
// splashing at their carry. Low-loft/high-speed clubs bomb-and-run; high-loft
// wedges fly steep and check up. baseSpeed falls and loft rises monotonically
// down the bag; rollFactor/backspin are unchanged so the run-vs-bite feel is
// identical, just longer. Re-run `pnpm --filter @relay/ui test` after any edit
// here — the harness prints this table and asserts the ladder/target invariants.

export interface Club {
  id: string;
  name: string;
  // Launch angle off the tee, degrees above horizontal.
  loft: number;
  // Ball speed at full power (power = 1), yards/second.
  baseSpeed: number;
  // Fraction of horizontal speed retained through the first ground contact
  // into the roll phase (1 = no loss, 0 = plugs on impact).
  rollFactor: number;
  // 0..1 bite: extra roll friction. Driver barely bites and runs out;
  // wedges bite hard and check up near where they land.
  backspin: number;
}

// Ordered longest → shortest, which is also the natural bag order.
export const CLUBS: Club[] = [
  { id: 'driver', name: 'Driver', loft: 10.5, baseSpeed: 142, rollFactor: 0.62, backspin: 0.08 },
  { id: '3wood', name: '3-Wood', loft: 13, baseSpeed: 123, rollFactor: 0.52, backspin: 0.16 },
  { id: 'hybrid', name: 'Hybrid', loft: 16, baseSpeed: 110, rollFactor: 0.44, backspin: 0.26 },
  { id: '5iron', name: '5-Iron', loft: 20, baseSpeed: 96, rollFactor: 0.36, backspin: 0.4 },
  { id: '7iron', name: '7-Iron', loft: 25, baseSpeed: 84, rollFactor: 0.28, backspin: 0.55 },
  { id: '9iron', name: '9-Iron', loft: 31, baseSpeed: 74, rollFactor: 0.2, backspin: 0.7 },
  { id: 'pw', name: 'Pitching Wedge', loft: 37, baseSpeed: 65, rollFactor: 0.14, backspin: 0.82 },
  { id: 'sw', name: 'Sand Wedge', loft: 44, baseSpeed: 57, rollFactor: 0.1, backspin: 0.92 },
];

export const DEFAULT_CLUB_ID = 'driver';

export function clubById(id: string): Club {
  return CLUBS.find((c) => c.id === id) ?? CLUBS[0]!;
}
