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
const STADIUM_DIR = join(COMPONENT_DIR, 'stadium');
const SHARED_DIR = join(COMPONENT_DIR, 'shared');

/** Line caps, per the baseball charter. Tests are exempt — see below. */
const LIB_CAP = 500;
const COMPONENT_CAP = 700;
const STADIUM_GL_CAP = 900;
/**
 * The `stadium/*` scene builders. Same 500 as a lib module, and for the same
 * reason: a builder is a single-purpose `(ctx) => handle` function, and one that
 * needs 500 lines is two builders. This cap is what stops `StadiumGL.tsx`'s
 * 900-line allowance being met by moving the monolith one directory down.
 */
const BUILDER_CAP = 500;

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

  it(`components/baseball: ${COMPONENT_CAP} lines, StadiumGL ${STADIUM_GL_CAP}, builders ${BUILDER_CAP}`, () => {
    // The cap was written before the first component existed, so that
    // StadiumGL.tsx was composed against a number rather than measured against
    // one after the fact. It is deliberately not a no-op waiting to be
    // forgotten: the moment a .tsx lands here it is capped.
    // Tests are exempt here for the same reason they are in the lib scan above:
    // a test file's length is its printed evidence, and shipping code is what
    // has to be re-read to change anything. `DerbyGame.test.tsx` is the fixture
    // proof and is mostly the argument for each assertion.
    const ship = (n: string) => !/\.test\.tsx?$/.test(n);
    const rows = [
      ...filesIn(COMPONENT_DIR, (n) => ship(n) && (n.endsWith('.tsx') || n.endsWith('.ts'))).map((n) => ({
        n,
        lines: lineCount(join(COMPONENT_DIR, n)),
        cap: n === 'StadiumGL.tsx' ? STADIUM_GL_CAP : COMPONENT_CAP,
      })),
      ...filesIn(STADIUM_DIR, (n) => n.endsWith('.ts') || n.endsWith('.tsx')).map((n) => ({
        n: `stadium/${n}`,
        lines: lineCount(join(STADIUM_DIR, n)),
        cap: BUILDER_CAP,
      })),
      // The HUD widgets. A widget is one readout; `COMPONENT_CAP` is generous
      // for one and that is deliberate — the number that matters here is that
      // nothing in `shared/` is allowed to quietly become a second HUD.
      ...filesIn(SHARED_DIR, (n) => n.endsWith('.ts') || n.endsWith('.tsx')).map((n) => ({
        n: `shared/${n}`,
        lines: lineCount(join(SHARED_DIR, n)),
        cap: COMPONENT_CAP,
      })),
    ].sort((a, b) => b.lines - a.lines);

    if (rows.length) {
      // eslint-disable-next-line no-console
      console.log(
        '\n[BUDGET — components/baseball]\n' +
          rows
            .map(
              (r) =>
                `  ${String(r.lines).padStart(4)}  ${((r.lines / r.cap) * 100)
                  .toFixed(0)
                  .padStart(3)} %  ${r.n}  (cap ${r.cap})`,
            )
            .join('\n') +
          '\n  StadiumGL is a COMPOSER: renderer, cameras, loop. Geometry lives in stadium/*.\n',
      );
    }

    const over = rows.filter((r) => r.lines > r.cap);
    expect(over.map((r) => `${r.n} is ${r.lines} lines (cap ${r.cap})`)).toEqual([]);
  });

  it('only StadiumGL and its stadium/* builders may import three', () => {
    // The lazy boundary, asserted rather than intended. `three` is a 560 kB
    // chunk; one import of a stadium builder from a HUD component would drag it
    // into whatever chunk that HUD lands in. The allowed set is exactly the
    // scene: StadiumGL.tsx as the composer, and the builders it composes.
    //
    // ⚠ GUARD THE GUARD, AND HERE THAT IS NOT A FORMALITY. Today
    // `components/baseball/` holds exactly `StadiumGL.tsx` plus `stadium/*`, all
    // of which are allowed — so the scan below inspects ZERO files and passes
    // vacuously. It does bite the moment a non-allowed file lands, which is the
    // case it exists for, but a vacuous pass and a real pass are the same green
    // tick, and a broken glob would look identical for the rest of the project.
    // So assert the SET the scan is walking, not just its verdict: the two
    // directories must be found, the allowed files must be present, and the
    // scanned set must be exactly `everything − allowed`.
    const seen: string[] = [];
    const offenders: string[] = [];
    const scan = (dir: string, prefix: string, allowed: (n: string) => boolean) => {
      for (const name of filesIn(dir, (n) => n.endsWith('.ts') || n.endsWith('.tsx'))) {
        seen.push(`${prefix}${name}`);
        if (allowed(name)) continue;
        const text = readFileSync(join(dir, name), 'utf8');
        text.split('\n').forEach((line, i) => {
          if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
          if (/\bfrom\s+['"]three(\/|['"])/.test(line)) {
            offenders.push(`${prefix}${name}:${i + 1}  ${line.trim()}`);
          }
        });
      }
    };
    scan(COMPONENT_DIR, '', (n) => n === 'StadiumGL.tsx');
    scan(STADIUM_DIR, 'stadium/', () => true);
    // ⚠ THE SCAN IS NO LONGER VACUOUS. `DerbyGame.tsx`, `BaseballScreen.tsx` and
    // every `shared/*` widget are now real files with `three` forbidden in them,
    // and they are the ones that would put the renderer in the entry chunk: the
    // HUD is imported eagerly by the Games hub, so ONE `import { Vector3 } from
    // 'three'` in a timing bar undoes the whole lazy boundary and nothing but
    // this test would say so.
    scan(SHARED_DIR, 'shared/', () => false);
    expect(seen, 'the three-import scan found no files — the glob is broken').toContain(
      'StadiumGL.tsx',
    );
    expect(seen).toContain('stadium/fence.ts');
    expect(seen).toContain('DerbyGame.tsx');
    expect(seen).toContain('shared/TimingBar.tsx');
    expect(seen.length).toBeGreaterThan(5);
    expect(offenders, `three imported outside the scene:\n${offenders.join('\n')}`).toEqual([]);

    // And prove the comparison bites, since the live set currently cannot: the
    // allowed predicate must reject a sibling component, not wave everything
    // through. `budget.test.ts` itself is a file in neither directory.
    const allowedInComponents = (n: string) => n === 'StadiumGL.tsx';
    expect(allowedInComponents('StadiumGL.tsx')).toBe(true);
    expect(allowedInComponents('DerbyGame.tsx')).toBe(false);
  });
});
