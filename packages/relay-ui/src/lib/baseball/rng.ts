// The SNAPSHOTTABLE seeded stream — one implementation, shared by every baseball
// game mode.
//
// `mulberry32` (lib/golf/wind.ts, three-free) returns a closure over a hidden
// counter, and a hidden counter cannot go in a snapshot. But its state after k
// calls is exactly `seed + k·STEP`, so the stream can be carried as a plain
// number on the sim instead. That is what makes `snapshot()` TOTAL: there is no
// generator object anywhere in the sim, only an integer.
//
// ⚠ EXTRACTED FROM `derbyRules.ts` WHEN THE DUEL LANDED, and extracted rather
// than copied. Two three-line `draw(state)` functions in two sibling game modes
// is precisely the "one implementation per concept" rule failing quietly: they
// would agree today and drift the first time either mode wanted a different
// mixer. `derbyRules.derbyDraw` now delegates here and keeps its name, so not
// one call site or test moved.
//
// ⚠ STEP IS AN UPSTREAM COUPLING and is pinned by a TRIPWIRE test that compares
// six draws of this against six calls of golf's own generator. If `wind.ts`
// changes its mixer, that test fails here rather than silently re-shaping every
// derby session and every duel.

import { mulberry32 } from '../golf/wind';

/**
 * mulberry32's per-call state increment. FIXED — it is `wind.ts`'s constant,
 * duplicated here as the price of carrying the state as a number, and the
 * tripwire test is what stops the duplicate rotting.
 */
export const MULBERRY_STEP = 0x6d2b79f5;

/** One draw plus the next stream state. Pure — no hidden counter. */
export function simDraw(state: number): { value: number; next: number } {
  return { value: mulberry32(state)(), next: (state + MULBERRY_STEP) >>> 0 };
}
