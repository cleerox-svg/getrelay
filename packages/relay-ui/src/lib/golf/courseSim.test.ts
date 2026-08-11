// Headless harness for the terrain-aware course sim (lib/golf/courseSim.ts).
// Proves the ball actually plays the HOLE_1 heightfield: full shots land on the
// terrain and finish with a real lie, a putt on the tilted green BREAKS and can
// be HOLED, an approach into the pond/rough/bunker resolves the way the hole is
// drawn, and a downhill putt outruns the same uphill putt. Tune slope/lie feel
// against THIS (and the range harness for the flat ballistics it shares).

import { describe, it, expect } from 'vitest';
import { CourseSim } from './courseSim';
import { HOLE_1, surfaceAt, type CourseHole } from './terrain';
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

  it('a well-judged putt straight at the cup is HOLED', () => {
    // From just below the hole, up the fall line at a well-judged (dead-weight)
    // pace, it drops. Too soft leaves it short; too firm lips out — only the
    // right band holes, which is the point of speed-dependent capture.
    let holed = false;
    for (const speed of [4.0, 4.4, 4.8, 5.2, 5.6]) {
      const m = sim().simulatePutt({ d: g.d - 7, x: g.x }, speed, 0);
      if (m.result === 'holed') {
        holed = true;
        break;
      }
    }
    expect(holed).toBe(true);
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

  it('the auto club never OVERSHOOTS: its full-power total lands at/short of the pin', () => {
    // The old rule picked the shortest club that "reaches", so a full-power 3-wood
    // bombed a short par 4's green. The new rule picks the LONGEST club that won't
    // overshoot — so full power lands at or short of the pin. Sweep a range of
    // approach distances and assert the recommended club's full-power total is
    // ≤ the distance to the pin (with a wedge-length grace for very short pitches,
    // where even the shortest club needs the power dialled down).
    const g = HOLE_1.green;
    for (let R = 90; R <= 480; R += 30) {
      const s = sim();
      s.ball.d = g.d - R; // straight up the pin line
      s.ball.x = g.x;
      const club = s.recommendedClub();
      const full = sim().simulateShot({ clubId: club, power: 1, from: { d: g.d - R, x: g.x } });
      // ≤ R for anything a club can be dialled to; the sole exception is a shot
      // shorter than a full sand wedge, where SW is the only choice and the
      // finesse curve dials it down.
      expect(full.total).toBeLessThanOrEqual(Math.max(R, 131));
    }
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
    // The shot fired BACKWARD toward the pin — its downrange position dropped by
    // more than the 28yd gap, carrying it back past the cup. The old clamped
    // bearing snapped sideways/away and could never turn the shot around.
    expect(s.ball.d).toBeLessThan(g.d); // ended up on the pin's side, not behind
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
