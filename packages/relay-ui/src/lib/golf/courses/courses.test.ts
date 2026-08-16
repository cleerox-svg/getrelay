// Invariant + playability coverage for every authored course/hole. This is the
// HARD GATE the plan calls for: every hole in GOLF_COURSES must pass
// validateHole (all terrain.ts invariants), the green must never abut a hazard
// (angular sweep, ported from terrain.test.ts), the course totals must be
// self-consistent and match the real pars, and every hole must be PLAYABLE
// through the headless CourseSim (a full swing terminates, a putt from centre
// rests on the green or holes). Mirrors the terrain/courseSim harness style.
//
// Run: `pnpm --filter @relay/ui test`.

import { describe, it, expect } from 'vitest';
import { GOLF_COURSES, getCourse, DEFAULT_COURSE_ID } from './index';
import { validateHole } from './builder';
import { CourseSim, type CourseResult } from '../courseSim';
import {
  surfaceAt,
  heightAt,
  greenPadRadius,
  courseTrees,
  EDGE_WOBBLE,
  type CourseHole,
} from '../terrain';

const VALID_RESULTS: CourseResult[] = [
  'tee',
  'fairway',
  'green',
  'fringe',
  'rough',
  'bunker',
  'water',
  'cartpath',
  'ob',
  'holed',
];

describe('golf courses — registry', () => {
  it('exposes the four authored courses with the documented ids', () => {
    expect(GOLF_COURSES.map((c) => c.id)).toEqual([
      'augusta',
      'listowel-vintage',
      'listowel-heritage',
      'listowel-millennium',
    ]);
  });

  it('getCourse returns the requested course, else the default (Augusta)', () => {
    expect(getCourse('listowel-vintage').id).toBe('listowel-vintage');
    expect(getCourse('nope').id).toBe(DEFAULT_COURSE_ID);
    expect(getCourse(undefined).id).toBe(DEFAULT_COURSE_ID);
  });
});

