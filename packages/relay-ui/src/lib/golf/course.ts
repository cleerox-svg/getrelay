// BACK-COMPAT SHIM. The hand-authored 6-flat-hole mini-golf course that used to
// live here has been reauthored — with slope physics, banked rails and a ramp —
// into puttCourses/garden.ts (an 8-hole PuttCourse). This module survives only
// so existing importers (GolfGame.tsx, PuttGL.tsx) keep compiling until the HUD
// slice migrates them onto the PuttCourse registry (puttCourses/index.ts).
//
// A PuttCourse is a structural superset of the old `Course` (it adds `theme` and
// a derived `par`), so `COURSE` still satisfies the old shape. New code should
// import from ./puttCourses, not here.

import type { Hole } from './puttSim';
import { GARDEN } from './puttCourses';

export interface Course {
  id: string;
  name: string;
  holes: Hole[];
}

// The default mini-golf course, re-exported under its historical name.
export const COURSE: Course = GARDEN;
