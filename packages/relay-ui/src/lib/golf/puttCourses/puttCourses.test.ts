// Invariant coverage for every authored mini-golf course. This is the HARD GATE
// (mirrors courses/courses.test.ts): every course in PUTT_COURSES must pass
// validatePuttCourse() — cup + tee on a green, the cup point holds a rest, the
// closed border loop present, par ∈ 2..3, everything in bounds, ≤ 8 holes — so a
// mis-authored hole fails loudly rather than shipping.
//
// Run: `pnpm --filter @relay/ui test`.

import { describe, it, expect } from 'vitest';
import { PUTT_COURSES, getPuttCourse, DEFAULT_PUTT_COURSE_ID } from './index';
import { validatePuttCourse, validatePuttHole } from './builder';
import { HOLES } from '../tuning';

describe('mini-golf courses — registry', () => {
  it('exposes the authored courses with the documented ids', () => {
    expect(PUTT_COURSES.map((c) => c.id)).toEqual(['garden']);
  });

  it('getPuttCourse returns the requested course, else the default (Garden)', () => {
    expect(getPuttCourse('garden').id).toBe('garden');
    expect(getPuttCourse('nope').id).toBe(DEFAULT_PUTT_COURSE_ID);
    expect(getPuttCourse(undefined).id).toBe(DEFAULT_PUTT_COURSE_ID);
  });
});

describe('mini-golf courses — totals + structure', () => {
  it('derived par equals the sum of the holes, ids are unique, and ≤ 8 holes', () => {
    for (const c of PUTT_COURSES) {
      expect(c.par).toBe(c.holes.reduce((a, h) => a + h.par, 0));
      expect(c.holes.length).toBeLessThanOrEqual(8);
      const ids = c.holes.map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('The Back Garden is 8 holes', () => {
    expect(getPuttCourse('garden').holes.length).toBe(8);
  });

  // Drift guard: tuning.HOLES is a hand-kept literal (it can't import the course
  // without a tuning↔puttCourses↔builder cycle), so pin it to the DEFAULT course
  // length here. GolfGame drives off course.holes.length; GolfScreen's "ended
  // early — n/HOLES" copy uses HOLES — they must agree with the default course.
  it('tuning.HOLES equals the default mini-golf course length', () => {
    expect(HOLES).toBe(getPuttCourse(DEFAULT_PUTT_COURSE_ID).holes.length);
  });
});

describe('mini-golf courses — HARD GATE (validatePuttCourse)', () => {
  for (const course of PUTT_COURSES) {
    it(`${course.name} passes validatePuttCourse (no violations)`, () => {
      expect(validatePuttCourse(course)).toEqual([]);
    });
    for (const h of course.holes) {
      it(`${course.name} · hole ${h.id} passes validatePuttHole`, () => {
        expect(validatePuttHole(h)).toEqual([]);
      });
    }
  }
});

describe('mini-golf courses — the validator actually catches bad holes', () => {
  const good = getPuttCourse('garden').holes[0]!;

  it('flags a par out of the 2..3 band', () => {
    expect(validatePuttHole({ ...good, par: 5 }).join(' ')).toMatch(/par 5 out of range/);
  });

  it('flags a cup off the green (out of bounds)', () => {
    const errs = validatePuttHole({ ...good, cup: { c: { x: 200, y: 24 }, r: good.cup.r } });
    expect(errs.join(' ')).toMatch(/cup/);
  });

  it('flags a course over the 8-hole clamp', () => {
    const nine = { ...getPuttCourse('garden'), holes: Array(9).fill(good) };
    expect(validatePuttCourse(nine).join(' ')).toMatch(/exceeds the 8-hole clamp/);
  });
});
