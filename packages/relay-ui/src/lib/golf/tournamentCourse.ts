// Rapid Tournament course synthesis — turns a tournament's 3 hole references
// (each a real Course-mode course id + a 1-based hole number, possibly spanning
// DIFFERENT source courses) into ONE playable 3-hole GolfCourse, with ZERO
// engine changes. CourseSim is hole-agnostic, so a hole authored for Augusta
// plays identically inside a synthesized container. The holes are re-id'd 1..3
// so the round scorecard reads "Hole 1/2/3" (and its per-hole keys stay unique)
// regardless of the source holes' authored ids.
//
// Pure data + math (no `three`) — safe to import from the Tournaments HUD and
// GolfScreen without pulling the 3D scene into the main bundle.

import { getCourse } from './courses';
import type { GolfCourse } from './courses';
import { defineCourse } from './courses/builder';
import type { TournamentHoleRef } from '../types';

// Build the synthesized 3-hole tournament course. Each ref's `hole` is 1-based
// within its source course, so it maps to `holes[hole-1]`; an out-of-range ref
// (older app / newer course data) falls back to that course's first hole so the
// round is always playable. Returns null only if there are no holes to build.
export function synthTournamentCourse(
  tournamentId: number,
  refs: TournamentHoleRef[],
): GolfCourse | null {
  if (!refs.length) return null;
  const holes = refs.map((ref, i) => {
    const src = getCourse(ref.course);
    const h = src.holes[ref.hole - 1] ?? src.holes[0]!;
    // Re-id to the round position (1-based) so the scorecard + hole heading read
    // Hole 1/2/3 and ScoreRow keys are unique even if two refs share an id.
    return { ...h, id: i + 1 };
  });
  return defineCourse({ id: `rt-${tournamentId}`, name: 'Tournament' }, holes);
}
