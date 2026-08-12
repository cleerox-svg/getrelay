// The mini-golf course CONTAINER — a playable round is an ordered list of Holes
// (≤ 8, the worker's rounds clamp) plus a DERIVED par. par is Σ hole.par, never
// hand-authored, so the scorecard can never drift from the hole data; see
// definePuttCourse() in builder.ts. Mirrors courses/types.ts (Course mode).

import type { Hole } from '../puttSim';

export interface PuttCourse {
  id: string;
  name: string;
  theme: string;
  holes: Hole[];
  // DERIVED: par = Σ hole.par. Do not author by hand.
  par: number;
}
