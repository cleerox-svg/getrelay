// The geometry the sim, the HUD and the GL scene all read. Small file, but the
// tests are the reason a called strike will agree with the drawn box.

import { describe, expect, it } from 'vitest';
import { BALL_RADIUS_FT, vec3 } from './airPhysics';
import { FT_TO_IN, IN_TO_FT } from './units';
import {
  CALL_ZONE,
  CALL_ZONE_HEIGHT_FT,
  CALL_ZONE_WIDTH_FT,
  PLATE_WIDTH_FT,
  RELEASE_D_FT,
  RUBBER_D_FT,
  RULE_ZONE,
  ZONE_CENTER,
  armSideX,
  isStrike,
  missDistance,
  plateToReticle,
  releasePoint,
  reportFromWorld,
  reticleToPlate,
  sprayAngle,
  worldFromReport,
  worldXAt,
} from './zone';

describe('zone — geometry', () => {
  it('prints the box and holds the published dimensions', () => {
    // eslint-disable-next-line no-console
    console.log(
      '\n[THE ZONE — REPORT frame, ft]\n' +
        `  rubber at d = ${RUBBER_D_FT}, release at d = ${RELEASE_D_FT} (extension ${(
          RUBBER_D_FT - RELEASE_D_FT
        ).toFixed(1)} ft)\n` +
        `  rule zone  : x ${RULE_ZONE.left.toFixed(4)} … ${RULE_ZONE.right.toFixed(
          4,
        )}  h ${RULE_ZONE.bottom.toFixed(2)} … ${RULE_ZONE.top.toFixed(2)}   ` +
        `(${(PLATE_WIDTH_FT * FT_TO_IN).toFixed(2)} in wide)\n` +
        `  called zone: x ${CALL_ZONE.left.toFixed(4)} … ${CALL_ZONE.right.toFixed(
          4,
        )}  h ${CALL_ZONE.bottom.toFixed(4)} … ${CALL_ZONE.top.toFixed(4)}   ` +
        `(${CALL_ZONE_WIDTH_FT.toFixed(4)} × ${CALL_ZONE_HEIGHT_FT.toFixed(4)} ft, ` +
        `${(CALL_ZONE_WIDTH_FT * FT_TO_IN).toFixed(2)} in wide)\n` +
        `  grown by one BALL RADIUS (${(BALL_RADIUS_FT * FT_TO_IN).toFixed(3)} in) a side, not one diameter.\n`,
    );

    expect(RUBBER_D_FT).toBe(60.5);
    expect(PLATE_WIDTH_FT).toBeCloseTo(17 * IN_TO_FT, 12);
    // Release extension inside the published 6–6.6 ft band.
    expect(RUBBER_D_FT - RELEASE_D_FT).toBeGreaterThanOrEqual(6);
    expect(RUBBER_D_FT - RELEASE_D_FT).toBeLessThanOrEqual(6.6);

    // ⚠ THE CALLED WIDTH IS 1.6587 ft, NOT 1.91. A strike is any part of the
    // ball over any part of the plate, and we integrate the ball's CENTRE, so
    // the centre may sit up to one RADIUS outside an edge. One DIAMETER a side
    // would give 1.901 ft — a figure that circulates and that stage 2's brief
    // quoted, whose own words ("a ball radius each side") say otherwise. If
    // this ever reads 1.90, someone has widened the zone by a ball.
    expect(CALL_ZONE_WIDTH_FT).toBeCloseTo(1.6587, 4);
    expect(CALL_ZONE_HEIGHT_FT).toBeCloseTo(2.042, 3);
    expect(CALL_ZONE_WIDTH_FT).toBeCloseTo(PLATE_WIDTH_FT + 2 * BALL_RADIUS_FT, 12);
  });

  it('calls a strike on the ball, not on the centre alone', () => {
    expect(isStrike(ZONE_CENTER.x, ZONE_CENTER.h)).toBe(true);
    // A centre exactly a radius outside the black still nicks the plate.
    expect(isStrike(RULE_ZONE.right + BALL_RADIUS_FT * 0.99, 2.5)).toBe(true);
    // A centre a radius and a hair outside does not.
    expect(isStrike(RULE_ZONE.right + BALL_RADIUS_FT * 1.01, 2.5)).toBe(false);
    expect(isStrike(0, RULE_ZONE.top + BALL_RADIUS_FT * 1.01)).toBe(false);
    expect(isStrike(0, RULE_ZONE.bottom - BALL_RADIUS_FT * 1.01)).toBe(false);
    // missDistance is 0 inside and the Chebyshev distance outside.
    expect(missDistance(0, 2.5)).toBe(0);
    expect(missDistance(CALL_ZONE.right + 0.25, 2.5)).toBeCloseTo(0.25, 12);
    expect(missDistance(0, CALL_ZONE.bottom - 0.5)).toBeCloseTo(0.5, 12);
  });

  it('reticle ↔ plate is an exact round trip, and ±1 is the DRAWN box', () => {
    for (const [u, v] of [
      [0, 0],
      [1, 1],
      [-1, -1],
      [0.37, -0.82],
      [1.6, 0.2],
    ] as const) {
      const p = reticleToPlate(u, v);
      const back = plateToReticle(p.x, p.h);
      expect(back.u).toBeCloseTo(u, 12);
      expect(back.v).toBeCloseTo(v, 12);
    }
    // u = 1 is the rule-zone edge (drawn), which is INSIDE the called edge —
    // so a pitch nicking the corner reads slightly over 1 and is still a strike.
    expect(reticleToPlate(1, 0).x).toBeCloseTo(RULE_ZONE.right, 12);
    expect(isStrike(reticleToPlate(1.1, 1.1).x, reticleToPlate(1.1, 1.1).h)).toBe(true);
    expect(reticleToPlate(0, 0)).toEqual({ x: ZONE_CENTER.x, h: ZONE_CENTER.h });
  });
});

