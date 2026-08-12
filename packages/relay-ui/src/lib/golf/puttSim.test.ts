// Headless harness for the revamped mini-golf sim (lib/golf/puttSim.ts). Proves
// the slope-coupled Coulomb engine actually plays the puttField slope schema: a
// putt on a tilt BREAKS vs a flat control, the same power downhill runs out
// further than uphill, a ball RESTS on a mild slope but keeps creeping on a
// steep one, cup capture holes an on-pace putt and skips a too-fast one, a bank
// shot reflects and continues, and identical inputs are byte-for-byte
// deterministic. The mini-scale constants (tuning.ts) were tuned against THIS.
//
// Run: `pnpm --filter @relay/ui test`.

import { describe, it, expect } from 'vitest';
import { PuttSim, type Hole, type Vec } from './puttSim';
import { puttHole } from './puttCourses/builder';
import { FIXED_MS, MAX_LAUNCH_SPEED, PUTT_CAPTURE_SPEED } from './tuning';

const H = FIXED_MS / 1000;

// A far-corner cup so a straight-up putt never nears it (for tests that measure
// where the ball SETTLES rather than whether it holes).
const FAR_CUP = { x: 85, y: 14 };

function hole(over: Partial<Parameters<typeof puttHole>[0]> = {}): Hole {
  return puttHole({
    id: 1,
    par: 3,
    tee: { x: 50, y: 100 },
    cup: FAR_CUP,
    ...over,
  });
}

// Directly inject a grounded launch velocity and integrate to rest (or a cap).
// Records the min vx seen (to detect a reflection) and whether a sink fired.
function roll(h: Hole, vel: Vec, maxSteps = 100000) {
  const sim = new PuttSim(h);
  const b = sim.ball;
  b.pos = { x: h.tee.x, y: h.tee.y };
  b.vel = { x: vel.x, y: vel.y };
  b.resting = false;
  let steps = 0;
  let minVx = vel.x;
  let sank = false;
  while (!b.resting && steps < maxSteps) {
    sim.substep(H);
    minVx = Math.min(minVx, b.vel.x);
    for (const ev of sim.drainEvents()) if (ev.type === 'sink') sank = true;
    steps++;
  }
  return { sim, ball: b, steps, minVx, sank };
}

describe('puttSim — a putt BREAKS on a lateral tilt', () => {
  it('a straight putt across a 5% sidehill ends offset vs a flat control', () => {
    const flat = roll(hole(), { x: 0, y: -150 });
    const tilted = roll(
      hole({ tilts: [{ region: { x0: 14, y0: 8, x1: 86, y1: 117 }, gradePct: 5, dirDeg: 0 }] }),
      { x: 0, y: -150 },
    );
    // Flat control tracks dead straight up the board.
    expect(Math.abs(flat.ball.pos.x - 50)).toBeLessThan(0.5);
    // The tilt (downhill = +x) curls the ball measurably to the RIGHT.
    expect(tilted.ball.pos.x).toBeGreaterThan(flat.ball.pos.x + 3);
  });
});

describe('puttSim — downhill runs out further than uphill', () => {
  it('the same launch speed rolls further with the slope than against it', () => {
    // dirDeg 270 = downhill toward −y (the launch direction); 90 = uphill.
    const downhill = roll(
      hole({ tilts: [{ region: { x0: 14, y0: 8, x1: 86, y1: 117 }, gradePct: 3, dirDeg: 270 }] }),
      { x: 0, y: -150 },
    );
    const uphill = roll(
      hole({ tilts: [{ region: { x0: 14, y0: 8, x1: 86, y1: 117 }, gradePct: 3, dirDeg: 90 }] }),
      { x: 0, y: -150 },
    );
    const dDown = Math.abs(downhill.ball.pos.y - 100);
    const dUp = Math.abs(uphill.ball.pos.y - 100);
    expect(dDown).toBeGreaterThan(dUp + 15);
  });
});

describe('puttSim — the static-rest rule', () => {
  it('rests on a mild slope (grade under the static hold)', () => {
    // 4% < the ~7.9% max holdable grade → a gentle roll settles.
    const r = roll(
      hole({ tilts: [{ region: { x0: 14, y0: 8, x1: 86, y1: 117 }, gradePct: 4, dirDeg: 0 }] }),
      { x: 8, y: -8 },
    );
    expect(r.ball.resting).toBe(true);
    expect(r.steps).toBeLessThan(100000);
  });

  it('never settles on a steep slope — still moving after 3 seconds', () => {
    // 14% > the max holdable grade → the slope keeps feeding the ball downhill;
    // it must NOT be at rest after 3 s of sim time. The tilt spans the FULL
    // board (to the walls) so there is no flat shelf for the ball to rest on.
    const sim = new PuttSim(
      hole({ tilts: [{ region: { x0: 8, y0: 8, x1: 92, y1: 117 }, gradePct: 14, dirDeg: 0 }] }),
    );
    const b = sim.ball;
    b.pos = { x: 30, y: 60 };
    b.vel = { x: 0, y: 0 };
    b.resting = false;
    for (let i = 0; i < Math.round(3 / H); i++) sim.substep(H);
    expect(b.resting).toBe(false);
  });
});

