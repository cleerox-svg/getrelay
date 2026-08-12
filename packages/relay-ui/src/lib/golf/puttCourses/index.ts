// Mini-golf course registry — the selectable themed short courses for Mini-Golf
// mode. Pure DATA + math (no three), so it's safe to import from the menu/HUD
// without pulling the 3D PuttGL scene into the main bundle (mirrors
// courses/index.ts). Each course is authored as Hole DATA (see garden.ts) and
// validated against the puttSim/puttField invariants by puttCourses.test.ts.

import { GARDEN } from './garden';
import type { PuttCourse } from './types';

export const PUTT_COURSES: PuttCourse[] = [GARDEN];

export const DEFAULT_PUTT_COURSE_ID = 'garden';

// Look up a course by id, falling back to the first (Garden) for an unknown or
// missing id so callers always get a playable course.
export function getPuttCourse(id?: string): PuttCourse {
  return PUTT_COURSES.find((c) => c.id === id) ?? PUTT_COURSES[0]!;
}

export type { PuttCourse } from './types';
export { GARDEN } from './garden';
