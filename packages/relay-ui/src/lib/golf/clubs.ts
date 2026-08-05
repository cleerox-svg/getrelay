// The club bag for the Golf driving-range mode, as pure data. Each club is
// a launch profile the range physics (lib/golf/rangeSim.ts) reads at swing
// time: loft sets the launch angle, baseSpeed the ball speed at full power,
// rollFactor how much forward speed survives the first bounce into roll,
// and backspin how hard the ball then bites (kills roll).
//
// The ladder is tuned against rangeSim's forgiving ballistic model
// (GRAVITY=16, AIR_DRAG=0.996, POWER_FLOOR=0.35). FULL-POWER (power=1)
// carry/total, verified by replaying swing()+the flight/roll integration at
// neutral spin (±1yd):
//   Driver 271/325, 3-Wood 247/290, Hybrid 229/264, 5-Iron 206/234,
//   7-Iron 180/207, 9-Iron 155/175, PW 131/146, SW 103/115  (carry/total yд).
// The bag was bumped up from the old ceiling so a full-power driver bombs
// ~270-275 carry / ~325 total (was ~265/318) — and, crucially, the pull now
// reaches a true 100% (see rangeSim/RangeGL maxPull). Low-loft/high-speed
// clubs bomb-and-run; high-loft wedges fly steep and check up. baseSpeed falls
// and loft rises monotonically down the bag; rollFactor/backspin are unchanged
// so the run-vs-bite feel is identical, just longer.

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
  { id: 'driver', name: 'Driver', loft: 10.5, baseSpeed: 136, rollFactor: 0.62, backspin: 0.08 },
  { id: '3wood', name: '3-Wood', loft: 13, baseSpeed: 119, rollFactor: 0.52, backspin: 0.16 },
  { id: 'hybrid', name: 'Hybrid', loft: 16, baseSpeed: 106, rollFactor: 0.44, backspin: 0.26 },
  { id: '5iron', name: '5-Iron', loft: 20, baseSpeed: 93, rollFactor: 0.36, backspin: 0.4 },
  { id: '7iron', name: '7-Iron', loft: 25, baseSpeed: 81, rollFactor: 0.28, backspin: 0.55 },
  { id: '9iron', name: '9-Iron', loft: 31, baseSpeed: 71, rollFactor: 0.2, backspin: 0.7 },
  { id: 'pw', name: 'Pitching Wedge', loft: 37, baseSpeed: 63, rollFactor: 0.14, backspin: 0.82 },
  { id: 'sw', name: 'Sand Wedge', loft: 44, baseSpeed: 55, rollFactor: 0.1, backspin: 0.92 },
];

export const DEFAULT_CLUB_ID = 'driver';

export function clubById(id: string): Club {
  return CLUBS.find((c) => c.id === id) ?? CLUBS[0]!;
}
