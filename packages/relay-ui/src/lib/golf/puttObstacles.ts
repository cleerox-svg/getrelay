// Mini-golf moving obstacles, tunnels and their per-simTime collider geometry —
// the Phase-2 signature features (windmills, swinging gates, portal tunnels).
// PURE MATH: no three, no canvas, no sim state. Everything is a function of the
// sim's DETERMINISTIC accumulated `simTime` (never wall-clock), so the vitest
// harness stays byte-for-byte reproducible and the renderer, reading the same
// simTime, draws exactly what the physics collides with (see-what-you-play).
//
// The obstacle DATA lives on the Hole (puttSim.ts `obstacles?`); this module
// turns each obstacle into (a) the moving line-segment colliders present at a
// given simTime and (b) the pure reflection/teleport solvers the sim applies.
// Collider math is segment-based so it reuses the same closest-point + reflect
// approach as the wall solver in puttSim.
//
// Coordinate space: the 100x125 virtual board (x right, y DOWN), same as
// puttSim/puttField. Angles are radians measured CLOCKWISE from +x (toward +y),
// matching puttField's dirDeg convention.

// A board point. Kept local (mirrors puttField's Pt) so this module stays free
// of any sim-state import cycle; structurally identical to puttSim.Vec.
export interface Vec {
  x: number;
  y: number;
}

// --- Obstacle schema -------------------------------------------------------

// Windmill / rotating bar: `bladeCount` straight blades of length `bladeLen`
// pivoting about `pivot` at angular speed `omega` (rad/s). Blade i's angle at
// time t is `phase0 + omega*t + i*2π/bladeCount` — so the whole set is a pure
// function of simTime. A blade both REFLECTS the ball and imparts its surface
// velocity at the contact point (a spinning blade can knock the ball).
export interface WindmillObstacle {
  kind: 'windmill';
  pivot: Vec;
  bladeLen: number;
  bladeCount: number;
  omega: number;
  phase0?: number;
}

// Pendulum / swinging gate: an arm of length `length` from `pivot` whose bearing
// OSCILLATES `centerDeg + ampDeg·sin(omega·t + phase0)` — it sweeps back and
// forth across a gap (risk/reward: dash through while it's swung clear).
// `gate:true` adds a second, opposed arm (bearing + π) so it reads as a bar
// pivoting across a corridor. Same reflect + surface-velocity treatment as a
// windmill blade (the arm's tip is moving, so it can nudge the ball).
export interface PendulumObstacle {
  kind: 'pendulum';
  pivot: Vec;
  length: number;
  centerDeg: number; // rest bearing (deg CW from +x); 90 = pointing +y (down)
  ampDeg: number; // swing amplitude (deg)
  omega: number; // rad/s
  phase0?: number;
  gate?: boolean;
}

// Tunnel / portal pair: two segment "mouths". A ball crossing INTO mouthA
// re-emerges at mouthB (and vice-versa) preserving speed, its velocity mapped
// from mouthA's local (tangent, outward-normal) frame onto mouthB's — see
// tunnelCrossing(). A simTime cooldown in the sim stops it ping-ponging.
export interface TunnelMouth {
  a: Vec;
  b: Vec;
}
export interface TunnelObstacle {
  kind: 'tunnel';
  mouthA: TunnelMouth;
  mouthB: TunnelMouth;
}

export type Obstacle = WindmillObstacle | PendulumObstacle | TunnelObstacle;

// A collider segment present at one instant, carrying the pivot + instantaneous
// angular velocity so the sim can compute its surface velocity at a contact
// point (v_surface = ω ẑ × r, r = contact − pivot). A static segment has
// omega = 0 (surface velocity zero).
export interface MovingSegment {
  a: Vec;
  b: Vec;
  omega: number;
  pivot: Vec;
}

// --- Small local vec + geometry helpers (duplicated, not imported, to keep the
// module dependency acyclic — puttSim imports THIS, so this must not import a
// runtime value back from puttSim). ---------------------------------------
const DEG = Math.PI / 180;
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
function norm(a: Vec): Vec {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}
// Nearest point to `p` on segment a->b, clamped to the endpoints (same math as
// puttSim.closestPointOnSegment).
function closestPointOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const denom = abx * abx + aby * aby;
  if (denom < 1e-9) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / denom;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + abx * t, y: a.y + aby * t };
}

// Outward normal of a mouth segment a->b: (b-a) rotated −90° in board space,
// i.e. the unit vector pointing to the RIGHT of the a→b direction. Author a
// tunnel so the ball APPROACHES mouthA from this side (moving against nOut). The
// SAME convention gives mouthB's exit direction, so the ball emerges outward.
export function mouthNormal(m: TunnelMouth): Vec {
  return norm({ x: m.b.y - m.a.y, y: -(m.b.x - m.a.x) });
}

