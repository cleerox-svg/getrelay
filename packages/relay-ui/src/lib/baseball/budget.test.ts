// Mechanical guard: the ANTI-BLOAT rules, enforced instead of intended.
//
// Golf works and sprawled — `CourseGL.tsx` is 2630 lines, and it got there one
// reasonable-looking hundred at a time, because nothing ever said no. Baseball
// says no here. Four sim modules is early to add this, and early is the point:
// a cap added at 480 lines is a design constraint, a cap added at 2600 is an
// apology.
//
// ⚠ AT THE CAP THE FIX IS EXTRACTION, NOT A RAISED CAP. If a number below has to
// move, it moves with a comment saying what was extracted first and why the
// remainder genuinely belongs together. `airPhysics.ts` at 440 lines is the one
// to watch: when stage 3's batted ball needs more of it, the answer is a second
// module beside it, not a 600-line integrator.

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIM_DIR = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(SIM_DIR, '..', '..');
const COMPONENT_DIR = join(UI_SRC, 'components', 'baseball');

/** Line caps, per the baseball charter. Tests are exempt — see below. */
const LIB_CAP = 500;
const COMPONENT_CAP = 700;
const STADIUM_GL_CAP = 900;

/**
 * Tests are EXEMPT from the line cap, deliberately. A test file's length is
 * mostly printed tables and the reasoning behind each assertion, and both of
 * those are the deliverable — `airPhysics.test.ts` is 657 lines and every one of
 * them is evidence. Shipping code is what has to stay small, because shipping
 * code is what has to be re-read to change anything.
 */
const isShipping = (name: string) => name.endsWith('.ts') && !name.endsWith('.test.ts');

const lineCount = (path: string) => readFileSync(path, 'utf8').split('\n').length;

function filesIn(dir: string, match: (n: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => match(n) && statSync(join(dir, n)).isFile())
    .sort();
}

describe('budget guard', () => {
  it(`no lib/baseball module exceeds ${LIB_CAP} lines`, () => {
    const names = filesIn(SIM_DIR, isShipping);
    // Guard the guard: a glob that stops matching must not "pass" over nothing.
    expect(names).toContain('airPhysics.ts');
    expect(names.length).toBeGreaterThan(3);

    const rows = names
      .map((n) => ({ n, lines: lineCount(join(SIM_DIR, n)) }))
      .sort((a, b) => b.lines - a.lines);
    // eslint-disable-next-line no-console
    console.log(
      `\n[BUDGET — lib/baseball shipping modules, cap ${LIB_CAP}]\n` +
        rows
          .map(
            (r) =>
              `  ${String(r.lines).padStart(4)}  ${((r.lines / LIB_CAP) * 100)
                .toFixed(0)
                .padStart(3)} %  ${r.n}`,
          )
          .join('\n') +
        '\n  At the cap the fix is EXTRACTION. Raising one needs a comment saying why.\n',
    );

    const over = rows.filter((r) => r.lines > LIB_CAP);
    expect(over.map((r) => `${r.n} is ${r.lines} lines`)).toEqual([]);
  });

  it('no lib/baseball module imports three, and there is no barrel index', () => {
    // Rule 8 of the charter, and the reason `three` can stay a lazy chunk at all:
    // the sim is pure ft-s-slug arithmetic and must be importable by the worker
    // mirror, the tests and the HUD without dragging a renderer behind it. A
    // single stray `import { Vector3 } from 'three'` in zone.ts would put the
    // whole library in the main entry chunk, and nothing else would complain.
    const violations: string[] = [];
    for (const name of filesIn(SIM_DIR, (n) => n.endsWith('.ts'))) {
      const text = readFileSync(join(SIM_DIR, name), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (/\bfrom\s+['"]three(\/|['"])/.test(line) || /\brequire\(['"]three['"]\)/.test(line)) {
          violations.push(`${name}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(violations, `three leaked into the sim:\n${violations.join('\n')}`).toEqual([]);

    // Barrel files defeat tree-shaking: one import of `zone.ts` through an
    // index would pull `pitchSim`, `battedBallSim` and everything they touch
    // into the same chunk. Named exports from the module itself, always.
    expect(filesIn(SIM_DIR, (n) => n === 'index.ts')).toEqual([]);
  });

  it('the guard catches a file over the cap', () => {
    // A guard nobody has watched fail is not a guard — same discipline as
    // determinism.test.ts's self-check. Prove the comparison bites without
    // having to write a 501-line file to prove it.
    const pretend = [
      { n: 'ok.ts', lines: LIB_CAP },
      { n: 'bloated.ts', lines: LIB_CAP + 1 },
    ];
    expect(pretend.filter((r) => r.lines > LIB_CAP).map((r) => r.n)).toEqual(['bloated.ts']);
    expect(isShipping('pitchSim.ts')).toBe(true);
    expect(isShipping('pitchSim.test.ts')).toBe(false);
  });

  it(`components/baseball: ${COMPONENT_CAP} lines, StadiumGL ${STADIUM_GL_CAP}`, () => {
    // Stage 4 fills this directory. The cap is written NOW, before the first
    // component exists, so that StadiumGL.tsx is composed against a number
    // rather than measured against one after the fact. It is deliberately not a
    // no-op waiting to be forgotten: the moment a .tsx lands here it is capped.
    const names = filesIn(COMPONENT_DIR, (n) => n.endsWith('.tsx') || n.endsWith('.ts'));
    const over = names
      .map((n) => ({
        n,
        lines: lineCount(join(COMPONENT_DIR, n)),
        cap: n === 'StadiumGL.tsx' ? STADIUM_GL_CAP : COMPONENT_CAP,
      }))
      .filter((r) => r.lines > r.cap);
    expect(over.map((r) => `${r.n} is ${r.lines} lines (cap ${r.cap})`)).toEqual([]);
  });
});
