// A RATCHET on the size of `components/golf`.
//
// WHY A RATCHET AND NOT A CAP. `lib/baseball/budget.test.ts` can afford a flat
// 700-line cap because it was written before the code existed. Golf was not:
// `CourseGL.tsx` is 2,673 lines, and a flat cap here would fail on the first run
// and get deleted by the next person who needed to ship something. So every file
// over the cap is grandfathered at the size it is TODAY and may only ever shrink,
// while every new file gets the real cap.
//
// That is the behaviour we actually want. The point is not to retroactively
// punish the big components; it is to stop them growing, and to force the
// fidelity work that follows into `components/golf/scene/` where the 500-line
// cap applies. `CourseGL.tsx` reached 2,673 lines precisely because nothing was
// watching — `budget.test.ts` guarded only `lib/baseball`, so golf, the larger
// and actually-shipped game, was unguarded.
//
// ⚠ SCOPE. This scans `components/golf` ONLY. It must never walk a baseball
// path: baseball is being built in a parallel session, and an assertion here
// firing on their file would be a failure they cannot act on and have no context
// for. Same rule as `lib/scene3d/budget.test.ts`.
//
// WHEN A GRANDFATHERED FILE SHRINKS, LOWER ITS NUMBER in the same change. The
// ratchet only tightens if someone tightens it; leaving slack in the table hands
// the reclaimed lines back.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname);

/** The cap every NEW file must meet. Matches `lib/scene3d` and `stadium/*`. */
const CAP = 500;

/**
 * Files that predate the cap, pinned at their current size. These may only go
 * DOWN. Do not add to this table — a new entry means a new oversized file, which
 * is the thing the cap exists to prevent.
 */
const GRANDFATHERED: Record<string, number> = {
  'CourseGL.tsx': 2664,
  'RangeGL.tsx': 1461,
  'PuttGL.tsx': 1226,
  // 1002 → 874: the scorecard rendering moved out to CourseScorecard.tsx (shared
  // with the new CoursePauseSheet), which is what paid for the pause + partial
  // -round-banking wiring. Banked per this file's own rule, NOT raised.
  'CourseGame.tsx': 874,
  'RangeGame.tsx': 894,
  // 796 → 751: the two results screens were the SAME 77 lines twice, differing in
  // five values, and became GolfResultScreen.tsx. That paid for the guarded-free
  // opt-in + pause wiring and still banked 45 lines. Banked, NOT raised.
  // 751 → 738: the three board-submit sites collapsed onto one durable channel
  // in useBoardSubmit.ts (persist-before-POST + retry), which also took
  // serverBest/lbKey with it. Banked.
  // 738 → 732: the resolved-cosmetics memo became useGolfCosmetics() in
  // economy.ts, so the in-chat ChallengeCard could share it instead of running
  // a golf round with no skin at all. Banked.
  'GolfScreen.tsx': 732,
  'GolfMenu.tsx': 621,
  'GolfGame.tsx': 508,
};

function sourceFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const relPath = rel ? `${rel}/${entry}` : entry;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, relPath));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.test.ts') && !entry.endsWith('.test.tsx')) {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * Lines, counted the way `wc -l` counts them, so the numbers in GRANDFATHERED
 * match what you get from the shell. A trailing newline does not add a line.
 */
function lineCount(rel: string): number {
  const parts = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

describe('components/golf — size ratchet', () => {
  it('keeps every non-grandfathered file under the cap', () => {
    const over = sourceFiles(ROOT)
      .filter((f) => !(f in GRANDFATHERED))
      .map((f) => [f, lineCount(f)] as const)
      .filter(([, n]) => n > CAP);

    expect(
      over,
      `over the ${CAP}-line cap — EXTRACT into a new module, do not raise the cap ` +
        `or add a GRANDFATHERED entry: ${JSON.stringify(over)}`,
    ).toEqual([]);
  });

  it('never lets a grandfathered file grow', () => {
    const grown = Object.entries(GRANDFATHERED)
      .map(([f, limit]) => ({ file: f, limit, now: lineCount(f) }))
      .filter((r) => r.now > r.limit);

    expect(
      grown,
      'these files may only SHRINK. New golf scene work belongs in ' +
        `components/golf/scene/ (${CAP}-line cap), not bolted onto a component ` +
        `that is already too big: ${JSON.stringify(grown)}`,
    ).toEqual([]);
  });

  it('has no stale grandfathered entry', () => {
    // A pinned file that no longer exists, or that has been renamed, would
    // silently stop being checked.
    const missing = Object.keys(GRANDFATHERED).filter((f) => !sourceFiles(ROOT).includes(f));
    expect(missing, `grandfathered file no longer exists — drop the entry: ${missing.join(', ')}`).toEqual([]);
  });

  it('reports any grandfathered file that has shrunk, so the ratchet tightens', () => {
    // Not a failure: shrinking is the goal. But the reclaimed lines have to be
    // BANKED by lowering the number, or the file is free to grow back to its old
    // size later and the ratchet quietly did nothing.
    const slack = Object.entries(GRANDFATHERED)
      .map(([f, limit]) => ({ file: f, limit, now: lineCount(f), reclaimed: limit - lineCount(f) }))
      .filter((r) => r.reclaimed >= 25);

    expect(
      slack,
      'these shrank by 25+ lines — LOWER their GRANDFATHERED numbers to bank it: ' +
        JSON.stringify(slack),
    ).toEqual([]);
  });
});