describe('puttSim — speed-dependent cup capture', () => {
  // Straight-up putt into a cup 60 units ahead. On-pace arrives slow → drops;
  // hot arrives fast → skips over (no sink before it crosses the cup line).
  const cupHole = (): Hole => hole({ tee: { x: 50, y: 100 }, cup: { x: 50, y: 40 } });

  it('an on-pace putt drops', () => {
    // v tuned so the flat roll-out just reaches the cup ~dead weight.
    const r = roll(cupHole(), { x: 0, y: -156 });
    expect(r.sank).toBe(true);
  });

  it('a too-fast putt does not drop (it skips the cup)', () => {
    const sim = new PuttSim(cupHole());
    const b = sim.ball;
    b.pos = { x: 50, y: 100 };
    b.vel = { x: 0, y: -MAX_LAUNCH_SPEED };
    b.resting = false;
    let sankBeforeCrossing = false;
    // Run only until the ball has clearly passed the cup line (y well past 40).
    while (!b.resting && b.pos.y > 30) {
      sim.substep(H);
      for (const ev of sim.drainEvents()) if (ev.type === 'sink') sankBeforeCrossing = true;
    }
    expect(sankBeforeCrossing).toBe(false);
    expect(b.pos.y).toBeLessThan(40); // it made it past the hole
  });
});

describe('puttSim — bank shots', () => {
  it('a shot into a banked rail reflects and keeps moving', () => {
    // A vertical banked rail near x=80; launch up-and-right into it.
    const banked = hole({ walls: [{ a: { x: 80, y: 8 }, b: { x: 80, y: 117 }, bank: true }] });
    const r = roll(banked, { x: 120, y: -70 });
    // It reflected off the rail (lateral velocity flipped negative at some point)
    expect(r.minVx).toBeLessThan(0);
    // …and the sim still terminated at rest (the ball continued, didn't stick).
    expect(r.ball.resting).toBe(true);
    expect(r.steps).toBeGreaterThan(1);
  });
});

describe('puttSim — determinism', () => {
  it('identical inputs + identical substep progression give identical state', () => {
    const mk = () =>
      hole({ tilts: [{ region: { x0: 14, y0: 8, x1: 86, y1: 117 }, gradePct: 4, dirDeg: 30 }] });
    const runN = (n: number) => {
      const sim = new PuttSim(mk());
      const b = sim.ball;
      b.pos = { x: 40, y: 90 };
      b.vel = { x: 20, y: -120 };
      b.resting = false;
      for (let i = 0; i < n; i++) sim.substep(H);
      return { pos: { ...b.pos }, vel: { ...b.vel }, resting: b.resting, simTime: sim.simTime };
    };
    const a = runN(400);
    const b = runN(400);
    expect(a).toEqual(b);
    // simTime is a pure accumulation of h.
    expect(a.simTime).toBeCloseTo(400 * H, 9);
  });
});

describe('puttSim — full-power putt crosses the board', () => {
  it('a max-power putt rolls past the far side (crosses ~80 units and overshoots)', () => {
    // Flat board, no cup in the way (far corner). From y=110 a full putt must
    // travel well past the 80-unit tee→top span.
    const sim = new PuttSim(hole({ tee: { x: 50, y: 112 } }));
    const b = sim.ball;
    b.pos = { x: 50, y: 112 };
    b.vel = { x: 0, y: -MAX_LAUNCH_SPEED };
    b.resting = false;
    let steps = 0;
    let minY = b.pos.y;
    while (!b.resting && steps < 100000) {
      sim.substep(H);
      minY = Math.min(minY, b.pos.y);
      steps++;
    }
    // The roll-out carried the ball to the top wall region (y≈8+BALL_R) — from
    // the tee at y=112 that is the whole ~100-unit board crossed and then some
    // (it caroms off the far wall before settling).
    expect(minY).toBeLessThan(14);
    // Sanity on the capture-speed scale wiring (used above): a real number.
    expect(PUTT_CAPTURE_SPEED).toBeGreaterThan(0);
  });
});
