// Mechanical guard: the baseball sim is DETERMINISTIC, and this test is what
// makes that a fact rather than an intention.
//
// BASEBALL.md asserts in the present tense that "no `Math.random`, no wall clock
// in any sim file — seeded `mulberry32` only". A doc sentence is not a guard, so
// this reads the sources and fails on the forbidden tokens. Two reasons it
// matters more here than in most code: the AI's `predict()` must replay the
// SAME trajectory the renderer draws, and the screenshot harness must reproduce
// a pitch byte-for-byte on a machine that is not this one.
//
// Randomness is allowed — it just has to come from a seeded `mulberry32`
// (`lib/golf/wind.ts`, three-free), threaded through sim state, so a replay of
// the same seed is the same game.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIM_DIR = dirname(fileURLToPath(import.meta.url));

// ⚠ SCOPE, and why it differs from ip.test.ts. This scans `lib/baseball/*.ts`
// ONLY — not `components/baseball`, and not `.tsx`. That asymmetry is
// deliberate, not an oversight: the RENDER layer legitimately needs a wall
// clock (rAF timestamps, `performance.now` for the frame loop) and seeded-random
// scenery jitter, so banning these tokens there would be wrong. Purity is a
// property of the SIM, which is what a replay re-runs. ip.test.ts has the
// opposite need — a trademark must not appear anywhere, render layer included —
// so it deliberately widens to components/baseball and .tsx.
// Stage 4 note: when duelSim/ai.ts land they are `lib/baseball/*.ts` and are
// covered automatically; a sim that ever moves under components/ is not.
/** Every `.ts` source under lib/baseball, tests included — replays must be pure too. */
function simSources(): Array<{ name: string; text: string }> {
  return readdirSync(SIM_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((name) => ({ name, text: readFileSync(join(SIM_DIR, name), 'utf8') }));
}

// Each entry: the token, and why it is banned. `performance.` and `new Date`
// are here alongside the obvious two because a wall clock corrupts a replay
// exactly as thoroughly as an unseeded RNG does — more insidiously, because it
// usually reproduces on the machine that wrote it.
/**
 * Comment-only lines are exempt. Documenting the ban ("no Math.random in any sim
 * file") must not trip the ban — but note this is not a hiding place: any line
 * that runs code is not a comment line, so `Math.random()` followed by `// ...`
 * is still caught. Verified below.
 */
const isComment = (line: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(line);

const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bMath\.random\b/, 'unseeded RNG — use mulberry32(seed) threaded through sim state'],
  [/\bDate\.now\b/, 'wall clock — advance by FIXED_MS instead'],
  [/\bperformance\s*\./, 'wall clock — advance by FIXED_MS instead'],
  [/\bnew\s+Date\b/, 'wall clock — advance by FIXED_MS instead'],
];

describe('determinism guard', () => {
  it('no lib/baseball source uses an unseeded RNG or a wall clock', () => {
    const files = simSources();
    // Guard the guard: if the glob ever stops matching, this test must not
    // silently become a no-op that "passes" over zero files.
    expect(files.length).toBeGreaterThan(0);
    expect(files.map((f) => f.name)).toContain('airPhysics.ts');

    const violations: string[] = [];
    for (const { name, text } of files) {
      // This file necessarily contains the forbidden tokens, as patterns.
      if (name === 'determinism.test.ts') continue;
      for (const [pattern, why] of FORBIDDEN) {
        text.split('\n').forEach((line, i) => {
          if (isComment(line)) return;
          if (pattern.test(line)) violations.push(`${name}:${i + 1}  ${line.trim()}  — ${why}`);
        });
      }
    }
    expect(violations, `determinism violations:\n${violations.join('\n')}`).toEqual([]);
  });

  it('no baseball SCENE source uses an unseeded RNG', () => {
    // ⚠ A NARROWER BAN FOR THE RENDER LAYER, and only one of the four tokens.
    // The scope note above says why the render layer keeps its wall clock: rAF
    // timestamps are how a frame loop works. But `Math.random` is banned there
    // too, for a different reason than in the sim — the screenshot harness's
    // determinism claim is that two runs produce BYTE-IDENTICAL PNGs, and one
    // unseeded call in a scene builder breaks that silently. The seats' section
    // jitter is `mulberry32(BOWL_SEED)` for exactly this reason.
    const dirs = [
      join(SIM_DIR, '..', '..', 'components', 'baseball'),
      join(SIM_DIR, '..', '..', 'components', 'baseball', 'stadium'),
    ];
    const files: Array<{ name: string; text: string }> = [];
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue;
        files.push({ name, text: readFileSync(join(dir, name), 'utf8') });
      }
    }
    // Guard the guard: once the scene exists this must never pass over nothing.
    expect(files.map((f) => f.name)).toContain('StadiumGL.tsx');

    const violations: string[] = [];
    for (const { name, text } of files) {
      text.split('\n').forEach((line, i) => {
        if (isComment(line)) return;
        if (/\bMath\.random\b/.test(line)) violations.push(`${name}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(violations, `unseeded RNG in the scene:\n${violations.join('\n')}`).toEqual([]);
  });

  it('the guard actually catches the things it claims to', () => {
    // A guard nobody has watched fail is not a guard. Same discipline as the
    // gyro superposition test: prove the patterns bite before trusting them.
    const hits = (s: string) => (isComment(s) ? 0 : FORBIDDEN.filter(([p]) => p.test(s)).length);
    expect(hits('const r = Math.random();')).toBe(1);
    expect(hits('const t = Date.now();')).toBe(1);
    expect(hits('const t = performance.now();')).toBe(1);
    expect(hits('const d = new Date();')).toBe(1);
    expect(hits('let ms = 0; ms += Math.random() * 3; // jitter')).toBe(1);
    // ...and leave the legitimate alternatives, and prose about them, alone.
    expect(hits('const rng = mulberry32(seed);')).toBe(0);
    expect(hits('t += FIXED_DT;')).toBe(0);
    expect(hits('// Pure math: no three, no Math.random, no clock.')).toBe(0);
  });
});
