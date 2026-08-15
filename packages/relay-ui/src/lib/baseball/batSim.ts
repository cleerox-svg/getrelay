// The bat-ball collision: one oblique, rigid-body impulse solve.
//
// Everything the hitting game produces — exit velocity, launch angle, spray
// angle, backspin AND sidespin — comes out of a SINGLE collision, driven by a
// SINGLE swing rotation model. There is no launch-angle curve, no backspin
// lookup and no separate "spray" knob: the geometry of where the bat's centre
// line passes the ball's centre sets the line of centres, and the impulse solve
// along and across that line produces all five numbers at once. If a behaviour
// the design wants does not fall out of this, the honest move is to say so —
// which this file does, in the ⚠ notes below and in `bat.ts`.
//
// The bat's published spec and every quantity derived from it (M_eff, q, eA,
// the swing constants, e_T) live in `bat.ts` — data and derivation there,
// dynamics here, the same split `pitches.ts` / `pitchSim.ts` uses.
//
// Frame: airPhysics.ts's WORLD (+x mound → plate, +y first base, +z up), so the
// PITCH arrives travelling +x and the BATTED BALL leaves travelling −x. Spray
// angle is zone.ts's `sprayAngle`, shared with the pitch side.
//
// No three, no Math.random, no clock, no state: same arguments in, byte-identical
// numbers out.

import {
  BALL_MASS_SLUG,
  BALL_RADIUS_FT,
  vAdd,
  vCross,
  vDot,
  vLen,
  vScale,
  vSub,
  vec3,
} from './airPhysics';
import type { Vec3 } from './airPhysics';
import {
  ATTACK_ANGLE_DEG,
  BAT_BALL_COR,
  BAT_OMEGA_RADS,
  E_T,
  LOC_DISTANCE_IN,
  M_PER_FT,
  SWEET_SPOT_M,
  SWING_AXIS_FT,
  collisionEfficiency,
  effectiveMassKg,
  massRatio,
} from './bat';
import { FPS_TO_MPH, MPH_TO_FPS, RADS_TO_RPM } from './units';
import { sprayAngle } from './zone';
import type { Handedness } from './zone';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What the pitch is doing at the instant of contact, WORLD. */
export interface ContactPitch {
  /** Velocity, ft/s. Travelling +x. `PitchResult.plate.v` drops straight in. */
  v: Vec3;
  /** Spin, rad/s, a real axial vector. `PitchResult.omega` drops straight in. */
  omega: Vec3;
}

/** One swing. Everything optional has a published or derived default. */
export interface Swing {
  /** The BATTER's handedness. A RHB pulls toward third base (WORLD −y). */
  hand: Handedness;
  /** Timing error, s. + is LATE (the bat arrives after the nominal instant). */
  timingErrorS: number;
  /** Vertical miss, in. + = the bat's centre line passes BELOW the ball's. */
  undercutIn: number;
  /** Horizontal miss, in. + = contact on the far side of the barrel. */
  horizontalOffsetIn?: number;
  /** Aim point along the bat, m from the knob. Defaults to the sweet spot. */
  aimZM?: number;
  /** Attack angle override, deg. Defaults to the published +10°. */
  attackAngleDeg?: number;
  /** Bat speed override, mph — the hook every card/fatigue modulator uses. */
  batSpeedMph?: number;
}

/** Where and how hard the bat met the ball. All of it derived from one swing. */
export interface ContactGeometry {
  /** Bat rotation away from its nominal contact orientation, rad. + = early. */
  batAngleRad: number;
  /** Contact point, m from the knob. */
  contactZM: number;
  /** Bat speed at THAT point, ft/s. */
  batSpeedFps: number;
  /** Time of contact relative to nominal, s. */
  contactDelayS: number;
}

