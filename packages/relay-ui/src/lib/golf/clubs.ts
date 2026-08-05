// The club bag for the Golf driving-range mode, as pure data. Each club is
// a launch profile the range physics (lib/golf/range.ts) reads at swing
// time: loft sets the launch angle, baseSpeed the ball speed at full power,
// rollFactor how much forward speed survives the first bounce into roll,
// and backspin how hard the ball then bites (kills roll).
//
// The ladder is tuned against the range's ballistic model
//   carry ≈ baseSpeed^2 * sin(2*loft) / GRAVITY   (GRAVITY defined in range.ts)
// so full-power carries step down sensibly across the 0..400yd range:
// Driver ~260 (huge roll → ~300 total) down to Sand Wedge ~75 (bites, ~80).
// Low-loft/high-speed clubs bomb-and-run; high-loft wedges fly steep and
// stop. baseSpeed falls and loft rises monotonically down the bag.

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
  { id: 'driver', name: 'Driver', loft: 11, baseSpeed: 118, rollFactor: 0.62, backspin: 0.08 },
  { id: '3wood', name: '3-Wood', loft: 14, baseSpeed: 99, rollFactor: 0.52, backspin: 0.16 },
  { id: 'hybrid', name: 'Hybrid', loft: 17, baseSpeed: 87, rollFactor: 0.44, backspin: 0.26 },
  { id: '5iron', name: '5-Iron', loft: 21, baseSpeed: 74, rollFactor: 0.36, backspin: 0.4 },
  { id: '7iron', name: '7-Iron', loft: 26, baseSpeed: 64, rollFactor: 0.28, backspin: 0.55 },
  { id: '9iron', name: '9-Iron', loft: 32, baseSpeed: 54, rollFactor: 0.2, backspin: 0.7 },
  { id: 'pw', name: 'Pitching Wedge', loft: 38, baseSpeed: 47, rollFactor: 0.14, backspin: 0.82 },
  { id: 'sw', name: 'Sand Wedge', loft: 44, baseSpeed: 39, rollFactor: 0.1, backspin: 0.92 },
];

export const DEFAULT_CLUB_ID = 'driver';

export function clubById(id: string): Club {
  return CLUBS.find((c) => c.id === id) ?? CLUBS[0]!;
}
