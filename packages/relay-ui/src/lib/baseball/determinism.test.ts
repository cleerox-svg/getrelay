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