/**
 * Resolve where on the bat, and at what bat angle, a mistimed swing meets the
 * ball. This is the whole timing model, and both of its gameplay consequences
 * come from the same two lines.
 *
 * The bat is a ray from the swing axis rotating at ω; the ball travels a
 * straight line whose perpendicular distance from that axis is the aim radius
 * `d`. Contact is where the two meet, so with the swing displaced by Δt:
 *
 *     d·tan(ω(t − Δt)) = −v_p·t   ⇒   t = Δt·ωd/(ωd + v_p)
 *     θ_c = ω(t − Δt) = −ω·Δt·v_p/(ωd + v_p)          R_c = d / cos θ_c
 *
 * ⚠ THE BALL KEEPS MOVING, and that is the whole content of the second factor.
 * The naive "spray shift = ω·Δt" would give 45.8° of BAT rotation at Δt = 25 ms;
 * contact actually happens 1.46 ft deeper (v_p · contactDelayS, NOT v_p · Δt,
 * which is the 3.3 ft an earlier draft of this comment quoted — precisely the
 * naive quantity this sentence exists to refute), and the bat is only 25.5° from
 * square when it gets there. The outgoing ball is nevertheless deflected further
 * than the bat angle (−43.8° measured on the reference swing) because the
 * retained tangential velocity carries it past the line of centres — so a
 * ±35°-scale spray falls out, but by a different mechanism than the rule of
 * thumb it comes from. −43.8° is also 1.2° INSIDE the foul line, which is a
 * gameplay fact and is asserted as one.
 *
 * And R_c = d/cos θ_c > d for a miss in EITHER direction: any mistiming, early
 * or late, drives contact OUT toward the barrel tip, where `M_eff` collapses.
 * That is where "mistimed and weaker" comes from, and it needs no second knob.
 *
 * ⚠ It also means the model is SYMMETRIC in |Δt| for exit velocity: it does not
 * reproduce "late = jammed at the handle". In this geometry a late swing meets
 * the ball DEEPER and further out the barrel, not nearer the hands.
 *
 * ⚠ RETRACTED, STAGE 3b: an earlier version of this note resolved that by saying
 * getting jammed "is a property of an INSIDE pitch (a smaller aim radius `d`),
 * which is `aimZM`'s job". THAT IS FALSE IN THIS MODEL, and it was measured to
 * be false. Exit velocity against aim radius, on time, reference swing: sweet
 * spot 101.6 mph, 2 in inside 104.3, 3 in inside 104.6 (the peak), 4 in inside
 * 104.3, and it does not fall back below the sweet-spot value until ~6.2 in
 * inside. An inside pitch makes this batter STRONGER for six inches. The cause
 * is the same missing physics as the handle-side finding in `bat.ts`: with a
 * constant `e`, `eA` keeps rising toward the balance point, so moving contact
 * toward the hands is rewarded. The model has NO jamming mechanism at all — not
 * in the timing geometry and not in the aim radius. It is a second consequence
 * of the missing measured `e(z)` profile, and it is reported as one.
 */
export function contactGeometry(pitchSpeedFps: number, swing: Swing): ContactGeometry {
  const omega = swing.batSpeedMph === undefined
    ? BAT_OMEGA_RADS
    : (swing.batSpeedMph * MPH_TO_FPS) / SWING_AXIS_FT;
  const aimZM = swing.aimZM ?? SWEET_SPOT_M;
  const dPerp = SWING_AXIS_FT + (aimZM - SWEET_SPOT_M) / M_PER_FT;
  const denom = omega * dPerp + pitchSpeedFps;
  const contactDelayS = (swing.timingErrorS * omega * dPerp) / denom;
  const batAngleRad = (-omega * swing.timingErrorS * pitchSpeedFps) / denom;
  const rc = dPerp / Math.cos(batAngleRad);
  return {
    batAngleRad,
    contactZM: aimZM + (rc - dPerp) * M_PER_FT,
    batSpeedFps: omega * rc,
    contactDelayS,
  };
}

// ---------------------------------------------------------------------------
// The collision
// ---------------------------------------------------------------------------