describe('golf courses — totals + structure', () => {
  it('Augusta is 18 holes, par 72', () => {
    const a = getCourse('augusta');
    expect(a.holes.length).toBe(18);
    expect(a.par).toBe(72);
  });

  it('each Listowel nine is 9 holes, par 36', () => {
    for (const id of ['listowel-vintage', 'listowel-heritage', 'listowel-millennium']) {
      const c = getCourse(id);
      expect(c.holes.length).toBe(9);
      expect(c.par).toBe(36);
    }
  });

  it('derived par/yards equal the sums of the holes, and hole ids are unique', () => {
    for (const c of GOLF_COURSES) {
      expect(c.par).toBe(c.holes.reduce((a, h) => a + h.par, 0));
      expect(c.yards).toBe(c.holes.reduce((a, h) => a + h.yards, 0));
      const ids = c.holes.map((h) => h.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('Listowel Vintage matches the CONFIRMED Gold-tee scorecard', () => {
    const v = getCourse('listowel-vintage');
    expect(v.holes.map((h) => h.par)).toEqual([5, 3, 4, 4, 5, 4, 4, 3, 4]);
    expect(v.holes.map((h) => h.yards)).toEqual([531, 190, 337, 440, 521, 363, 334, 180, 470]);
    expect(v.yards).toBe(3366);
  });
});

// Angular green-never-abuts-hazard sweep, ported from terrain.test.ts. Sweeping
// out from the green centre in every direction, the FIRST non-green/fringe lie
// must never be a bunker/water — the fringe collar must always intervene.
function greenNeverAbutsHazard(h: CourseHole): void {
  const g = h.green;
  const reach = greenPadRadius(h) * (1 + EDGE_WOBBLE) + 8;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 90) {
    const dirD = Math.sin(a);
    const dirX = Math.cos(a);
    let prev: string = 'green';
    for (let r = 0; r <= reach; r += 0.25) {
      const s = surfaceAt(h, g.d + dirD * r, g.x + dirX * r);
      if ((s === 'bunker' || s === 'water') && prev === 'green') {
        throw new Error(`hole ${h.id}: green abuts ${s} at angle ${a.toFixed(2)}`);
      }
      prev = s;
    }
  }
}

describe('golf courses — per-hole invariants + playability', () => {
  for (const course of GOLF_COURSES) {
    describe(course.name, () => {
      for (const h of course.holes) {
        describe(`hole ${h.id}${h.name ? ` · ${h.name}` : ''}`, () => {
          it('passes validateHole (all terrain.ts invariants)', () => {
            expect(validateHole(h)).toEqual([]);
          });

          it('green never directly abuts a hazard (fringe always intervenes)', () => {
            expect(() => greenNeverAbutsHazard(h)).not.toThrow();
          });

          it('a full swing from the tee terminates with a valid result', () => {
            const s = new CourseSim(h);
            const shot = s.simulateShot({ power: 1 });
            expect(VALID_RESULTS).toContain(shot.result);
            expect(s.ball.resting).toBe(true);
          });

          it('a putt from the green centre rests on the green or holes', () => {
            const s = new CourseSim(h);
            const putt = s.simulatePutt({ d: h.green.d, x: h.green.x }, 1.2, 90);
            expect(['green', 'holed']).toContain(putt.result);
          });

          // REGRESSION (device report: "HOLE 7 · PAR 4, 13 yd, Stroke 1"): a
          // freshly-addressed hole must read the FULL tee→pin distance, not a
          // collapsed few yards. Guards against a builder/units regression that
          // would degenerate the hole geometry (which would ALSO float the ball
          // and make every club overshoot the tiny hole). distToPin is rounded
          // in getState, so allow ±1 yd; and it must be a real hole length
          // (nothing tees off within 100 yd of its own pin).
          it('distToPin at address equals the tee→pin distance (not collapsed)', () => {
            const s = new CourseSim(h);
            const st = s.getState();
            const teeToPin = Math.hypot(h.pin.d - h.tee.d, h.pin.x - h.tee.x);
            expect(st.distToPin).toBeGreaterThan(100);
            expect(Math.abs(st.distToPin - teeToPin)).toBeLessThanOrEqual(1);
            // Sanity: the address lie is the tee, not some near-green surface.
            expect(st.lie).toBe('tee');
          });

          // REGRESSION (device report: a full-power auto-club tee shot flew the
          // green on a short par 4). The auto-recommended tee club must not
          // OVERSHOOT: its full-power total lands at or short of the pin, so a
          // player who pulls full power doesn't automatically fly the green.
          it('the recommended tee club does not overshoot the hole at full power', () => {
            const s = new CourseSim(h);
            const club = s.getState().clubId;
            const full = new CourseSim(h).simulateShot({ clubId: club, power: 1 });
            // Straight-line tee→pin (what the recommendation targets). The played
            // total must not exceed it (the pin sits inside the green, so ≤ tee→pin
            // keeps the ball at/short of the green — never flying it).
            const teeToPin = Math.hypot(h.pin.d - h.tee.d, h.pin.x - h.tee.x);
            // Grace only for a hole shorter than a full sand wedge, where SW is the
            // sole choice and the finesse curve dials the distance down.
            expect(full.total).toBeLessThanOrEqual(Math.max(teeToPin, 131));
          });

          // REGRESSION (device report: "ball floats above the surface"): a shot
          // that has come to REST must sit exactly on the ground — the rest code
          // snaps ball.h to heightAt at the resting (d,x). If this drifts the ball
          // renders floating above its contact shadow. Play a real full swing to
          // rest and assert the seat is exact.
          it('a rested ball sits exactly on the ground (ball.h == heightAt)', () => {
            const s = new CourseSim(h);
            s.simulateShot({ power: 1 });
            const b = s.ball;
            expect(b.resting).toBe(true);
            expect(Math.abs(b.h - heightAt(h, b.d, b.x))).toBeLessThan(1e-6);
          });
        });
      }
    });
  }
});

// --- Flowering canopy (data guard) -----------------------------------------
// Augusta names 13 of its 18 holes after a flowering plant and every one of them
// used to render a plain green tree line (GOLF.md defect 6). The blossom is
// authored per hole as DATA — deliberately NOT derived from the display name at
// render time — so this is the guard that the data and the names still agree.
describe('Augusta — the flowering holes actually flower', () => {
  const augusta = getCourse('augusta');
  const byId = (id: number): CourseHole => augusta.holes.find((h) => h.id === id)!;

  // Every hole named for a plant that visibly flowers or fruits.
  const FLOWERING = [2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 15, 16, 17];
  // Tea Olive's flowers are tiny and hidden; the rest are conifers/grass/holly.
  const PLAIN = [1, 6, 7, 14, 18];

  it('gives every flowering hole a bloom, and every other hole none', () => {
    expect(FLOWERING.filter((id) => !byId(id).bloom)).toEqual([]);
    expect(PLAIN.filter((id) => byId(id).bloom)).toEqual([]);
  });

  it('authors a plausible blossom on each — a real colour, a real fraction', () => {
    for (const id of FLOWERING) {
      const b = byId(id).bloom!;
      expect(b.color).toBeGreaterThan(0);
      expect(b.color).toBeLessThanOrEqual(0xffffff);
      // Never 0 (a hole that renders nothing) and never 1 (a grove of one hue).
      expect(b.fraction).toBeGreaterThan(0.2);
      expect(b.fraction).toBeLessThan(1);
    }
  });

  // ⚠ THE AUTUMN GUARD. This is the rule the visual gate enforced by eye after
  // the first blossom pass had already merged, and it cost three holes: yellow,
  // orange and red ARE the autumn palette, so a full tree-sized crown in one of
  // them reads as October over green turf at ANY saturation. Pink escapes it
  // because nothing in nature is a pink tree in autumn.
  //
  // The rule, therefore: a WARM, SATURATED bloom may not use the default
  // 'canopy' form. Either it belongs on a plant that is really a shrub (12
  // Golden Bell → forsythia → 'understory'), or the colour was the wrong
  // SEASON's feature in the first place (15 Firethorn and 17 Nandina were
  // authored from autumn/winter BERRIES; both flower white in April).
  it('never puts a warm saturated bloom on a tree-sized CANOPY', () => {
    const warm: string[] = [];
    for (const id of FLOWERING) {
      const h = byId(id);
      const b = h.bloom!;
      const r = (b.color >> 16) & 255;
      const g = (b.color >> 8) & 255;
      const bl = b.color & 255;
      const mx = Math.max(r, g, bl);
      const sat = mx === 0 ? 0 : (mx - Math.min(r, g, bl)) / mx;
      let hue = 0;
      const d = mx - Math.min(r, g, bl);
      if (d > 0) {
        if (mx === r) hue = (60 * (((g - bl) / d) % 6) + 360) % 360;
        else if (mx === g) hue = 60 * ((bl - r) / d + 2);
        else hue = 60 * ((r - g) / d + 4);
      }
      // THE AUTUMN WEDGE is hue 0–65°: crimson, scarlet, orange, gold, lemon —
      // the colours a deciduous leaf actually turns. The MAGENTA side (rose,
      // pink, mauve, ~300–355°) is deliberately exempt and must stay exempt:
      // 2 Pink Dogwood, 13 Azalea and 16 Redbud all sit there at sat 0.47–0.64
      // and all three passed the gate emphatically. Widening this wedge to cover
      // them would fail the only holes known to be right.
      const autumnHue = hue <= 65;
      if (autumnHue && sat > 0.45 && (b.form ?? 'canopy') === 'canopy') {
        warm.push(`hole ${id}: #${b.color.toString(16)} hue ${hue.toFixed(0)}° sat ${sat.toFixed(2)}`);
      }
    }
    expect(warm, 'warm saturated bloom on a canopy — see the BLOOM header in augusta.ts').toEqual([]);
  });

  it('plants a drift under an understory hole, and never on a pine', () => {
    const understory = augusta.holes.filter((h) => h.bloom?.form === 'understory');
    // 12 Golden Bell is the reason this form exists; if it ever goes back to a
    // canopy the test above is what should fail, not this one.
    expect(understory.map((h) => h.id)).toContain(12);
    for (const h of understory) {
      const bloomed = courseTrees(h).filter((t) => t.bloom !== undefined);
      expect(bloomed.length, `hole ${h.id} planted no flowering tree`).toBeGreaterThan(4);
      expect(bloomed.every((t) => t.kind === 'broadleaf')).toBe(true);
    }
  });

  it('actually plants flowering trees on the three holes the visual gate shoots', () => {
    // 2 Pink Dogwood, 13 Azalea, 16 Redbud — the frames that measured ZERO pink.
    for (const id of [2, 13, 16]) {
      const bloomed = courseTrees(byId(id)).filter((t) => t.bloom !== undefined);
      expect(bloomed.length, `hole ${id} planted no flowering tree`).toBeGreaterThan(4);
      expect(bloomed.every((t) => t.kind === 'broadleaf')).toBe(true);
    }
  });

  it('does not change a single thing the ball touches', () => {
    // The whole safety argument for bloom: strip it and the tree list is
    // byte-identical, so a flowering hole plays exactly as a plain one would.
    for (const id of FLOWERING) {
      const h = byId(id);
      const { bloom: _bloom, ...plain } = h;
      const stripped = courseTrees(plain as CourseHole).map((t) => JSON.stringify(t));
      const flowering = courseTrees(h).map((t) => {
        const { bloom: _b, ...rest } = t;
        return JSON.stringify(rest);
      });
      expect(flowering, `hole ${id}`).toEqual(stripped);
    }
  });
});
