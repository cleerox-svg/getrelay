// The GROUND LAYER STACK — the one place that says how high off the apron each
// coplanar playing surface is drawn.
//
// ⚠ EXTRACTED FROM `field.ts`, NOT COPIED, AND THE 500-LINE CAP IS WHAT ASKED
// THE QUESTION. It lived as a private `Y` in `field.ts` while `field.ts` was the
// only thing that drew ground. `stadium/figures.ts` then had to stand eleven
// people ON that ground — a fielder's feet must sit on the layer his own
// surface was drawn at, or he floats over the dirt and sinks into the grass —
// and exporting it put `field.ts` exactly on its cap. At the cap the fix is
// extraction, so here it is: one stack, two consumers, and neither reaching
// through the other.
//
// ⚠ Z-FIGHTING, NOT DESIGN. These are all "the ground" and they are all flat;
// the offsets exist only so the depth buffer can order them. The gaps are
// 0.06 ft rather than the 0.02 they started at because the `wide` camera reads
// them from 1200 ft — even so the real fix was the per-mode near plane in
// StadiumGL, and this only buys margin.
//
// No three, no data: six numbers and nothing that reads them.

export const GROUND_Y = {
  apron: 0,
  grass: 0.06,
  track: 0.12,
  dirt: 0.18,
  chalk: 0.24,
  plate: 0.3,
} as const;