/** Everything the collision produces. Feeds `battedBallSim` unchanged. */
export interface Contact {
  /** Outgoing WORLD velocity, ft/s. Travelling −x toward centre field. */
  v: Vec3;
  /** Outgoing WORLD spin, rad/s, a real axial vector. */
  omega: Vec3;
  evMph: number;
  laDeg: number;
  /** Spray, deg: 0 = centre field, + = right field, − = left field. */
  sprayDeg: number;
  /** Spin about the axis that lifts, rpm. + = backspin, − = topspin. */
  backspinRpm: number;
  /** Spin about the up axis, rpm. + deflects the ball toward third base. */
  sidespinRpm: number;
  /** Velocity-parallel spin, rpm. Inert (airPhysics projects it out). */
  gyrospinRpm: number;
  totalSpinRpm: number;
  contactZM: number;
  effectiveMassKg: number;
  collisionEfficiency: number;
  batSpeedMph: number;
  batAngleDeg: number;
}

/**
 * Reflect a POLAR vector (velocity, position) through the y = 0 plane. Used to
 * turn the right-handed batter this file solves into a left-handed one.
 */
const mirrorPolarY = (v: Vec3): Vec3 => vec3(v.x, -v.y, v.z);

/**
 * Reflect an AXIAL vector (spin) through the y = 0 plane.
 *
 * ⚠ NOT the same operation, and BASEBALL.md flags exactly this for the pitching
 * side. A mirror leaves the component ALONG the reflected axis alone and flips
 * the two perpendicular to it, because a mirrored right-handed screw is a
 * left-handed one. Get it wrong and a left-handed batter's pulled ball slices
 * instead of hooking.
 */
const mirrorAxialY = (w: Vec3): Vec3 => vec3(-w.x, w.y, -w.z);

/**
 * Solve one bat-ball collision.
 *
 * The impulse is split along the line of centres n̂ and across it:
 *
 *   NORMAL — the standard 1-D restitution result with the bat's effective mass,
 *     v'_n = v_n + (1 + e)/(1 + q)·(w_n − v_n), which is algebraically identical
 *     to the published `EV = eA·v_pitch + (1 + eA)·v_bat` through the identity
 *     (1 + e)/(1 + q) ≡ 1 + eA. `batSim.test.ts` asserts the two agree.
 *
 *   TANGENTIAL — the contact patch's relative velocity s (which includes the
 *     ball's INCOMING spin, `ω × (−r n̂)`) leaves as −e_T·s. Linear and angular
 *     impulse-momentum on a uniform sphere, I = ⅖mr², close it uniquely:
 *       s' = s + J_t(1/m + r²/I) = s + J_t·7/(2m)  ⇒  J_t = −(1 + e_T)·s·2m/7
 *       v' += J_t t̂ / m        ω' += (−r n̂) × (J_t t̂) / I
 *
 * Backspin, sidespin, launch angle and spray all fall out of that one solve.
 * The sign that makes it work is worth stating: an undercut tilts n̂ up, so the
 * ball's contact patch slides UP the barrel relative to the bat, friction acts
 * down, and the torque about the contact point is backspin. Hit over the top and
 * every one of those reverses, which is why `undercutIn < 0` produces topspin
 * with no extra code.
 *
 * ⚠ RETRACTED, STAGE 3b: "the two published targets cannot both be met". They
 * can, and the finding that said otherwise was an artifact of a one-dimensional
 * sweep. Stage 3 varied e_T at a FIXED 0.75 in undercut and found that launch
 * angle and backspin move in opposite directions with e_T:
 *
 *     e_T    LA      backspin
 *   +0.46   26.2°     5866 rpm    ← the LA the "LA = θ_LOC + α" rule predicts
 *   +0.20   29.0°     4430 rpm    ← the textbook rigid-surface e_T
 *    0.00   31.2°     3325 rpm    ← exact rolling (the patch stops sliding)
 *   −0.20   33.4°     2220 rpm    ← what stage 3 shipped
 *
 * …and concluded the bands were disjoint. But THE UNDERCUT IS NOT PUBLISHED
 * DATA — it is a free swing parameter, so holding it fixed asks the wrong
 * question. The 2-D (e_T, undercut) region says the bands overlap for
 * e_T ∈ [−0.16, +0.02]; `bat.ts`'s Coulomb argument says only e_T ∈ [0, +0.2] is
 * physically admissible; the intersection is [0, +0.02] and e_T = 0 sits in it.
 * At 0.56 in of undercut that gives LA 25.3°, backspin 2391 rpm, EV 101.6 mph —
 * both published bands at once. `batSim.test.ts` prints the whole region.
 *
 * ⚠ AND THE "~2.7×" WAS A MISLABEL. 2.643 is the BACKSPIN ratio between
 * e_T = +0.46 and −0.20 — a different quantity. The tangential-impulse gap is
 * (1 + e_T)'s ratio, and at the fixed 0.75 in undercut the two bands' nearest
 * edges are e_T = +0.2024 (LA 29.0°) and e_T = −0.1493 (2500 rpm), i.e.
 * 1.202/0.851 = **1.413×**. Corrected here, in BASEBALL.md and in the tests.
 *
 * WHAT SURVIVES, restated precisely: at any FIXED undercut the two bands are
 * disjoint, by 1.413× in tangential impulse — the model cannot reach both with
 * one swing shape it was not allowed to choose. And `LA ≈ θ_LOC + α_attack`
 * still under-predicts: at exact rolling the reference swing launches 25.3°
 * against the rule's 22.0°, a 3.3° gap, because the rule assumes the tangential
 * velocity is entirely scrubbed off and even at 100 % grip it is not.
 */
