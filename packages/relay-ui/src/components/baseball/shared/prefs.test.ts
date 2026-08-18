// ⚠⚠ THE NIGHT TOGGLE IS COSMETIC, AND THIS FILE IS WHY THAT IS A FACT.
//
// The owner asked for open-roof day and open-roof night and chose "user option".
// The danger in that is specific and it is not aesthetic: this game derives air
// density from TEMPERATURE (`airDensity`), so a physically honest night would be
// cooler, denser air and a ball that carried several feet shorter. A
// *player-selectable* option that changes carry is a "pick the easy mode" button
// on a leaderboard game — every score on the board would be a different game.
//
// So the rule is that temperature and humidity are held identical across the
// toggle, and this file asserts it the only way that means anything: it runs the
// PUBLISHED MAX-CARRY LADDER with the preference set to `night`, then again with
// it set to `day`, and requires the two byte-identical — including the sampled
// tracks, not merely the carry scalars.
//
// ⚠ AND A SECOND, STRUCTURAL ASSERTION, BECAUSE THE FIRST ONE ONLY TESTS TODAY.
// Nothing under `lib/baseball/` may import this module or mention the preference
// at all. The ladder comparison would still pass if a future edit read the
// preference somewhere that happened not to affect the ladder; the source scan
// is what says the CHANNEL does not exist. Two different claims, both needed.
//
// If night is ever to PLAY differently it rolls from the daily seed — the same
// mechanism the roof state was always meant to use — and a preference cannot do
// it. That is a design decision recorded as a test.

import { describe, expect, it, beforeEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchFromAngles, simulateBattedBall } from '../../../lib/baseball/battedBallSim';
import { vec3 } from '../../../lib/baseball/airPhysics';
import { HARBOURFRONT, parkConditions } from '../../../lib/baseball/parks';
import { DEFAULT_DAYLIGHT, loadDaylight, saveDaylight } from './prefs';
import type { DaylightId } from '../stadium/daylight';

const SIM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'lib', 'baseball');

/**
 * A minimal `localStorage`, because vitest runs this in node.
 *
 * ⚠ IT IS A REAL STORE, NOT A SPY. The point of the ladder comparison is that
 * the preference is genuinely SET while the physics runs — a mock that recorded
 * the call and returned the default would make the whole test a tautology.
 */
function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/**
 * The published max-carry ladder — BASEBALL.md § "The carry experiment".
 *
 * ⚠ THE SAME SIX RUNGS THE MODEL IS CORROBORATED AGAINST — but NOT at the same
 * air, and the printed carries are therefore NOT § "The carry experiment"'s
 * numbers and are not claimed to be. That table is quoted at game-day sea level
 * (70 °F / 50 % RH, ρ = 0.0023168); this runs with the roof SHUT, i.e. the
 * climate-controlled 72 °F / 40 % RH, which carries a few feet further and is
 * PINNED. Determinism is what a byte comparison needs, and the shut roof gives
 * it for one reason (the air is a constant) rather than two (a seeded draw that
 * happens to use the same seed). Corroborating the ladder is
 * `battedBallSim.test.ts`'s job and it is not repeated here.
 */
const LADDER = [90, 95, 100, 105, 110, 115];
const LA_DEG = 27;
const BACKSPIN_RPM = 2200;

/** Run the ladder and return every number it produces, as a string. */
function ladder(): string {
  const c = parkConditions(HARBOURFRONT, true, 1);
  return LADDER.map((ev) => {
    const f = simulateBattedBall(
      launchFromAngles(ev, LA_DEG, 0, BACKSPIN_RPM, 0, vec3(0, 0, 3)),
      c.air,
      c.windFps,
    );
    // Carry, hang and apex — AND the whole sampled track. A toggle that moved
    // the flight without moving its summary is the interesting failure, and the
    // scalars alone cannot see it.
    return [
      f.carryFt,
      f.hangS,
      f.apexFt,
      f.evMph,
      f.laDeg,
      ...f.track.x,
      ...f.track.y,
      ...f.track.z,
      ...f.track.t,
    ].join(',');
  }).join('|');
}