// --- Moving colliders at a given simTime -----------------------------------

// Blade/arm angle helpers (exported so the renderer can read the SAME phase).
export function windmillBladeAngle(o: WindmillObstacle, simTime: number, i: number): number {
  return (o.phase0 ?? 0) + o.omega * simTime + (i * 2 * Math.PI) / o.bladeCount;
}
export function pendulumAngle(o: PendulumObstacle, simTime: number): number {
  return o.centerDeg * DEG + o.ampDeg * DEG * Math.sin(o.omega * simTime + (o.phase0 ?? 0));
}
// d(angle)/dt for the pendulum — its instantaneous angular velocity.
function pendulumAngVel(o: PendulumObstacle, simTime: number): number {
  return o.ampDeg * DEG * o.omega * Math.cos(o.omega * simTime + (o.phase0 ?? 0));
}

// The line-segment colliders one obstacle presents at `simTime`. Windmill →
// `bladeCount` blades (each pivot→tip). Pendulum → one arm (two if `gate`). A
// tunnel presents NO reflecting segments (it teleports; see tunnelCrossing).
export function obstacleSegments(o: Obstacle, simTime: number): MovingSegment[] {
  if (o.kind === 'windmill') {
    const out: MovingSegment[] = [];
    for (let i = 0; i < o.bladeCount; i++) {
      const ang = windmillBladeAngle(o, simTime, i);
      out.push({
        a: { x: o.pivot.x, y: o.pivot.y },
        b: { x: o.pivot.x + Math.cos(ang) * o.bladeLen, y: o.pivot.y + Math.sin(ang) * o.bladeLen },
        omega: o.omega,
        pivot: o.pivot,
      });
    }
    return out;
  }
  if (o.kind === 'pendulum') {
    const ang = pendulumAngle(o, simTime);
    const w = pendulumAngVel(o, simTime);
    const arm = (bearing: number): MovingSegment => ({
      a: { x: o.pivot.x, y: o.pivot.y },
      b: { x: o.pivot.x + Math.cos(bearing) * o.length, y: o.pivot.y + Math.sin(bearing) * o.length },
      omega: w,
      pivot: o.pivot,
    });
    return o.gate ? [arm(ang), arm(ang + Math.PI)] : [arm(ang)];
  }
  return [];
}

// Surface velocity of a moving segment at a world point `p`: ω ẑ × r, with
// r = p − pivot. In 2D that is (−ω·r_y, ω·r_x). This is what lets a swinging
// blade impart momentum to (knock) the ball.
export function segmentSurfaceVelocity(seg: MovingSegment, p: Vec): Vec {
  const rx = p.x - seg.pivot.x;
  const ry = p.y - seg.pivot.y;
  return { x: -seg.omega * ry, y: seg.omega * rx };
}

// --- Moving-wall reflection (the momentum model) ---------------------------
//
// Resolve a ball (centre `pos`, radius `r`, velocity `vel`) against ONE moving
// segment. If the ball overlaps the segment it is depenetrated along the contact
// normal, then reflected in the segment's MOVING frame:
//   1. contact normal n = (pos − closestPoint)/|·|;
//   2. blade surface velocity vs at the contact point (bounded to
//      `maxSurfaceSpeed` so a fast blade can't fling the ball to absurd speed);
//   3. relative velocity vrel = vel − vs; if approaching (vrel·n < 0) reflect it
//      with `restitution`: vrel' = vrel − (1+e)(vrel·n) n;
//   4. back to world frame: vel' = vrel' + vs.
// Because vs is added back, a moving blade transfers momentum (knocks the ball);
// a still blade (vs≈0) is an ordinary elastic wall. Purely arithmetic in `pos`,
// `vel`, `simTime`-derived geometry → deterministic.
export function reflectMovingSegment(
  pos: Vec,
  vel: Vec,
  r: number,
  seg: MovingSegment,
  restitution: number,
  maxSurfaceSpeed: number,
): { pos: Vec; vel: Vec; hit: boolean } {
  const cp = closestPointOnSegment(pos, seg.a, seg.b);
  const dx = pos.x - cp.x;
  const dy = pos.y - cp.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= r) return { pos, vel, hit: false };
  // Contact normal (fall back to the segment's perpendicular if dead-centre).
  let n: Vec;
  if (dist > 1e-6) n = { x: dx / dist, y: dy / dist };
  else {
    const t = norm(sub(seg.b, seg.a));
    n = { x: -t.y, y: t.x };
  }
  const outPos = { x: pos.x + n.x * (r - dist), y: pos.y + n.y * (r - dist) };
  // Bounded blade surface velocity at the contact point.
  let vs = segmentSurfaceVelocity(seg, cp);
  const vsMag = Math.hypot(vs.x, vs.y);
  if (vsMag > maxSurfaceSpeed) {
    const s = maxSurfaceSpeed / vsMag;
    vs = { x: vs.x * s, y: vs.y * s };
  }
  const rel = { x: vel.x - vs.x, y: vel.y - vs.y };
  const vn = rel.x * n.x + rel.y * n.y;
  if (vn >= 0) return { pos: outPos, vel, hit: true }; // separating → depenetrate only
  const reflRel = {
    x: rel.x - (1 + restitution) * vn * n.x,
    y: rel.y - (1 + restitution) * vn * n.y,
  };
  return { pos: outPos, vel: { x: reflRel.x + vs.x, y: reflRel.y + vs.y }, hit: true };
}

