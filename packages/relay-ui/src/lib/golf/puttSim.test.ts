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
import { puttHole, windmill, pendulum, tunnel } from './puttCourses/builder';
import { FIXED_MS, MAX_LAUNCH_SPEED, PUTT_CAPTURE_SPEED, BALL_R, MAX_PULL } from './tuning';
import {
  obstacleSegments,
  reflectMovingSegment,
  tunnelCrossing,
  type PendulumObstacle,
  type TunnelObstacle,
  type WindmillObstacle,
} from './puttObstacles';
import { BLADE_RESTITUTION, BLADE_MAX_SURFACE_SPEED } from './tuning';

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

// --- Phase 2: moving obstacles, tunnels, hazards --------------------------

describe('puttObstacles — a windmill blade deflects the ball reproducibly', () => {
  it('reflects + imparts blade momentum at a fixed simTime, byte-identical twice', () => {
    // One horizontal blade (angle 0 at simTime 0): pivot→(+x). Ball just above the
    // blade, rolling down into it.
    const wm: WindmillObstacle = {
      kind: 'windmill',
      pivot: { x: 50, y: 60 },
      bladeLen: 20,
      bladeCount: 1,
      omega: 2,
      phase0: 0,
    };
    const seg = obstacleSegments(wm, 0)[0]!;
    const deflect = (omega: number) =>
      reflectMovingSegment(
        { x: 60, y: 60.5 },
        { x: 0, y: -30 },
        BALL_R,
        { ...seg, omega },
        BLADE_RESTITUTION,
        BLADE_MAX_SURFACE_SPEED,
      );
    const a = deflect(wm.omega);
    expect(a.hit).toBe(true);
    // The blade reverses the approach (vel.y flips positive)…
    expect(a.vel.y).toBeGreaterThan(0);
    // …and a SPINNING blade imparts extra momentum vs a still one (ω×r here is
    // along +y at the contact, so it shoves the ball off harder).
    expect(a.vel.y).toBeGreaterThan(deflect(0).vel.y);
    // Deterministic: same simTime + inputs → byte-identical.
    expect(deflect(wm.omega)).toEqual(a);
  });

  it('bounds the imparted blade surface speed (a fast blade cannot fling the ball)', () => {
    // A very long, very fast blade would have a huge tip speed; the momentum it
    // imparts is clamped to BLADE_MAX_SURFACE_SPEED.
    const wm: WindmillObstacle = {
      kind: 'windmill',
      pivot: { x: 50, y: 60 },
      bladeLen: 40,
      bladeCount: 1,
      omega: 20,
      phase0: 0,
    };
    const seg = obstacleSegments(wm, 0)[0]!;
    const res = reflectMovingSegment(
      { x: 88, y: 60.5 },
      { x: 0, y: -10 },
      BALL_R,
      seg,
      BLADE_RESTITUTION,
      BLADE_MAX_SURFACE_SPEED,
    );
    expect(res.hit).toBe(true);
    // Unclamped, this blade's tip speed (~800) would fling the ball to ~1300;
    // clamped to BLADE_MAX_SURFACE_SPEED the moving-wall reflection is bounded by
    // ~(1+e)·maxSurfaceSpeed + e·approach, well under 300.
    expect(Math.hypot(res.vel.x, res.vel.y)).toBeLessThan(300);
  });
});

describe('puttObstacles — a swinging gate blocks at one phase and passes at another', () => {
  const pen: PendulumObstacle = {
    kind: 'pendulum',
    pivot: { x: 50, y: 50 },
    length: 20,
    centerDeg: 90, // arm points +y (down the board) at rest
    ampDeg: 60,
    omega: 3,
    phase0: 0,
  };
  // A fixed point on the rest-position arm (x=50, below the pivot).
  const ballPos: Vec = { x: 51, y: 68 };
  const probe = (t: number) =>
    reflectMovingSegment(
      ballPos,
      { x: -30, y: 0 },
      BALL_R,
      obstacleSegments(pen, t)[0]!,
      BLADE_RESTITUTION,
      BLADE_MAX_SURFACE_SPEED,
    );

  it('blocks when the arm covers the gap (simTime 0)', () => {
    expect(probe(0).hit).toBe(true);
  });

  it('passes when the arm has swung clear (simTime π/6, arm at +60°)', () => {
    // At t = π/6, sin(ω t) = 1 → angle 150°, the arm is up-left, far from the
    // probe point, so the ball rolls through untouched.
    expect(probe(Math.PI / 6).hit).toBe(false);
  });
});

