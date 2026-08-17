// Headless harness for the terrain-aware course sim (lib/golf/courseSim.ts).
// Proves the ball actually plays the HOLE_1 heightfield: full shots land on the
// terrain and finish with a real lie, a putt on the tilted green BREAKS and can
// be HOLED, an approach into the pond/rough/bunker resolves the way the hole is
// drawn, and a downhill putt outruns the same uphill putt. Tune slope/lie feel
// against THIS (and the range harness for the flat ballistics it shares).

import { describe, it, expect } from 'vitest';
import { CourseSim } from './courseSim';
import { HOLE_1, courseTrees, heightAt, surfaceAt, type CourseHole } from './terrain';
import { GOLF_COURSES, getCourse } from './courses';
import { validateHole } from './courses/builder';
import { CLUBS } from './clubs';
import { GRAVITY } from './rangeSim';
import { BALL_R, CUP_R, greenRollDecel, rollOutDistance } from './greenPhysics';
import { MIN_PULL, powerCurve, powerCurveInv } from './tuning';

// A HOLE_1 clone with a DEAD-FLAT green (no tilt, no undulation) — the control
// for proving the tilt (not noise) is what breaks a putt.
const FLAT_GREEN: CourseHole = {
  ...HOLE_1,
  green: { ...HOLE_1.green, tiltPct: 0, undulation: 0 },
};

// A fully FLAT hole (level everywhere) — the control for the Stimpmeter roll-out
// calibration: with no slope, a putt's distance must be v²/(2·g·μ) to the yard.
const FLAT: CourseHole = {
  ...HOLE_1,
  green: { ...HOLE_1.green, raise: 0, tiltPct: 0, undulation: 0 },
  hazards: [],
  terrain: { seed: 1, hilliness: 0, hillScale: 40, teeElev: 5, greenElev: 5 },
};

// A hole with a UNIFORM planar grade and no hills/hazards/green tilt — a clean
// controlled slope for the static-friction rest tests. The tee→green elevation
// ramp is linear over the centerline span, so ∂h/∂d = gradient everywhere (the
// green pad is flattened but irrelevant off it). downhill is toward −d.
function gradedHole(gradient: number): CourseHole {
  const span = 512;
  return {
    ...HOLE_1,
    hazards: [],
    green: { ...HOLE_1.green, raise: 0, tiltPct: 0, undulation: 0 },
    terrain: { seed: 1, hilliness: 0, hillScale: 40, teeElev: 0, greenElev: gradient * span },
  };
}