// --- Tunnel teleport -------------------------------------------------------

// Segment/segment crossing: does path p0->p1 cross mouth q0->q1? Returns the
// mouth parameter u∈[0,1] at the crossing, else null (parallel or no overlap).
function pathCrossesMouth(p0: Vec, p1: Vec, q0: Vec, q1: Vec): { u: number } | null {
  const rx = p1.x - p0.x;
  const ry = p1.y - p0.y;
  const sx = q1.x - q0.x;
  const sy = q1.y - q0.y;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-12) return null; // parallel / degenerate
  const qpx = q0.x - p0.x;
  const qpy = q0.y - p0.y;
  const t = (qpx * sy - qpy * sx) / denom; // along the path
  const u = (qpx * ry - qpy * rx) / denom; // along the mouth
  if (t < -1e-9 || t > 1 + 1e-9 || u < 0 || u > 1) return null;
  return { u };
}

// Map a ball crossing INTO `entry` onto `exit`, preserving speed. The velocity
// is decomposed in `entry`'s (tangent, outward-normal) frame and rebuilt in
// `exit`'s frame with the NORMAL component flipped to +nExit, so the ball exits
// OUTWARD (|v| unchanged). The crossing's fractional position along `entry` is
// reproduced along `exit`, then pushed `clearance` past the mouth so it can't
// immediately re-trigger. Returns null if the path doesn't cross `entry` moving
// inward (against nEntry).
function mouthTeleport(
  entry: TunnelMouth,
  exit: TunnelMouth,
  prev: Vec,
  pos: Vec,
  vel: Vec,
  clearance: number,
): { pos: Vec; vel: Vec } | null {
  const nEntry = mouthNormal(entry);
  // Must be travelling INTO the mouth (against its outward normal).
  if (dot(vel, nEntry) >= 0) return null;
  const cross = pathCrossesMouth(prev, pos, entry.a, entry.b);
  if (!cross) return null;
  const u = cross.u;
  const tEntry = norm(sub(entry.b, entry.a));
  const vt = dot(vel, tEntry);
  const vn = dot(vel, nEntry); // < 0 (inward)
  const tExit = norm(sub(exit.b, exit.a));
  const nExit = mouthNormal(exit);
  // Exit outward: normal component flips sign (-vn > 0); tangential preserved.
  const velOut = {
    x: tExit.x * vt + nExit.x * -vn,
    y: tExit.y * vt + nExit.y * -vn,
  };
  const exitPoint = { x: exit.a.x + (exit.b.x - exit.a.x) * u, y: exit.a.y + (exit.b.y - exit.a.y) * u };
  const posOut = { x: exitPoint.x + nExit.x * clearance, y: exitPoint.y + nExit.y * clearance };
  return { pos: posOut, vel: velOut };
}

// Resolve a ball moving prev->pos against one tunnel: if it crossed into either
// mouth this substep, return its teleported {pos, vel} at the other mouth, else
// null. `clearance` (ball radius + a hair) sets how far past the exit mouth the
// ball is placed so it clears the mouth segment. Deterministic (pure geometry).
export function tunnelCrossing(
  t: TunnelObstacle,
  prev: Vec,
  pos: Vec,
  vel: Vec,
  clearance: number,
): { pos: Vec; vel: Vec } | null {
  return (
    mouthTeleport(t.mouthA, t.mouthB, prev, pos, vel, clearance) ??
    mouthTeleport(t.mouthB, t.mouthA, prev, pos, vel, clearance)
  );
}