export function swingContact(pitch: ContactPitch, swing: Swing): Contact {
  // Solve for a right-handed batter, then mirror. The pitch is mirrored INTO
  // that frame first so the whole solve only ever exists once.
  const lefty = swing.hand === 'L';
  const vBall = lefty ? mirrorPolarY(pitch.v) : pitch.v;
  const omegaIn = lefty ? mirrorAxialY(pitch.omega) : pitch.omega;

  const geom = contactGeometry(vLen(vBall), swing);
  const zM = geom.contactZM;
  const q = massRatio(zM);
  const eA = collisionEfficiency(zM);

  // Line of centres. The swing plane is tilted by the attack angle; the undercut
  // tilts n̂ a further θ_LOC = asin(E_v / (r + R)) within it, and a horizontal
  // miss tilts it by the same law across it. The bat's own rotation (batAngleRad)
  // swings both.
  const attack = ((swing.attackAngleDeg ?? ATTACK_ANGLE_DEG) * Math.PI) / 180;
  const clampSin = (x: number) => Math.asin(Math.max(-1, Math.min(1, x)));
  const elev = attack + clampSin(swing.undercutIn / LOC_DISTANCE_IN);
  const azim = geom.batAngleRad + clampSin((swing.horizontalOffsetIn ?? 0) / LOC_DISTANCE_IN);
  // The batted ball leaves toward −x, so every outgoing direction carries it.
  const n = vec3(-Math.cos(elev) * Math.cos(azim), -Math.cos(elev) * Math.sin(azim), Math.sin(elev));
  const batDir = vec3(
    -Math.cos(attack) * Math.cos(geom.batAngleRad),
    -Math.cos(attack) * Math.sin(geom.batAngleRad),
    Math.sin(attack),
  );
  const vBat = vScale(batDir, geom.batSpeedFps);

  // Normal impulse.
  const vN = vDot(vBall, n);
  const vNOut = vN + ((1 + BAT_BALL_COR) / (1 + q)) * (vDot(vBat, n) - vN);

  // Tangential impulse. `s` is the CONTACT PATCH's relative velocity, so the
  // ball's incoming spin is in it — which is why a hanging curveball (topspin
  // arriving) comes off with more backspin than a fastball does.
  const rVec = vScale(n, -BALL_RADIUS_FT);
  const patch = vAdd(vBall, vCross(omegaIn, rVec));
  const rel = vSub(patch, vBat);
  const relT = vSub(rel, vScale(n, vDot(rel, n)));
  const sMag = vLen(relT);

  let vOut = vAdd(vScale(n, vNOut), vSub(vBall, vScale(n, vN)));
  let omegaOut = omegaIn;
  if (sMag > 1e-9) {
    const tHat = vScale(relT, 1 / sMag);
    const jt = (-(1 + E_T) * sMag * (2 * BALL_MASS_SLUG)) / 7;
    vOut = vAdd(vOut, vScale(tHat, jt / BALL_MASS_SLUG));
    const inertia = (2 / 5) * BALL_MASS_SLUG * BALL_RADIUS_FT * BALL_RADIUS_FT;
    omegaOut = vAdd(omegaIn, vScale(vCross(rVec, vScale(tHat, jt)), 1 / inertia));
  }

  if (lefty) {
    vOut = mirrorPolarY(vOut);
    omegaOut = mirrorAxialY(omegaOut);
  }

  const spin = decomposeSpin(vOut, omegaOut);
  const speed = vLen(vOut);
  return {
    v: vOut,
    omega: omegaOut,
    evMph: speed * FPS_TO_MPH,
    laDeg: (Math.atan2(vOut.z, Math.hypot(vOut.x, vOut.y)) * 180) / Math.PI,
    sprayDeg: (sprayAngle(vOut) * 180) / Math.PI,
    ...spin,
    contactZM: zM,
    effectiveMassKg: effectiveMassKg(zM),
    collisionEfficiency: eA,
    batSpeedMph: geom.batSpeedFps * FPS_TO_MPH,
    batAngleDeg: (geom.batAngleRad * 180) / Math.PI,
  };
}

