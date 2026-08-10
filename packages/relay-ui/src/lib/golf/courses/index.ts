// Course registry — the selectable real-world courses for Course mode. Pure data
// + math (no three), so it's safe to import from the menu/route without pulling
// the 3D scene into the main bundle. Each course is authored as CourseHole DATA
// (see augusta.ts / listowel-*.ts) and validated against the terrain.ts
// invariants by courses.test.ts.

import { AUGUSTA } from './augusta';
import { LISTOWEL_VINTAGE } from './listowel-vintage';
import { LISTOWEL_HERITAGE } from './listowel-heritage';
import { LISTOWEL_MILLENNIUM } from './listowel-millennium';
import type { GolfCourse } from './types';

export const GOLF_COURSES: GolfCourse[] = [
  AUGUSTA,
  LISTOWEL_VINTAGE,
  LISTOWEL_HERITAGE,
  LISTOWEL_MILLENNIUM,
];

export const DEFAULT_COURSE_ID = 'augusta';

// Look up a course by id, falling back to the first (Augusta) for an unknown or
// missing id so callers always get a playable course.
export function getCourse(id?: string): GolfCourse {
  return GOLF_COURSES.find((c) => c.id === id) ?? GOLF_COURSES[0]!;
}

export type { GolfCourse } from './types';
export { AUGUSTA } from './augusta';
export { LISTOWEL_VINTAGE } from './listowel-vintage';
export { LISTOWEL_HERITAGE } from './listowel-heritage';
export { LISTOWEL_MILLENNIUM } from './listowel-millennium';