// Roll a grounded ball from a lie with an initial ground velocity and integrate
// to rest (or a step cap). The direct-injection analogue of simulatePutt for
// off-green lies, used to exercise the grounded-roll rest rule.
function rollGrounded(
  hole: CourseHole,
  start: { d: number; x: number },
  vel: { vd: number; vx: number },
  maxSteps = 100002,
) {
  const s = new CourseSim(hole);
  const b = s.ball;
  b.d = start.d;
  b.x = start.x;
  b.h = 0;
  b.vd = vel.vd;
  b.vx = vel.vx;
  b.inFlight = true;
  b.grounded = true;
  b.resting = false;
  let steps = 0;
  while (b.inFlight && steps < maxSteps) {
    s.substep(1 / 120);
    steps++;
  }
  return { steps, ball: b, result: s.getState().lastResult };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

function sim() {
  return new CourseSim(HOLE_1);
}

describe('course sim — full shots on HOLE_1', () => {
  it('prints the tee-shot bag on the hole (lands on terrain, real lies)', () => {
    const rows = ['  club     | carry | total | apex | toPin | lie'];
    for (const c of CLUBS) {
      const m = sim().simulateShot({ clubId: c.id, power: 1 });
      rows.push(
        `  ${pad(c.name, 8)} | ${pad(m.carry, 5)} | ${pad(m.total, 5)} | ${pad(m.apex, 4)} | ${pad(
          m.distToPin,
          5,
        )} | ${m.result}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n[HOLE_1 TEE BAG]\n' + rows.join('\n') + '\n');
    // A full driver travels a sensible distance and finishes on a solid lie.
    const drv = sim().simulateShot({ clubId: 'driver', power: 1 });
    expect(drv.total).toBeGreaterThan(250);
    expect(['fairway', 'rough', 'green', 'fringe', 'bunker', 'cartpath', 'tee']).toContain(drv.result);
  });

  it('a ball hit into the pond finds water; a wild pull goes OB', () => {
    // A short wedge from the approach line, straight at the pin, that comes up in
    // the pond guarding the front of the green splashes. (from→pin runs over the
    // pond centre, so a shot that lands short of the green finds water.) Power
    // 0.5: with the wedge finesse curve (quadratic low end) a PW at half power
    // carries ~49 yd — onto the pond ~49 yd ahead; the old linear map reached it
    // at 0.3, but full-power carry is unchanged either way.
    const water = sim().simulateShot({ clubId: 'pw', power: 0.5, from: { d: 427, x: 13 } });
    expect(water.result).toBe('water');
    // A wildly pulled driver off the tee leaves the corridor → out of bounds.
    const ob = sim().simulateShot({ clubId: 'driver', power: 1, aimDeg: -35 });
    expect(ob.result).toBe('ob');
  });

  it('a shot into the greenside bunker checks up (short run in sand)', () => {
    // Drop a wedge into the sand and confirm it barely runs (bunker material).
    const b = HOLE_1.hazards.find((h) => h.kind === 'bunker' && h.d > 480)!;
    const m = sim().simulateShot({ clubId: 'sw', power: 0.7, from: { d: b.d - 90, x: b.x } });
    // It should end in the bunker or very near it, having killed its run.
    expect(['bunker', 'rough', 'fringe', 'green']).toContain(m.result);
  });
});

describe('course sim — aim prediction', () => {
  it('predict() matches the committed live shot to the yard, and never mutates', () => {
    // Address a full driver at the tee (aim down the drive line, aimRad 0).
    const s1 = sim();
    s1.power = 1;
    const before = JSON.stringify(s1.getState());
    const ballBefore = JSON.stringify(s1.ball);
    const pred = s1.predict(0);
    // Read-only probe: state + ball untouched.
    expect(JSON.stringify(s1.getState())).toBe(before);
    expect(JSON.stringify(s1.ball)).toBe(ballBefore);

    // The same address fired for real (arm + fire) lands where predict said.
    const s2 = sim();
    s2.power = 1;
    s2.onPointerDown({ x: 0, y: 0 });
    s2.onPointerMove({ x: 0, y: 400 }); // straight-back pull → aimRad 0, full power
    s2.arm({ x: 0, y: 400 });
    s2.fireArmed(0);
    let guard = 0;
    while (s2.ball.inFlight && guard++ < 100000) s2.substep(1 / 120);
    expect(Math.abs(pred.rest.d - s2.ball.d)).toBeLessThanOrEqual(1);
    expect(Math.abs(pred.rest.x - s2.ball.x)).toBeLessThanOrEqual(1);
    expect(pred.landing).not.toBeNull();
  });

  it('predict() returns a full sampled path for a mid-power drive from the tee', () => {
    // A ~0.5-power driver flies + rolls a long way; the sampled arc must be a
    // real trajectory, not a degenerate 1–2 point stub (the "arc is empty" bug).
    const s = sim();
    s.power = 0.5;
    const p = s.predict(0);
    expect(p.path.length).toBeGreaterThan(50);
    expect(p.landing).not.toBeNull();
    // Every sample is finite and moves downrange (no NaN / stuck-at-tee path).
    for (const pt of p.path) {
      expect(Number.isFinite(pt.d) && Number.isFinite(pt.x) && Number.isFinite(pt.h)).toBe(true);
    }
    expect(p.rest.d).toBeGreaterThan(50);
  });

  it('predict() rest matches simulateShot for the SAME absolute inputs (shared physics)', () => {
    // On the TEE, predict aims along the DRIVE LINE (first fairway leg) + aimRad;
    // with aimRad 0 that is the first-leg heading. Firing simulateShot at that SAME
    // absolute heading + power must land in the same spot — proof both paths run
    // one integrator. (HOLE_1 is a dogleg, so the drive line ≠ the pin bearing.)
    const cl = HOLE_1.centerline;
    const driveDeg = (Math.atan2(cl[1]!.x - cl[0]!.x, cl[1]!.d - cl[0]!.d) * 180) / Math.PI;
    const s1 = sim();
    s1.power = 0.7;
    const pred = s1.predict(0);
    const shot = sim().simulateShot({ clubId: s1.getState().clubId, power: 0.7, aimDeg: driveDeg });
    expect(Math.abs(pred.rest.d - shot.restD)).toBeLessThanOrEqual(1);
    expect(Math.abs(pred.rest.x - shot.restX)).toBeLessThanOrEqual(1);
  });

  it('snapshot/restore leaves the sim state byte-identical after predict()', () => {
    // The single-snapshot mechanism must rewind EVERY mutated field. Crucially,
    // the before/after comparison is taken INDEPENDENTLY of snapshot() — it dumps
    // ALL own enumerable data props of the sim (ball + trail + every field),
    // minus the static `hole` — so it can SEE a field that snapshot() forgot. If
    // predict() mutates such a field, restore() won't rewind it and the dump
    // diverges → the test fails loudly. (A dump taken through snapshot() itself
    // would be blind to its own omissions, which is the drift this must catch.)
    const s = sim();
    s.power = 0.8;
    s.setSpin(0.3, -0.2);
    const fullDump = () => {
      const rest: Record<string, unknown> = {};
      const all = s as unknown as Record<string, unknown>;
      for (const k of Object.keys(all)) if (k !== 'hole') rest[k] = all[k];
      return JSON.stringify(rest);
    };
    const before = fullDump();
    // Fire the renderer's actual usage: centre + both dispersion edges.
    s.predict(0);
    s.predict(-1);
    s.predict(1);
    expect(fullDump()).toBe(before);
  });
});

// The TEE-SHOT aim base is the DRIVE LINE (first fairway leg), so the address view
// + tee box sit square to the fairway, not twisted at the pin around a dogleg.
// Every other lie (approach + putts) keeps aiming at the pin/cup. On a straight
// hole / par-3 the drive line is collinear tee→pin, so those holes are unchanged.
describe('course sim — tee-shot aim base is the drive line (first leg)', () => {
  // Build a hole from HOLE_1, overriding the shape bits. Clears the cart path so a
  // sampled lie can't land on it.
  const shape = (o: Partial<CourseHole>): CourseHole => ({
    ...HOLE_1,
    tee: { d: 0, x: 0 },
    hazards: [],
    cartPath: undefined,
    ...o,
  });
  const legHeading = (h: CourseHole) =>
    Math.atan2(h.centerline[1]!.x - h.centerline[0]!.x, h.centerline[1]!.d - h.centerline[0]!.d);
  const pinBearing = (h: CourseHole) => Math.atan2(h.pin.x - h.tee.x, h.pin.d - h.tee.d);

  it('STRAIGHT / collinear hole: drive heading == pin bearing (byte-identical)', () => {
    const straight = shape({
      pin: { d: 300, x: 0 },
      centerline: [
        { d: 0, x: 0 },
        { d: 150, x: 0 },
        { d: 300, x: 0 },
      ],
      green: { ...HOLE_1.green, d: 300, x: 0 },
    });
    expect(legHeading(straight)).toBeCloseTo(pinBearing(straight), 12);
    // The tee-shot aim heading (aimRad 0) is exactly the tee→pin bearing (0 here).
    expect(new CourseSim(straight).aimHeading()).toBeCloseTo(pinBearing(straight), 12);
  });

  it('a par-3 (collinear tee→pin at an angle): drive heading == pin bearing', () => {
    const p3 = shape({
      par: 3,
      pin: { d: 180, x: -20 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: -10 },
        { d: 180, x: -20 }, // collinear: constant slope −10/90
      ],
      green: { ...HOLE_1.green, d: 180, x: -20, r: 14 },
    });
    expect(legHeading(p3)).toBeCloseTo(pinBearing(p3), 12);
    expect(new CourseSim(p3).aimHeading()).toBeCloseTo(pinBearing(p3), 12);
  });

  it('a DOGLEG: tee-shot aim heading is the first leg, NOT the pin bearing', () => {
    const s = new CourseSim(HOLE_1); // dogleg-right; ball on the tee
    expect(s.aimHeading()).toBeCloseTo(legHeading(HOLE_1), 12);
    // The drive line genuinely differs from the pin bearing on a dogleg.
    expect(Math.abs(legHeading(HOLE_1) - pinBearing(HOLE_1))).toBeGreaterThan(0.02);
  });

  it('after the drive (strokes > 0) the aim base reverts to the pin/cup', () => {
    // The predicate is strokes === 0, so any later stroke aims at the pin/cup.
    const s = new CourseSim(HOLE_1);
    s.strokes = 1;
    s.ball.d = 300; // out on the hole
    s.ball.x = 4;
    const wantPin = Math.atan2(HOLE_1.pin.x - s.ball.x, HOLE_1.pin.d - s.ball.d);
    expect(s.aimHeading()).toBeCloseTo(wantPin, 12);
  });

  it('a later stroke resting ON the tee disc still aims at the pin (strokes gate)', () => {
    // The case the old lieAt('tee') predicate got wrong: a ball that trickled back
    // onto the tee box on a LATER stroke must aim at the pin, not down the drive
    // line. `strokes > 0` gives that; a lie-based gate would have flipped to drive.
    const s = new CourseSim(HOLE_1);
    s.strokes = 2;
    s.ball.d = HOLE_1.tee.d; // literally on the tee (lie === 'tee')
    s.ball.x = HOLE_1.tee.x;
    const wantPin = Math.atan2(HOLE_1.pin.x - s.ball.x, HOLE_1.pin.d - s.ball.d);
    expect(s.aimHeading()).toBeCloseTo(wantPin, 12);
  });
});

// --- The authored par 3s, end to end ----------------------------------------
// A par 3 is the one hole type where the default address IS the hole: the player
// is handed a club and a heading, and one swing is meant to be able to find the
// green. Two independent defects each broke that on their own — a decorative
// mid-vertex that aimed "straight" 3.0–6.4° off the flag, and a club rule that
// picked on RUN-OUT (CLUB_FULL_TOTAL, the max total over every hole) for a shot
// whose whole job is CARRY, leaving six of the ten par 3s with no power setting
// of the recommended club that reached dry land at all.
//
// So these guards are stated over EVERY par 3 of EVERY authored course, they
// measure the hole's own geometry longhand (never by calling the sim helper they
// are checking — `frontalCarry` and `driveHeading` are both private, and copying
// them in would make the fix and the assertion agree by construction), and each
// COUNTS what it checked, because the way a sweep like this rots is by silently
// selecting nothing.
describe('course sim — the authored par 3s (aim, club, and reaching the green)', () => {
  const PAR3: { course: string; h: CourseHole }[] = [];
  for (const c of GOLF_COURSES) for (const h of c.holes) if (h.par === 3) PAR3.push({ course: c.id, h });

  // Distance from the tee, along the tee→pin line, to the FAR edge of the last
  // hazard that line crosses short of the pin — i.e. the yardage a tee shot has
  // to CARRY. 0 when the line is clean. Stated here as plain segment/circle
  // geometry: project the centre onto the line, and if the perpendicular miss is
  // inside the radius the line cuts the circle and leaves it at `along + half`.
  const carryNeeded = (h: CourseHole): { need: number; kind: string } => {
    const R = Math.hypot(h.pin.d - h.tee.d, h.pin.x - h.tee.x);
    const ud = (h.pin.d - h.tee.d) / R;
    const ux = (h.pin.x - h.tee.x) / R;
    let need = 0;
    let kind = 'none';
    for (const hz of h.hazards) {
      const rd = hz.d - h.tee.d;
      const rx = hz.x - h.tee.x;
      const along = rd * ud + rx * ux;
      const perp = Math.sqrt(Math.max(0, rd * rd + rx * rx - along * along));
      if (perp >= hz.r) continue;
      const far = along + Math.sqrt(hz.r * hz.r - perp * perp);
      if (far <= 0 || far >= R) continue; // behind the tee / not short of the pin
      if (far > need) {
        need = far;
        kind = hz.kind;
      }
    }
    return { need, kind };
  };

  it('there are ten authored par 3s, and every one is checked below', () => {
    // The sweeps in this block all iterate PAR3; if the filter ever selects
    // nothing (a renamed field, a course dropped from the registry) they would
    // pass green while testing zero holes. This is the count that stops that.
    expect(PAR3.length).toBe(10);
    expect(PAR3.filter(({ h }) => carryNeeded(h).need > 0).length).toBe(8);
  });

  it('"straight" points at the FLAG on every par 3 (< 1° off the pin bearing)', () => {
    // driveHeading() aims the tee shot down centerline[0] → centerline[1] so that
    // "straight" runs down the fairway on a dogleg. A par 3 has no dogleg, so its
    // first segment must BE the shot at the flag — the invariant the code comment
    // claimed and five holes broke (Augusta 6 by 6.4° / 20 yd, and no club at aim
    // 0 could reach that green). aimHeading() at address (strokes 0, aimRad 0) is
    // the sim's real answer; the bearing it is compared against is computed here
    // from the hole data alone.
    const rows: string[] = [];
    let checked = 0;
    for (const { course, h } of PAR3) {
      const bearing = Math.atan2(h.pin.x - h.tee.x, h.pin.d - h.tee.d);
      const aim = new CourseSim(h).aimHeading();
      const errDeg = ((aim - bearing) * 180) / Math.PI;
      const R = Math.hypot(h.pin.d - h.tee.d, h.pin.x - h.tee.x);
      rows.push(
        `  ${pad(`${course} h${h.id}`, 24)} | ${pad(errDeg.toFixed(3), 7)}° | ${pad(
          (Math.abs(Math.sin(aim - bearing)) * R).toFixed(2),
          6,
        )} yd off at the pin`,
      );
      expect(Math.abs(errDeg), `${course} hole ${h.id}: "straight" misses the flag`).toBeLessThan(1);
      checked++;
    }
    console.log('\n[PAR 3 — AIM AT ADDRESS]\n' + rows.join('\n'));
    expect(checked).toBe(10);
  });

  it('the recommended tee club CARRIES the last frontal hazard, on every par 3', () => {
    // The counterpart to the never-overshoot guard, and the half that was missing:
    // a par 3 lands on a receptive green that CHECKS, so a rule tuned on maximum
    // TOTAL picked one to three clubs short of the water. Measure the REAL carry
    // of the REAL recommendation, down the line the player is actually addressing.
    const rows: string[] = [];
    let withHazard = 0;
    for (const { course, h } of PAR3) {
      const { need, kind } = carryNeeded(h);
      const s = new CourseSim(h);
      const club = s.getState().clubId;
      const aimDeg = (s.aimHeading() * 180) / Math.PI;
      const shot = new CourseSim(h).simulateShot({ clubId: club, power: 1, aimDeg });
      rows.push(
        `  ${pad(`${course} h${h.id}`, 24)} | ${pad(h.yards, 4)} | ${pad(club, 6)} | carry ${pad(
          shot.carry,
          4,
        )} | needs ${pad(need.toFixed(1), 6)} ${pad(kind, 7)} | clears ${pad(
          (shot.carry - need).toFixed(1),
          6,
        )} | ${shot.result}`,
      );
      if (need <= 0) continue;
      withHazard++;
      expect(
        shot.carry,
        `${course} hole ${h.id}: the recommended ${club} carries ${shot.carry} yd, ` +
          `${need.toFixed(1)} yd of ${kind} to clear — it cannot reach dry land at ANY power`,
      ).toBeGreaterThan(need);
      expect(shot.result, `${course} hole ${h.id}: full power finds ${shot.result}`).not.toBe('water');
    }
    console.log('\n[PAR 3 — RECOMMENDED CLUB vs THE FORCED CARRY]\n' + rows.join('\n'));
    expect(withHazard).toBe(8); // 8 of the 10 have a hazard on the tee→pin line
  });

  it('a dead-straight swing with the recommended club can reach DRY LAND', () => {
    // The blocker exactly as it was reported: sweep power 0.40→1.00 with the
    // recommended club at aim 0 and count the settings that finish out of the
    // water. Six holes measured ZERO. Anything above zero means the hole is
    // playable as dealt; the assertion is on the count, per hole.
    let checked = 0;
    for (const { course, h } of PAR3) {
      const aimDeg = (new CourseSim(h).aimHeading() * 180) / Math.PI;
      const club = new CourseSim(h).getState().clubId;
      let dry = 0;
      for (let p = 0.4; p <= 1.0001; p += 0.02) {
        const shot = new CourseSim(h).simulateShot({ clubId: club, power: p, aimDeg });
        if (shot.result !== 'water' && shot.result !== 'ob') dry++;
      }
      expect(dry, `${course} hole ${h.id}: no power of the recommended ${club} stays dry`).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBe(10);
  });

  it('a dead-straight, perfectly clubbed swing can HIT THE GREEN on every par 3', () => {
    // The end-to-end statement of the aim fix. On Augusta 6 Juniper every club ×
    // every power at aim 0 missed the green, because the aim line itself pointed
    // 20 yd left of it — no club selection could rescue that. This sweeps the
    // whole bag and asserts each hole has at least one club/power that finishes on
    // the putting surface, and prints how many do.
    const rows: string[] = [];
    let checked = 0;
    for (const { course, h } of PAR3) {
      const aimDeg = (new CourseSim(h).aimHeading() * 180) / Math.PI;
      let hits = 0;
      for (const c of CLUBS) {
        for (let p = 0.4; p <= 1.0001; p += 0.05) {
          const shot = new CourseSim(h).simulateShot({ clubId: c.id, power: p, aimDeg });
          if (shot.result === 'green' || shot.result === 'holed') hits++;
        }
      }
      rows.push(`  ${pad(`${course} h${h.id}`, 24)} | ${pad(hits, 3)} of 104 club×power lines find the green`);
      expect(hits, `${course} hole ${h.id}: NO club at any power hits this green dead straight`).toBeGreaterThan(0);
      checked++;
    }
    console.log('\n[PAR 3 — GREEN REACHABLE DEAD STRAIGHT]\n' + rows.join('\n'));
    expect(checked).toBe(10);
  });
});

// --- Wind on the course (setWind + predict includeWind) ----------------------
// The Course gains the Range's wind: setWind() mutates the EXISTING
// windAlong/windCross fields (already in the CourseSnapshot), the airborne-only
// rule pushes the ball in flight, and predict({includeWind}) mirrors the Range so
// the aim aids can draw the wind-adjusted arc + the pre-wind reticle. These pin:
// (a) a windy predict matches the committed windy shot to the yard, (b) cross
// wind offsets the ball laterally, and (c) setWind added NO new mutable field
// (the snapshot round-trip guard stays byte-identical).
describe('course sim — wind', () => {
  it('predict({includeWind:true}) matches the committed windy shot to the yard', () => {
    // A non-zero head/cross wind set via setWind; address a full driver at the
    // tee. The prediction (wind included) must land where the real windy shot,
    // fired through the interactive path with the SAME wind, comes to rest.
    const w = { along: -1.5, cross: 2.5 };
    const s1 = sim();
    s1.setWind(w.along, w.cross);
    s1.power = 1;
    const pred = s1.predict({ includeWind: true });

    const s2 = sim();
    s2.setWind(w.along, w.cross);
    s2.power = 1;
    s2.onPointerDown({ x: 0, y: 0 });
    s2.onPointerMove({ x: 0, y: 400 }); // straight-back pull → aimRad 0, full power
    s2.arm({ x: 0, y: 400 });
    s2.fireArmed(0);
    let guard = 0;
    while (s2.ball.inFlight && guard++ < 100000) s2.substep(1 / 120);
    expect(Math.abs(pred.rest.d - s2.ball.d)).toBeLessThanOrEqual(1);
    expect(Math.abs(pred.rest.x - s2.ball.x)).toBeLessThanOrEqual(1);
    expect(pred.landing).not.toBeNull();
  });

  it('a cross-wind shot lands laterally offset from the same shot with zero wind', () => {
    // The SAME address predicted with a right cross-wind vs with the wind zeroed
    // (includeWind:false): the wind must push the ball measurably to the right.
    const s = sim();
    s.setWind(0, 3); // strong right cross (+x)
    s.power = 1;
    const withWind = s.predict({ includeWind: true });
    const noWind = s.predict({ includeWind: false });
    expect(withWind.rest.x - noWind.rest.x).toBeGreaterThan(3);
  });

  it('setWind adds no mutable field — the snapshot round-trip stays byte-identical', () => {
    // Same guard as the aim-prediction suite, but with a wind set AND a
    // predict({includeWind:false}) (which zeroes wind mid-run): restore() must
    // put windAlong/windCross back, so the full dump is unchanged after predict.
    const s = sim();
    s.setWind(-1.2, 2.7);
    s.power = 0.8;
    const fullDump = () => {
      const rest: Record<string, unknown> = {};
      const all = s as unknown as Record<string, unknown>;
      for (const k of Object.keys(all)) if (k !== 'hole') rest[k] = all[k];
      return JSON.stringify(rest);
    };
    const before = fullDump();
    s.predict({ includeWind: true });
    s.predict({ includeWind: false });
    s.predict(1);
    expect(fullDump()).toBe(before);
  });
});

describe('course sim — putting on the tilted green', () => {
  const g = HOLE_1.green;

  it('a putt across the green BREAKS toward the low (front) side vs a flat green', () => {
    // The SAME cross putt (straight +x from the left) on the tilted green vs a
    // dead-flat control: the tilt pulls the roll toward the front (−d), so the
    // tilted ball finishes measurably further front than the flat one. Proves
    // the break comes from the slope, not from noise.
    const tilted = sim().simulatePutt({ d: g.d, x: g.x - 9 }, 5, 90);
    const flat = new CourseSim(FLAT_GREEN).simulatePutt({ d: g.d, x: g.x - 9 }, 5, 90);
    expect(tilted.restD).toBeLessThan(flat.restD - 0.15);
  });

  it('a downhill putt runs further than the same putt uphill', () => {
    // Downhill = toward the front (−d, bearing 180°); uphill = toward the back
    // (+d, bearing 0°). Same start + speed, compare distance rolled.
    const down = sim().simulatePutt({ d: g.d + 6, x: g.x }, 4, 180);
    const up = sim().simulatePutt({ d: g.d - 6, x: g.x }, 4, 0);
    const downDist = Math.hypot(down.restD - (g.d + 6), down.restX - g.x);
    const upDist = Math.hypot(up.restD - (g.d - 6), up.restX - g.x);
    expect(downDist).toBeGreaterThan(upDist);
  });

  it('a well-judged putt straight at the cup is HOLED — on ANY legal green', () => {
    // From just below the hole, up the fall line at a well-judged (dead-weight)
    // pace, it drops. Too soft leaves it short; too firm lips out — only the
    // right band holes, which is the point of speed-dependent capture.
    //
    // ⚠ THIS USED TO BE A ONE-POINT TEST, AND IT PASSED ON A COINCIDENCE. It ran
    // five paces on the shipped HOLE_1 green and nothing else. HOLE_1's pin sits
    // at the green centre, so the putt runs the pure slope line, and at the old
    // fixture values `undulation 0.08` turned out to be the ONLY amplitude in
    // 0.01–0.08 whose noise field bent the roll back into the cup — every other
    // value missed at every pace. A test called "the hole is reliably makeable"
    // was in fact pinned to one value of a noise amplitude: green for the wrong
    // reason, and red the moment the fixture was retuned for something unrelated.
    //
    // So it now asserts what its name claims — that an on-line putt at holing
    // pace drops on ANY green the authoring contract accepts, not at one point in
    // the space. The grid spans the whole authored range of tilt (0.030–0.044,
    // against 0.037–0.045 on the shipped holes) × undulation (0.01–0.06), every
    // cell is put through the SHIPPED `validateHole` so the claim is scoped to
    // legal greens rather than to a hand-picked list, and each cell must show a
    // real holing WINDOW: at least one pace in a plausible band drops, a dead tap
    // finishes short, and a blasted putt does not drop. Without those last two a
    // sim that simply swallowed every ball would pass.
    const rows: string[] = [];
    let cells = 0;
    for (const tiltPct of [0.03, 0.034, 0.037, 0.04, 0.044]) {
      const line: string[] = [];
      for (const undulation of [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]) {
        const h: CourseHole = { ...HOLE_1, green: { ...g, tiltPct, undulation } };
        // Scope: only greens the shipped authoring gate would accept.
        expect(validateHole(h), `tilt ${tiltPct} undulation ${undulation}`).toEqual([]);
        const paces: number[] = [];
        for (let sp = 3.6; sp <= 6.001; sp += 0.1) {
          if (new CourseSim(h).simulatePutt({ d: g.d - 7, x: g.x }, sp, 0).result === 'holed') {
            paces.push(Math.round(sp * 10) / 10);
          }
        }
        const soft = new CourseSim(h).simulatePutt({ d: g.d - 7, x: g.x }, 2, 0);
        const hard = new CourseSim(h).simulatePutt({ d: g.d - 7, x: g.x }, 10, 0);
        expect(
          paces.length,
          `tilt ${tiltPct} undulation ${undulation}: a 7 yd on-line putt holes at NO pace in 3.6–6.0`,
        ).toBeGreaterThan(0);
        expect(soft.result, `tilt ${tiltPct} undulation ${undulation}: a dead tap holed`).not.toBe('holed');
        expect(hard.result, `tilt ${tiltPct} undulation ${undulation}: a blasted putt holed`).not.toBe(
          'holed',
        );
        line.push(`u ${undulation.toFixed(2)} → ${pad(paces.length, 2)} paces from ${paces[0]!.toFixed(1)}`);
        cells++;
      }
      rows.push(`  tilt ${tiltPct.toFixed(3)} | ${line.join(' | ')}`);
    }
    console.log('\n[HOLING WINDOW ACROSS LEGAL GREENS]\n' + rows.join('\n'));
    // 5 tilts × 6 undulations. A filter or a fixture change that collapsed this
    // grid would otherwise leave the sweep passing on nothing at all.
    expect(cells).toBe(30);
  });

  it('a putt hit much too hard LIPS OUT / rolls over the cup (speed-capture)', () => {
    // Straight over the cup but far too fast: the effective capture radius has
    // shrunk to nothing, so it does NOT drop — it runs on off the green.
    const m = sim().simulatePutt({ d: g.d - 7, x: g.x }, 10, 0);
    expect(m.result).not.toBe('holed');
  });
});

describe('course sim — green speed (Stimpmeter roll-out)', () => {
  it("a flat-green putt rolls the Stimpmeter distance v²/(2·g·μ) for its speed", () => {
    // On a level green the integrated roll-out must match the calibrated Coulomb
    // model to within a small margin (semi-implicit integration + the fine rest
    // cutoff) — this is what makes putt power predictable, not guessed. (The pure
    // stimp→friction→distance math itself is covered in greenPhysics.test.ts;
    // this exercises it THROUGH the real CourseSim roll integrator.)
    const a = greenRollDecel(GRAVITY);
    const g = FLAT.green;
    for (const v of [3, 4, 5]) {
      const m = new CourseSim(FLAT).simulatePutt({ d: g.d, x: g.x }, v, 90);
      const predicted = rollOutDistance(v, a);
      expect(Math.abs(m.total - predicted)).toBeLessThan(0.6);
    }
  });
});

// --- Static-friction rest on grounded slopes (the "rolls slowly forever" fix) -
// A ball on a slope in the rough/fairway must come to a DEFINITE stop where the
// slope is gentle enough that STATIC friction holds it — it must not creep
// downhill forever re-accelerated by slopeAccel each substep. This is ONE rest
// rule for every grounded surface: slow AND slope ≤ the surface's static hold →
// rest. Only a genuinely STEEP slope (slopeAccel > static hold) keeps it rolling.
describe('course sim — static-friction rest on grounded slopes', () => {
  it('a ball rolling on a MODEST fairway slope comes to REST (velocity → 0)', () => {
    // grad 0.15 → slopeAccel 2.4 yd/s², well under the fairway static hold, so
    // friction wins: the ball rolls a bounded distance and STOPS (does not creep).
    const r = rollGrounded(gradedHole(0.15), { d: 200, x: 0 }, { vd: -6, vx: 0 });
    expect(r.ball.resting).toBe(true);
    expect(Math.hypot(r.ball.vd, r.ball.vx)).toBe(0);
    expect(r.result).toBe('fairway');
    // It settled promptly and travelled a bounded distance — NOT indefinitely.
    expect(r.steps).toBeLessThan(2000); // ≪ the 100000-step safety guard
    expect(Math.abs(200 - r.ball.d)).toBeLessThan(30);
  });

  it('a ball rolling on a MODEST rough slope comes to REST', () => {
    // grad 0.20 in the rough band (x=30): slopeAccel 3.2 < rough static hold.
    const r = rollGrounded(gradedHole(0.2), { d: 200, x: 30 }, { vd: -4, vx: 0 });
    expect(surfaceAt(HOLE_1, 200, 30)).toBe('rough');
    expect(r.ball.resting).toBe(true);
    expect(Math.hypot(r.ball.vd, r.ball.vx)).toBe(0);
    expect(r.result).toBe('rough');
    expect(r.steps).toBeLessThan(2000);
  });

  it('a ball on a STEEP slope keeps rolling downhill (NOT falsely frozen)', () => {
    // grad 0.7 → slopeAccel 11.2 yd/s², above the rough static hold, so the slope
    // overcomes static friction: a ball released from rest starts moving and
    // travels a meaningful distance downhill within a short window (it is not
    // snapped to rest). downhill is −d.
    const r = rollGrounded(gradedHole(0.7), { d: 200, x: 30 }, { vd: 0, vx: 0 }, 1200);
    expect(r.ball.resting).toBe(false); // still rolling after 10 s
    expect(200 - r.ball.d).toBeGreaterThan(5); // travelled well downhill, not frozen
  });

  it('the reported bug: a ball on the HOLE_1 green bank rough STOPS (no perpetual creep)', () => {
    // The rough bank around the raised green is a "legit hill" where a nearly
    // stopped ball used to sit exactly on the KINETIC angle-of-repose contour and
    // creep forever (only the 100000-step safety guard ever stopped it, ~833 s of
    // sim). It must now settle quickly, held by static friction, with resting set.
    const start = { d: 514.1, x: -5.9 };
    expect(surfaceAt(HOLE_1, start.d, start.x)).toBe('rough');
    const r = rollGrounded(HOLE_1, start, { vd: 0.5, vx: 0.5 });
    expect(r.ball.resting).toBe(true);
    expect(Math.hypot(r.ball.vd, r.ball.vx)).toBe(0);
    expect(r.steps).toBeLessThan(1000); // definite stop, nowhere near the guard
    expect(r.result).toBe('rough');
  });
});

// --- The real fire pipeline (what the game actually calls) -------------------
// simulateShot/simulatePutt are measurement hooks; the GAME fires through
// onPointerDown → onPointerMove → arm → fireArmed. These pin the play-test
// fixes to THAT path: a stroke on the green is a putt (rolls, can hole), a soft
// wedge flies genuinely short (finesse floor), and a ball behind the pin aims
// back at the cup instead of away.

// Fire a straight-at-pin shot at the given EFFECTIVE power through the
// interactive path. onPointerMove now shapes the raw pull through the elastic
// powerCurve, so to land on a specific effective power the drag distance is the
// curve's INVERSE (powerCurveInv) — the tests reason in effective power, which is
// what the sim stores, uses and shows on the meter.
function fireStraight(s: CourseSim, power: number): void {
  const MP = 100;
  s.setMaxPull(MP);
  // A REAL finger drag can't be shorter than MIN_PULL (arm() cancels below it),
  // so the smallest arm-able tap is powerCurve(MIN_PULL/MP) ≈ 0.09, not 0. Clamp
  // the inverse-mapped drag to that floor: a request below it fires the genuine
  // minimum tap (still a delicate trickle), which is what the sim can produce.
  const drag = Math.max(MIN_PULL + 0.5, powerCurveInv(power) * MP); // aim at pin
  s.onPointerDown({ x: 0, y: 0 });
  s.onPointerMove({ x: 0, y: drag });
  s.arm({ x: 0, y: drag });
  s.fireArmed(0); // pure strike
  let g = 0;
  while (s.ball.inFlight && g++ < 200000) s.substep(1 / 120);
}

// --- Elastic slingshot power response (reachability + rubber-band feel) -------
// onPointerMove/arm shape the raw pull fraction through powerCurve() so a low
// ball can reach 100% power in the limited screen room below it, while the last
// stretch compresses (a deliberate strain). The ENDS must be exact — f(0)=0,
// f(1)=1 — or full-power carry (and the club ladder) would move.
describe('course sim — elastic power curve', () => {
  it('is exact at the ends so full-power carry is UNCHANGED (f(0)=0, f(1)=1)', () => {
    expect(powerCurve(0)).toBe(0);
    expect(powerCurve(1)).toBe(1);
    // A FULL downward pull (drag ≥ maxPull) still yields power exactly 1.
    const s = sim();
    s.setMaxPull(100);
    s.onPointerDown({ x: 0, y: 0 });
    s.onPointerMove({ x: 0, y: 140 }); // past maxPull → clamps to a full pull
    expect(s.power).toBe(1);
  });

  it('is near-linear so the MIDDLE is dialable (~50% pull ≈ ~50% power)', () => {
    // The camera now frames the ball high enough for a generous pull, so the curve
    // is gentle (no longer front-loaded): mid-pull maps to mid-power, giving a
    // controllable middle instead of a hypersensitive 0→100 twitch.
    expect(powerCurve(0.5)).toBeGreaterThan(0.5);
    expect(powerCurve(0.5)).toBeLessThan(0.6); // ~0.55 — barely above linear
    // Only a MILD strain up top: 65% pull is well short of max (was ~0.90).
    expect(powerCurve(0.65)).toBeGreaterThan(0.66);
    expect(powerCurve(0.65)).toBeLessThan(0.74);
    // Monotonic and strictly increasing across the drag (no dead zone / plateau).
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const p = powerCurve(t);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    // Low end tracks the pull closely (dialable, near 1:1), preserving finesse.
    expect(powerCurve(0.1)).toBeGreaterThan(0.08);
    expect(powerCurve(0.1)).toBeLessThan(0.16);
    expect(powerCurve(0.3)).toBeGreaterThan(0.28);
    expect(powerCurve(0.3)).toBeLessThan(0.4);
  });

  it('powerCurveInv round-trips powerCurve (tools/tests can hit a given power)', () => {
    for (const p of [0.05, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      expect(powerCurve(powerCurveInv(p))).toBeCloseTo(p, 6);
    }
  });

  it('a full swing reaches 100% on the room-derived maxPull, and mid-pull is mid-power', () => {
    // The GL scene frames the ball ~64% down and sets maxPull to the (now
    // generous) measured room below it — a full downward pull to that room hits
    // power 1.0, so 100% is always reachable within the screen.
    const s = sim();
    s.setMaxPull(200); // a typical phone's measured room
    s.onPointerDown({ x: 0, y: 0 });
    s.onPointerMove({ x: 0, y: 200 }); // pull down exactly the available room
    expect(s.power).toBe(1);
    // The dialable middle: half the pull yields roughly half the power.
    s.onPointerMove({ x: 0, y: 100 });
    expect(s.power).toBeGreaterThan(0.5);
    expect(s.power).toBeLessThan(0.6);
  });

  it('a putt stays FEATHER-able on a generous (non-room) maxPull', () => {
    // Putts never need 100%; the GL scene gives them a generous finesse maxPull
    // (~h*0.3), NOT the tiny green room, so the smallest arm-able tap is a soft
    // trickle rather than a blast that overshoots a short putt.
    const s = sim();
    const g = HOLE_1.green;
    s.ball.d = g.d;
    s.ball.x = g.x - 2;
    s.ball.h = 0;
    expect(s.getState().putting).toBe(true);
    s.setMaxPull(240); // generous finesse pull (≈ h*0.3 on a phone)
    s.onPointerDown({ x: 0, y: 0 });
    s.onPointerMove({ x: 0, y: MIN_PULL + 1 }); // the minimum arm-able tap
    expect(s.power).toBeLessThan(0.12); // soft enough to feather a short putt
  });
});

describe('course sim — auto club recommendation', () => {
  const g = HOLE_1.green;

  it('the opening tee shot on a 512yd par 5 defaults to the driver', () => {
    expect(sim().getState().clubId).toBe('driver');
  });

  it('a greenside bunker chip recommends a wedge, not a driver', () => {
    const s = sim();
    const b = HOLE_1.hazards.find((h) => h.kind === 'bunker' && h.d > 480)!;
    s.ball.d = b.d;
    s.ball.x = b.x; // ~16yd from the pin, in the sand
    expect(s.getState().lie).toBe('bunker');
    expect(['sw', 'pw']).toContain(s.recommendedClub());
  });

  it('club scales with distance: far → long club, near → wedge', () => {
    const s = sim();
    s.ball.d = g.d - 210; // long approach on the fairway
    s.ball.x = -6;
    const far = s.recommendedClub();
    s.ball.d = g.d - 40; // short pitch
    const near = s.recommendedClub();
    const order = ['sw', 'pw', '9iron', '7iron', '5iron', 'hybrid', '3wood', 'driver'];
    expect(order.indexOf(far)).toBeGreaterThan(order.indexOf(near));
  });

  it('the auto club never OVERSHOOTS on a CLEAN line: full total lands at/short of the pin', () => {
    // The old rule picked the shortest club that "reaches", so a full-power 3-wood
    // bombed a short par 4's green. The rule picks the LONGEST club that won't
    // overshoot — so full power lands at or short of the pin. Sweep a range of
    // approach distances and assert the recommended club's full-power total is
    // ≤ the distance to the pin (with a wedge-length grace for very short pitches,
    // where even the shortest club needs the power dialled down).
    //
    // ⚠ SWEPT ON A HAZARD-FREE CLONE OF HOLE_1, and that is the point rather than a
    // convenience: HOLE_1's pond ends 25 yd short of its pin, so EVERY lie on the
    // pin line is a forced carry and the never-overshoot rule deliberately yields
    // to the carry rule there (see the next test). Stripping the hazards isolates
    // the property this test is about; the assertion that the line really is clean
    // is made below rather than assumed, so the sweep can't quietly become the
    // other case.
    const g = HOLE_1.green;
    const clean: CourseHole = { ...HOLE_1, hazards: [] };
    let checked = 0;
    for (let R = 90; R <= 480; R += 30) {
      const from = { d: g.d - R, x: g.x }; // straight up the pin line
      expect(clean.hazards.length).toBe(0); // the line cannot be a forced carry
      const s = new CourseSim(clean);
      s.ball.d = from.d;
      s.ball.x = from.x;
      const club = s.recommendedClub();
      const full = new CourseSim(clean).simulateShot({ clubId: club, power: 1, from });
      // ≤ R for anything a club can be dialled to; the sole exception is a shot
      // shorter than a full sand wedge, where SW is the only choice and the
      // finesse curve dials it down.
      expect(full.total, `R=${R} club=${club}`).toBeLessThanOrEqual(Math.max(R, 131));
      checked++;
    }
    expect(checked).toBe(14);
  });

  it('…but a forced carry OUTRANKS it: the pick clears the water when a club can', () => {
    // HOLE_1's pond sits across the pin line, its far edge ~25 yd short of the cup.
    // Landing short of that is a stroke and a replay, which no power setting
    // avoids; running past the pin is a chip back, which the player can avoid by
    // easing off. So where the two rules disagree the CARRY wins — and where no
    // club in the bag can carry it, the never-overshoot club stands rather than
    // handing the player a driver that also comes up wet.
    const g = HOLE_1.green;
    // The pond's far edge, measured from the green centre along the pin line, from
    // the hole data alone.
    const pond = HOLE_1.hazards.find((h) => h.kind === 'water')!;
    const pondFar = g.d - (pond.d + pond.r); // yd short of the green centre
    expect(pondFar).toBeGreaterThan(0); // it really does front the green
    let cleared = 0;
    let unreachable = 0;
    for (let R = 90; R <= 480; R += 30) {
      const from = { d: g.d - R, x: g.x };
      const s = sim();
      s.ball.d = from.d;
      s.ball.x = from.x;
      if (s.getState().lie === 'bunker') continue; // sand has its own wedge rule
      const club = s.recommendedClub();
      const full = sim().simulateShot({ clubId: club, power: 1, from });
      const need = R - pondFar; // carry required from HERE
      // The longest club in the bag carries 291 yd flat; past that the pond is
      // simply not carryable and the pick falls back to the lay-up-safe club.
      if (need > 291) {
        unreachable++;
        continue;
      }
      expect(full.carry, `R=${R} club=${club} needs ${need.toFixed(0)} yd of carry`).toBeGreaterThan(need);
      cleared++;
    }
    expect(cleared).toBeGreaterThanOrEqual(6);
    expect(cleared + unreachable).toBeGreaterThanOrEqual(11);
  });

  it('…and it up-clubs by ONE club, never two: the pick is the shortest that clears', () => {
    // What bounds the overshoot on an APPROACH. The par-3 guards bound it against
    // the green, but an approach has no such landmark — a 300-yd shot over water
    // ending 25 yd short of the flag goes 5-iron → driver and finishes 23 yd past,
    // and no fixed yardage says whether that is the rule working or the rule
    // over-correcting. The invariant that does say it: step 2 stops at the FIRST
    // club that clears, so the pick must be the SHORTEST club whose carry beats the
    // hazard — the least distance the water forces the player to give up.
    //
    // "Shortest" is established by MEASURING every club's real carry from that lie,
    // not by consulting the table the rule uses, so the check cannot agree with the
    // rule by construction. One club of slack is allowed and no more: the rule
    // compares against the flat-lie ladder while this compares against the carry
    // actually flown, and where an uphill lie puts those on opposite sides of the
    // requirement the pick lands one club long (measured: 2 of the 8 forced lies).
    // Two clubs long would be the over-correction, and fails here.
    const g = HOLE_1.green;
    const pond = HOLE_1.hazards.find((h) => h.kind === 'water')!;
    const pondFar = g.d - (pond.d + pond.r);
    const rank = (id: string) => CLUBS.findIndex((c) => c.id === id); // longest → shortest
    const rows: string[] = [];
    let forced = 0;
    let exact = 0;
    for (let R = 120; R <= 300; R += 20) {
      const from = { d: g.d - R, x: g.x };
      const s = sim();
      s.ball.d = from.d;
      s.ball.x = from.x;
      if (s.getState().lie === 'bunker') continue; // sand has its own wedge rule
      const club = s.recommendedClub();
      const need = R - pondFar;
      // The shortest club in the bag whose MEASURED full-power carry clears.
      let shortest: string | null = null;
      for (let i = CLUBS.length - 1; i >= 0; i--) {
        if (sim().simulateShot({ clubId: CLUBS[i]!.id, power: 1, from }).carry > need) {
          shortest = CLUBS[i]!.id;
          break;
        }
      }
      if (shortest == null) continue; // nothing carries it — the fallback case below
      forced++;
      const delta = rank(shortest) - rank(club); // 0 = exactly it, 1 = one club long
      rows.push(
        `  ${pad(R, 4)} yd | needs ${pad(need.toFixed(0), 4)} | picks ${pad(club, 6)} | shortest that clears ${pad(shortest, 6)} | ${delta} club(s) long`,
      );
      expect(delta, `R=${R}: picked ${club}, but ${shortest} already clears`).toBeGreaterThanOrEqual(0);
      expect(delta, `R=${R}: picked ${club} where ${shortest} clears — a two-club over-correction`).toBeLessThanOrEqual(1);
      if (delta === 0) exact++;
    }
    console.log('\n[APPROACH OVER WATER — HOW FAR THE CARRY FORCES YOU UP]\n' + rows.join('\n'));
    expect(forced).toBe(8); // every non-bunker lie in the sweep is a forced carry
    expect(exact).toBeGreaterThanOrEqual(5); // most land on the minimal club exactly
  });

  it('where NOTHING carries the water, the pick is EXACTLY the hazard-free pick', () => {
    // The other half of the approach story, and the guarantee that the carry rule
    // cannot make a hopeless lie worse: past the longest club's reach the pond is
    // simply not carryable, and step 2 must then leave the never-overshoot club
    // alone rather than handing over a driver that comes up wet too. Asserted as
    // EQUALITY against the same sweep run on a hazard-free clone — a bound would
    // not catch a rule that shuffled the club for no gain.
    const g = HOLE_1.green;
    const clean: CourseHole = { ...HOLE_1, hazards: [] };
    const pond = HOLE_1.hazards.find((h) => h.kind === 'water')!;
    const pondFar = g.d - (pond.d + pond.r);
    let checked = 0;
    for (let R = 330; R <= 480; R += 30) {
      const from = { d: g.d - R, x: g.x };
      const need = R - pondFar;
      // Confirm this lie really is beyond every club, by measurement.
      for (const c of CLUBS) {
        expect(sim().simulateShot({ clubId: c.id, power: 1, from }).carry).toBeLessThan(need);
      }
      const s = sim();
      s.ball.d = from.d;
      s.ball.x = from.x;
      const c2 = new CourseSim(clean);
      c2.ball.d = from.d;
      c2.ball.x = from.x;
      expect(s.recommendedClub(), `R=${R}`).toBe(c2.recommendedClub());
      checked++;
    }
    expect(checked).toBe(6);
  });
});

describe('course sim — wedge finesse (controllable short game)', () => {
  // Off-green pitch/chip shots need FINE low-end control. The wedge power→speed
  // map is QUADRATIC with a low floor so a soft pitch is playable, while FULL
  // power is identical to the linear map (A + (1−A)·pᵏ = 1 at p=1) — the club
  // ladder off the tee is untouched. This pins both halves.
  const from = { d: 300, x: 4 }; // a fairway approach lie on HOLE_1

  it('a low-power wedge is a genuine short pitch, and carry grows smoothly with power', () => {
    for (const id of ['pw', 'sw']) {
      const soft = sim().simulateShot({ clubId: id, power: 0.15, from });
      expect(soft.carry).toBeGreaterThan(0);
      expect(soft.carry).toBeLessThan(15); // a controllable chip, not a 35yd jump
      // Monotonic across the whole drag — no dead zone, no jump.
      let prev = -1;
      for (const p of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1]) {
        const c = sim().simulateShot({ clubId: id, power: p, from }).carry;
        expect(c).toBeGreaterThanOrEqual(prev);
        prev = c;
      }
    }
  });

  it('FULL-power carry is UNCHANGED for every club (finesse only lifts the low end)', () => {
    // Baselines measured on HOLE_1 by the harness; the quadratic wedge map must
    // not move any of them (least of all the wedges).
    const expected: Record<string, number> = {
      driver: 278,
      '3wood': 250,
      hybrid: 235,
      '5iron': 213,
      '7iron': 188,
      '9iron': 163,
      pw: 137,
      sw: 109,
    };
    for (const c of CLUBS) {
      const carry = sim().simulateShot({ clubId: c.id, power: 1 }).carry;
      expect(Math.abs(carry - expected[c.id]!)).toBeLessThanOrEqual(2);
    }
  });
});

describe('course sim — play-test fixes (interactive fire path)', () => {
  const g = HOLE_1.green;

  it('a stroke ON THE GREEN is a putt: it rolls, it does not fly off', () => {
    const s = sim();
    s.ball.d = g.d - 8;
    s.ball.x = g.x;
    s.ball.h = 0;
    expect(s.getState().putting).toBe(true);
    fireStraight(s, 1); // full power
    // A putt rolls along the green — it never becomes a 40yd lofted shot: it
    // stays on the green/fringe and finishes within a green's length of start.
    expect(['green', 'fringe', 'holed']).toContain(s.getState().lastResult);
    expect(Math.hypot(s.ball.d - (g.d - 8), s.ball.x - g.x)).toBeLessThan(40);
  });

  it('a putt through the real pipeline can be HOLED', () => {
    // The green breaks and the cup is speed-gated, so only a well-paced putt
    // drops — scan the power band finely to find the holing pace (proving the
    // hole IS holeable through the actual fire path, not that any power works).
    // This is a 6-yd UPHILL putt, so with the low-end-dense quadratic putt map
    // the holing pace lives in the upper part of the drag.
    let holed = false;
    for (let power = 0.3; power <= 0.95; power += 0.01) {
      const s = sim();
      s.ball.d = g.d - 6;
      s.ball.x = g.x;
      s.ball.h = 0;
      fireStraight(s, power);
      if (s.holed) {
        holed = true;
        break;
      }
    }
    expect(holed).toBe(true);
  });

  it('finesse: a soft wedge now flies genuinely short (low power floor)', () => {
    // Before the course floor drop, POWER_FLOOR 0.35 forced even a min wedge to
    // carry ~40yd. A 15% SW must now be a true short pitch.
    const soft = sim().simulateShot({ clubId: 'sw', power: 0.15, from: { d: 300, x: 4 } });
    expect(soft.carry).toBeLessThan(35);
    // Full power is unchanged (floor only lifts the low end).
    const full = sim().simulateShot({ clubId: 'sw', power: 1, from: { d: 300, x: 4 } });
    expect(full.carry).toBeGreaterThan(95);
  });

  it('a ball BEHIND the pin aims back at the cup, not away', () => {
    const s = sim();
    s.strokes = 1; // not the teed drive → the aim base is the pin, not the drive line
    s.selectClub('sw'); // a realistic short shot back toward the pin
    s.ball.d = g.d + 28; // 28yd past the green, on the pin's line
    s.ball.x = g.x;
    s.ball.h = 0;
    fireStraight(s, 0.4);
    // The shot fired BACKWARD toward the pin: from 28yd behind it travelled all
    // the way back to the cup, where the flagstick (now a solid pole) stops a
    // dead-centre runner right AT the hole instead of letting it run through. This
    // still guards the old bug (a clamped bearing that snapped the shot sideways/
    // away and could never turn it around): d must drop sharply toward the pin and
    // x must stay on line.
    expect(g.d + 28 - s.ball.d).toBeGreaterThan(20); // came ~27yd back to the pin
    expect(s.ball.d).toBeLessThan(g.d + 2); // stopped at the pin (the flag caught it)
    expect(s.ball.x).toBeCloseTo(g.x, 0); // and stayed on line (didn't snap sideways)
  });
});

// --- Phase 2: putting scale, holing reliability + short-putt control ----------
// The user played Hole 1 and took 13-14 strokes because putts would not drop and
// short putts could not be feathered. These pin the fixes: the ball is ~0.4× the
// cup (visibly fits), an on-line putt at a normal pace HOLES OUT (via the real
// fire path AND predict()), a too-fast putt does NOT, and a delicate tap on a
// 3-ft putt stays near the hole instead of blasting past.
describe('course sim — putting scale + holing (Phase 2)', () => {
  const g = HOLE_1.green;

  it('the ball is smaller than the cup, at a realistic ~0.4 ratio (visibly fits)', () => {
    expect(BALL_R).toBeLessThan(CUP_R);
    const ratio = BALL_R / CUP_R;
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.5);
  });

  it('an on-line ~6ft putt at a normal pace HOLES OUT (real fire path)', () => {
    // A 2-yd (6-ft) putt aimed straight at the cup: some normal (mid-drag) pace
    // must drop it. Scan a sensible pace band — the point is the hole is reliably
    // makeable, not that one magic number works.
    let holed = false;
    for (let power = 0.35; power <= 0.62; power += 0.02) {
      const s = sim();
      s.strokes = 1; // a putt is never the opening (teed) stroke → aims at the cup
      s.ball.d = g.d;
      s.ball.x = g.x - 2; // 2 yd from the cup, on the cross line
      s.ball.h = 0;
      fireStraight(s, power);
      if (s.holed) {
        holed = true;
        break;
      }
    }
    expect(holed).toBe(true);
  });

  it('predict() reports HOLED for an on-line putt at a holing pace', () => {
    // Phase 3 lights the aim line when predict().result === 'holed', so predict
    // must faithfully report a drop for the same on-line stroke the fire path holes.
    const s = sim();
    s.strokes = 1; // a putt is never the opening (teed) stroke → aims at the cup
    s.ball.d = g.d;
    s.ball.x = g.x - 1; // 3 ft below the cup
    s.ball.h = 0;
    s.power = 0.3; // a modest holing pace for a short putt
    expect(s.getState().putting).toBe(true);
    expect(s.predict(0).result).toBe('holed');
  });

  it('a putt hit much too hard does NOT hole (lips out / rolls over)', () => {
    // Full power over the cup from 6 ft: far above the capture limit, so it runs on.
    const s = sim();
    s.strokes = 1; // a putt is never the opening (teed) stroke → aims at the cup
    s.ball.d = g.d;
    s.ball.x = g.x - 2;
    s.ball.h = 0;
    fireStraight(s, 1); // blast it
    expect(s.holed).toBe(false);
  });

  it('a delicate tap on a 3-ft putt stays near the hole (does not blast past)', () => {
    // The core control complaint: the minimum stroke used to overshoot a short
    // putt. A soft tap on a 1-yd putt must trickle up short of / near the cup,
    // never rocket past it.
    const s = sim();
    s.strokes = 1; // a putt is never the opening (teed) stroke → aims at the cup
    s.ball.d = g.d;
    s.ball.x = g.x - 1; // 3 ft from the cup
    s.ball.h = 0;
    // NOTE: 0.1 is below the MIN_PULL floor, so fireStraight clamps the drag to
    // MIN_PULL and the ACTUAL fired power is the genuine minimum tap (~0.18) — the
    // literal 0.1 is not exercised; this pins that even the softest tap stays put.
    fireStraight(s, 0.1); // barely-there tap
    // It didn't fly off (still a putt outcome) and it did not overshoot: it rests
    // no further from the cup than it started (it came up short / dead).
    expect(['green', 'fringe', 'holed']).toContain(s.getState().lastResult);
    if (!s.holed) {
      expect(Math.hypot(s.ball.d - g.d, s.ball.x - g.x)).toBeLessThanOrEqual(1);
    }
  });

  it('a 3-ft putt is makeable with a controlled (not maxed) stroke', () => {
    // A modest pace in the lower-middle of the drag holes a 3-ft putt — you are
    // NOT forced to the top of the power meter to reach a close hole.
    let holed = false;
    for (let power = 0.2; power <= 0.45; power += 0.02) {
      const s = sim();
      s.strokes = 1; // a putt is never the opening (teed) stroke → aims at the cup
      s.ball.d = g.d;
      s.ball.x = g.x - 1;
      s.ball.h = 0;
      fireStraight(s, power);
      if (s.holed) {
        holed = true;
        break;
      }
    }
    expect(holed).toBe(true);
  });
});

// --- Per-hole best-shot records (drive / closest-to-pin / holed putt) ---------
// The recap POSTs these to /game/golf-records. They accumulate as shots come to
// REST, so simulateShot / simulatePutt / the interactive fire path all feed the
// same numbers — this pins the attribution: the drive is the FIRST full swing's
// total, closest-to-pin is the nearest a non-holing shot rested, and the longest
// putt is the length of a putt that HOLED.
describe('course sim — per-hole best-shot records', () => {
  const g = HOLE_1.green;

  it('drive = the first full swing total; later swings do NOT overwrite it', () => {
    const s = sim();
    const drv = s.simulateShot({ clubId: 'driver', power: 1 }); // opening tee shot
    expect(s.driveYards).not.toBeNull();
    expect(Math.round(s.driveYards!)).toBe(drv.total);
    const locked = s.driveYards;
    // A second full swing from up the fairway must not replace the drive.
    s.simulateShot({ clubId: '7iron', power: 1, from: { d: 300, x: 0 } });
    expect(s.driveYards).toBe(locked);
  });

  it('a first swing that goes OB is not the drive — the replay is', () => {
    const s = sim();
    const ob = s.simulateShot({ clubId: 'driver', power: 1, aimDeg: -35 });
    expect(ob.result).toBe('ob');
    expect(s.driveYards).toBeNull(); // OB doesn't lock a drive
    const good = s.simulateShot({ clubId: 'driver', power: 1, from: { d: 0, x: 0 } });
    expect(['fairway', 'rough', 'green', 'fringe', 'bunker', 'cartpath', 'tee']).toContain(
      good.result,
    );
    expect(Math.round(s.driveYards!)).toBe(good.total); // the in-bounds swing is the drive
  });

  it('closest-to-pin tracks the MINIMUM rest distance across non-holing shots', () => {
    const s = sim();
    const drv = s.simulateShot({ clubId: 'driver', power: 1 }); // far from the pin
    expect(Math.round(s.closestToPinYards!)).toBeLessThanOrEqual(drv.distToPin + 1);
    // A short approach that carries the pond and holds the green must pull the
    // record in. (Full power here trickles off the front into the pond — a real
    // consequence of the back-to-front green guarded by water — so it's played at
    // a controlled pace that finishes on the putting surface.)
    const near = s.simulateShot({
      clubId: 'pw',
      power: 0.85,
      from: { d: g.d - 120, x: g.x },
    });
    const best = Math.min(drv.distToPin, near.distToPin);
    expect(Math.abs(Math.round(s.closestToPinYards!) - best)).toBeLessThanOrEqual(1);
  });

  it('a two-putt does NOT record a ~0 closest-to-pin from the tap — the approach wins', () => {
    const s = sim();
    // An APPROACH (full swing) that finishes several yards from the pin.
    const approach = s.simulateShot({ clubId: 'sw', power: 0.7, from: { d: g.d - 80, x: g.x } });
    expect(approach.result).not.toBe('holed');
    const closestAfterApproach = s.closestToPinYards!;
    expect(Math.round(closestAfterApproach)).toBe(approach.distToPin);
    expect(closestAfterApproach).toBeGreaterThan(2);

    // A lag PUTT (stroke from the green) that trickles up and rests CLOSER to the
    // cup than the approach did. Because putts are excluded, it must NOT become
    // the closest-to-pin — otherwise every two-putt would record a ~0.
    const putt = s.simulatePutt({ d: g.d - 1.5, x: g.x }, 1.5, 0);
    expect(putt.result).not.toBe('holed');
    expect(putt.distToPin).toBeLessThan(closestAfterApproach); // the tap finished closer...
    expect(s.closestToPinYards).toBe(closestAfterApproach); // ...yet closest is unchanged
  });

  it('longest putt = the length of a putt that HOLES OUT (via the fire path)', () => {
    // Scan the power band for the holing pace from 6yd below the cup, then assert
    // the recorded putt length is ~that 6yd putt (not a lofted-shot distance).
    // (Uphill 6-yd putt → the holing pace is high on the quadratic putt map.)
    let holed: CourseSim | null = null;
    for (let power = 0.3; power <= 0.95; power += 0.01) {
      const s = sim();
      s.ball.d = g.d - 6;
      s.ball.x = g.x;
      s.ball.h = 0;
      fireStraight(s, power);
      if (s.holed) {
        holed = s;
        break;
      }
    }
    expect(holed).not.toBeNull();
    expect(holed!.longestPuttYards).not.toBeNull();
    // The putt was struck ~6yd from the cup, so its recorded length is ~6yd.
    expect(holed!.longestPuttYards!).toBeGreaterThan(4);
    expect(holed!.longestPuttYards!).toBeLessThan(8);
  });

  it('no putt is recorded before any putt holes', () => {
    const s = sim();
    s.simulateShot({ clubId: 'driver', power: 1 });
    expect(s.longestPuttYards).toBeNull();
  });
});

// --- Flagstick (pin) collision ------------------------------------------------
// The pin is always in the hole (no in/out toggle) and now has a physical pole
// (POLE_R). A ball reaching the pole at the cup centre is CAPTURED if slow enough
// (drops) or CAROMS off if too fast (stays out, pace killed, direction reversed);
// a ball that never reaches the pole zone is untouched. These pin the three cases
// on a DEAD-FLAT green (FLAT) so the roll tracks straight with no break.
// --- Tree collision (trunk ricochet + canopy brush) --------------------------
// Trees are DETERMINISTIC DATA (terrain.courseTrees) shared by the renderer and
// the sim, so the trunk you see is the trunk you hit. A trunk hit REFLECTS the
// horizontal velocity about the contact normal (central → back, glancing → aside)
// and loses pace; the canopy lightly slows an airborne ball passing through the
// leaves — "just a little", not a hard stop. Exercised AIRBORNE (the trees line
// the OB edge, and an airborne ball doesn't stop on OB until it lands, so the
// carom is isolated from the OB terminator).
describe('course sim — tree collision (trunk ricochet + canopy brush)', () => {
  const trees = courseTrees(HOLE_1);

  it('the grove is deterministic data with sane trunk/canopy dimensions', () => {
    expect(trees.length).toBeGreaterThan(0);
    for (const t of trees) {
      expect(t.trunkR).toBeGreaterThan(0);
      expect(t.canopyR).toBeGreaterThan(t.trunkR);
      expect(Number.isFinite(t.d) && Number.isFinite(t.x) && Number.isFinite(t.ground)).toBe(true);
    }
    // Same list every call (no RNG) — the renderer and sim can never disagree.
    expect(JSON.stringify(courseTrees(HOLE_1))).toBe(JSON.stringify(trees));
  });

  // Fly a low liner straight at trunk `t` from `back` yards short of it, offset
  // `aimX` laterally, at height `relH` above the base (below the trunk top). Track
  // whether the downrange velocity reverses (a carom back), the speed at that
  // reversal, and the greatest lateral speed picked up (a glancing deflection).
  function fireAtTrunk(t: (typeof trees)[number], back: number, aimX: number, relH: number) {
    const s = new CourseSim(HOLE_1);
    const b = s.ball;
    b.d = t.d - back;
    b.x = t.x + aimX;
    b.h = t.ground + relH;
    b.vd = 40;
    b.vx = 0;
    b.vh = 0;
    b.inFlight = true;
    b.grounded = false;
    b.resting = false;
    const v0 = Math.hypot(b.vd, b.vx);
    let reversed = false;
    let speedAtReversal = Infinity;
    let maxVx = 0;
    let prevVd = b.vd;
    let steps = 0;
    while (b.inFlight && steps < 60) {
      s.substep(1 / 120);
      if (prevVd > 0 && b.vd < 0) {
        reversed = true;
        speedAtReversal = Math.hypot(b.vd, b.vx);
      }
      maxVx = Math.max(maxVx, Math.abs(b.vx));
      prevVd = b.vd;
      steps++;
    }
    return { reversed, speedAtReversal, maxVx, v0, ball: b };
  }

  it('a ball fired dead-centre into a trunk ricochets BACK and loses speed', () => {
    const t = trees[0]!;
    const r = fireAtTrunk(t, 4, 0, 1.2); // centre strike, low, well below the trunk top
    expect(r.reversed).toBe(true); // the trunk turned it around
    expect(r.speedAtReversal).toBeLessThan(r.v0); // pace killed by the knock
  });

  it('a GLANCING trunk hit deflects to the side (based on where it hit)', () => {
    const t = trees[0]!;
    // Aimed at the +x flank of the trunk: the contact normal has a +x component, so
    // the ball is kicked sideways (gains lateral speed it launched without).
    const r = fireAtTrunk(t, 4, t.trunkR * 0.7, 1.2);
    expect(r.maxVx).toBeGreaterThan(1); // clearly deflected laterally off the flank
  });

  it('a ball flying OVER the trunk top is not caromed by the trunk', () => {
    const t = trees[0]!;
    // Same central line but ABOVE the trunk top: no trunk hit, so the downrange
    // velocity never reverses (it sails on / brushes canopy only).
    const r = fireAtTrunk(t, 4, 0, t.height + 3);
    expect(r.reversed).toBe(false);
  });

  it('a ball passing THROUGH a canopy is slowed slightly vs clear air', () => {
    const t = trees[0]!;
    // Same launch, integrated the same number of substeps: one through the canopy
    // (just above the trunk top so it's the LEAVES, not the trunk), one clear above
    // the whole tree. Horizontal air drag is identical, so any extra speed loss is
    // the canopy brush.
    const run = (relH: number) => {
      const s = new CourseSim(HOLE_1);
      const b = s.ball;
      b.d = t.d - (t.canopyR + 2);
      b.x = t.x;
      b.h = t.ground + relH;
      b.vd = 30;
      b.vx = 0;
      b.vh = 0;
      b.inFlight = true;
      b.grounded = false;
      b.resting = false;
      for (let i = 0; i < 24 && b.inFlight; i++) s.substep(1 / 120);
      return Math.hypot(b.vd, b.vx);
    };
    const through = run(t.height + t.canopyR * 0.4); // above the trunk, inside the leaves
    const clear = run(t.canopyH + t.canopyR + 25); // well above the tree
    expect(through).toBeLessThan(clear); // leaves brushed pace off — measurably slower
    expect(through).toBeGreaterThan(clear * 0.95); // but only a LITTLE (a few %), a gentle brush
  });

  it('a straight fairway drive with no trees in its path is UNAFFECTED', () => {
    // The invariant: adding trees must not perturb a shot that never nears one.
    // A full driver down the drive line stays in the corridor (trees line the OB
    // edge ~48 yd out), so its rest is identical with the collision code present.
    const m = sim().simulateShot({ clubId: 'driver', power: 1 });
    expect(['fairway', 'rough', 'green', 'fringe', 'bunker', 'cartpath', 'tee']).toContain(
      m.result,
    );
    // Its lateral rest stays well inside the tree line — proof it never caromed.
    expect(Math.abs(m.restX)).toBeLessThan(HOLE_1.roughHalf);
  });
});

// --- The flowering UNDERSTORY drift -----------------------------------------
// The third tree volume, and the only one that exists because of authored ART.
// A hole whose bloom.form is 'understory' draws a mass of flowering shrub at the
// foot of its tree line — 5.3–7.0 yd across and 2.6–3.5 yd tall — and the sim
// used to know nothing about it: the only collidable down there was the 1.3–1.7
// yd trunk cylinder, so a ball rolled through eight yards of apparent shrub and
// felt nothing. `courseTrees` now emits shrubR/shrubH for exactly those trees and
// `brushShrub` drags a ball inside one. It DAMPS and never caroms — a forsythia
// is not a trunk.
describe('course sim — understory drift (a thicket, not a phantom)', () => {
  // HOLE_1 with each of the two bloom forms. Same hole, same trees, same seeds:
  // the ONLY difference is which form the blossom takes, which is exactly the
  // difference under test.
  const DRIFTED: CourseHole = {
    ...HOLE_1,
    bloom: { color: 0xfbdc12, fraction: 0.8, form: 'understory' },
  };
  const TINTED: CourseHole = { ...HOLE_1, bloom: { color: 0xf2a0bd, fraction: 0.8 } };
  const drift = courseTrees(DRIFTED).find((t) => t.shrubR !== undefined)!;

  it('a CANOPY bloom leaves the ball’s world untouched, shot for shot', () => {
    // The property holes 2, 13 and 16 rest on, asserted through the SIM rather
    // than through the data: tint the crowns and every shot in the bag finishes
    // in the identical place. If a future bloom field ever leaks into physics,
    // this is the test that should fail first.
    for (const clubId of ['driver', 'iron7', 'wedge']) {
      const a = new CourseSim(HOLE_1).simulateShot({ clubId, power: 1 });
      const b = new CourseSim(TINTED).simulateShot({ clubId, power: 1 });
      expect(JSON.stringify(b), clubId).toBe(JSON.stringify(a));
    }
  });

  // Fly a ball through the drift's centre at `relH` above its base and return the
  // horizontal speed 0.2 s later. The CONTROL is the same flight on TINTED — the
  // identical hole, grove and seeds with the blossom in the crowns instead — so
  // air drag, terrain and every other force are bit-for-bit the same and the only
  // possible difference is the drift.
  const flyThrough = (hole: CourseHole, relH: number): number => {
    const s = new CourseSim(hole);
    const b = s.ball;
    b.d = drift.d - 3;
    b.x = drift.x;
    b.h = drift.ground + relH;
    b.vd = 30;
    b.vx = 0;
    b.vh = 0;
    b.inFlight = true;
    b.grounded = false;
    b.resting = false;
    for (let i = 0; i < 48 && b.inFlight; i++) s.substep(1 / 240);
    return Math.hypot(b.vd, b.vx);
  };

  it('drags a low ball down HARD — this is the phantom, closed', () => {
    const relH = drift.shrubH! * 0.6;
    const through = flyThrough(DRIFTED, relH);
    const clear = flyThrough(TINTED, relH);
    // Not the canopy's "just a little" (which is >0.95 of clear air over the same
    // window): a thicket takes a real bite.
    expect(through).toBeLessThan(clear * 0.75);
  });

  it('never reverses the ball — a shrub catches, it does not carom', () => {
    const s = new CourseSim(DRIFTED);
    const b = s.ball;
    b.d = drift.d - 12;
    b.x = drift.x;
    b.h = drift.ground + drift.shrubH! * 0.3;
    b.vd = 30;
    b.vx = 0;
    b.vh = 0;
    b.inFlight = true;
    b.grounded = false;
    b.resting = false;
    for (let i = 0; i < 120 && b.inFlight; i++) {
      s.substep(1 / 240);
      expect(b.vd).toBeGreaterThanOrEqual(0); // slowed, never sent back
      expect(Math.abs(b.vx)).toBeLessThan(1e-9); // and never kicked sideways
    }
  });

  it('lets a ball OVER the drift through untouched', () => {
    // A yard above the envelope is clear air: the drift must not reach up into
    // the band a normal approach flies through. (The canopy sphere starts at
    // 3.6·scale, well above the drift's 1.6·scale, so there is nothing else here
    // to confuse the measurement.)
    const relH = drift.shrubH! + 1;
    expect(flyThrough(DRIFTED, relH)).toBeCloseTo(flyThrough(TINTED, relH), 6);
  });

  // ⚠ THE ONE PLACE THIS CHANGES A PLAYABLE SHOT, and it is worth pinning by
  // name. HOLE_1's tree line stands 8 yd OUTSIDE the OB edge, so a rolling ball
  // is out of bounds long before it reaches a drift — the whole grove is
  // unreachable on the ground. Augusta 8 doglegs 34° left and its right-hand tree
  // line crowds the corner, so a drift there does spill onto playable ground.
  //
  // ⚠ THE SELECTOR CHANGED, AND WHY MATTERS. This used to look for a tree whose
  // TRUNK stood in rough, which worked only because the grove's lateral x-offset
  // let the tree line walk INTO the corridor on a dogleg (GOLF.md defect 14).
  // `clearOfCorridor` fixed that, and a selector keyed to the bug went undefined
  // the moment it did. The drift is what has to reach playable ground, not the
  // trunk: the trunk now clears by trunkR while shrubR (3.2·scale) still extends
  // ~4 yd back inside, which is the whole reason the wider "push the canopy out
  // too" variant of that fix was rejected — it would have lifted every drift out
  // of play and left brushShrub with nothing to damp.
  it('catches a ball rolling through a drift that reaches PLAYABLE ground on Augusta 8', () => {
    const hole8 = getCourse('augusta').holes.find((h) => h.id === 8)!;
    const { bloom: _b, ...plain } = hole8;
    // Find a drift that overlaps the corridor, and a line through it that is
    // actually in rough — stepping inward from the trunk, which is now OB.
    let inPlay: ReturnType<typeof courseTrees>[number] | undefined;
    let ballX = 0;
    outer: for (const t of courseTrees(hole8)) {
      if (t.shrubR === undefined) continue;
      for (let step = 0.5; step < t.shrubR - 0.5; step += 0.5) {
        for (const cand of [t.x - step, t.x + step]) {
          if (
            surfaceAt(hole8, t.d, cand) === 'rough' &&
            surfaceAt(hole8, t.d - t.shrubR - 1, cand) === 'rough'
          ) {
            inPlay = t;
            ballX = cand;
            break outer;
          }
        }
      }
    }
    expect(inPlay, 'no drift reaches playable ground — the premise of this test moved').toBeDefined();

    const roll = (hole: CourseHole) => {
      const s = new CourseSim(hole);
      const b = s.ball;
      b.d = inPlay!.d - inPlay!.shrubR! - 1;
      b.x = ballX;
      b.h = heightAt(hole, b.d, b.x);
      b.vd = 20;
      b.vx = 0;
      b.vh = 0;
      b.inFlight = true;
      b.grounded = true;
      b.resting = false;
      for (let i = 0; i < 2000 && b.inFlight; i++) s.substep(1 / 240);
      return b.d - (inPlay!.d - inPlay!.shrubR! - 1);
    };
    const withDrift = roll(hole8);
    const without = roll(plain as CourseHole);
    // The ball runs into the shrub and gives up in it, a third of its run short
    // of where the bare hole let it go (measured: 3.1 yd against 4.6). That IS a
    // gameplay change, and it is the point: there is a flowering mass drawn
    // there, and it should cost something to roll into it.
    expect(withDrift).toBeLessThan(without * 0.8);
  });

  it('the envelope is a SHRUB, and only the flowering trees have one', () => {
    const trees = courseTrees(DRIFTED);
    const drifts = trees.filter((t) => t.shrubR !== undefined);
    expect(drifts.length).toBeGreaterThan(4);
    expect(drifts.length).toBeLessThan(trees.length); // never the whole grove
    for (const t of drifts) {
      expect(t.kind).toBe('broadleaf');
      expect(t.shrubR!).toBeGreaterThan(t.trunkR); // wider than the trunk it rings
      expect(t.shrubR!).toBeLessThan(t.canopyR); // narrower than the crown above
      expect(t.shrubH!).toBeLessThan(t.height); // and shorter than the trunk
    }
    // A tree with no bloom has no drift, so two trees of identical geometry can
    // carry different colliders. That is the point, not an accident.
    expect(trees.some((t) => t.bloom === undefined && t.shrubR === undefined)).toBe(true);
    // …and a hole with no bloom at all has none anywhere.
    expect(courseTrees(HOLE_1).some((t) => t.shrubR !== undefined)).toBe(false);
  });
});

describe('course sim — flagstick (pin) collision', () => {
  const p = HOLE_1.pin; // { d: 512, x: 18 }, at the cup centre

  // Roll a grounded ball straight at the pin (+d) from `back` yards below it at
  // the given ground speed on the flat hole, integrating to rest. Records whether
  // it holed, whether the downrange velocity ever reversed (a carom), and the
  // speed at that reversal.
  function atPin(speed: number, back: number) {
    const s = new CourseSim(FLAT);
    const b = s.ball;
    b.d = p.d - back;
    b.x = p.x;
    b.h = 0;
    b.vd = speed;
    b.vx = 0;
    b.inFlight = true;
    b.grounded = true;
    b.resting = false;
    let reversed = false;
    let speedAtReversal = Infinity;
    let prevVd = b.vd;
    let steps = 0;
    while (b.inFlight && steps < 100000) {
      s.substep(1 / 120);
      if (prevVd > 0 && b.vd < 0) {
        reversed = true;
        speedAtReversal = Math.hypot(b.vd, b.vx);
      }
      prevVd = b.vd;
      steps++;
    }
    return { ball: b, result: s.getState().lastResult, reversed, speedAtReversal };
  }

  it('a SLOW strike straight at the pin drops (holes out)', () => {
    // A gentle roll that arrives at the cup dead weight: the pin is at the centre,
    // so it is captured and holes — a slow strike drops.
    const r = atPin(1.8, 1.2);
    expect(r.result).toBe('holed');
  });

  it('a FAST strike deflects: stays out, pace killed, direction reversed', () => {
    // The same line hit far too hard reaches the pole still fast, so it caroms off
    // the flagstick instead of dropping: it never holes, its downrange velocity
    // reverses at reduced pace, and it ends OUTSIDE the cup on the near side.
    const r = atPin(8, 1.2);
    expect(r.result).not.toBe('holed');
    expect(r.reversed).toBe(true); // the pole turned it around
    expect(r.speedAtReversal).toBeLessThan(8); // pace killed by the carom
    expect(r.ball.d).toBeLessThan(p.d); // bounced back down the green
    expect(Math.hypot(r.ball.d - p.d, r.ball.x - p.x)).toBeGreaterThan(CUP_R);
  });

  it('a VERY FAST strike is caught by the SWEPT test (no tunneling through the pin)', () => {
    // At 100 yd/s the ball steps ~0.83yd per 1/120s substep — well over the
    // ~0.56yd pin zone — so a single-point per-substep test would let it step
    // clean over the pin and tunnel through undeflected. The swept segment test
    // catches it: it still deflects (never holes) and its downrange velocity
    // reverses at reduced pace. (This is the regime the reviewer flagged as the
    // "all other club/shot types" case — a powered liner straight at the flag.)
    const r = atPin(100, 2);
    expect(r.result).not.toBe('holed');
    expect(r.reversed).toBe(true); // the pole turned it around (didn't pass through)
    expect(r.speedAtReversal).toBeLessThan(100);
  });

  it('a ball that MISSES the pin is untouched (no phantom deflection)', () => {
    // Rolls parallel to and 1yd left of the pin — always outside the pole zone
    // (POLE_R + BALL_R ≈ 0.28yd) — so the flagstick never acts: it tracks dead
    // straight (vx stays exactly 0 on the flat green) and holes nothing, exactly
    // as before the pin existed.
    const s = new CourseSim(FLAT);
    const b = s.ball;
    b.d = p.d - 4;
    b.x = p.x + 1; // a yard off the pin line
    b.h = 0;
    b.vd = 5;
    b.vx = 0;
    b.inFlight = true;
    b.grounded = true;
    b.resting = false;
    let maxVx = 0;
    let steps = 0;
    while (b.inFlight && steps < 100000) {
      s.substep(1 / 120);
      maxVx = Math.max(maxVx, Math.abs(b.vx));
      steps++;
    }
    expect(s.getState().lastResult).not.toBe('holed');
    expect(maxVx).toBe(0); // never nudged sideways by the pin
    expect(b.x).toBeCloseTo(p.x + 1, 6); // stayed on its line
  });
});
