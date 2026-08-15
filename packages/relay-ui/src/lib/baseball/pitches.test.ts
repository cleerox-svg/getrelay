// The arsenal as data: parse it, validate it, and print what the eight rows
// SAY about themselves before any physics is run on them. Bad data is a build
// failure here, not a pitch that quietly does nothing on the mound.
//
// ⚠ EVERY ASSERTION IN THIS FILE HAS BEEN SEEN TO FAIL — see the mutation log
// in pitchSim.test.ts's header. In particular the tilt→axis test is written to
// distinguish a MIRRORED clock from a correct one, because a mirrored tilt
// produces a perfectly-shaped pitch that breaks the wrong way, and any test
// that only checks magnitudes passes it.

import { describe, expect, it } from 'vitest';
import { vDot, vLen, vScale, vec3 } from './airPhysics';
import {
  PITCHES,
  pitchById,
  publishedBreak,
  spinVector,
  tiltAngleRad,
  tiltVsPublishedDeg,
  validatePitches,
} from './pitches';
import { RPM_TO_RADS } from './units';
import { armSideX } from './zone';

const pad = (s: string | number, n: number) => String(s).padStart(n);

describe('pitches — the table', () => {
  it('validates, and prints what each row claims', () => {
    const rows = PITCHES.map((p) => {
      const theta = (tiltAngleRad(p.tilt) * 180) / Math.PI;
      return [
        pad(p.id, 4),
        pad(p.name, 17),
        pad(p.veloMph.toFixed(1), 7),
        pad(p.spinRpm, 6),
        pad(p.tilt, 7),
        pad(theta.toFixed(1) + '°', 8),
        pad(p.activeSpin.toFixed(2), 7),
        pad((p.spinRpm * p.activeSpin).toFixed(0), 9),
        pad(p.ivbIn.toFixed(1), 7),
        pad(p.hbIn.toFixed(1), 7),
        pad(tiltVsPublishedDeg(p).toFixed(1) + '°', 9),
      ].join('');
    });
    // eslint-disable-next-line no-console
    console.log(
      '\n[THE ARSENAL — published RHP league averages]\n' +
        '  id             name   velo  spin   tilt   angle  active  spin_eff    IVB     HB  tilt−pub\n' +
        rows.join('\n') +
        '\n  tilt−pub: angle between the direction the tilt clock points and the direction\n' +
        '  the published IVB/HB columns point. A row that is tens of degrees out is telling\n' +
        '  you its own two columns disagree — see the splitter (40°) and changeup (22°).\n',
    );

    expect(validatePitches()).toEqual([]);
    expect(PITCHES).toHaveLength(8);
  });

  it('rejects malformed tilt loudly rather than parsing to NaN', () => {
    expect(() => tiltAngleRad('13:00')).toThrow();
    expect(() => tiltAngleRad('1:75')).toThrow();
    expect(() => tiltAngleRad('130')).toThrow();
    expect(() => tiltAngleRad('')).toThrow();
    expect(tiltAngleRad('12:00')).toBeCloseTo(0, 12);
    expect(tiltAngleRad('3:00')).toBeCloseTo(Math.PI / 2, 12);
    expect(tiltAngleRad('6:30')).toBeCloseTo((6.5 * Math.PI) / 6, 12);
  });

  it('catches a mirrored or shifted row', () => {
    // A tilt that points up against a published IVB that points down.
    const bad = PITCHES.map((p) => (p.id === 'cu' ? { ...p, tilt: '12:30' } : p));
    expect(validatePitches(bad).join()).toMatch(/cu: tilt 12:30 points up/);
    // A tilt mirrored to the wrong side of the clock.
    const mirrored = PITCHES.map((p) => (p.id === 'st' ? { ...p, tilt: '3:00' } : p));
    expect(validatePitches(mirrored).join()).toMatch(/st: tilt 3:00 points arm side/);
    // Structural rot.
    expect(validatePitches([{ ...pitchById('ff'), activeSpin: 1.4 }]).join()).toMatch(/activeSpin/);
    expect(validatePitches([{ ...pitchById('ff'), veloMph: 140 }]).join()).toMatch(/velo/);
  });
});

