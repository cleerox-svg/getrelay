// Island / pin layout for the driving range, plus a deterministic target
// spawner for the Target Challenge.
//
// Islands poke out of the water hazard (100..390yd); a couple of pins also
// sit on the near grass (<100yd) and the back grass lip (390..400yd). Every
// pin is a landing target: an island (grass patch with a flag) or a plain
// grass pin. Coordinates are world-space (d = downrange yards, x = lateral
// yards, +right). Radius is the grass patch / catch radius in yards.

import { RANGE_YD } from './projection';

export type PinKind = 'grass' | 'island' | 'lip';

export interface Pin {
  id: string;
  // Island / patch centre in world space; the flag sits here.
  d: number;
  x: number;
  // Grass-patch radius in yards (also the "on the island" catch radius).
  r: number;
  kind: PinKind;
}

// Grass 0..100, water 100..390, lip+fence 390..400.
export const GRASS_END = 100;
export const WATER_END = 390;

// Hand-placed layout, staggered in depth and side so the challenge never
// spawns two pins on top of each other and the perspective reads cleanly.
export const PINS: Pin[] = [
  // Near grass pins (short, safe targets).
  { id: 'g1', d: 55, x: -16, r: 7, kind: 'grass' },
  { id: 'g2', d: 82, x: 14, r: 6.5, kind: 'grass' },
  // Water islands, far → they get small in perspective.
  { id: 'i1', d: 130, x: 18, r: 9, kind: 'island' },
  { id: 'i2', d: 165, x: -14, r: 8, kind: 'island' },
  { id: 'i3', d: 205, x: 8, r: 7.5, kind: 'island' },
  { id: 'i4', d: 245, x: -20, r: 7, kind: 'island' },
  { id: 'i5', d: 285, x: 16, r: 6.5, kind: 'island' },
  { id: 'i6', d: 330, x: -8, r: 6, kind: 'island' },
  { id: 'i7', d: 365, x: 10, r: 5.5, kind: 'island' },
  // Back grass lip pin (carry-the-hazard hero target).
  { id: 'l1', d: 396, x: 0, r: 6, kind: 'lip' },
];

// Is a world point on solid ground (grass, an island patch, or the back
// lip) rather than in the water? The range physics calls this to decide
// bounce-vs-splash at the landing point.
export function surfaceAt(d: number, x: number): 'grass' | 'island' | 'water' | 'fence' {
  if (d >= RANGE_YD) return 'fence';
  if (d < GRASS_END) return 'grass';
  if (d > WATER_END) return 'grass'; // back lip is grass
  for (const p of PINS) {
    if (p.kind !== 'island') continue;
    const dd = d - p.d;
    const dx = x - p.x;
    if (dd * dd + dx * dx <= p.r * p.r) return 'island';
  }
  return 'water';
}

// Small deterministic PRNG (mulberry32) so a given (seed, shotIndex) always
// spawns the same target — handy for reproducible challenges and tests.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick the Target Challenge pin for a given shot. Varies by shot index (and
// optional seed); avoids repeating the immediately previous pin so back-to-
// back shots always change target.
export function spawnTarget(shotIndex: number, seed = 1, prevId?: string): Pin {
  const r = rng(seed * 1000 + shotIndex * 7 + 13);
  let pool = PINS;
  if (prevId) pool = PINS.filter((p) => p.id !== prevId);
  if (pool.length === 0) pool = PINS;
  const pick = pool[Math.floor(r() * pool.length)] ?? PINS[0]!;
  return pick;
}
