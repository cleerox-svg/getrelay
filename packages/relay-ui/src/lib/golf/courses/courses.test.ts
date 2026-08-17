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
  HOLE_1,
  type CourseHole,
} from '../terrain';
import type { GolfCourse } from './types';

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

// ⚠ THE REFERENCE HOLE IS GATED TOO, THROUGH THIS EXACT LOOP.
// `terrain.ts`'s HOLE_1 is not in GOLF_COURSES and no player can reach it — but
// it is the hole the screenshot harness renders by default and the hole the
// putting physics were tuned against, which makes it the LAST hole that should
// be exempt from the contract. Being exempt is why it drifted unnoticed: it
// carried a green whose finished surface reached |gradient| 0.207 against
// μ = 0.0611 (a dead ball could not rest on much of it) and a `yards` of 520
// against its own 513.0 yd centerline.
//
// It joins the SAME loop rather than getting a parallel assertion of its own,
// because a parallel one is free to fall behind the gate it is imitating — which
// is the same failure mode one step removed.
const GATED: GolfCourse[] = [
  ...GOLF_COURSES,
  {
    id: 'terrain-fixture',
    name: 'terrain.ts · HOLE_1 (QA fixture, unreachable in play)',
    holes: [HOLE_1],
    par: HOLE_1.par,
    yards: HOLE_1.yards,
  },
];

