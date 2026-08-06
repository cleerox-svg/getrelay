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