describe('the daylight preference cannot reach the physics', () => {
  beforeEach(() => {
    installStorage();
  });

  it('runs the PUBLISHED CARRY LADDER byte-identical in both modes', () => {
    saveDaylight('night');
    expect(loadDaylight()).toBe('night');
    const atNight = ladder();

    saveDaylight('day');
    expect(loadDaylight()).toBe('day');
    const atDay = ladder();

    // eslint-disable-next-line no-console
    console.log(
      `\n[NIGHT — the carry ladder, roof shut, ${BACKSPIN_RPM} rpm @ ${LA_DEG}°]\n` +
        LADDER.map((ev, i) => {
          const n = atNight.split('|')[i]!.split(',');
          return (
            `  ${String(ev).padStart(3)} mph   carry ${Number(n[0]).toFixed(2).padStart(7)} ft` +
            `   hang ${Number(n[1]).toFixed(2)} s   apex ${Number(n[2]).toFixed(1)} ft`
          );
        }).join('\n') +
        `\n  night ≡ day: ${atNight === atDay ? 'YES' : 'NO'}` +
        `   (${atNight.length} chars compared, tracks included)\n` +
        `  ⚠ Air density falls out of temperature. If this ever prints NO, the\n` +
        `    night option has become a difficulty setting — see stadium/daylight.ts.\n`,
    );
    expect(atNight).toBe(atDay);

    // GUARD THE GUARD. A comparison of two identical strings passes on a
    // `ladder()` that ignores its inputs entirely, so prove it can tell two
    // flights apart: one degree of launch angle is worth ~1 ft of carry and the
    // string must change.
    const perturbed = (() => {
      const c = parkConditions(HARBOURFRONT, true, 1);
      const f = simulateBattedBall(
        launchFromAngles(90, LA_DEG + 1, 0, BACKSPIN_RPM, 0, vec3(0, 0, 3)),
        c.air,
        c.windFps,
      );
      return f.carryFt;
    })();
    expect(perturbed).not.toBe(Number(atDay.split('|')[0]!.split(',')[0]));
  });

  it('the AIR ITSELF is identical, which is the mechanism the ladder is downstream of', () => {
    // The ladder is a consequence; this is the cause. `parkConditions` is the
    // only door temperature and humidity come through, and it takes a park, a
    // roof state and a seed — no lighting anywhere in its signature.
    saveDaylight('night');
    const night = parkConditions(HARBOURFRONT, true, 4242);
    saveDaylight('day');
    const day = parkConditions(HARBOURFRONT, true, 4242);
    expect(JSON.stringify(night)).toBe(JSON.stringify(day));
    // The two inputs `airDensity` derives ρ from, named explicitly, because
    // TEMPERATURE is the specific channel this whole file exists to close.
    expect(night.air.tempF).toBe(day.air.tempF);
    expect(night.air.rh).toBe(day.air.rh);
    expect(night.air.elevFt).toBe(day.air.elevFt);
  });

  it('no `lib/baseball` source knows the preference exists', () => {
    // ⚠ THE CHANNEL, NOT THE OUTCOME. The ladder test above would still pass if
    // some future sim module read the preference in a place that happened not to
    // affect a 27° fly ball. This says the import does not exist at all.
    const offenders: string[] = [];
    for (const name of readdirSync(SIM_DIR).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(SIM_DIR, name), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
        if (/\bfrom\s+['"].*\/(prefs|daylight)['"]/.test(line) || /\bdaylight\b/i.test(line)) {
          offenders.push(`${name}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders, `the daylight option leaked into the sim:\n${offenders.join('\n')}`).toEqual(
      [],
    );
    // Guard the guard: the scan must be walking real files.
    expect(readdirSync(SIM_DIR)).toContain('battedBallSim.ts');
  });
});

describe('the preference persists, and survives a hostile store', () => {
  beforeEach(() => {
    installStorage();
  });

  it('round-trips, and defaults when the value is absent or junk', () => {
    expect(loadDaylight()).toBe(DEFAULT_DAYLIGHT);
    for (const v of ['day', 'night'] as DaylightId[]) {
      saveDaylight(v);
      expect(loadDaylight()).toBe(v);
    }
    // ⚠ UNTRUSTED INPUT. A stored value survives upgrades and is editable in
    // devtools, so it is validated on the way OUT, not merely on the way in.
    localStorage.setItem('relay.bb.daylight', 'dusk');
    expect(loadDaylight()).toBe(DEFAULT_DAYLIGHT);
    localStorage.setItem('relay.bb.daylight', '{"night":true}');
    expect(loadDaylight()).toBe(DEFAULT_DAYLIGHT);
  });

  it('does not take the game down when storage throws', () => {
    // Safari in private mode throws on `setItem`; an embedded WebView can have
    // storage disabled outright. A preference that crashes the game is worse
    // than one that does not persist.
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;
    expect(() => saveDaylight('night')).not.toThrow();
    expect(loadDaylight()).toBe(DEFAULT_DAYLIGHT);
  });
});