describe('pitches — tilt becomes an axis', () => {
  // Straight down the middle at 90 mph, so the geometry is easy to reason about
  // by hand: v̂ = +x̂, so the clock's 12:00 is +ẑ and its 3:00 is −ŷ (third base).
  const vHat = vec3(1, 0, 0);

  it('⚠ 12:00 is BACKSPIN, and the whole clock rotates the right way round it', () => {
    const at = (tilt: string) =>
      spinVector({ ...pitchById('ff'), tilt, activeSpin: 1, spinRpm: 2400 }, 'R', vHat);

    const twelve = at('12:00');
    const three = at('3:00');
    const six = at('6:00');
    const nine = at('9:00');

    const show = (n: string, v: { x: number; y: number; z: number }) =>
      `  ${n}  ω = (${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}) rad/s`;
    // eslint-disable-next-line no-console
    console.log(
      '\n[TILT → SPIN AXIS — 2400 rpm, fully efficient, v̂ = +x̂]\n' +
        [show('12:00', twelve), show(' 3:00', three), show(' 6:00', six), show(' 9:00', nine)].join('\n') +
        '\n  12:00 must be ω = −ŷ (backspin, which LIFTS). 3:00 must be ω = −ẑ, whose\n' +
        '  Magnus (−ẑ)×x̂ = −ŷ pushes toward THIRD base — a RHP’s arm side.\n',
    );

    const w = 2400 * RPM_TO_RADS;
    // 12:00 → backspin about −y. This is the exact case stage 1's Magnus SIGN
    // test pins as "lift", so the clock is anchored to a mutation-verified fact.
    expect(twelve.x).toBeCloseTo(0, 9);
    expect(twelve.y).toBeCloseTo(-w, 6);
    expect(twelve.z).toBeCloseTo(0, 9);
    // 6:00 is the exact mirror — topspin.
    expect(six.y).toBeCloseTo(w, 6);
    // 3:00 → axis −z, whose Magnus is (−ẑ) × x̂ = −ŷ, i.e. toward third base,
    // the arm side of a RHP. 9:00 is its mirror. If the clock were mirrored,
    // these two would swap and every magnitude in the suite would stay correct.
    expect(three.z).toBeCloseTo(-w, 6);
    expect(nine.z).toBeCloseTo(w, 6);
  });

  it('a LHP is the mirror of a RHP, and only in the lateral axis', () => {
    const ff = pitchById('ff');
    const r = spinVector(ff, 'R', vHat);
    const l = spinVector(ff, 'L', vHat);
    // Spin is an AXIAL vector: reflecting y flips the components PERPENDICULAR
    // to the mirror and leaves the parallel one alone. So the backspin part
    // survives (same IVB), the side part flips (mirrored HB) — and the gyro
    // part, along v̂ = +x̂, flips too, because a mirrored right-handed screw is
    // a left-handed one.
    expect(l.y).toBeCloseTo(r.y, 9);
    expect(l.z).toBeCloseTo(-r.z, 9);
    expect(l.x).toBeCloseTo(-r.x, 9);
    expect(Math.abs(r.x)).toBeGreaterThan(1); // the gyro part is actually there
    // And the display mirror on the published columns runs the same way.
    expect(publishedBreak(ff, 'R').hbIn).toBeCloseTo(-ff.hbIn, 9);
    expect(publishedBreak(ff, 'L').hbIn).toBeCloseTo(ff.hbIn, 9);
    expect(armSideX('R')).toBe(-1);
    expect(armSideX('L')).toBe(1);
  });

  it('|ω| is the PUBLISHED total spin and activeSpin is its transverse fraction', () => {
    for (const p of PITCHES) {
      const w = spinVector(p, 'R', vHat);
      const total = p.spinRpm * RPM_TO_RADS;
      // Total magnitude is the published rpm — the gyro part is carried, not dropped.
      expect(vLen(w)).toBeCloseTo(total, 6);
      // The transverse part is exactly activeSpin × total; the rest is gyro,
      // which aeroAccel projects out. Drop the activeSpin factor from
      // spinVector and every one of these fails by 1/activeSpin.
      const gyro = vDot(w, vHat);
      const transverse = vLen(vScale(vec3(w.x - gyro * vHat.x, w.y - gyro * vHat.y, w.z - gyro * vHat.z), 1));
      expect(transverse).toBeCloseTo(p.activeSpin * total, 6);
      expect(gyro).toBeCloseTo(Math.sqrt(1 - p.activeSpin ** 2) * total, 6);
    }
  });
});
