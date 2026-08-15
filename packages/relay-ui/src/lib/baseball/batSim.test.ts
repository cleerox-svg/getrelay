// The collision bench. Every table is PRINTED — read them. A collision model can
// sit inside every tolerance while walking the whole grid one way, and the grid
// is the point.
//
// ⚠ WHAT THIS FILE FOUND, up front, because it is the most important thing the
// collision produced: the two published targets for a reference swing cannot
// both be met, and no value of `e_T` reconciles them. Launch angle and backspin
// move in OPPOSITE directions with `e_T`, measured on the reference swing
// (0.75 in undercut, +10° attack, 90 mph pitch descending 8° with 2200 rpm,
// 71.5 mph bat speed):
//
//     e_T      LA        backspin
//   +0.46    26.1°      5900 rpm     the LA that "LA = θ_LOC + α" predicts
//   +0.20    29.0°      4430 rpm     the textbook rigid-surface e_T
//    0.00    31.2°      3325 rpm     exact rolling (the patch stops sliding)
//   −0.20    33.4°      2220 rpm     ADOPTED — the published backspin band
//
// "LA 25–29°" needs e_T ≥ +0.2; "backspin 1900–2500 rpm" needs e_T ≤ −0.14.
// Disjoint, by a factor of ~2.7 in tangential impulse. Neither Coulomb friction
// (the adopted solve needs only J_t/J_n = 0.12 against μ ≈ 0.5) nor the bat's
// own tangential recoil (worth 6.6 %) closes it. `e_T` is calibrated against
// BACKSPIN because that is the tangential observable it controls and because
// backspin is what feeds carry; the consequence is that the `LA ≈ θ_LOC + α`
// rule of thumb under-predicts this model's launch angle by ~7°, which is
// reported rather than absorbed into a launch-angle correction.
//
// ⚠ SECOND FINDING, printed as its own table: the rigid-body model has no bat
// VIBRATION, so `eA` keeps rising toward the balance point and the model's exit
// -velocity optimum sits ~3 in toward the HANDLE of the real sweet spot. Toward
// the tip it is right for the right reason (M_eff collapses, 4 in costs 11.25
// mph); toward the handle it GAINS 2.6 mph where a real bat loses. Both are
// pinned below so the gap cannot quietly close or quietly widen.
//
// ⚠ MUTATIONS WATCHED TO FAIL — see the log at the bottom of this file.

import { describe, expect, it } from 'vitest';
import { vLen, vec3 } from './airPhysics';
import type { Vec3 } from './airPhysics';
import {
  BALL_MASS_KG,
  BAT_BALL_COR,
  BAT_SPEED_MPH,
  E_T,
  LOC_DISTANCE_IN,
  SWEET_SPOT_M,
  SWING_AXIS_FT,
  collisionEfficiency,
  effectiveMassKg,
  exitVelocityMph,
  locAngleRad,
  massRatio,
} from './bat';
import { contactGeometry, decomposeSpin, swingContact } from './batSim';
import type { Swing } from './batSim';
import { isBarrel } from './tuning';
import { FPS_TO_MPH, MPH_TO_FPS, RPM_TO_RADS } from './units';

const pad = (s: string | number, n: number) => String(s).padStart(n);
const f = (n: number, w: number, p = 2) => pad(n.toFixed(p), w);
const IN_TO_M = 0.0254;

/** A 90 mph pitch descending 8° with 2200 rpm of backspin — the reference. */
const refPitch = (spinRpm = 2200, descDeg = -8, mph = 90) => {
  const s = mph * MPH_TO_FPS;
  const d = (descDeg * Math.PI) / 180;
  return {
    v: vec3(s * Math.cos(d), 0, s * Math.sin(d)),
    // Backspin on a ball travelling +x is about −y (BASEBALL.md's Magnus sign).
    omega: vec3(0, -spinRpm * RPM_TO_RADS, 0),
  };
};

/** The reference swing: sweet spot, on time, 0.75 in undercut, +10° attack. */
const swing = (o: Partial<Swing> = {}): Swing => ({
  hand: 'R',
  timingErrorS: 0,
  undercutIn: 0.75,
  ...o,
});