describe('zone — frames', () => {
  it('WORLD ↔ REPORT is an exact round trip with the plate at d = 0', () => {
    const w = worldFromReport(12.5, -0.4, 3.1);
    const r = reportFromWorld(w);
    expect(r.d).toBeCloseTo(12.5, 12);
    expect(r.x).toBeCloseTo(-0.4, 12);
    expect(r.h).toBeCloseTo(3.1, 12);
    // Release is world x = 0; the plate is world x = RELEASE_D_FT.
    expect(worldXAt(RELEASE_D_FT)).toBeCloseTo(0, 12);
    expect(worldXAt(0)).toBeCloseTo(RELEASE_D_FT, 12);
    expect(reportFromWorld(vec3(0, 0, 0)).d).toBeCloseTo(RELEASE_D_FT, 12);
  });

  it('⚠ a RHP releases toward THIRD base, i.e. at negative x', () => {
    // This is the sign that pins the whole lateral frame to the published data:
    // league-average release_pos_x for a RHP is ≈ −1.9 ft. A mirrored frame
    // would put it at +1.9 and every horizontal break would follow it.
    expect(releasePoint('R').x).toBeCloseTo(-1.9, 12);
    expect(releasePoint('L').x).toBeCloseTo(1.9, 12);
    expect(releasePoint('R').h).toBeCloseTo(5.8, 12);
    expect(armSideX('R')).toBe(-1);
  });

  it('spray angle is 0 up the middle and positive toward first base', () => {
    // A batted ball travels in −x WORLD (away from the mound, toward centre).
    expect(sprayAngle(vec3(-100, 0, 40))).toBeCloseTo(0, 12);
    expect(sprayAngle(vec3(-100, 100, 40))).toBeCloseTo(Math.PI / 4, 12);
    expect(sprayAngle(vec3(-100, -100, 40))).toBeCloseTo(-Math.PI / 4, 12);
  });
});