describe('golf courses — per-hole invariants + playability', () => {
  for (const course of GATED) {
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
          //
          // ⚠ …EXCEPT WHERE THE HOLE DEMANDS A FORCED CARRY, and the exception is
          // the whole reason this assertion is split. On a hole whose tee→pin line
          // crosses water the two goals genuinely conflict: the club that stays
          // short of the pin is often the club that comes up wet, and on six of the
          // ten par 3s NO power setting of the never-overshoot pick reached dry
          // land. The carry wins there, because the player can always ease off a
          // long club but cannot power a short one over a creek — so a forced-carry
          // hole gets a BOUNDED overshoot (never more than a green's diameter past
          // the flag) instead of a hard ceiling. Everywhere else, the original
          // ceiling stands untouched.
          it('the recommended tee club does not overshoot the hole at full power', () => {
            // Does the tee→pin line cross a hazard SHORT of the pin, and how far
            // out is its far edge? Written longhand from the hole's own circles
            // rather than by calling the sim's private frontal-carry helper, so the
            // rule and the check cannot agree by construction.
            const teeToPin = Math.hypot(h.pin.d - h.tee.d, h.pin.x - h.tee.x);
            const ud = (h.pin.d - h.tee.d) / teeToPin;
            const ux = (h.pin.x - h.tee.x) / teeToPin;
            let forcedCarry = 0;
            for (const hz of h.hazards) {
              const rd = hz.d - h.tee.d;
              const rx = hz.x - h.tee.x;
              const along = rd * ud + rx * ux;
              const perp = Math.sqrt(Math.max(0, rd * rd + rx * rx - along * along));
              if (perp >= hz.r) continue;
              const far = along + Math.sqrt(hz.r * hz.r - perp * perp);
              if (far > 0 && far < teeToPin) forcedCarry = Math.max(forcedCarry, far);
            }

            const s = new CourseSim(h);
            const club = s.getState().clubId;
            const full = new CourseSim(h).simulateShot({ clubId: club, power: 1 });
            if (forcedCarry > 0) {
              // The clearing club may run past the flag — but a pick that flies the
              // green by more than its own diameter is not a recommendation, it is
              // the two-club over-correction this rule is written to avoid.
              expect(full.total).toBeLessThanOrEqual(teeToPin + 2 * h.green.r);
            } else {
              // Straight-line tee→pin (what the recommendation targets). The played
              // total must not exceed it (the pin sits inside the green, so ≤ tee→pin
              // keeps the ball at/short of the green — never flying it).
              // Grace only for a hole shorter than a full sand wedge, where SW is the
              // sole choice and the finesse curve dials the distance down.
              expect(full.total).toBeLessThanOrEqual(Math.max(teeToPin, 131));
            }
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

// --- A pond may not reach the putting surface, in HEIGHT as well as in LIE ---
//
// `surfaceAt` gives the green strict precedence over water, and `heightAt` used
// to disagree with it about the same yard of ground. Every pond grades a skirt
// (10–22 yd, derived from its depth) around itself so its surface can be level,
// and that skirt ran 3.5–5.9 yd ONTO the green on 14 of the 17 authored ponds.
// The player was told "green" and putted, while the ground under him was being
// dragged toward the pond's plateau — measured slopes up to 0.262 against
// μ = 0.0611, so a dead ball rolled itself off (Augusta 11: a slow putt from
// 15.4 yd slid 6.0 yd clean off the green).
//
// validateHole's green design guard catches the SYMPTOM (a green too steep to
// hold a putt). This states the CAUSE's fix at its strongest, and independently:
// delete every water hazard from a hole and the height of its putting surface
// does not move by a single bit. Stated as exact equality on purpose — the
// placement invariant already keeps a hazard's whole wobbled outline off the
// wobbled pad, so the pad mask is the entire difference and there is no
// legitimate epsilon to allow. It samples and counts its own points rather than
// reusing the guard's sampler, so the two cannot rot together.
describe('greenside water — the green pad outranks the water pad', () => {
  it('deleting a hole\'s ponds does not move its putting surface by one bit', () => {
    let holesWithWater = 0;
    let checked = 0;
    const drifted: string[] = [];
    for (const course of GATED) {
      for (const h of course.holes) {
        if (!h.hazards.some((hz) => hz.kind === 'water')) continue;
        holesWithWater++;
        const dry: CourseHole = { ...h, hazards: h.hazards.filter((hz) => hz.kind !== 'water') };
        const g = h.green;
        const reach = g.r * (1 + EDGE_WOBBLE);
        for (let dd = -reach; dd <= reach; dd += 0.7) {
          for (let dx = -reach; dx <= reach; dx += 0.7) {
            const d = g.d + dd;
            const x = g.x + dx;
            if (surfaceAt(h, d, x) !== 'green') continue;
            checked++;
            const wet = heightAt(h, d, x);
            const nowet = heightAt(dry, d, x);
            if (wet !== nowet) {
              drifted.push(
                `${course.id} h${h.id} @ d=${d.toFixed(1)} x=${x.toFixed(1)}: ` +
                  `${wet.toFixed(4)} vs ${nowet.toFixed(4)} (Δ ${(wet - nowet).toFixed(4)})`,
              );
            }
          }
        }
      }
    }
    expect(drifted.slice(0, 8), `pond grading reached the putting surface`).toEqual([]);
    // Vacuity guards: this passes trivially if no hole has water, or if the
    // sampler stops landing on green.
    expect(holesWithWater).toBeGreaterThanOrEqual(17);
    expect(checked).toBeGreaterThan(10000);
  });
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
      // …and every one of those drifts is a COLLIDABLE. This is the difference
      // between the two forms and the reason the autumn guard above cannot be
      // satisfied for free: choosing 'understory' puts a visible mass at ball
      // height, so it has to put an obstacle there too.
      expect(bloomed.every((t) => t.shrubR !== undefined && t.shrubH !== undefined)).toBe(true);
      for (const t of bloomed) {
        // A drift is a SHRUB drift: never wider than the crown it grows under
        // (canopyR), and 2–3 m tall rather than the 4–6 yd the first pass drew.
        expect(t.shrubR!).toBeLessThan(t.canopyR);
        expect(t.shrubH!).toBeGreaterThan(2.5);
        expect(t.shrubH!).toBeLessThan(3.6);
      }
    }
  });

  it('gives a CANOPY hole no drift at all — the form is the whole difference', () => {
    for (const id of FLOWERING) {
      const h = byId(id);
      if (h.bloom!.form === 'understory') continue;
      const trees = courseTrees(h);
      expect(trees.some((t) => 'shrubR' in t || 'shrubH' in t), `hole ${id}`).toBe(false);
    }
  });

  // Perpendicular distance from a point to the hole's centerline polyline, written
  // out longhand ON PURPOSE. terrain.ts has `nearestOnPolyline`, but importing the
  // production helper would make the guard below re-run the very arithmetic it is
  // supposed to check — the placement fix and the assertion would agree by
  // construction and a sign error in either would pass. This is the same measure
  // stated independently.
  const perpToCenterline = (hole: CourseHole, d: number, x: number): number => {
    let best = Infinity;
    const cl = hole.centerline;
    for (let i = 0; i < cl.length - 1; i++) {
      const a = cl[i]!;
      const b = cl[i + 1]!;
      const vd = b.d - a.d;
      const vx = b.x - a.x;
      const len2 = vd * vd + vx * vx || 1e-6;
      const t = Math.max(0, Math.min(1, ((d - a.d) * vd + (x - a.x) * vx) / len2));
      best = Math.min(best, Math.hypot(d - (a.d + vd * t), x - (a.x + vx * t)));
    }
    return best;
  };

  // ⚠ THE GROVE AND THE CORRIDOR ONCE MEASURED DIFFERENT THINGS. `surfaceAt`
  // classifies the corridor by PERPENDICULAR distance to the centerline polyline;
  // `courseTrees` lines the grove out at a lateral x-offset. Those agree only on a
  // straight hole — on a centerline at θ to the d axis the achieved clearance is
  // `off · cos θ`, so the tree line walked into the corridor it was meant to flank.
  // Unguarded, that put 171 COLLIDABLE trunks inside the rough and 359 canopies
  // over playable ground across 3,084 trees, scaling with dogleg angle (holes
  // under ~28° clean; Augusta 10 at 51° and 13 at 50° carrying 12–14 each; worst
  // tree 12.8 yd inside the OB line).
  //
  // This is the guard, and it is deliberately stated over EVERY hole of EVERY
  // course rather than over the doglegs that were measured — the bug is a
  // property of the placement model, so a new hole with a sharper turn must fail
  // here rather than ship.
  //
  // ⚠ IT GUARDS THE TRUNK ONLY, AND THAT IS THE POINT. Do not "strengthen" this
  // to the canopy or the drift. A canopy over the rough is what a tree-lined hole
  // IS, and the understory drift is REQUIRED to reach playable ground or the
  // brushShrub damping has nothing to damp — courseSim.test.ts asserts a drift in
  // play on Augusta 8 and will fail if you push the whole tree out. The line is:
  // you may be under a tree, you may be in its brush, you may not be inside its
  // trunk.
  it('never plants a collidable TRUNK on playable ground, on any hole of any course', () => {
    let checked = 0;
    for (const course of Object.values(GOLF_COURSES)) {
      for (const hole of course.holes) {
        for (const t of courseTrees(hole)) {
          // Same measure surfaceAt uses to decide rough-vs-OB.
          const clear = perpToCenterline(hole, t.d, t.x) - t.trunkR;
          expect(
            clear,
            `${course.id} h${hole.id}: ${t.kind} trunk at d ${t.d} x ${t.x.toFixed(1)} stands ` +
              `${(hole.roughHalf - clear).toFixed(1)} yd INSIDE the corridor ` +
              `(clearance ${clear.toFixed(1)} vs roughHalf ${hole.roughHalf})`,
          ).toBeGreaterThanOrEqual(hole.roughHalf - 1e-6);
          checked++;
        }
      }
    }
    // The assertion above is vacuously true if courseTrees ever returns nothing,
    // which is exactly how this guard would rot without anyone noticing.
    expect(checked).toBeGreaterThan(3000);
  });

  it('actually plants flowering trees on the three holes the visual gate shoots', () => {
    // 2 Pink Dogwood, 13 Azalea, 16 Redbud — the frames that measured ZERO pink.
    for (const id of [2, 13, 16]) {
      const bloomed = courseTrees(byId(id)).filter((t) => t.bloom !== undefined);
      expect(bloomed.length, `hole ${id} planted no flowering tree`).toBeGreaterThan(4);
      expect(bloomed.every((t) => t.kind === 'broadleaf')).toBe(true);
    }
  });

  // ⚠ THE SAFETY ARGUMENT, AND WHERE IT NOW STOPS. It used to be one sentence —
  // "strip the bloom and the tree list is byte-identical, so a flowering hole
  // plays exactly as a plain one would". That is still true of a CANOPY bloom and
  // it is load-bearing: 2, 13 and 16 are pixel-identical frames on the strength of
  // it. It is NOT true of an understory drift, and pretending otherwise is what
  // let a phantom obstacle ship. So the guarantee splits in two, and each half is
  // tested for exactly what it claims.
  it('CANOPY bloom does not change a single thing the ball touches', () => {
    for (const id of FLOWERING) {
      const h = byId(id);
      if (h.bloom!.form === 'understory') continue;
      const { bloom: _bloom, ...plain } = h;
      const stripped = courseTrees(plain as CourseHole).map((t) => JSON.stringify(t));
      const flowering = courseTrees(h).map((t) => {
        const { bloom: _b, ...rest } = t;
        return JSON.stringify(rest);
      });
      expect(flowering, `hole ${id}`).toEqual(stripped);
    }
  });

  it('UNDERSTORY bloom ADDS a drift and changes nothing else', () => {
    // The narrower claim the drift can honour: it does not move a tree, resize a
    // trunk, or touch a canopy — it only puts a new volume where the blossom is
    // drawn. Everything the ball touched before, it still touches identically.
    for (const id of FLOWERING) {
      const h = byId(id);
      if (h.bloom!.form !== 'understory') continue;
      const { bloom: _bloom, ...plain } = h;
      const stripped = courseTrees(plain as CourseHole).map((t) => JSON.stringify(t));
      const flowering = courseTrees(h).map((t) => {
        const { bloom: _b, shrubR: _r, shrubH: _hh, ...rest } = t;
        return JSON.stringify(rest);
      });
      expect(flowering, `hole ${id}`).toEqual(stripped);
    }
  });
});