const REF = refPitch();

// ---------------------------------------------------------------------------
// The derivation — M_eff, q, eA
// ---------------------------------------------------------------------------

describe('effective mass and collision efficiency are DERIVED', () => {
  it('prints the contact-point ladder and reproduces the published sweet spot', () => {
    console.log('\nCONTACT POINT LADDER (90 mph pitch, bat speed from the one rotation model)');
    console.log(' off(in)   z(m)   M_eff(kg)      q       eA   v_bat(mph)   EV(mph)');
    for (let off = -6; off <= 6; off++) {
      const z = SWEET_SPOT_M + off * IN_TO_M;
      const vb = (32 * (SWING_AXIS_FT + off / 12)) * FPS_TO_MPH;
      console.log(
        `${f(off, 7, 1)} ${f(z, 7, 4)} ${f(effectiveMassKg(z), 10, 4)} ${f(massRatio(z), 7, 4)} ${f(collisionEfficiency(z), 8, 4)} ${f(vb, 11, 2)} ${f(exitVelocityMph(90, vb, z), 9, 2)}`,
      );
    }

    // The published sweet-spot triple, reproduced rather than asserted.
    expect(effectiveMassKg(SWEET_SPOT_M)).toBeCloseTo(0.5816, 4);
    expect(massRatio(SWEET_SPOT_M)).toBeCloseTo(0.2498, 4);
    expect(collisionEfficiency(SWEET_SPOT_M)).toBeCloseTo(0.2002, 4);
    // …and against the published 0.20 at the brief's ±0.01.
    expect(Math.abs(collisionEfficiency(SWEET_SPOT_M) - 0.2)).toBeLessThan(0.01);
    // The ball mass is DERIVED from the 5.125 oz rule midpoint, not the round
    // 145 g the collision literature quotes — worth 0.0005 in eA, and stated.
    expect(BALL_MASS_KG).toBeCloseTo(0.1452915, 7);
  });

  it('⚠ INVARIANT: (1+e)/(1+q) ≡ 1 + eA at every contact point', () => {
    // This is the identity that lets EV = eA·v_p + (1+eA)·v_b be the SAME
    // statement as the impulse solve. If eA were ever hand-set rather than
    // derived, this breaks everywhere except the one point it was set at.
    for (let off = -8; off <= 8; off += 0.5) {
      const z = SWEET_SPOT_M + off * IN_TO_M;
      const lhs = (1 + BAT_BALL_COR) / (1 + massRatio(z));
      expect(lhs).toBeCloseTo(1 + collisionEfficiency(z), 12);
    }
  });

  it('M_eff peaks at the balance point and falls off BOTH ways', () => {
    const at = (zm: number) => effectiveMassKg(zm);
    expect(at(0.56)).toBeCloseTo(0.879, 6); // z = z_cm ⇒ M_eff = the whole bat
    expect(at(0.56)).toBeGreaterThan(at(0.56 + 0.05));
    expect(at(0.56)).toBeGreaterThan(at(0.56 - 0.05));
    // and it is symmetric about it, which is what makes the handle-side finding
    // below a property of v_bat rather than of M_eff.
    expect(at(0.56 + 0.12)).toBeCloseTo(at(0.56 - 0.12), 12);
  });

  it('EV closed form: 90 mph pitch + 70 mph bat = 102 mph', () => {
    expect(exitVelocityMph(90, 70)).toBeCloseTo(102.03, 2);
    expect(Math.abs(exitVelocityMph(90, 70) - 102)).toBeLessThan(2);
    // 0.2·v_p + 1.2·v_b to ±2 mph, the brief's form of the same check.
    expect(Math.abs(exitVelocityMph(90, 70) - (0.2 * 90 + 1.2 * 70))).toBeLessThan(2);
  });
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

describe('launch angle is geometry', () => {
  it('the line of centres is r_ball + R_bat, and asin() turns a miss into an angle', () => {
    expect(LOC_DISTANCE_IN).toBeCloseTo(2.7023, 4);
    expect((locAngleRad(0.75) * 180) / Math.PI).toBeCloseTo(16.114, 3);
    expect((locAngleRad(-0.5) * 180) / Math.PI).toBeCloseTo(-10.66, 2);
    expect(locAngleRad(0)).toBe(0);
  });

  it('the swing axis is DERIVED and reproduces the published bat speed', () => {
    expect(SWING_AXIS_FT).toBeCloseTo(3.2771, 4);
    const g = contactGeometry(90 * MPH_TO_FPS, swing());
    expect(g.batSpeedFps * FPS_TO_MPH).toBeCloseTo(BAT_SPEED_MPH, 9);
    expect(g.contactZM).toBeCloseTo(SWEET_SPOT_M, 12);
    expect(g.batAngleRad).toBeCloseTo(0, 12);
  });
});

// ---------------------------------------------------------------------------
// The collision grid
// ---------------------------------------------------------------------------

const GRID: [string, Swing][] = [
  ['sweet spot, 0.75 in under', swing()],
  ['sweet spot, 0.00 in under', swing({ undercutIn: 0 })],
  ['over the top, −0.5 in', swing({ undercutIn: -0.5 })],
  ['4 in toward the TIP', swing({ aimZM: SWEET_SPOT_M + 4 * IN_TO_M })],
  ['4 in toward the HANDLE', swing({ aimZM: SWEET_SPOT_M - 4 * IN_TO_M })],
  ['25 ms EARLY', swing({ timingErrorS: -0.025 })],
  ['25 ms LATE', swing({ timingErrorS: 0.025 })],
  ['10 ms EARLY', swing({ timingErrorS: -0.01 })],
  ['10 ms LATE', swing({ timingErrorS: 0.01 })],
];

describe('the collision grid', () => {
  it('⚠ GRID: prints the whole thing', () => {
    console.log(`\nCOLLISION GRID — 90 mph pitch descending 8° @ 2200 rpm, RHB, e_T = ${E_T}`);
    console.log('case                          EV     LA   spray   back   side   gyro    z(m)     eA  v_bat  batAng  barrel');
    for (const [name, s] of GRID) {
      const c = swingContact(REF, s);
      console.log(
        `${name.padEnd(26)} ${f(c.evMph, 6, 1)} ${f(c.laDeg, 6, 1)} ${f(c.sprayDeg, 7, 1)} ${f(c.backspinRpm, 6, 0)} ${f(c.sidespinRpm, 6, 0)} ${f(c.gyrospinRpm, 6, 0)} ${f(c.contactZM, 7, 4)} ${f(c.collisionEfficiency, 6, 3)} ${f(c.batSpeedMph, 6, 1)} ${f(c.batAngleDeg, 7, 1)}  ${isBarrel(c.evMph, c.laDeg) ? 'yes' : ' no'}`,
      );
    }
  });

  it('⚠ INVARIANT: at zero obliquity the 3-D solve IS the published closed form', () => {
    // Level pitch, level swing, no undercut ⇒ the line of centres, the bat's
    // velocity and the ball's velocity are collinear, so the tangential impulse
    // must vanish EXACTLY and EV must equal eA·v_p + (1+eA)·v_b to machine
    // precision. Any error in the normal solve, the frame, or the tangential
    // decomposition shows up here as a non-zero spin or a mismatched EV.
    const c = swingContact(
      { v: vec3(90 * MPH_TO_FPS, 0, 0), omega: vec3(0, 0, 0) },
      swing({ undercutIn: 0, attackAngleDeg: 0 }),
    );
    expect(c.evMph).toBeCloseTo(exitVelocityMph(90, BAT_SPEED_MPH), 9);
    expect(c.evMph).toBeCloseTo(103.827, 3);
    expect(c.laDeg).toBeCloseTo(0, 9);
    expect(c.sprayDeg).toBeCloseTo(0, 9);
    expect(c.totalSpinRpm).toBeCloseTo(0, 9);
  });

  it('0.75 in undercut: backspin lands in the published 1900–2500 rpm band', () => {
    const c = swingContact(REF, swing());
    expect(c.backspinRpm).toBeGreaterThan(1900);
    expect(c.backspinRpm).toBeLessThan(2500);
    // GOLDEN — the model's own numbers, with the published rule of thumb beside
    // them. LA = θ_LOC + α_attack predicts 26.11°; this model gives 33.4°,
    // because at 80 % grip the ball keeps ~7° worth of tangential velocity.
    // See this file's header: no e_T satisfies both bands.
    expect(c.backspinRpm).toBeCloseTo(2220, 0);
    expect(c.laDeg).toBeCloseTo(33.4, 1);
    expect(c.evMph).toBeCloseTo(100.4, 1);
    const ruleOfThumb = ((locAngleRad(0.75) + Math.PI / 18) * 180) / Math.PI;
    expect(ruleOfThumb).toBeCloseTo(26.114, 3);
    expect(c.laDeg - ruleOfThumb).toBeGreaterThan(6); // the gap, pinned
  });

  it('zero undercut on a level-ish swing launches at ~the attack angle, barely spinning', () => {
    const c = swingContact(REF, swing({ undercutIn: 0 }));
    expect(Math.abs(c.laDeg - 10)).toBeLessThan(3);
    expect(Math.abs(c.backspinRpm)).toBeLessThan(1200);
    expect(c.laDeg).toBeCloseTo(8.9, 1);
    expect(c.backspinRpm).toBeCloseTo(-735, 0);
  });

  it('over the top ⇒ negative launch angle AND topspin, from the same solve', () => {
    const c = swingContact(REF, swing({ undercutIn: -0.5 }));
    expect(c.laDeg).toBeLessThan(0);
    expect(c.backspinRpm).toBeLessThan(0); // negative backspin IS topspin
    expect(c.laDeg).toBeCloseTo(-7.2, 1);
    expect(c.backspinRpm).toBeCloseTo(-2714, 0);
  });

  it('⚠ INVARIANT: undercut drives LA and backspin together, monotonically', () => {
    // A hand-authored backspin curve can be monotone in undercut without the
    // launch angle following it. Here they are the SAME solve, so both must be
    // monotone in the same parameter and must cross zero at the same place.
    let prevLa = -Infinity;
    let prevSpin = -Infinity;
    for (let u = -1.0; u <= 1.4; u += 0.1) {
      const c = swingContact(REF, swing({ undercutIn: u }));
      expect(c.laDeg).toBeGreaterThan(prevLa);
      expect(c.backspinRpm).toBeGreaterThan(prevSpin);
      prevLa = c.laDeg;
      prevSpin = c.backspinRpm;
    }
  });

  it('4 in toward the TIP costs 8–12 mph; 4 in toward the HANDLE GAINS (the finding)', () => {
    const on = swingContact(REF, swing());
    const tip = swingContact(REF, swing({ aimZM: SWEET_SPOT_M + 4 * IN_TO_M }));
    const handle = swingContact(REF, swing({ aimZM: SWEET_SPOT_M - 4 * IN_TO_M }));
    const tipLoss = on.evMph - tip.evMph;
    expect(tipLoss).toBeGreaterThan(8);
    expect(tipLoss).toBeLessThan(12);
    expect(tipLoss).toBeCloseTo(11.25, 2);
    // ⚠ The rigid-body model has no vibrational loss, so the handle side GAINS.
    // Pinned as a golden so the gap is visible and cannot silently move; closing
    // it needs a measured e(z) profile this stage has no data for.
    expect(handle.evMph - on.evMph).toBeCloseTo(2.66, 2);
    expect(handle.evMph).toBeGreaterThan(on.evMph);
  });
});

// ---------------------------------------------------------------------------
// Timing — ONE rotation model, two consequences
// ---------------------------------------------------------------------------

describe('timing produces spray AND contact quality from one model', () => {
  it('⚠ TIMING TABLE', () => {
    console.log('\nTIMING — one rotation model at ω_bat = 32 rad/s (RHB)');
    console.log('  Δt(ms)   batAng   spray      EV    z(m)   z-off(in)      eA   side(rpm)');
    for (const ms of [-30, -25, -20, -10, -5, 0, 5, 10, 20, 25, 30]) {
      const c = swingContact(REF, swing({ timingErrorS: ms / 1000 }));
      console.log(
        `${f(ms, 8, 0)} ${f(c.batAngleDeg, 8, 1)} ${f(c.sprayDeg, 7, 1)} ${f(c.evMph, 7, 1)} ${f(c.contactZM, 7, 4)} ${f((c.contactZM - SWEET_SPOT_M) / IN_TO_M, 11, 2)} ${f(c.collisionEfficiency, 7, 3)} ${f(c.sidespinRpm, 11, 0)}`,
      );
    }
  });

  it('25 ms early pulls, 25 ms late goes oppo, and BOTH are weaker', () => {
    const on = swingContact(REF, swing());
    const early = swingContact(REF, swing({ timingErrorS: -0.025 }));
    const late = swingContact(REF, swing({ timingErrorS: 0.025 }));
    expect(early.sprayDeg).toBeLessThanOrEqual(-35);
    expect(late.sprayDeg).toBeGreaterThanOrEqual(20);
    expect(late.evMph).toBeLessThan(on.evMph);
    expect(on.evMph - late.evMph).toBeGreaterThan(5);
    expect(early.evMph).toBeCloseTo(92.0, 1);
    expect(early.sprayDeg).toBeCloseTo(-46.9, 1);
  });

  it('⚠ FINDING: the EV penalty is SYMMETRIC in |Δt|, and contact moves to the TIP', () => {
    // The one rotation model gives R_c = d / cos θ_c > d for a miss either way,
    // so both mistimings drive contact OUT the barrel and cost the same. It does
    // NOT reproduce "late = jammed at the handle": in this geometry a late swing
    // meets the ball deeper and further out, and getting jammed is a property of
    // an INSIDE pitch (a smaller aim radius), not of the timing model. Asserted
    // rather than hidden, so nobody "fixes" it with an asymmetric fudge.
    const early = swingContact(REF, swing({ timingErrorS: -0.025 }));
    const late = swingContact(REF, swing({ timingErrorS: 0.025 }));
    expect(early.evMph).toBeCloseTo(late.evMph, 9);
    expect(early.sprayDeg).toBeCloseTo(-late.sprayDeg, 9);
    expect(early.contactZM).toBeCloseTo(late.contactZM, 12);
    expect(early.contactZM).toBeGreaterThan(SWEET_SPOT_M);
  });

  it('⚠ the ball keeps moving: the spray shift is NOT ω_bat·Δt', () => {
    // The naive rule gives ω·Δt = 45.8° of BAT rotation at 25 ms. Because the
    // ball travels 3.3 ft deeper while the bat catches up, the bat is only 25.5°
    // from square. A model that skipped the ball's motion would report 45.8 here.
    const c = swingContact(REF, swing({ timingErrorS: -0.025 }));
    const naiveDeg = ((32 * 0.025) * 180) / Math.PI;
    expect(naiveDeg).toBeCloseTo(45.84, 2);
    expect(c.batAngleDeg).toBeCloseTo(25.5, 1);
    expect(c.batAngleDeg).toBeLessThan(naiveDeg * 0.7);
    // …and yet the BALL is deflected further than the bat angle, because the
    // retained tangential velocity carries it past the line of centres.
    expect(Math.abs(c.sprayDeg)).toBeGreaterThan(c.batAngleDeg);
  });

  it('⚠ a pulled ball HOOKS and an oppo ball SLICES — sidespin, not script', () => {
    // +sidespin is about the up axis and deflects a ball travelling −x toward
    // THIRD base. A RHB's pulled ball (spray < 0, i.e. toward third) must get
    // +sidespin, carrying it further foul; his oppo ball the mirror.
    const early = swingContact(REF, swing({ timingErrorS: -0.025 }));
    const late = swingContact(REF, swing({ timingErrorS: 0.025 }));
    expect(early.sprayDeg).toBeLessThan(0);
    expect(early.sidespinRpm).toBeGreaterThan(500);
    expect(late.sprayDeg).toBeGreaterThan(0);
    expect(late.sidespinRpm).toBeLessThan(-500);
  });
});

// ---------------------------------------------------------------------------
// Handedness, incoming spin, determinism
// ---------------------------------------------------------------------------

describe('the rest of the model', () => {
  it('⚠ a LHB is the exact MIRROR of a RHB — polar and AXIAL both', () => {
    // BASEBALL.md's warning, on the hitting side: spin is an axial vector, so a
    // mirror leaves the component ALONG the reflected axis alone and flips the
    // two perpendicular to it. Negating the whole spin vector (or none of it)
    // gives a left-handed batter who slices what he should hook, while leaving
    // EV and LA — which are mirror-invariant — perfectly correct.
    for (const ms of [-25, -10, 0, 10, 25]) {
      const r = swingContact(REF, swing({ hand: 'R', timingErrorS: ms / 1000 }));
      // The pitch must be mirrored too, or we are comparing two different pitches.
      const mirrored = { v: vec3(REF.v.x, -REF.v.y, REF.v.z), omega: vec3(-REF.omega.x, REF.omega.y, -REF.omega.z) };
      const l = swingContact(mirrored, swing({ hand: 'L', timingErrorS: ms / 1000 }));
      expect(l.evMph).toBeCloseTo(r.evMph, 9);
      expect(l.laDeg).toBeCloseTo(r.laDeg, 9);
      expect(l.sprayDeg).toBeCloseTo(-r.sprayDeg, 9);
      expect(l.backspinRpm).toBeCloseTo(r.backspinRpm, 6);
      expect(l.sidespinRpm).toBeCloseTo(-r.sidespinRpm, 6);
      expect(l.v.y).toBeCloseTo(-r.v.y, 9);
      expect(l.omega.y).toBeCloseTo(r.omega.y, 9);
      expect(l.omega.z).toBeCloseTo(-r.omega.z, 9);
    }
  });

  it('⚠ a hanging curveball comes off with MORE backspin than a fastball', () => {
    // The contact patch's velocity carries the ball's INCOMING spin, so a pitch
    // arriving with topspin is already turning the right way for the batted
    // ball and needs less of the tangential impulse spent reversing it. This is
    // the classic result, and it falls out of the same solve with no branch.
    const fast = swingContact(refPitch(2200), swing());
    const hook = swingContact(refPitch(-2200), swing());
    const dead = swingContact(refPitch(0), swing());
    console.log(
      `\nINCOMING SPIN: 2200 backspin ⇒ ${fast.backspinRpm.toFixed(0)} rpm | spinless ⇒ ${dead.backspinRpm.toFixed(0)} | 2200 topspin ⇒ ${hook.backspinRpm.toFixed(0)}`,
    );
    expect(hook.backspinRpm).toBeGreaterThan(dead.backspinRpm);
    expect(dead.backspinRpm).toBeGreaterThan(fast.backspinRpm);
  });

  it('bat speed is the one card hook, and EV rises with it', () => {
    let prev = -Infinity;
    for (const mph of [62, 66, 71.5, 74, 77]) {
      const c = swingContact(REF, swing({ batSpeedMph: mph }));
      expect(c.evMph).toBeGreaterThan(prev);
      prev = c.evMph;
      if (mph === BAT_SPEED_MPH) expect(c.batSpeedMph).toBeCloseTo(BAT_SPEED_MPH, 9);
    }
  });

  it('decomposeSpin round-trips: gyro is inert, back/side reconstruct the magnitude', () => {
    const c = swingContact(REF, swing({ timingErrorS: -0.02 }));
    const d = decomposeSpin(c.v, c.omega);
    const rebuilt = Math.hypot(d.backspinRpm, d.sidespinRpm, d.gyrospinRpm);
    expect(rebuilt).toBeCloseTo(d.totalSpinRpm, 6);
    // Adding pure gyro spin must move NOTHING but the gyro component.
    const speed = vLen(c.v);
    const extra: Vec3 = vec3(
      c.omega.x + (100 * c.v.x) / speed,
      c.omega.y + (100 * c.v.y) / speed,
      c.omega.z + (100 * c.v.z) / speed,
    );
    const d2 = decomposeSpin(c.v, extra);
    expect(d2.backspinRpm).toBeCloseTo(d.backspinRpm, 9);
    expect(d2.sidespinRpm).toBeCloseTo(d.sidespinRpm, 9);
    expect(d2.gyrospinRpm - d.gyrospinRpm).toBeCloseTo(100 * (30 / Math.PI), 6);
  });

  it('is deterministic — same swing twice, byte-identical', () => {
    const s = swing({ timingErrorS: -0.013, undercutIn: 0.9, horizontalOffsetIn: 0.3 });
    expect(JSON.stringify(swingContact(REF, s))).toBe(JSON.stringify(swingContact(REF, s)));
  });
});

// ---------------------------------------------------------------------------
// The barrel
// ---------------------------------------------------------------------------

describe('isBarrel', () => {
  it('⚠ BARREL TABLE', () => {
    console.log('\nBARREL WINDOW');
    console.log('  EV    lo     hi');
    for (const ev of [97, 98, 99, 100, 105, 110, 116, 120]) {
      let lo = NaN;
      let hi = NaN;
      for (let la = 0; la <= 60; la += 0.5) {
        if (isBarrel(ev, la)) {
          if (Number.isNaN(lo)) lo = la;
          hi = la;
        }
      }
      console.log(`${f(ev, 5, 0)} ${f(lo, 6, 1)} ${f(hi, 6, 1)}`);
    }
  });

  it('98 mph is the floor and 26–30° the window there', () => {
    expect(isBarrel(97.9, 28)).toBe(false);
    expect(isBarrel(98, 28)).toBe(true);
    expect(isBarrel(98, 25.9)).toBe(false);
    expect(isBarrel(98, 30.1)).toBe(false);
  });

  it('the window widens ~1°/side/mph and saturates', () => {
    expect(isBarrel(100, 24)).toBe(true);
    expect(isBarrel(100, 23.9)).toBe(false);
    expect(isBarrel(100, 32)).toBe(true);
    expect(isBarrel(100, 32.1)).toBe(false);
    expect(isBarrel(116, 8)).toBe(true);
    expect(isBarrel(116, 7.9)).toBe(false);
    // The saturation clamps hold above 116 rather than opening forever.
    expect(isBarrel(125, 7.9)).toBe(false);
    expect(isBarrel(125, 51)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⚠ MUTATIONS WATCHED TO FAIL. Each was applied to the shipping source, the
// whole 93-test baseball suite was run, and the source reverted. A test nobody
// has seen fail is not a test. Tests killed, measured:
//
//   1. e_T −0.20 → the textbook +0.20 — 5 tests. The backspin band, the goldens,
//      the LA pin and the end-to-end carry. The calibration cannot drift without
//      someone re-reading the e_T ladder at the top of this file.
//   2. the tangential impulse deleted entirely (frictionless bat) — 9 tests. The
//      normal solve alone still gives a plausible EV and a plausible LA, which is
//      exactly why the spin, hook and zero-obliquity tests exist.
//   3. `mirrorAxialY` made identical to `mirrorPolarY` (spin mirrored like a
//      velocity) — 1 test, the LHB mirror. EV, LA and spray all stay perfect;
//      only the spin components move. This is the BASEBALL.md axial-vector
//      warning, and it is the single test that catches it.
//   4. the naive spray model, batAngle = −ω·Δt with the ball's motion ignored —
//      2 tests. Note the spray-magnitude assertions do NOT catch it (45.8° still
//      clears −35°); the bat-angle test does, which is why it is separate.
//   5. contact pinned to the aim point, R_c = d — 3 tests. Mistiming stops
//      costing exit velocity, and the "both mistimings are weaker" pair dies.
//   6. M_eff stripped of its rotational term (1/M only) — 10 tests, the largest
//      blast radius in the file: it is the term that makes the bat a bat.
//   7. eA hand-set to the literal 0.20 — 4 tests, and the (1+e)/(1+q) ≡ 1+eA
//      identity is one of them. Exactly what that invariant is for.
//   8. the incoming pitch spin dropped from the contact patch — 6 tests,
//      including the hanging-curveball ordering.
//   9. the backspin axis flipped in decomposeSpin — 7 tests.
//  10. the swing axis hand-set to 3.0 ft instead of derived from the published
//      bat speed — 8 tests. A derived constant that nothing checks is a literal.
//  11. the barrel window widened 1 → 3 °/mph — 1 test, the widening assertion.
// ---------------------------------------------------------------------------
