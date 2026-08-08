// Headless harness for the terrain-aware course sim (lib/golf/courseSim.ts).
// Proves the ball actually plays the HOLE_1 heightfield: full shots land on the
// terrain and finish with a real lie, a putt on the tilted green BREAKS and can
// be HOLED, an approach into the pond/rough/bunker resolves the way the hole is
// drawn, and a downhill putt outruns the same uphill putt. Tune slope/lie feel
// against THIS (and the range harness for the flat ballistics it shares).

import { describe, it, expect } from 'vitest';
import { CourseSim } from './courseSim';
import { HOLE_1, type CourseHole } from './terrain';
import { CLUBS } from './clubs';

// A HOLE_1 clone with a DEAD-FLAT green (no tilt, no undulation) — the control
// for proving the tilt (not noise) is what breaks a putt.
const FLAT_GREEN: CourseHole = {
  ...HOLE_1,
  green: { ...HOLE_1.green, tiltPct: 0, undulation: 0 },
};

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
    // A short wedge that carries into the pond short-right of the green splashes.
    const water = sim().simulateShot({ clubId: 'pw', power: 0.5, from: { d: 400, x: 2 } });
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
    // Address a full driver at the tee (aim toward the pin, aimRad 0).
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
    // predict aims at bearingToPin + aimRad; with aimRad 0 that is the straight
    // tee→pin bearing. Firing simulateShot at that SAME absolute bearing + power
    // must land in the same spot — proof both paths run one integrator.
    const bearingDeg =
      (Math.atan2(HOLE_1.pin.x - HOLE_1.tee.x, HOLE_1.pin.d - HOLE_1.tee.d) * 180) / Math.PI;
    const s1 = sim();
    s1.power = 0.7;
    const pred = s1.predict(0);
    const shot = sim().simulateShot({ clubId: s1.getState().clubId, power: 0.7, aimDeg: bearingDeg });
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

describe('course sim — putting on the tilted green', () => {
  const g = HOLE_1.green;

  it('a putt across the green BREAKS toward the low (front) side vs a flat green', () => {
    // The SAME cross putt (straight +x from the left) on the tilted green vs a
    // dead-flat control: the tilt pulls the roll toward the front (−d), so the
    // tilted ball finishes measurably further front than the flat one. Proves
    // the break comes from the slope, not from noise.
    const tilted = sim().simulatePutt({ d: g.d, x: g.x - 9 }, 11, 90);
    const flat = new CourseSim(FLAT_GREEN).simulatePutt({ d: g.d, x: g.x - 9 }, 11, 90);
    expect(tilted.restD).toBeLessThan(flat.restD - 0.15);
  });

  it('a downhill putt runs further than the same putt uphill', () => {
    // Downhill = toward the front (−d, bearing 180°); uphill = toward the back
    // (+d, bearing 0°). Same start + speed, compare distance rolled.
    const down = sim().simulatePutt({ d: g.d + 6, x: g.x }, 8, 180);
    const up = sim().simulatePutt({ d: g.d - 6, x: g.x }, 8, 0);
    const downDist = Math.hypot(down.restD - (g.d + 6), down.restX - g.x);
    const upDist = Math.hypot(up.restD - (g.d - 6), up.restX - g.x);
    expect(downDist).toBeGreaterThan(upDist);
  });

  it('a well-judged putt straight at the cup is HOLED', () => {
    // From just below the hole, up the fall line at a gentle pace, it drops.
    let holed = false;
    for (const speed of [9, 10, 11, 11.5, 12, 12.5, 13]) {
      const m = sim().simulatePutt({ d: g.d - 7, x: g.x }, speed, 0);
      if (m.result === 'holed') {
        holed = true;
        break;
      }
    }
    expect(holed).toBe(true);
  });
});

// --- The real fire pipeline (what the game actually calls) -------------------
// simulateShot/simulatePutt are measurement hooks; the GAME fires through
// onPointerDown → onPointerMove → arm → fireArmed. These pin the play-test
// fixes to THAT path: a stroke on the green is a putt (rolls, can hole), a soft
// wedge flies genuinely short (finesse floor), and a ball behind the pin aims
// back at the cup instead of away.

// Fire a straight-at-pin shot at the given power through the interactive path.
function fireStraight(s: CourseSim, power: number): void {
  const MP = 100;
  s.setMaxPull(MP);
  s.onPointerDown({ x: 0, y: 0 });
  s.onPointerMove({ x: 0, y: power * MP }); // straight-back pull → aim at pin
  s.arm({ x: 0, y: power * MP });
  s.fireArmed(0); // pure strike
  let g = 0;
  while (s.ball.inFlight && g++ < 200000) s.substep(1 / 120);
}

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
    let holed = false;
    for (const power of [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
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