describe('puttObstacles — a tunnel teleports mouthA→mouthB preserving speed', () => {
  const tun: TunnelObstacle = {
    kind: 'tunnel',
    mouthA: { a: { x: 56, y: 72 }, b: { x: 44, y: 72 } },
    mouthB: { a: { x: 44, y: 40 }, b: { x: 56, y: 40 } },
  };

  it('maps an inbound crossing to the far mouth, |v| unchanged', () => {
    const vel: Vec = { x: 0, y: -100 };
    const tp = tunnelCrossing(tun, { x: 50, y: 74 }, { x: 50, y: 71 }, vel, BALL_R + 0.5);
    expect(tp).not.toBeNull();
    // Speed preserved through the portal.
    expect(Math.hypot(tp!.vel.x, tp!.vel.y)).toBeCloseTo(100, 6);
    // Emerges at the far (upper) mouth, above it, still travelling up.
    expect(tp!.pos.y).toBeLessThan(40);
    expect(tp!.vel.y).toBeLessThan(0);
  });

  it('through a hole the tunnel does not re-enter-loop — the sim settles', () => {
    const h = hole({
      tee: { x: 50, y: 100 },
      cup: { x: 12, y: 110 }, // far corner, out of the way
      obstacles: [
        tunnel(
          [
            { x: 56, y: 72 },
            { x: 44, y: 72 },
          ],
          [
            { x: 44, y: 40 },
            { x: 56, y: 40 },
          ],
        ),
      ],
    });
    const r = roll(h, { x: 0, y: -140 });
    // It teleported up past the tunnel and settled (no infinite ping-pong).
    expect(r.ball.resting).toBe(true);
    expect(r.steps).toBeLessThan(100000);
    expect(r.ball.pos.y).toBeLessThan(40);
  });
});

describe('puttSim — water hazard resets to the start of the shot (+penalty)', () => {
  it('rolling into water returns the ball to the launch point and emits penalty', () => {
    const h = hole({
      tee: { x: 50, y: 100 },
      cup: { x: 85, y: 14 },
      hazards: [{ kind: 'water', region: { x0: 30, y0: 40, x1: 70, y1: 70 } }],
    });
    const sim = new PuttSim(h);
    // Launch straight up (drag down) at full power through the input pipeline so
    // the shot-start capture path runs.
    sim.onPointerDown({ x: 50, y: 100 });
    sim.onPointerMove({ x: 50, y: 120 }, MAX_PULL);
    sim.onPointerUp({ x: 50, y: 120 }, MAX_PULL);
    let penalty = false;
    let steps = 0;
    while (!sim.ball.resting && steps < 100000) {
      sim.substep(H);
      for (const ev of sim.drainEvents()) if (ev.type === 'penalty') penalty = true;
      steps++;
    }
    expect(penalty).toBe(true);
    expect(sim.ball.resting).toBe(true);
    // Reset to the launch point (the tee), at rest.
    expect(sim.ball.pos.x).toBeCloseTo(50, 6);
    expect(sim.ball.pos.y).toBeCloseTo(100, 6);
  });
});

describe('puttSim — sand slows the ball more than plain green', () => {
  it('the same launch travels shorter over sand than over green', () => {
    const green = roll(hole(), { x: 0, y: -150 });
    const sand = roll(
      hole({ hazards: [{ kind: 'sand', region: { x0: 8, y0: 8, x1: 92, y1: 117 } }] }),
      { x: 0, y: -150 },
    );
    const dGreen = Math.abs(green.ball.pos.y - 100);
    const dSand = Math.abs(sand.ball.pos.y - 100);
    expect(dSand).toBeLessThan(dGreen - 15);
  });
});

describe('puttSim — determinism holds WITH moving obstacles + tunnels', () => {
  it('the same run twice is byte-identical including obstacle interactions', () => {
    const mk = (): Hole =>
      hole({
        tee: { x: 50, y: 100 },
        cup: { x: 12, y: 12 },
        obstacles: [
          windmill({ x: 50, y: 60 }, { bladeLen: 20, bladeCount: 3, omega: 4 }),
          pendulum({ x: 30, y: 40 }, { length: 14, ampDeg: 50, omega: 2.5 }),
          tunnel(
            [
              { x: 70, y: 78 },
              { x: 58, y: 78 },
            ],
            [
              { x: 58, y: 30 },
              { x: 70, y: 30 },
            ],
          ),
        ],
      });
    const runN = (n: number) => {
      const sim = new PuttSim(mk());
      const b = sim.ball;
      b.pos = { x: 50, y: 100 };
      b.vel = { x: 12, y: -150 };
      b.resting = false;
      for (let i = 0; i < n; i++) sim.substep(H);
      return { pos: { ...b.pos }, vel: { ...b.vel }, resting: b.resting, simTime: sim.simTime };
    };
    const a = runN(500);
    const c = runN(500);
    expect(a).toEqual(c);
  });
});