/**
 * Split a spin vector into the three components that mean something to the
 * aerodynamics, given the direction of travel:
 *
 *   • BACKSPIN about â = normalise(v̂ × ẑ), the axis for which â × v̂ points UP —
 *     so + is lift, − is topspin, whichever way the ball is travelling;
 *   • SIDESPIN about the up-ish axis ĉ = normalise(ẑ − (ẑ·v̂)v̂). On a ball
 *     travelling −x, ẑ × (−x̂) = −ŷ, so + pushes toward THIRD base — a pulled
 *     ball's hook for a right-handed batter, an opposite-field slice for a left;
 *   • GYROSPIN along v̂, which produces no Magnus force at all (airPhysics
 *     projects it out every substep) and is reported only so it is visible.
 */
export function decomposeSpin(
  v: Vec3,
  omega: Vec3,
): { backspinRpm: number; sidespinRpm: number; gyrospinRpm: number; totalSpinRpm: number } {
  const speed = vLen(v);
  const total = vLen(omega) * RADS_TO_RPM;
  if (speed <= 1e-9) return { backspinRpm: 0, sidespinRpm: 0, gyrospinRpm: 0, totalSpinRpm: total };
  const vHat = vScale(v, 1 / speed);
  const gyro = vDot(omega, vHat);
  const lift = vCross(vHat, vec3(0, 0, 1));
  const liftMag = vLen(lift);
  const up = vSub(vec3(0, 0, 1), vScale(vHat, vHat.z));
  const upMag = vLen(up);
  return {
    backspinRpm: liftMag > 1e-9 ? vDot(omega, vScale(lift, 1 / liftMag)) * RADS_TO_RPM : 0,
    sidespinRpm: upMag > 1e-9 ? vDot(omega, vScale(up, 1 / upMag)) * RADS_TO_RPM : 0,
    gyrospinRpm: gyro * RADS_TO_RPM,
    totalSpinRpm: total,
  };
}
