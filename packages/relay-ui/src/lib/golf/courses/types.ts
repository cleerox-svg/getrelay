// The course CONTAINER — a playable round is an ordered list of CourseHoles
// plus derived totals. par and yards are DERIVED from the holes (never hand-
// authored) so the scorecard can never drift from the hole data; see
// defineCourse() in builder.ts.

import type { CourseHole } from '../terrain';

export interface GolfCourse {
  id: string;
  name: string;
  location?: string;
  holes: CourseHole[];
  // DERIVED: par = Σ hole.par, yards = Σ hole.yards. Do not author by hand.
  par: number;
  yards: number;
}
